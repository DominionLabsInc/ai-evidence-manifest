import { fetchSafe } from './fetch-safe.js';
import { extractText, extractTitle, extractMeta, extractJsonLd, extractBlocks, looksClientRendered } from './html.js';
import { sha256OfText, normalizeText, containsNormalized, textFragment } from './normalize.js';

export const EXTRACT_DEFAULTS = {
  maxPages: 20,
  maxCandidatesPerPage: 8,   // recall matters more than volume; review prunes further
  maxPerType: 6,             // stops one boilerplate-heavy page dominating the manifest
  minSentenceChars: 40,
  maxSentenceChars: 500
};

/**
 * The invariant that makes automatic extraction safe:
 * a candidate is only ever emitted if its text is present in the page's own
 * visible text. Nothing is summarised, paraphrased or invented. Extraction can
 * therefore miss evidence, but it cannot fabricate it.
 */
function assertPresent(pageText, candidateText) {
  return containsNormalized(pageText, candidateText);
}

// ---------------------------------------------------------------- tier 1 ---
// Entities the publisher has already declared in machine-readable form.

const SCHEMA_TYPE_MAP = {
  Organization: 'organization', Corporation: 'organization', LocalBusiness: 'organization',
  Product: 'product', SoftwareApplication: 'product', Service: 'service',
  Person: 'person', Place: 'location', PostalAddress: 'location',
  ScholarlyArticle: 'research', Article: 'documentation', TechArticle: 'documentation',
  Offer: 'pricing', Course: 'service', Dataset: 'documentation'
};

function tier1(pageText, jsonld) {
  const out = [];
  for (const node of jsonld) {
    const rawType = Array.isArray(node['@type']) ? node['@type'][0] : node['@type'];
    const type = SCHEMA_TYPE_MAP[rawType];
    if (!type) continue;
    const name = typeof node.name === 'string' ? node.name.trim()
               : typeof node.headline === 'string' ? node.headline.trim() : null;
    if (!name) continue;

    // Prefer a declared description, but only if the page actually shows it.
    for (const field of ['description', 'abstract', 'disambiguatingDescription']) {
      const value = typeof node[field] === 'string' ? node[field].trim() : null;
      if (value && assertPresent(pageText, value)) {
        out.push({ tier: 1, type, claim: value, text: value, why: `schema.org ${rawType}.${field}` });
        break;
      }
    }
    // A bare name is not a claim — "X is described as an Organization" tells a
    // consumer nothing it could not read from the markup itself. Only emit
    // tier 1 when the publisher wrote a description the page actually shows.

  }
  return out;
}

// ---------------------------------------------------------------- tier 2 ---
// Deterministic sentence patterns. Ordered: the first match wins, so a sentence
// is classified once rather than appearing under several types.

const ACTION_VERBS = String.raw`build|builds|building|built|develop|develops|developing|developed|`
  + String.raw`provide|provides|providing|offer|offers|offering|deliver|delivers|delivering|`
  + String.raw`operate|operates|operating|enable|enables|enabling|support|supports|supporting|`
  + String.raw`run|runs|running|create|creates|creating|design|designs|designing|`
  + String.raw`publish|publishes|publishing|maintain|maintains|maintaining|`
  + String.raw`pair|pairs|pairing|focus|focuses|focusing|specialis|specializ`;

const ENTITY_NOUNS = String.raw`company|platform|system|tool|service|library|framework|product|`
  + String.raw`organi[sz]ation|lab|laboratory|institute|agency|studio|firm|architecture|substrate`;

