/**
 * Detached-payload JWS (RFC 7515) over canonical manifest JSON, with Ed25519.
 *
 * What a signature here is for
 * ---------------------------
 * HTTPS already proves a manifest came from an origin, to the client that
 * fetched it, at the moment it fetched it. That proof is not transferable and
 * does not survive storage: an agent that caches a manifest and passes a claim
 * downstream has nothing left to show for its provenance. A signature makes the
 * document itself the evidence, verifiable by a party that never spoke to the
 * origin.
 *
 * Design decisions worth stating, because each closes an attack:
 *
 *   * `alg` is exactly "EdDSA" over Ed25519. There is no algorithm negotiation,
 *     so there is no algorithm-confusion attack and no "none".
 *   * The protected header is verified as the exact octets received, never
 *     re-serialized. Re-serializing lets an attacker vary bytes the signature
 *     covered.
 *   * The payload is detached (RFC 7515 Appendix F): it is the canonical form
 *     of the manifest with the top-level `signatures` member removed, so every
 *     signature covers the same payload and multiple signers can coexist.
 *   * The header must carry exactly the four parameters below. Unknown
 *     parameters are rejected rather than ignored, so nothing can be smuggled
 *     inside a signed region that verifiers skip over.
 *   * `typ` is specific to this specification, so a signature minted for some
 *     other protocol by the same key cannot be replayed as a manifest
 *     signature.
 *   * `iat` is inside the signed header, which is what makes it worth anything:
 *     it is the one freshness statement in the whole format that a publisher
 *     cannot backdate after the fact and a cache cannot forge.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { canonicalize, canonicalBytes, CanonicalizationError } from './canonical.js';

export const SIGNATURE_TYP = 'aem-signature+jws';
export const SIGNATURE_ALG = 'EdDSA';
export const SIGNATURE_CRV = 'Ed25519';
export const JWKS_PATH = '/.well-known/ai-evidence-jwks.json';

/** Accepted clock skew when judging whether `iat` lies in the future. */
export const DEFAULT_SKEW_SECONDS = 300;

const HEADER_PARAMS = ['alg', 'typ', 'kid', 'iat'];

export class SignatureError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SignatureError';
    this.code = code;
  }
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

/**
 * RFC 7638 JWK thumbprint, used as the `kid`.
 *
 * Deriving the identifier from the key means a key cannot be published under a
 * name that does not belong to it, and two parties naming the same key always
 * agree on the name.
 */
export function jwkThumbprint(jwk) {
  if (jwk?.kty !== 'OKP' || jwk?.crv !== SIGNATURE_CRV || typeof jwk?.x !== 'string') {
    throw new SignatureError(
      `thumbprint requires an OKP/${SIGNATURE_CRV} JWK with an "x" member`, 'bad-key');
  }
  // RFC 7638 requires the required members only, lexicographic, no whitespace.
  const required = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  return b64u(createHash('sha256').update(canonicalize(required), 'utf8').digest());
}

/** Generate an Ed25519 signing key. The returned `kid` is the thumbprint of the public key. */
export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicJwk = publicKey.export({ format: 'jwk' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const kid = jwkThumbprint(publicJwk);
  return {
    kid,
    publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, kid, use: 'sig', alg: SIGNATURE_ALG },
    privateJwk: { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, d: privateJwk.d, kid, use: 'sig', alg: SIGNATURE_ALG },
  };
}

/** The public half of a private JWK, in the form that belongs in a JWKS. */
export function publicJwkOf(privateJwk) {
  const kid = jwkThumbprint(privateJwk);
  return { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, kid, use: 'sig', alg: SIGNATURE_ALG };
}

/** A JWKS document ready to serve at {@link JWKS_PATH}. */
export function buildJwks(publicJwks) {
  return { keys: publicJwks.map((k) => ({ kty: k.kty, crv: k.crv, x: k.x, kid: k.kid ?? jwkThumbprint(k), use: 'sig', alg: SIGNATURE_ALG })) };
}

