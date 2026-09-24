import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, parseManifest } from '../reference-implementation/validate.js';
import { normalizeText, sha256OfText, containsNormalized, textFragment } from '../reference-implementation/normalize.js';
import { assertFetchable, FetchRefused } from '../reference-implementation/fetch-safe.js';
import { extractText, extractJsonLd, extractBlocks, decodeEntities } from '../reference-implementation/html.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = n => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const check = (n, o = {}) => validateManifest(load(n), { offline: true, ...o });
const codes = r => [...r.errors, ...r.warnings].map(f => f.code);

describe('normalization', () => {
  test('collapses whitespace and applies NFC', () => {
    assert.equal(normalizeText('  a \n\t b  '), 'a b');
    assert.equal(sha256OfText('café'), sha256OfText('café'));
  });
  test('hash is stable across reflowed whitespace', () => {
    assert.equal(sha256OfText('one   two'), sha256OfText('one two'));
  });
  test('hash changes when the text changes', () => {
    assert.notEqual(sha256OfText('one two'), sha256OfText('one three'));
  });
  test('containsNormalized ignores case and spacing', () => {
    assert.ok(containsNormalized('The  QUICK brown fox', 'quick   Brown'));
    assert.ok(!containsNormalized('the quick brown fox', 'lazy dog'));
  });
  test('builds a W3C text fragment', () => {
    assert.match(textFragment('Hello world'), /^#:~:text=Hello%20world$/);
  });
});

describe('schema validation', () => {
  test('accepts a valid manifest', async () => {
    const r = await check('valid.json');
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });
  test('rejects missing required fields', async () => {
    const r = await check('missing-required.json');
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.code === 'schema'));
  });
  test('rejects a missing manifest header', async () => {
    assert.equal((await check('missing-manifest-header.json')).valid, false);
  });
  test('rejects http:// evidence URLs', async () => {
    assert.equal((await check('invalid-url-http.json')).valid, false);
  });
  test('rejects javascript: URLs', async () => {
    assert.equal((await check('invalid-url-javascript.json')).valid, false);
  });
  test('rejects malformed dates', async () => {
    assert.equal((await check('malformed-date.json')).valid, false);
  });
  test('rejects unknown claim types', async () => {
    assert.equal((await check('unknown-type.json')).valid, false);
  });
  test('rejects unknown fields (additionalProperties: false)', async () => {
    assert.equal((await check('unknown-field.json')).valid, false);
  });
  test('rejects malformed ids', async () => {
    assert.equal((await check('bad-id-format.json')).valid, false);
  });
  test('rejects a malformed hash', async () => {
    assert.equal((await check('hash-malformed.json')).valid, false);
  });
  test('rejects an empty claims array', async () => {
    assert.equal((await check('no-claims.json')).valid, false);
  });
  test('rejects a non-semver version', async () => {
    assert.equal((await check('version-not-semver.json')).valid, false);
  });
  test('rejects an unsupported major version', async () => {
    const r = await check('bad-version.json');
    assert.equal(r.valid, false);
    assert.ok(codes(r).includes('version'));
  });
});

describe('semantic checks', () => {
  test('detects duplicate ids', async () => {
    const r = await check('duplicate-ids.json');
    assert.equal(r.valid, false);
    assert.ok(codes(r).includes('duplicate-id'));
  });
  test('detects a hash that does not match its text', async () => {
    const r = await check('hash-mismatch.json');
    assert.equal(r.valid, false);
    assert.ok(codes(r).includes('integrity-mismatch'));
  });
  test('warns about stale evidence', async () => {
    assert.ok(codes(await check('stale.json')).includes('stale'));
  });
  test('warns when integrity is absent', async () => {
    assert.ok(codes(await check('no-integrity.json')).includes('no-integrity'));
  });
  test('rejects machine extraction claiming to be verified', async () => {
    // verified:true with automatically-generated is contradictory. It used to
    // be a warning; the schema now forbids it, so the two fields cannot
    // disagree in a valid document.
    const r = await check('auto-verified.json');
    assert.equal(r.valid, false);
    assert.ok(codes(r).includes('schema'));
  });
  test('warns on selector-only locators', async () => {
    assert.ok(codes(await check('selector-only.json')).includes('selector-only'));
  });
  test('warns when first-party evidence is cross-origin', async () => {
    assert.ok(codes(await check('cross-origin-first-party.json')).includes('cross-origin-first-party'));
  });
  test('warns on an oversized manifest', async () => {
    assert.ok(codes(await check('oversized.json')).includes('size'));
  });
  test('strict mode turns warnings into failure', async () => {
    assert.equal((await check('stale.json', { strict: false })).valid, true);
    assert.equal((await check('stale.json', { strict: true })).valid, false);
  });
});