// Ordered: first match wins, so each sentence is classified once rather than
// appearing under several types.
const PATTERNS = [
  ['certification',   /\b(ISO\s?\d{4,5}|SOC\s?2|HIPAA|GDPR|FedRAMP|CMMC|PCI[- ]DSS|certified|accredited|audited|compliant with)\b/i],
  ['statistic',       /\b\d[\d,.]*\s?(%|percent|million|billion|thousand|users|customers|requests|ms|seconds|hours)\b/i],
  ['pricing',         /(\$|\u20ac|\u00a3)\s?\d|\bper\s+(month|year|seat|user|request|token)\b|\bfree tier\b/i],
  ['availability',    /\b(available in|supported regions|uptime|SLA|service level|99\.\d+%)\b/i],
  ['credential',      /\b(patent(ed)?|trademark|licen[cs]ed|registered in)\b/i],
  ['research',        /\b(we (show|measure|demonstrate|evaluate|find)|our (paper|study|research|experiments?)|peer[- ]reviewed|preprint)\b/i],
  ['policy',          /\b(we (do not|never) (sell|share|store)|data (retention|residency)|privacy policy|terms of service)\b/i],
  ['contact',         /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b|\bcontact us\b/i],
  // "X is a/the <entity noun>" — the most common way an organisation or
  // product states what it is.
  ['organization',    new RegExp(String.raw`\b(is|are)\s+(an?|the)\s+[^.]{0,60}\b(company|organi[sz]ation|lab|laboratory|institute|agency|firm)\b`, 'i')],
  ['product',         new RegExp(String.raw`\b(is|are)\s+(an?|the)\s+[^.]{0,60}\b(platform|system|tool|service|library|framework|product|architecture|substrate)\b`, 'i')],
  // "we/our X ... <action verb>"
  ['capability',      new RegExp(String.raw`\b(we|our\s+\w+|the\s+(${ENTITY_NOUNS}))\b[^.]{0,90}\b(${ACTION_VERBS})`, 'i')],
  ['technical_claim', new RegExp(String.raw`\b(reasons?|verif(y|ies|ied)|infers?|derives?|validates?|proves?|guarantees?|ensures?)\b[^.]{0,90}\b(without|over|from|against|before)\b`, 'i')],
  ['business_fact',   new RegExp(String.raw`\b(founded|headquartered|based in|established|incorporated|team of|since\s+\d{4})\b`, 'i')]
];

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“'(])/u)
    .map(s => s.trim())
    .filter(Boolean);
}

function tier2(blocks, opts) {
  const out = [];
  for (const block of blocks) {
    if (block.tag === 'h1' || block.tag === 'h2' || block.tag === 'h3' || block.tag === 'h4') continue;
    for (const sentence of splitSentences(block.text)) {
      if (sentence.length < opts.minSentenceChars || sentence.length > opts.maxSentenceChars) continue;
      const hit = PATTERNS.find(([, re]) => re.test(sentence));
      if (!hit) continue;
      out.push({ tier: 2, type: hit[0], claim: sentence, text: sentence, why: `pattern:${hit[0]}`, block });
    }
  }
  return out;
}

// ------------------------------------------------------------------ pages ---

export async function extractFromPage(url, opts = {}) {
  const o = { ...EXTRACT_DEFAULTS, ...opts };
  const res = await fetchSafe(url, { accept: 'text/html,application/xhtml+xml' });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!/html/i.test(res.contentType)) throw new Error(`not HTML (${res.contentType || 'no content-type'}) for ${url}`);
  return candidatesFromHtml(res.body, res.url, o);
}

/**
 * The pure half of extraction: HTML in, candidates out, no network.
 * Separated so the safety invariant can be tested directly.
 */
export function candidatesFromHtml(html, url, opts = {}) {
  const o = { ...EXTRACT_DEFAULTS, ...opts };
  const pageText = extractText(html);
  const blocks = extractBlocks(html);
  const title = extractTitle(html);
  const meta = extractMeta(html);

  const candidates = [...tier1(pageText, extractJsonLd(html)), ...tier2(blocks, o)];

  const seenText = new Set();
  const evidence = [];
  for (const c of candidates) {
    const norm = normalizeText(c.text).toLowerCase();
    if (seenText.has(norm)) continue;                 // same sentence matched twice
    if (!assertPresent(pageText, c.text)) continue;   // the invariant, enforced again at the boundary
    seenText.add(norm);

    const block = c.block ?? blocks.find(b => containsNormalized(b.text, c.text));
    const locator = {};
    if (block?.id) locator.section = block.id;
    else if (block?.section) locator.section = block.section;
    locator.fragment = textFragment(c.text);

    evidence.push({
      type: c.type,
      claim: c.claim,
      tier: c.tier,
      why: c.why,
      evidence: {
        url: url.split('#')[0],
        text: c.text,
        ...(title ? { title } : {}),
        locator,
        integrity: { sha256: sha256OfText(c.text) },
        source_type: 'first-party',
        authority: 'publisher',
        ...(meta['article:published_time']?.slice(0, 10)?.match(/^\d{4}-\d{2}-\d{2}$/) ? { published_at: meta['article:published_time'].slice(0, 10) } : {}),
        verification: { verified: false, verified_at: new Date().toISOString().slice(0, 10), method: 'automatically-generated' }
      }
    });
    if (evidence.length >= o.maxCandidatesPerPage) break;
  }

  // Finding nothing is ambiguous: the page may genuinely have no claims, or it
  // may assemble its content in the browser where fetching cannot see it.
  // Saying which is the difference between a useful result and a misleading one.
  let note = null;
  if (evidence.length === 0) {
    const cr = looksClientRendered(html);
    if (cr.likely) note = { code: 'client-rendered', reasons: cr.reasons, textLength: cr.textLength };
    else note = { code: 'no-candidates', reasons: [`${cr.textLength} characters of visible text, none matching a claim pattern`], textLength: cr.textLength };
  }
  return { url, title, candidates: evidence, note };
}

