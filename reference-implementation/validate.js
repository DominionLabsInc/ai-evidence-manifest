import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { sha256OfText, containsNormalized, normalizeText } from './normalize.js';
import { fetchSafe, FetchRefused } from './fetch-safe.js';
import { extractText } from './html.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = path.join(here, '..', 'schema', 'ai-evidence-manifest.schema.json');
export const SUPPORTED_MAJOR = 1;

export const LIMITS = {
  maxManifestBytes: 1024 * 1024,   // 1 MiB
  maxClaims: 1000,
  maxEvidencePerClaim: 20,
  maxTextChars: 2000,
  staleAfterDays: 365
};

let _validator;
function schemaValidator() {
  if (!_validator) {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    _validator = ajv.compile(schema);
  }
  return _validator;
}

const err = (code, message, where) => ({ severity: 'error', code, message, where });
const warn = (code, message, where) => ({ severity: 'warning', code, message, where });

/**
 * Validate a manifest.
 *
 * Offline checks cover structure, internal consistency and limits.
 * Online checks additionally confirm each evidence URL still serves the quoted
 * text — that is the check that catches a page drifting away from its manifest.
 */
export async function validateManifest(manifest, opts = {}) {
  const o = { offline: true, strict: false, limits: { ...LIMITS }, rawBytes: null, ...opts };
  const findings = [];
  const stats = { claims: 0, evidence: 0, checkedUrls: 0, reachable: 0, textPresent: 0 };

  // ---- structure -------------------------------------------------------
  const validate = schemaValidator();
  if (!validate(manifest)) {
    for (const e of validate.errors) {
      findings.push(err('schema', `${e.instancePath || '/'} ${e.message}${e.params?.allowedValues ? ` (allowed: ${e.params.allowedValues.join(', ')})` : ''}`, e.instancePath || '/'));
    }
    return finish(findings, stats, o);   // later checks assume a valid shape
  }

  // ---- version ---------------------------------------------------------
  const major = Number(manifest.manifest.version.split('.')[0]);
  if (major !== SUPPORTED_MAJOR) {
    findings.push(err('version', `manifest version ${manifest.manifest.version} is not supported by this validator (expects ${SUPPORTED_MAJOR}.x.x)`, '/manifest/version'));
  }

  // ---- limits ----------------------------------------------------------
  if (o.rawBytes != null && o.rawBytes > o.limits.maxManifestBytes) {
    findings.push(warn('size', `manifest is ${o.rawBytes} bytes, above the recommended ${o.limits.maxManifestBytes}`, '/'));
  }
  if (manifest.claims.length > o.limits.maxClaims) {
    findings.push(warn('size', `${manifest.claims.length} claims, above the recommended ${o.limits.maxClaims}`, '/claims'));
  }

  // ---- identifiers -----------------------------------------------------
  const seen = new Map();
  manifest.claims.forEach((c, i) => {
    if (seen.has(c.id)) {
      findings.push(err('duplicate-id', `claim id "${c.id}" is used more than once (also at /claims/${seen.get(c.id)})`, `/claims/${i}/id`));
    } else seen.set(c.id, i);
  });

  // ---- per-evidence ----------------------------------------------------
  let siteOrigin = null;
  try { siteOrigin = new URL(manifest.manifest.site).origin; } catch { /* schema already rejected this */ }

  const now = Date.now();
  stats.claims = manifest.claims.length;

  for (const [ci, claim] of manifest.claims.entries()) {
    if (claim.evidence.length > o.limits.maxEvidencePerClaim) {
      findings.push(warn('size', `claim "${claim.id}" has ${claim.evidence.length} evidence records, above the recommended ${o.limits.maxEvidencePerClaim}`, `/claims/${ci}/evidence`));
    }

    for (const [ei, ev] of claim.evidence.entries()) {
      stats.evidence++;
      const at = `/claims/${ci}/evidence/${ei}`;

      // internal consistency: does the stated hash match the stated text?
      if (ev.integrity?.sha256) {
        const actual = sha256OfText(ev.text);
        if (actual !== ev.integrity.sha256) {
          findings.push(err('integrity-mismatch', `integrity.sha256 does not match the normalized text (expected ${actual})`, `${at}/integrity/sha256`));
        }
      } else {
        findings.push(warn('no-integrity', 'no integrity.sha256; consumers cannot detect drift without refetching', at));
      }

      if (siteOrigin && ev.source_type === 'first-party') {
        let evOrigin = null;
        try { evOrigin = new URL(ev.url).origin; } catch { /* schema-checked */ }
        if (evOrigin && evOrigin !== siteOrigin) {
          findings.push(warn('cross-origin-first-party', `marked first-party but ${evOrigin} is not the manifest origin ${siteOrigin}`, `${at}/url`));
        }
      }

      if (ev.locator && !ev.locator.fragment && !ev.locator.section && ev.locator.selector) {
        findings.push(warn('selector-only', 'locator relies on a CSS selector alone; prefer fragment or section', `${at}/locator`));
      }

      if (ev.verification?.verified_at) {
        const age = (now - Date.parse(ev.verification.verified_at)) / 86_400_000;
        if (age > o.limits.staleAfterDays) {
          findings.push(warn('stale', `last verified ${Math.round(age)} days ago (stale after ${o.limits.staleAfterDays})`, `${at}/verification/verified_at`));
        }
      } else {
        findings.push(warn('unverified', 'no verification.verified_at; freshness is unknown', at));
      }

      if (ev.verification?.verified === true && ev.verification.method === 'automatically-generated') {
        findings.push(warn('auto-verified', 'verified:true with method automatically-generated — machine extraction is not confirmation', `${at}/verification`));
      }

      if (ev.text.length > o.limits.maxTextChars) {
        findings.push(warn('size', `evidence text is ${ev.text.length} chars, above the recommended ${o.limits.maxTextChars}`, `${at}/text`));
      }
    }
  }

  // ---- network ---------------------------------------------------------
  if (!o.offline) {
    const cache = new Map();
    for (const [ci, claim] of manifest.claims.entries()) {
      for (const [ei, ev] of claim.evidence.entries()) {
        const at = `/claims/${ci}/evidence/${ei}`;
        const key = ev.url.split('#')[0];
        stats.checkedUrls++;
        if (!cache.has(key)) {
          try {
            const res = await fetchSafe(key, { accept: 'text/html,*/*' });
            cache.set(key, res.status >= 200 && res.status < 300 ? { ok: true, text: extractText(res.body) } : { ok: false, reason: `HTTP ${res.status}` });
          } catch (e) {
            cache.set(key, { ok: false, reason: e instanceof FetchRefused ? `${e.code}: ${e.message}` : e.message });
          }
        }
        const page = cache.get(key);
        if (!page.ok) { findings.push(err('unreachable', `evidence URL not retrievable (${page.reason})`, `${at}/url`)); continue; }
        stats.reachable++;
        if (containsNormalized(page.text, ev.text)) stats.textPresent++;
        else findings.push(err('text-absent', 'quoted text was not found at the evidence URL — the page may have changed', `${at}/text`));
      }
    }
  }

  return finish(findings, stats, o);
}

function finish(findings, stats, o) {
  const errors = findings.filter(f => f.severity === 'error');
  const warnings = findings.filter(f => f.severity === 'warning');
  return { valid: errors.length === 0 && (!o.strict || warnings.length === 0), errors, warnings, findings, stats, strict: o.strict, offline: o.offline };
}

export function parseManifest(raw) {
  try { return { manifest: JSON.parse(raw), bytes: Buffer.byteLength(raw, 'utf8') }; }
  catch (e) { const err = new Error(`manifest is not valid JSON: ${e.message}`); err.code = 'malformed-json'; throw err; }
}