describe('malformed input', () => {
  test('reports malformed JSON without throwing raw', () => {
    assert.throws(() => parseManifest(fs.readFileSync(path.join(FIX, 'malformed.json'), 'utf8')), /not valid JSON/);
  });
});

describe('unicode and multilingual content', () => {
  test('accepts multilingual claims and hashes them consistently', async () => {
    const r = await check('unicode.json');
    assert.equal(r.valid, true, JSON.stringify(r.errors));
    const ev = load('unicode.json').claims[0].evidence[0];
    assert.equal(ev.integrity.sha256, sha256OfText(ev.text));
  });
});

describe('XSS payloads are inert data', () => {
  test('a script payload validates as text and is never markup', async () => {
    const r = await check('xss-payload.json');
    assert.equal(r.valid, true, JSON.stringify(r.errors));
    const m = load('xss-payload.json');
    assert.ok(m.claims[0].claim.includes('<script>'));
    // it survives a JSON round-trip unchanged: the format stores, it does not render
    assert.equal(JSON.parse(JSON.stringify(m)).claims[0].claim, m.claims[0].claim);
  });
});

describe('SSRF protections', () => {
  const blocked = [
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['loopback v4', 'https://127.0.0.1/admin'],
    ['loopback v6', 'https://[::1]/admin'],
    ['private 10/8', 'https://10.0.0.1/internal'],
    ['private 192.168', 'https://192.168.1.1/'],
    ['private 172.16', 'https://172.16.0.1/'],
    ['CGNAT', 'https://100.64.0.1/'],
    ['localhost', 'https://localhost/'],
    ['.internal', 'https://vault.internal/'],
    ['ipv4-mapped v6', 'https://[::ffff:127.0.0.1]/'],
    ['plaintext http', 'http://example.com/'],
    ['url credentials', 'https://user:pass@example.com/']
  ];
  for (const [label, url] of blocked) {
    test(`refuses ${label}`, async () => {
      await assert.rejects(() => assertFetchable(url, { resolve: false }), e => e instanceof FetchRefused);
    });
  }
  test('allows an ordinary public https URL', async () => {
    const u = await assertFetchable('https://example.com/page', { resolve: false });
    assert.equal(u.hostname, 'example.com');
  });
  test('fixtures pointing at internal addresses still parse but are refused on fetch', async () => {
    for (const f of ['ssrf-metadata.json', 'ssrf-loopback.json', 'ssrf-private.json']) {
      assert.equal((await check(f)).valid, true);   // structurally fine
      const url = load(f).claims[0].evidence[0].url;
      await assert.rejects(() => assertFetchable(url, { resolve: false }));  // refused at fetch time
    }
  });
});

describe('html reading never executes or leaks scripts', () => {
  const html = `<html><head><title>T</title>
    <script>var x = "LEAK";</script><style>.a{content:"LEAK"}</style>
    <script type="application/ld+json">{"@type":"Organization","name":"Example"}</script></head>
    <body><noscript>LEAK</noscript><section id="s"><p>Visible &amp; safe.</p></section></body></html>`;
  test('script, style and noscript content never reaches extracted text', () => {
    const t = extractText(html);
    assert.ok(!t.includes('LEAK'), t);
    assert.ok(t.includes('Visible & safe.'));
  });
  test('reads JSON-LD without evaluating it', () => {
    assert.equal(extractJsonLd(html)[0].name, 'Example');
  });
  test('ignores malformed JSON-LD rather than guessing', () => {
    assert.equal(extractJsonLd('<script type="application/ld+json">{oops</script>').length, 0);
  });
  test('resolves the nearest section id for a block', () => {
    assert.equal(extractBlocks(html)[0].section, 's');
  });
  test('decodes entities without introducing markup', () => {
    assert.equal(decodeEntities('&lt;b&gt;'), '<b>');
  });
});

describe('published examples stay valid', () => {
  for (const f of ['ai.json', 'minimal.json']) {
    test(`examples/${f} validates in strict mode`, async () => {
      const raw = fs.readFileSync(path.join(FIX, '..', '..', 'examples', f), 'utf8');
      const { manifest, bytes } = parseManifest(raw);
      const r = await validateManifest(manifest, { offline: true, strict: true, rawBytes: bytes });
      assert.equal(r.valid, true, JSON.stringify(r.findings, null, 1));
    });
  }
});