// ------------------------------------------------------------------- site ---

async function discoverUrls(siteUrl, o) {
  const origin = new URL(siteUrl).origin;
  const urls = new Set([siteUrl]);
  try {
    const sm = await fetchSafe(new URL('/sitemap.xml', origin).toString(), { accept: 'application/xml,text/xml' });
    if (sm.status >= 200 && sm.status < 300) {
      for (const m of sm.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
        const u = m[1].trim();
        if (u.startsWith(origin) && !/\.(pdf|png|jpe?g|gif|svg|webp|zip|xml)$/i.test(u)) urls.add(u);
        if (urls.size >= o.maxPages) break;
      }
    }
  } catch { /* no sitemap is normal; fall back to links on the entry page */ }

  if (urls.size < o.maxPages) {
    try {
      const home = await fetchSafe(siteUrl, { accept: 'text/html' });
      for (const m of home.body.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)) {
        let u;
        try { u = new URL(m[1], siteUrl); } catch { continue; }
        if (u.origin !== origin) continue;
        if (/\.(pdf|png|jpe?g|gif|svg|webp|zip|xml|json|css|js)$/i.test(u.pathname)) continue;
        urls.add(u.toString().split('#')[0]);
        if (urls.size >= o.maxPages) break;
      }
    } catch { /* entry page failure is reported by the caller */ }
  }
  return [...urls].slice(0, o.maxPages);
}

export async function extractFromSite(siteUrl, opts = {}) {
  const o = { ...EXTRACT_DEFAULTS, ...opts };
  const origin = new URL(siteUrl).origin;
  const pages = await discoverUrls(siteUrl, o);
  const all = [];
  const pageResults = [];
  const errors = [];

  for (const url of pages) {
    try {
      const r = await extractFromPage(url, o);
      pageResults.push({ url, candidates: r.candidates.length, note: r.note });
      all.push(...r.candidates);
      if (typeof o.onPage === 'function') o.onPage(url, r.candidates.length, null, r.note);
    } catch (e) {
      errors.push({ url, error: e.message });
      if (typeof o.onPage === 'function') o.onPage(url, 0, e.message);
    }
  }

  const capped = capPerType(all, o.maxPerType);
  return {
    manifest: toManifest(origin, capped),
    pages: pageResults,
    errors,
    candidateCount: capped.length,
    droppedByCap: all.length - capped.length
  };
}

/** Keep the first N of each type, so a long policy page cannot crowd out capabilities. */
function capPerType(candidates, maxPerType) {
  if (!maxPerType) return candidates;
  const seen = new Map();
  return candidates.filter(c => {
    const n = (seen.get(c.type) ?? 0) + 1;
    seen.set(c.type, n);
    return n <= maxPerType;
  });
}

// -------------------------------------------------------------- assembling ---

function slugify(s, max = 48) {
  return s.toLowerCase().normalize('NFKD').replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '') || 'claim';
}

export function toManifest(site, candidates) {
  const used = new Set();
  const claims = candidates.map(c => {
    let id = `${c.type.replace(/_/g, '-')}-${slugify(c.claim, 40)}`;
    let n = 2;
    const base = id;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    return { id, type: c.type, claim: c.claim, evidence: [c.evidence] };
  });

  return {
    manifest: {
      version: '1.0.0',
      site,
      generated_at: new Date().toISOString(),
      generator: 'ai-evidence/0.1.0'
    },
    claims
  };
}