/** The payload every signature covers: the manifest without its `signatures` member. */
export function signingPayload(doc) {
  const { signatures, ...rest } = doc;
  return canonicalBytes(rest);
}

function keyObjectFromJwk(jwk, kind) {
  const fn = kind === 'private' ? createPrivateKey : createPublicKey;
  return fn({ key: jwk, format: 'jwk' });
}

/**
 * Sign a manifest, returning a new document with the signature appended.
 *
 * Signing is refused if the document cannot be canonicalized; see canonical.js
 * for why that refusal is preferable to a signature that verifies in only one
 * implementation.
 */
export function signManifest(doc, privateJwk, { iat, kid } = {}) {
  if (privateJwk?.kty !== 'OKP' || privateJwk?.crv !== SIGNATURE_CRV || typeof privateJwk?.d !== 'string') {
    throw new SignatureError(`signing requires an OKP/${SIGNATURE_CRV} private JWK`, 'bad-key');
  }
  const header = {
    alg: SIGNATURE_ALG,
    typ: SIGNATURE_TYP,
    kid: kid ?? privateJwk.kid ?? jwkThumbprint(privateJwk),
    iat: iat ?? Math.floor(Date.now() / 1000),
  };
  if (!Number.isSafeInteger(header.iat)) {
    throw new SignatureError('iat must be an integer number of seconds', 'bad-iat');
  }

  const payload = signingPayload(doc);
  const protectedB64 = b64u(Buffer.from(canonicalize(header), 'utf8'));
  const input = Buffer.from(`${protectedB64}.${b64u(payload)}`, 'ascii');
  const signature = edSign(null, input, keyObjectFromJwk(privateJwk, 'private'));

  const existing = Array.isArray(doc.signatures) ? doc.signatures : [];
  return { ...doc, signatures: [...existing, { protected: protectedB64, signature: b64u(signature) }] };
}

function parseHeader(protectedB64) {
  let header;
  try {
    header = JSON.parse(unb64u(protectedB64).toString('utf8'));
  } catch {
    throw new SignatureError('protected header is not valid base64url-encoded JSON', 'bad-header');
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    throw new SignatureError('protected header is not a JSON object', 'bad-header');
  }
  const keys = Object.keys(header).sort();
  const expected = [...HEADER_PARAMS].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new SignatureError(
      `protected header must carry exactly ${expected.join(', ')} (got ${keys.join(', ') || 'nothing'})`,
      'bad-header');
  }
  if (header.alg !== SIGNATURE_ALG) {
    throw new SignatureError(`unsupported alg ${JSON.stringify(header.alg)}; only ${SIGNATURE_ALG} is defined`, 'bad-alg');
  }
  if (header.typ !== SIGNATURE_TYP) {
    throw new SignatureError(`typ must be ${SIGNATURE_TYP}`, 'bad-typ');
  }
  if (typeof header.kid !== 'string' || !header.kid) {
    throw new SignatureError('kid must be a non-empty string', 'bad-header');
  }
  if (!Number.isSafeInteger(header.iat)) {
    throw new SignatureError('iat must be an integer number of seconds', 'bad-iat');
  }
  return header;
}

/**
 * Verify every signature on a manifest against a JWKS.
 *
 * Returns a result per signature rather than a single boolean, because "this
 * manifest is signed" and "this manifest is signed by the key I trust" are
 * different questions and a caller usually needs the second one.
 */
