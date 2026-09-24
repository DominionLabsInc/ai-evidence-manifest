import { fetchSafe } from './fetch-safe.js';
import { extractText, extractTitle, extractMeta, extractJsonLd, extractBlocks, looksClientRendered } from './html.js';
import { sha256OfText, normalizeText, containsNormalized, textFragment } from './normalize.js';
import { T, CLAIM_PATTERNS, GATES, SENTENCE, ATOMIC_TYPES as SHARED_ATOMIC, SCHEMA_TYPE_MAP as SHARED_TYPES } from './patterns.js';

export const EXTRACT_DEFAULTS = {
  maxPages: 20,
  maxCandidatesPerPage: T.maxCandidatesPerPage,
  maxPerType: T.maxPerType,
  minSentenceChars: T.minSentenceChars,
  maxSentenceChars: T.maxSentenceChars,
  // 'summaries' keeps only claims whose text the publisher wrote as a summary,
  // with matching quotes as evidence. 'all' also emits section leads and
  // uncovered sentences.
  claims: 'summaries'
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

const SCHEMA_TYPE_MAP = SHARED_TYPES;

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

const PATTERNS = CLAIM_PATTERNS;


function splitSentences(text) {
  const parts = text.split(SENTENCE.splitAfter);
  const out = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    // Re-join after an abbreviation, or after a single capital letter (an
    // initial, as in "Stefan R. Ragland").
    if (prev && (SENTENCE.abbreviations.test(prev) || SENTENCE.initial.test(prev))) out[out.length - 1] = `${prev} ${part}`;
    else out.push(part);
  }
  return out.map(s => s.trim()).filter(Boolean);
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
  const verified = [];
  for (const c of candidates) {
    const norm = normalizeText(c.text).toLowerCase();
    if (seenText.has(norm)) continue;                 // same sentence matched twice
    if (!assertPresent(pageText, c.text)) continue;   // the invariant, enforced at the boundary
    seenText.add(norm);
    const block = c.block ?? blocks.find(b => containsNormalized(b.text, c.text));
    verified.push({ ...c, block });
  }

  const summaries = publisherSummaries(html, meta, pageText);
  const claims = clusterUnderSummaries(verified, summaries, { url: res_url(url), title, meta, o });

  let note = null;
  if (claims.length === 0) {
    const cr = looksClientRendered(html);
    note = cr.likely
      ? { code: 'client-rendered', reasons: cr.reasons, textLength: cr.textLength }
      : { code: 'no-candidates', reasons: [`${cr.textLength} characters of visible text, none matching a claim pattern`], textLength: cr.textLength };
  }
  return { url, title, candidates: claims, note };
}

const res_url = u => u.split('#')[0];

/**
 * Summary text the publisher already wrote.
 *
 * A claim should summarise; evidence should quote. Generating a summary is not
 * something this tool can do deterministically, but most pages already contain
 * one — a schema.org description, a meta description, a section heading. Those
 * are the publisher's own words about what the page says, so they are used as
 * claims and the matching sentences become the evidence beneath them.
 */
function publisherSummaries(html, meta, pageText) {
  const out = [];
  for (const node of extractJsonLd(html)) {
    for (const field of ['description', 'abstract', 'disambiguatingDescription']) {
      const v = typeof node[field] === 'string' ? node[field].trim() : null;
      const rawType = Array.isArray(node['@type']) ? node['@type'][0] : node['@type'];
      if (v && v.length >= T.minSummaryChars) out.push({ text: v, source: 'schema.org', type: SCHEMA_TYPE_MAP[rawType] ?? null });
    }
  }
  for (const key of ['description', 'og:description']) {
    const v = meta[key];
    if (v && v.length >= T.minSummaryChars) out.push({ text: v, source: 'meta', type: null });
  }

  // Section lead sentences. A heading names a topic but rarely asserts
  // anything; the sentence that opens the section usually states its point, and
  // it is the publisher's own summary of what follows.
  for (const lead of sectionLeads(blocksOf(html))) out.push({ text: lead, source: 'heading', type: null });

  // A schema.org description and a meta description are often near-copies of
  // each other. Keeping both produces two claims saying the same thing.
  const deduped = [];
  for (const s of out) {
    const dupe = deduped.find(d => overlap(d.text, s.text) > T.summaryDedupeThreshold);
    if (!dupe) deduped.push(s);
    else if (s.text.length > dupe.text.length) deduped[deduped.indexOf(dupe)] = s;
  }
  return deduped;
}

let _blockCache = new WeakMap();
function blocksOf(html) {
  if (typeof html !== 'string') return extractBlocks(html);
  return extractBlocks(html);
}

