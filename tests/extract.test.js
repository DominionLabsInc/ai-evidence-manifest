import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { candidatesFromHtml, toManifest } from '../reference-implementation/extract.js';
import { validateManifest } from '../reference-implementation/validate.js';
import { sha256OfText } from '../reference-implementation/normalize.js';

const page = (body, head = '') =>
  `<!doctype html><html><head><title>Acme</title>${head}</head><body>${body}</body></html>`;

const URL_ = 'https://acme.example/about';
const run = (html, opts) => candidatesFromHtml(html, URL_, { claims: 'all', ...opts }).candidates;
// A claim may now stand over several quotes; flatten for assertions about evidence.
const ev = (html, opts) => run(html, opts).flatMap(c => c.evidence);

describe('extraction safety invariant', () => {
  test('never emits text that is not in the page', () => {
    const html = page(
      '<section id="s"><p>Acme is an independent robotics company based in Leeds.</p></section>',
      '<script type="application/ld+json">{"@type":"Organization","name":"Acme","description":"A sentence that appears nowhere on the page."}</script>'
    );
    const out = run(html);
    assert.ok(out.length > 0);
    assert.ok(!ev(html).some(e => e.text.includes('appears nowhere')));
  });

  test('uses a declared description when the page really shows it', () => {
    const shown = 'Acme builds autonomous warehouse systems.';
    const html = page(
      `<p>${shown}</p>`,
      `<script type="application/ld+json">{"@type":"Organization","name":"Acme","description":"${shown}"}</script>`
    );
    assert.ok(ev(html).some(e => e.text === shown));
  });

  test('ignores script and style content entirely', () => {
    const html = page(
      '<p>Acme is an independent robotics company based in Leeds.</p>' +
      '<script>var s = "We build secret weapons for undisclosed clients.";</script>' +
      '<style>.a::after{content:"We provide covert services to anonymous buyers."}</style>'
    );
    assert.ok(!ev(html).some(e => /secret weapons|covert services/.test(e.text)));
  });

  test('every emitted record hashes to its own text', () => {
    const html = page('<p>Acme is an independent robotics company based in Leeds.</p><p>We build autonomous warehouse systems for regulated industries.</p>');
    for (const e of ev(html)) {
      assert.equal(e.integrity.sha256, sha256OfText(e.text));
    }
  });

  test('marks everything as automatically-generated and unverified', () => {
    const html = page('<p>Acme is an independent robotics company based in Leeds.</p>');
    for (const e of ev(html)) {
      assert.equal(e.verification.method, 'automatically-generated');
      assert.equal(e.verification.verified, false);
    }
  });

  test('builds a locator that is not selector-only', () => {
    const html = page('<section id="about"><p>Acme is an independent robotics company based in Leeds.</p></section>');
    for (const e of ev(html)) {
      assert.ok(e.locator.fragment || e.locator.section);
      assert.equal(e.locator.selector, undefined);
    }
  });

  test('does not duplicate the same sentence', () => {
    const s = 'Acme is an independent robotics company based in Leeds.';
    assert.equal(ev(page(`<p>${s}</p><p>${s}</p>`)).filter(e => e.text === s).length, 1);
  });

  test('respects the per-page cap', () => {
    const body = Array.from({ length: 30 }, (_, i) =>
      `<p>We build autonomous warehouse system number ${i} for regulated industries.</p>`).join('');
    assert.ok(run(page(body), { maxCandidatesPerPage: 5 }).length <= 5);
  });

  test('skips sentences outside the length bounds', () => {
    const tooShort = 'We build.';
    const tooLong = 'We build ' + 'extremely '.repeat(80) + 'large systems.';
    assert.ok(!ev(page(`<p>${tooShort}</p><p>${tooLong}</p>`)).some(e => e.text === tooShort || e.text === tooLong));
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

describe('sentence boundaries', () => {
  const only = html => candidatesFromHtml(html, URL_, { claims: 'all' }).candidates.flatMap(c => c.evidence).map(e => e.text);
  test('a company suffix does not end a sentence', () => {
    const t = only('<body><p>This Privacy Policy explains how Dominion Labs Inc. collects and uses your personal information today.</p></body>');
    assert.ok(t.some(x => x.includes('Inc. collects')), JSON.stringify(t));
    assert.ok(!t.some(x => x.trim().endsWith('Dominion Labs Inc.')), JSON.stringify(t));
  });
  test('an initial does not end a sentence', () => {
    const t = only('<body><p>The policy was written by Stefan R. Ragland and reviewed by our counsel in Miami.</p></body>');
    assert.ok(!t.some(x => x.trim().endsWith('Stefan R.')), JSON.stringify(t));
  });
  test('real sentence boundaries still split', () => {
    const t = only('<body><p>We do not sell personal information for money. We never share it with data brokers either.</p></body>');
    assert.ok(t.some(x => x === 'We do not sell personal information for money.'), JSON.stringify(t));
  });
});
