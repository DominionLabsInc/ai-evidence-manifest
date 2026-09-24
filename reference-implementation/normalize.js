import { createHash } from 'node:crypto';

/**
 * Canonical text normalization for AI Evidence Manifest integrity hashes.
 *
 * Every consumer must derive the same hash from the same visible text, so the
 * steps are fixed and deliberately boring:
 *
 *   1. Unicode NFC
 *   2. every run of Unicode whitespace becomes a single U+0020
 *   3. trim
 *   4. UTF-8, SHA-256, lowercase hex
 *
 * Whitespace is collapsed because HTML authoring reflows it freely; an
 * indentation change must not invalidate otherwise-intact evidence.
 */
export function normalizeText(text) {
  if (typeof text !== 'string') throw new TypeError('normalizeText expects a string');
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

export function sha256OfText(text) {
  return createHash('sha256').update(normalizeText(text), 'utf8').digest('hex');
}

/** Case- and whitespace-insensitive containment, used to confirm a quote is really on a page. */
export function containsNormalized(haystack, needle) {
  return normalizeText(haystack).toLowerCase().includes(normalizeText(needle).toLowerCase());
}

/** Build a W3C Text Fragment so an agent (or a browser) can jump straight to the quote. */
export function textFragment(text, maxWords = 12) {
  const words = normalizeText(text).split(' ');
  if (words.length <= maxWords * 2) return `#:~:text=${encodeURIComponent(words.join(' '))}`;
  const start = words.slice(0, maxWords).join(' ');
  const end = words.slice(-maxWords).join(' ');
  return `#:~:text=${encodeURIComponent(start)},${encodeURIComponent(end)}`;
}
