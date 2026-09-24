/**
 * RFC 8785 (JSON Canonicalization Scheme) — restricted to the value space this
 * specification is willing to sign.
 *
 * A signature is computed over a byte string. JSON is not a byte string: the
 * same document can be serialized many ways, and any disagreement between two
 * implementations about which bytes a document "is" shows up as a valid
 * signature that fails to verify somewhere else. That failure is silent,
 * remote, and extremely hard to debug, so this module refuses every input
 * whose canonical form is not provably identical in JavaScript and Python.
 *
 * Three restrictions beyond RFC 8785, each rejected loudly at signing time
 * rather than risked at verification time in someone else's stack:
 *
 *   1. No non-integer numbers. RFC 8785 canonicalizes floats with the ES6
 *      Number::toString algorithm. Python's repr() agrees with it across most
 *      of the range and disagrees at the edges — 1e17, 1e-5, -0.0 — so a float
 *      anywhere in the document is a latent interoperability break. The
 *      manifest schema contains no floats; only `extensions` can introduce
 *      one, and a publisher who does gets an error instead of a signature.
 *   2. No integers outside IEEE 754 safe range. JSON.parse turns 2^53+1 into a
 *      float; Python's json keeps it an exact int. The two would canonicalize
 *      the same source bytes differently.
 *   3. No lone surrogates. They cannot be encoded as UTF-8, so there is no
 *      byte string to sign.
 *
 * Key ordering follows RFC 8785: UTF-16 code units, which is what JavaScript's
 * default string comparison already does.
 */

export class CanonicalizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

const SHORT_ESCAPES = new Map([
  [0x08, '\\b'],
  [0x09, '\\t'],
  [0x0a, '\\n'],
  [0x0c, '\\f'],
  [0x0d, '\\r'],
  [0x22, '\\"'],
  [0x5c, '\\\\'],
]);

function escapeString(s, path) {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      throw new CanonicalizationError(
        `lone surrogate U+${cp.toString(16).toUpperCase()} at ${path || '/'} cannot be encoded as UTF-8`);
    }
    const short = SHORT_ESCAPES.get(cp);
    if (short !== undefined) out += short;
    else if (cp < 0x20) out += '\\u' + cp.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

function serialize(value, path) {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'string') return escapeString(value, path);

  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(`${value} at ${path || '/'} is not representable in JSON`);
    }
    if (!Number.isInteger(value)) {
      throw new CanonicalizationError(
        `non-integer number ${value} at ${path || '/'} cannot be signed: canonical float ` +
        `formatting is not byte-identical across implementations (see canonical.js)`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalizationError(
        `integer ${value} at ${path || '/'} is outside the IEEE 754 safe range ` +
        `and does not round-trip identically across implementations`);
    }
    return String(value === 0 ? 0 : value);
  }

  if (Array.isArray(value)) {
    const parts = value.map((item, i) => serialize(item, `${path}/${i}`));
    return '[' + parts.join(',') + ']';
  }

  if (t === 'object') {
    // Default sort compares UTF-16 code units, which is what RFC 8785 requires.
    const keys = Object.keys(value).sort();
    const parts = keys.map((k) => `${escapeString(k, path)}:${serialize(value[k], `${path}/${k}`)}`);
    return '{' + parts.join(',') + '}';
  }

  throw new CanonicalizationError(`value of type ${t} at ${path || '/'} has no JSON representation`);
}

/** Canonical JSON text (RFC 8785, restricted). Encode as UTF-8 to get the bytes that are signed. */
export function canonicalize(value) {
  return serialize(value, '');
}

/** Canonical bytes: what a signature is actually computed over. */
export function canonicalBytes(value) {
  return Buffer.from(canonicalize(value), 'utf8');
}
