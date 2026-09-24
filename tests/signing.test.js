import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalize, CanonicalizationError } from '../reference-implementation/canonical.js';
import {
  generateKeyPair, signManifest, verifyManifest, buildJwks, jwkThumbprint,
  dnsTxtRecord, parseDnsTxtRecord, signingPayload, SignatureError,
} from '../reference-implementation/jws.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const b64u = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

describe('canonical JSON', () => {
  const { vectors } = read('tests/conformance/canonical/vectors.json');

  for (const v of vectors) {
    test(v.name, () => assert.equal(canonicalize(v.input), v.expected));
  }

  test('refuses values whose canonical form is not portable', () => {
    // Each of these would canonicalize differently, or not at all, in the
    // Python implementation. Refusing at signing time beats a signature that
    // fails to verify in someone else's stack.
    for (const bad of [1.5, -0.5, 1e21, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      assert.throws(() => canonicalize(bad), CanonicalizationError, `accepted ${bad}`);
    }
    assert.throws(() => canonicalize('\ud800'), CanonicalizationError, 'accepted a lone surrogate');
    assert.throws(() => canonicalize(undefined), CanonicalizationError);
  });

  test('member order in the source does not change the output', () => {
    assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
  });
});

describe('key handling', () => {
  test('the kid is the key thumbprint, so a key cannot be published under a borrowed name', () => {
    const kp = generateKeyPair();
    assert.equal(kp.kid, jwkThumbprint(kp.publicJwk));
    assert.equal(kp.kid, jwkThumbprint(kp.privateJwk));
  });

  test('thumbprints are computed over the required members only (RFC 7638)', () => {
    const kp = generateKeyPair();
    const noisy = { ...kp.publicJwk, ext: true, key_ops: ['verify'] };
    assert.equal(jwkThumbprint(noisy), kp.kid);
  });

  test('a JWKS carries no private material', () => {
    const kp = generateKeyPair();
    const jwks = buildJwks([kp.publicJwk]);
    assert.ok(!JSON.stringify(jwks).includes(kp.privateJwk.d));
    assert.ok(!('d' in jwks.keys[0]));
  });

  test('the DNS record round-trips, and a relabelled one is refused', () => {
    const kp = generateKeyPair();
    const rec = dnsTxtRecord(kp.publicJwk, 'example.com');
    assert.equal(rec.name, '_ai-evidence.example.com');
    assert.equal(parseDnsTxtRecord(rec.value).kid, kp.kid);
    const relabelled = rec.value.replace(kp.kid, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    assert.throws(() => parseDnsTxtRecord(relabelled), /thumbprint/);
    assert.throws(() => parseDnsTxtRecord('v=aem2; k=ed25519; p=x'), /version/);
  });
});

describe('signing', () => {
  const manifest = read('examples/ai.json');

  test('a signature made here verifies here', () => {
    const kp = generateKeyPair();
    const signed = signManifest(manifest, kp.privateJwk);
    const r = verifyManifest(signed, buildJwks([kp.publicJwk]));
    assert.equal(r.verified, true);
    assert.equal(r.results[0].kid, kp.kid);
  });

  test('re-serializing the document does not break the signature', () => {
    // This is the reason the payload is canonical JSON rather than the bytes as
    // served: an agent that stores a manifest and hands it on re-serializes it.
    const kp = generateKeyPair();
    const signed = signManifest(manifest, kp.privateJwk);
    const roundTripped = JSON.parse(JSON.stringify(signed, null, 4));
    const reordered = Object.fromEntries(Object.entries(roundTripped).reverse());
    assert.equal(verifyManifest(reordered, buildJwks([kp.publicJwk])).verified, true);
  });

  test('changing any covered byte invalidates it', () => {
    const kp = generateKeyPair();
    const jwks = buildJwks([kp.publicJwk]);
    const signed = signManifest(manifest, kp.privateJwk);

    const mutations = {
      'claim text': (m) => { m.claims[0].claim = 'A different claim.'; },
      'evidence quote': (m) => { m.claims[0].evidence[0].text += ' '; },
      'evidence url': (m) => { m.claims[0].evidence[0].url = 'https://evil.example/'; },
      'manifest site': (m) => { m.manifest.site = 'https://evil.example'; },
      'integrity hash': (m) => { m.claims[0].evidence[0].integrity.sha256 = 'f'.repeat(64); },
      'an added claim': (m) => { m.claims.push(JSON.parse(JSON.stringify(m.claims[0]))); },
      'a removed claim': (m) => { m.claims.pop(); },
      'an added member': (m) => { m.publisher = { ...m.publisher, injected: true }; },
    };
    for (const [what, mutate] of Object.entries(mutations)) {
      const copy = JSON.parse(JSON.stringify(signed));
      mutate(copy);
      const r = verifyManifest(copy, jwks);
      assert.equal(r.verified, false, `tampering with ${what} went undetected`);
      assert.equal(r.results[0].code, 'invalid');
    }
  });

  test('the signatures member itself is outside the payload, so signers can be added', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const signed = signManifest(signManifest(manifest, a.privateJwk), b.privateJwk);
    assert.equal(signed.signatures.length, 2);
    const r = verifyManifest(signed, buildJwks([a.publicJwk, b.publicJwk]));
    assert.equal(r.results.filter((x) => x.valid).length, 2);
  });

  test('a signature is judged only against the key set supplied', () => {
    const mine = generateKeyPair();
    const theirs = generateKeyPair();
    const signed = signManifest(manifest, mine.privateJwk);
    const r = verifyManifest(signed, buildJwks([theirs.publicJwk]));
    assert.equal(r.verified, false);
    assert.equal(r.results[0].code, 'unknown-kid');
  });

  test('refuses to sign a document it cannot canonicalize', () => {
    const kp = generateKeyPair();
    const bad = { ...manifest, extensions: { 'vendor.example': { ratio: 0.5 } } };
    assert.throws(() => signManifest(bad, kp.privateJwk), CanonicalizationError);
  });

  test('refuses a key that is not Ed25519', () => {
    assert.throws(() => signManifest(manifest, { kty: 'EC', crv: 'P-256', d: 'x' }), SignatureError);
  });
});

describe('signature forgery attempts', () => {
  const manifest = read('examples/minimal.json');
  const kp = generateKeyPair();
  const jwks = buildJwks([kp.publicJwk]);
  const signed = signManifest(manifest, kp.privateJwk);
  const header = () => JSON.parse(Buffer.from(signed.signatures[0].protected, 'base64url').toString('utf8'));
  const withHeader = (h) => ({ ...manifest, signatures: [{ protected: b64u(h), signature: signed.signatures[0].signature }] });
  const codeOf = (doc, opts) => verifyManifest(doc, jwks, opts).results[0].code;

  test('rejects alg: none', () => {
    assert.equal(codeOf(withHeader({ ...header(), alg: 'none' })), 'bad-alg');
  });

  test('rejects a substituted algorithm', () => {
    for (const alg of ['HS256', 'RS256', 'ES256', 'EdDSA ']) {
      assert.equal(codeOf(withHeader({ ...header(), alg })), 'bad-alg', `accepted alg ${alg}`);
    }
  });

  test('rejects a signature minted for another protocol', () => {
    assert.equal(codeOf(withHeader({ ...header(), typ: 'JWT' })), 'bad-typ');
  });

  test('rejects unknown or missing header parameters rather than ignoring them', () => {
    assert.equal(codeOf(withHeader({ ...header(), extra: 1 })), 'bad-header');
    const { kid, ...noKid } = header();
    assert.equal(codeOf(withHeader(noKid)), 'bad-header');
  });

  test('rejects a key relabelled with someone else’s kid', () => {
    // An attacker who can serve the JWKS puts their own key under the honest
    // kid. The thumbprint check is what stops it.
    const attacker = generateKeyPair();
    const swapped = { keys: [{ ...attacker.publicJwk, kid: kp.kid }] };
    assert.equal(verifyManifest(signed, swapped).results[0].code, 'kid-mismatch');
  });

  test('rejects a signing time in the future', () => {
    const early = verifyManifest(signed, jwks, { now: header().iat - 3600 });
    assert.equal(early.results[0].code, 'iat-future');
    // ...but tolerates ordinary clock skew.
    assert.equal(verifyManifest(signed, jwks, { now: header().iat - 60 }).verified, true);
  });

  test('rejects malformed entries without throwing', () => {
    for (const bad of [{}, { protected: 1, signature: 'x' }, { protected: '!!', signature: 'x' }, null]) {
      const r = verifyManifest({ ...manifest, signatures: [bad] }, jwks);
      assert.equal(r.verified, false);
    }
  });

  test('an unsigned manifest is reported as unsigned, not as verified', () => {
    const r = verifyManifest(manifest, jwks);
    assert.equal(r.signed, false);
    assert.equal(r.verified, false);
  });
});

describe('cross-implementation conformance', () => {
  const dir = 'tests/conformance/signing';
  const manifest = read(`${dir}/manifest.json`);
  const expected = read(`${dir}/expected.json`);
  const key = read(`${dir}/key.json`);
  const jwks = read(`${dir}/jwks.json`);

  test('canonical form matches the recorded hash', () => {
    const canon = canonicalize(manifest);
    assert.equal(Buffer.byteLength(canon, 'utf8'), expected.canonical_bytes);
    assert.equal(createHash('sha256').update(canon, 'utf8').digest('hex'), expected.canonical_sha256);
  });

  test('the signature reproduces byte for byte', () => {
    // Ed25519 is deterministic. Identical bytes here mean canonicalization, the
    // protected header and the signing input all agree across implementations;
    // any divergence shows up as a different signature rather than silently.
    const signed = signManifest(manifest, key, { iat: expected.iat });
    assert.deepEqual(signed.signatures[0], expected.signature);
  });

  test('the recorded signature verifies against the recorded key set', () => {
    const doc = { ...manifest, signatures: [expected.signature] };
    assert.equal(verifyManifest(doc, jwks, { now: expected.iat + 10 }).verified, true);
  });

  test('the payload excludes the signatures member', () => {
    const doc = { ...manifest, signatures: [expected.signature] };
    assert.deepEqual(signingPayload(doc), signingPayload(manifest));
  });
});

describe('version compatibility', () => {
  test('a 2.0.0 document is still valid under 2.1.0 tooling', async () => {
    // SPEC 11.1 claims 2.1.0 is a minor version. The fixtures are all written
    // at 2.0.0 on purpose, so that claim is tested rather than asserted.
    const { validateManifest } = await import('../reference-implementation/validate.js');
    const doc = read('tests/fixtures/valid.json');
    assert.equal(doc.manifest.version, '2.0.0');
    assert.equal((await validateManifest(doc, { offline: true, strict: true })).valid, true);
  });

  test('an unsigned manifest is not rejected for being unsigned', async () => {
    const { validateManifest } = await import('../reference-implementation/validate.js');
    const r = await validateManifest(read('examples/minimal.json'), { offline: true });
    assert.equal(r.valid, true);
  });
});