export function verifyManifest(doc, jwks, { now = Math.floor(Date.now() / 1000), skewSeconds = DEFAULT_SKEW_SECONDS } = {}) {
  const results = [];
  const signatures = Array.isArray(doc?.signatures) ? doc.signatures : [];
  if (signatures.length === 0) {
    return { signed: false, verified: false, results };
  }

  let payloadB64;
  try {
    payloadB64 = b64u(signingPayload(doc));
  } catch (err) {
    if (err instanceof CanonicalizationError) {
      return { signed: true, verified: false, results: signatures.map(() => ({ valid: false, code: 'uncanonicalizable', reason: err.message })) };
    }
    throw err;
  }

  const keys = new Map((jwks?.keys ?? []).map((k) => [k.kid ?? jwkThumbprint(k), k]));

  for (const sig of signatures) {
    try {
      if (typeof sig?.protected !== 'string' || typeof sig?.signature !== 'string') {
        throw new SignatureError('signature entry needs string "protected" and "signature" members', 'malformed');
      }
      const header = parseHeader(sig.protected);
      const key = keys.get(header.kid);
      if (!key) {
        throw new SignatureError(`no key with kid ${header.kid} in the key set`, 'unknown-kid');
      }
      if (key.kty !== 'OKP' || key.crv !== SIGNATURE_CRV) {
        throw new SignatureError(`key ${header.kid} is not an OKP/${SIGNATURE_CRV} key`, 'bad-key');
      }
      // A key must answer to its own thumbprint, or `kid` is just a label an
      // attacker chooses.
      const thumb = jwkThumbprint(key);
      if (thumb !== header.kid) {
        throw new SignatureError(`kid ${header.kid} does not match the key's thumbprint ${thumb}`, 'kid-mismatch');
      }
      if (header.iat > now + skewSeconds) {
        throw new SignatureError(`iat ${header.iat} is more than ${skewSeconds}s in the future`, 'iat-future');
      }

      const input = Buffer.from(`${sig.protected}.${payloadB64}`, 'ascii');
      const ok = edVerify(null, input, keyObjectFromJwk(key, 'public'), unb64u(sig.signature));
      if (!ok) throw new SignatureError('signature does not verify over the canonical manifest', 'invalid');

      results.push({ valid: true, kid: header.kid, iat: header.iat });
    } catch (err) {
      if (!(err instanceof SignatureError)) throw err;
      results.push({ valid: false, code: err.code, reason: err.message });
    }
  }

  return { signed: true, verified: results.some((r) => r.valid), results };
}

/**
 * The DNS TXT record that anchors a key outside the web origin it signs for.
 *
 * Publishing this means a consumer can establish the key without trusting the
 * web host at all, which matters precisely in the case a signature is supposed
 * to cover: a compromised or substituted server.
 */
export function dnsTxtRecord(publicJwk, host) {
  const kid = publicJwk.kid ?? jwkThumbprint(publicJwk);
  return { name: `_ai-evidence.${host}`, type: 'TXT', value: `v=aem1; k=ed25519; kid=${kid}; p=${publicJwk.x}` };
}

/** Parse a TXT record published per {@link dnsTxtRecord} into a public JWK. */
export function parseDnsTxtRecord(value) {
  const fields = Object.fromEntries(
    String(value).split(';').map((p) => p.trim()).filter(Boolean)
      .map((p) => { const i = p.indexOf('='); return i < 0 ? [p, ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  if (fields.v !== 'aem1') throw new SignatureError(`unsupported TXT record version ${JSON.stringify(fields.v)}`, 'bad-txt');
  if (fields.k !== 'ed25519') throw new SignatureError(`unsupported key type ${JSON.stringify(fields.k)}`, 'bad-txt');
  if (!fields.p) throw new SignatureError('TXT record has no p= public key', 'bad-txt');
  const jwk = { kty: 'OKP', crv: SIGNATURE_CRV, x: fields.p, use: 'sig', alg: SIGNATURE_ALG };
  const thumb = jwkThumbprint(jwk);
  if (fields.kid && fields.kid !== thumb) {
    throw new SignatureError(`TXT record kid ${fields.kid} does not match the key's thumbprint ${thumb}`, 'kid-mismatch');
  }
  return { ...jwk, kid: thumb };
}
