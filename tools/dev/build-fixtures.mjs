import fs from 'node:fs';
import { sha256OfText } from '../../reference-implementation/normalize.js';
const dir = new URL('../../tests/fixtures/', import.meta.url);
const w = (name, obj) => fs.writeFileSync(new URL(name, dir), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n');

const good = (text = 'Our research program develops autonomous AI systems.') => ({
  url: 'https://example.com/research', text,
  integrity: { sha256: sha256OfText(text) },
  source_type: 'first-party', authority: 'publisher',
  verification: { verified: true, verified_at: '2026-09-24', method: 'publisher-confirmed' }
});
const base = (claims) => ({ manifest: { version: '1.0.0', site: 'https://example.com' }, claims });
const claim = (over = {}) => ({ id: 'capability-autonomous-ai', type: 'capability', claim: 'The company develops autonomous AI systems.', evidence: [good()], ...over });

w('valid.json', base([claim()]));
w('missing-required.json', { manifest: { version: '1.0.0', site: 'https://example.com' }, claims: [{ id: 'x', type: 'capability' }] });
w('missing-manifest-header.json', { claims: [claim()] });
w('invalid-url-http.json', base([claim({ evidence: [{ ...good(), url: 'http://example.com/research' }] })]));
w('invalid-url-javascript.json', base([claim({ evidence: [{ ...good(), url: 'javascript:alert(1)' }] })]));
w('malformed-date.json', base([claim({ evidence: [{ ...good(), published_at: '24-09-2026' }] })]));
w('duplicate-ids.json', base([claim(), claim({ claim: 'A different claim entirely.' })]));
w('bad-id-format.json', base([claim({ id: 'Capability With Spaces' })]));
w('unknown-type.json', base([claim({ type: 'made-up-type' })]));
w('unknown-field.json', base([claim({ colour: 'blue' })]));
w('hash-mismatch.json', base([claim({ evidence: [{ ...good(), integrity: { sha256: 'b'.repeat(64) } }] })]));
w('hash-malformed.json', base([claim({ evidence: [{ ...good(), integrity: { sha256: 'not-a-hash' } }] })]));
w('stale.json', base([claim({ evidence: [{ ...good(), verification: { verified: true, verified_at: '2015-01-01', method: 'publisher-confirmed' } }] })]));
w('no-integrity.json', base([claim({ evidence: [{ url: 'https://example.com/research', text: 'Plain text.', source_type: 'first-party' }] })]));
w('auto-verified.json', base([claim({ evidence: [{ ...good(), verification: { verified: true, verified_at: '2026-09-24', method: 'automatically-generated' } }] })]));
w('selector-only.json', base([claim({ evidence: [{ ...good(), locator: { selector: 'body > div:nth-child(3) > p' } }] })]));
w('cross-origin-first-party.json', base([claim({ evidence: [{ ...good(), url: 'https://elsewhere.example.net/page' }] })]));
w('no-claims.json', { manifest: { version: '1.0.0', site: 'https://example.com' }, claims: [] });
w('bad-version.json', base([claim()]));
const bv = JSON.parse(fs.readFileSync(new URL('bad-version.json', dir))); bv.manifest.version = '9.0.0'; w('bad-version.json', bv);
w('version-not-semver.json', { manifest: { version: '1.0', site: 'https://example.com' }, claims: [claim()] });

// XSS payloads must survive as inert text: the format stores strings, never markup to render.
const xss = '<script>alert("xss")</script> and <img src=x onerror=alert(1)>';
w('xss-payload.json', base([claim({ claim: xss, evidence: [good(xss)] })]));

// Unicode + multilingual
const uni = 'Nous développons des systèmes d’IA autonomes — 我们开发自主人工智能系统 — نطور أنظمة ذكاء اصطناعي مستقلة.';
w('unicode.json', { manifest: { version: '1.0.0', site: 'https://example.com', language: 'fr' },
  claims: [claim({ id: 'capability-multilingue', language: 'fr', claim: uni, evidence: [{ ...good(uni), language: 'fr' }] })] });

// SSRF targets, as evidence URLs
for (const [name, url] of [['ssrf-metadata', 'https://169.254.169.254/latest/meta-data/'], ['ssrf-loopback', 'https://127.0.0.1/admin'], ['ssrf-private', 'https://10.0.0.1/internal']]) {
  w(`${name}.json`, base([claim({ evidence: [{ ...good(), url }] })]));
}

// Oversized: many claims
w('oversized.json', base(Array.from({ length: 1200 }, (_, i) => claim({ id: `capability-${i}`, claim: `Claim number ${i} about the platform.` }))));

// Malformed JSON, and a self-referential extension (JSON cannot hold cycles; the
// closest real-world case is a manifest pointing at itself)
w('malformed.json', '{ "manifest": { "version": "1.0.0", ');
w('self-referential.json', { manifest: { version: '1.0.0', site: 'https://example.com' },
  claims: [claim({ evidence: [{ ...good(), url: 'https://example.com/ai.json' }] })],
  extensions: { includes: ['https://example.com/ai.json'] } });
console.log('fixtures written:', fs.readdirSync(dir).length);