/** First sentence of the first paragraph following each heading. */
function sectionLeads(blocks) {
  const leads = [];
  for (let i = 0; i < blocks.length; i++) {
    if (!/^h[1-4]$/.test(blocks[i].tag)) continue;
    const body = blocks.slice(i + 1).find(b => b.tag === 'p' && b.text.length >= 60);
    if (!body) continue;
    const first = body.text.split(/(?<=[.!?])\s+(?=[A-Z0-9"\u201c'(])/u)[0]?.trim();
    if (first && first.length >= 50 && first.length <= 320) leads.push(first);
  }
  return leads;
}

/** Word overlap, used to decide which sentences support which summary. */
function overlap(a, b) {
  const A = new Set(normalizeText(a).toLowerCase().match(/\p{Letter}{3,}/gu) ?? []);
  const B = new Set(normalizeText(b).toLowerCase().match(/\p{Letter}{3,}/gu) ?? []);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / Math.min(A.size, B.size);
}

const SUPPORT_THRESHOLD = T.supportThreshold;
const MAX_EVIDENCE_PER_CLAIM = T.maxEvidencePerClaim;

function toEvidence(c, { url, title, meta }) {
  const locator = {};
  if (c.block?.id) locator.section = c.block.id;
  else if (c.block?.section) locator.section = c.block.section;
  locator.fragment = textFragment(c.text);
  const published = meta['article:published_time']?.slice(0, 10);
  return {
    url,
    text: c.text,
    ...(title ? { title } : {}),
    locator,
    integrity: { sha256: sha256OfText(c.text) },
    source_type: 'first-party',
    authority: 'publisher',
    ...(published && /^\d{4}-\d{2}-\d{2}$/.test(published) ? { published_at: published } : {}),
    verification: { verified: false, verified_at: new Date().toISOString().slice(0, 10), method: 'automatically-generated' }
  };
}

const ATOMIC_TYPES = SHARED_ATOMIC;

/**
 * Sentences that are grammatically fine and completely useless as claims.
 *
 * Three families, all detectable without judgement:
 *   - the sentence is about the document rather than the organisation
 *     ("This Privacy Policy explains…", "Table 2 maps…")
 *   - consent formulas addressed to the reader ("By using the Services, you
 *     agree…"), which appear on millions of sites and say nothing specific
 *   - capitalised liability blocks, which are disclaimers, not claims
 */



function isBoilerplate(text) {
  if (GATES.obfuscatedValue.test(text)) return true;
  if (GATES.selfReferential.test(text) || GATES.consentFormula.test(text) || GATES.governedBy.test(text)) return true;
  if (GATES.danglingReference.test(text)) return true;
  const letters = text.replace(/[^\p{Letter}]/gu, '');
  if (letters.length > T.minUppercaseSampleChars &&
      (letters.replace(/[^\p{Uppercase_Letter}]/gu, '').length / letters.length) > T.uppercaseRatioLimit) return true;
  return false;
}


function clusterUnderSummaries(verified, summaries, ctx) {
  const used = new Set();
  const claims = [];
  const summariesOnly = ctx.o.claims !== 'all';
  if (summariesOnly) summaries = summaries.filter(s => s.source === 'schema.org' || s.source === 'meta');

  for (const summary of summaries) {
    const supporting = verified
      .map((c, i) => ({ c, i, score: overlap(summary.text, c.text) }))
      .filter(x => !used.has(x.i) && x.score >= SUPPORT_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_EVIDENCE_PER_CLAIM);
    if (!supporting.length) continue;
    for (const x of supporting) used.add(x.i);

    const types = supporting.map(x => x.c.type);
    const type = summary.type ?? types.sort((a, b) =>
      types.filter(t => t === b).length - types.filter(t => t === a).length)[0];

    claims.push({
      type,
      claim: summary.text,
      summary_source: summary.source,
      tier: 1,
      why: `summary from ${summary.source}, ${supporting.length} supporting quote(s)`,
      evidence: supporting.map(x => toEvidence(x.c, ctx))
    });
  }

  // Sentences no summary covered stand on their own. In 'summaries' mode only
  // atomic facts qualify — a discrete, checkable statement is worth publishing
  // whether or not a page summary happens to mention it.
  for (const [i, c] of verified.entries()) {
    if (used.has(i)) continue;
    if (summariesOnly && !ATOMIC_TYPES.has(c.type)) continue;
    if (summariesOnly && isBoilerplate(c.text)) continue;
    if (summariesOnly && (c.type === 'certification' || c.type === 'credential') && !GATES.namedCredential.test(c.text)) continue;
    if (summariesOnly && c.type === 'pricing' && !GATES.concretePricing.test(c.text)) continue;
    if (claims.length >= ctx.o.maxCandidatesPerPage) break;
    claims.push({
      type: c.type,
      claim: c.text,
      summary_source: 'evidence',
      tier: c.tier,
      why: c.why,
      evidence: [toEvidence(c, ctx)]
    });
  }
  return dropSubsumed(claims).slice(0, ctx.o.maxCandidatesPerPage);
}

/**
 * Two summaries on the same page (a schema.org description and a meta
 * description, typically) often say the same thing in different words. Text
 * similarity is an unreliable way to catch that — the wording can differ a lot.
 * What gives it away is that they end up standing over the same quotes, so
 * compare evidence sets and keep the better-supported claim.
 */
function dropSubsumed(claims) {
  const key = c => new Set(c.evidence.map(e => normalizeText(e.text).toLowerCase()));
  const out = [];
  for (const c of [...claims].sort((a, b) => b.evidence.length - a.evidence.length)) {
    const ck = key(c);
    const covered = out.some(kept => {
      const kk = key(kept);
      let shared = 0;
      for (const t of ck) if (kk.has(t)) shared++;
      return shared / ck.size >= T.subsumedEvidenceRatio;     // half its support already stands under another claim
    });
    if (!covered) out.push(c);
  }
  return out;
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
    let id = `${String(c.type).replace(/_/g, '-')}-${slugify(c.claim, 40)}`;
    let n = 2;
    const base = id;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    return {
      id,
      type: c.type,
      claim: c.claim,
      ...(c.summary_source ? { summary_source: c.summary_source } : {}),
      evidence: c.evidence ?? [c.evidence]
    };
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
