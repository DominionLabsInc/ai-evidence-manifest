import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { candidatesFromHtml, toManifest } from '../reference-implementation/extract.js';
import { validateManifest } from '../reference-implementation/validate.js';
import { sha256OfText } from '../reference-implementation/normalize.js';

const page = (body, head = '') =>
  `<!doctype html><html><head><title>Acme</title>${head}</head><body>${body}</body></html>`;

const URL_ = 'https://acme.example/about';
const run = (html, opts) => candidatesFromHtml(html, URL_, opts).candidates;

describe('extraction safety invariant', () => {
  test('never emits text that is not in the page', () => {
    const html = page(
      '<section id="s"><p>Acme is an independent robotics company based in Leeds.</p></section>',
      '<script type="application/ld+json">{"@type":"Organization","name":"Acme","description":"A sentence that appears nowhere on the page."}</script>'
    );
    const out = run(html);
    assert.ok(out.length > 0);
    assert.ok(!out.some(c => c.evidence.text.includes('appears nowhere')));
  });

  test('uses a declared description when the page really shows it', () => {
    const shown = 'Acme builds autonomous warehouse systems.';
    const html = page(
      `<p>${shown}</p>`,
      `<script type="application/ld+json">{"@type":"Organization","name":"Acme","description":"${shown}"}</script>`
    );
    assert.ok(run(html).some(c => c.tier === 1 && c.evidence.text === shown));
  });

  test('ignores script and style content entirely', () => {
    const html = page(
      '<p>Acme is an independent robotics company based in Leeds.</p>' +
      '<script>var s = "We build secret weapons for undisclosed clients.";</script>' +
      '<style>.a::after{content:"We provide covert services to anonymous buyers."}</style>'
    );
    const out = run(html);
    assert.ok(!out.some(c => /secret weapons|covert services/.test(c.evidence.text)));
  });

  test('every emitted record hashes to its own text', () => {
    const html = page('<p>Acme is an independent robotics company based in Leeds.</p><p>We build autonomous warehouse systems for regulated industries.</p>');
    for (const c of run(html)) {
      assert.equal(c.evidence.integrity.sha256, sha256OfText(c.evidence.text));
    }
  });

  test('marks everything as automatically-generated and unverified', () => {
    const html = page('<p>Acme is an independent robotics company based in Leeds.</p>');
    for (const c of run(html)) {
      assert.equal(c.evidence.verification.method, 'automatically-generated');
      assert.equal(c.evidence.verification.verified, false);
    }
  });

  test('builds a locator that is not selector-only', () => {
    const html = page('<section id="about"><p>Acme is an independent robotics company based in Leeds.</p></section>');
    for (const c of run(html)) {
      assert.ok(c.evidence.locator.fragment || c.evidence.locator.section);
      assert.equal(c.evidence.locator.selector, undefined);
    }
  });

  test('does not duplicate the same sentence', () => {
    const s = 'Acme is an independent robotics company based in Leeds.';
    const out = run(page(`<p>${s}</p><p>${s}</p>`));
    assert.equal(out.filter(c => c.evidence.text === s).length, 1);
  });

  test('respects the per-page cap', () => {
    const body = Array.from({ length: 30 }, (_, i) =>
      `<p>We build autonomous warehouse system number ${i} for regulated industries.</p>`).join('');
    assert.ok(run(page(body), { maxCandidatesPerPage: 5 }).length <= 5);
  });

  test('skips sentences outside the length bounds', () => {
    const tooShort = 'We build.';
    const tooLong = 'We build ' + 'extremely '.repeat(80) + 'large systems.';
    const out = run(page(`<p>${tooShort}</p><p>${tooLong}</p>`));
    assert.ok(!out.some(c => c.evidence.text === tooShort || c.evidence.text === tooLong));
  });
});

describe('assembled manifests are valid', () => {
  test('extractor output passes the validator', async () => {
    const html = page(
      '<section id="about"><p>Acme is an independent robotics company based in Leeds.</p>' +
      '<p>We build autonomous warehouse systems for regulated industries.</p>' +
      '<p>Acme completed a SOC 2 Type II audit covering security and availability.</p></section>'
    );
    const manifest = toManifest('https://acme.example', run(html));
    const r = await validateManifest(manifest, { offline: true });
    assert.equal(r.valid, true, JSON.stringify(r.errors, null, 1));
    assert.ok(manifest.claims.length >= 3);
  });

  test('ids are unique even when claims are near-identical', () => {
    const body = Array.from({ length: 5 }, () =>
      '<p>We build autonomous warehouse systems for regulated industries today.</p>').join('');
    const manifest = toManifest('https://acme.example', [
      ...run(page(body)),
      ...run(page(body))
    ]);
    const ids = manifest.claims.map(c => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
