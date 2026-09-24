import { fetchSafe, FetchRefused } from './fetch-safe.js';
import { extractText, extractBlocks } from './html.js';
import { normalizeText, sha256OfText, containsNormalized, textFragment } from './normalize.js';
import { T } from './patterns.js';

/**
 * Repair evidence whose quoted text has drifted away from its source.
 *
 * Detection alone is not enough: a scheduled check that only reports "2 of 19
 * quotes are gone" leaves the published file wrong until a human intervenes,
 * and agents read it in the meantime.
 *
 * The danger in automatic repair is obvious — silently substituting different
 * text would turn an evidence index into a fabrication engine. So relocation is
 * gated: a replacement is only accepted when it is demonstrably a near-variant
 * of the text it replaces (SIMILARITY_THRESHOLD of word overlap) and comes from
 * the same URL. Anything below that is reported as lost and left for a person.
 * The tool would rather leave a hole than invent a patch.
 */

export const SIMILARITY_THRESHOLD = T.repairSimilarityThreshold;

const tokens = s => new Set(normalizeText(s).toLowerCase().match(/\p{Letter}+|\p{Number}+/gu) ?? []);

/** Jaccard overlap of word sets: order-insensitive, punctuation-insensitive, deterministic. */
export function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

/**
 * Candidate texts to match against: whole blocks and the sentences inside them.
 *
 * Evidence is captured at sentence level, so comparing a sentence against a
 * whole paragraph dilutes the score — a one-word edit inside a 60-word
 * paragraph scores 0.38 rather than 0.92 and a repairable drift reads as lost.
 * Like must be compared with like.
 */
function candidateTexts(blocks) {
  const out = [];
  for (const b of blocks) {
    out.push({ block: b, text: b.text });
    const sentences = b.text.split(/(?<=[.!?])\s+(?=[A-Z0-9"\u201c'(])/u).map(x => x.trim()).filter(Boolean);
    if (sentences.length > 1) for (const t of sentences) out.push({ block: b, text: t });
  }
  return out;
}

/** Closest text on the page to a quote that has gone missing. */
export function bestMatch(blocks, missingText, threshold = SIMILARITY_THRESHOLD) {
  let best = null;
  for (const c of candidateTexts(blocks)) {
    const score = similarity(missingText, c.text);
    if (!best || score > best.score) best = { block: c.block, text: c.text, score };
  }
  return best && best.score >= threshold ? best : null;
}

export async function repairManifest(manifest, opts = {}) {
  const { threshold = SIMILARITY_THRESHOLD, prune = false, onEvent } = opts;
  const pages = new Map();
  const events = [];
  const now = new Date().toISOString();

  const emit = e => { events.push(e); onEvent?.(e); };

  for (const [ci, claim] of manifest.claims.entries()) {
    for (const [ei, ev] of claim.evidence.entries()) {
      const key = ev.url.split('#')[0];
      if (!pages.has(key)) {
        try {
          const res = await fetchSafe(key, { accept: 'text/html' });
          pages.set(key, { ok: true, text: extractText(res.body), blocks: extractBlocks(res.body) });
        } catch (e) {
          pages.set(key, { ok: false, reason: e instanceof FetchRefused ? `${e.code}: ${e.message}` : e.message });
        }
      }
      const page = pages.get(key);
      const where = `${claim.id}[${ei}]`;

      if (!page.ok) { emit({ kind: 'unreachable', where, url: key, reason: page.reason }); continue; }

      if (containsNormalized(page.text, ev.text)) {
        ev.last_seen = now;
        emit({ kind: 'present', where });
        continue;
      }

      const match = bestMatch(page.blocks, ev.text, threshold);
      if (match) {
        const before = ev.text;
        ev.text = match.text;
        ev.integrity = { ...(ev.integrity ?? {}), sha256: sha256OfText(match.text) };
        ev.locator = {
          ...(match.block.id ? { section: match.block.id } : match.block.section ? { section: match.block.section } : {}),
          fragment: textFragment(match.text)
        };
        ev.last_seen = now;
        // The publisher confirmed the old wording, not this one.
        ev.verification = { ...(ev.verification ?? {}), verified: false, verified_at: now.slice(0, 10), method: 'automatically-generated' };
        emit({ kind: 'relocated', where, url: key, score: Number(match.score.toFixed(3)), before, after: match.text });
      } else {
        delete ev.last_seen;
        emit({ kind: 'lost', where, url: key, text: ev.text });
      }
    }
  }

  let pruned = 0;
  if (prune) {
    for (const claim of manifest.claims) {
      const keep = claim.evidence.filter(ev => ev.last_seen);
      pruned += claim.evidence.length - keep.length;
      claim.evidence = keep;
    }
    const before = manifest.claims.length;
    // A claim with no surviving evidence is an assertion with nothing behind it.
    manifest.claims = manifest.claims.filter(c => c.evidence.length > 0);
    if (manifest.claims.length !== before) emit({ kind: 'claims-dropped', count: before - manifest.claims.length });
  }

  const counts = events.reduce((a, e) => ({ ...a, [e.kind]: (a[e.kind] ?? 0) + 1 }), {});
  return { manifest, events, counts, pruned };
}
