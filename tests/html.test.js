import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, extractTitle, extractMeta, extractJsonLd, extractBlocks, looksClientRendered } from '../reference-implementation/html.js';

describe('markup a regex parser gets wrong', () => {
  test('an attribute containing > does not truncate the text', () => {
    const t = extractText('<body><p title="a>b">Real sentence here.</p></body>');
    assert.equal(t, 'Real sentence here.');
  });
  test('unclosed <p> tags become separate blocks, per HTML5 rules', () => {
    const b = extractBlocks('<body><p>one<p>two<p>three</body>').map(x => x.text);
    assert.deepEqual(b, ['one', 'two', 'three']);
  });
  test('adjacent blocks do not run together', () => {
    const t = extractText('<body><p>First sentence.</p><p>Second sentence.</p></body>');
    assert.equal(t, 'First sentence. Second sentence.');
    assert.ok(!t.includes('sentence.Second'));
  });
  test('list items are separated', () => {
    assert.equal(extractText('<body><ul><li>alpha</li><li>beta</li></ul></body>'), 'alpha beta');
  });
  test('implied tbody/tr structure is handled', () => {
    const b = extractBlocks('<body><table><tr><td>cell one</td><td>cell two</td></tr></table></body>').map(x => x.text);
    assert.deepEqual(b, ['cell one', 'cell two']);
  });
  test('entities are decoded by the parser', () => {
    assert.equal(extractTitle('<html><head><title>T &amp; Co &mdash; x</title></head></html>'), 'T & Co — x');
  });
  test('a comment containing markup is ignored', () => {
    assert.equal(extractText('<body><!-- <p>HIDDEN</p> --><p>visible</p></body>'), 'visible');
  });
});

describe('non-content is never returned', () => {
  const html = `<body>
    <script>var a = "<p>LEAK</p>";</script>
    <style>.x::after{content:"LEAK"}</style>
    <noscript>LEAK</noscript>
    <template><p>LEAK</p></template>
    <svg><text>LEAK</text></svg>
    <p>visible text</p></body>`;
  test('script, style, noscript, template and svg are all skipped', () => {
    const t = extractText(html);
    assert.ok(!t.includes('LEAK'), t);
    assert.ok(t.includes('visible text'));
  });
  test('they do not appear as blocks either', () => {
    assert.ok(!extractBlocks(html).some(b => b.text.includes('LEAK')));
  });
});

describe('structured data', () => {
  test('reads JSON-LD without evaluating it', () => {
    const nodes = extractJsonLd('<script type="application/ld+json">{"@type":"Organization","name":"Example"}</script>');
    assert.equal(nodes[0].name, 'Example');
  });
  test('flattens @graph', () => {
    const nodes = extractJsonLd('<script type="application/ld+json">{"@graph":[{"@type":"Product","name":"P"}]}</script>');
    assert.ok(nodes.some(n => n.name === 'P'));
  });
  test('ignores malformed JSON-LD rather than guessing', () => {
    assert.equal(extractJsonLd('<script type="application/ld+json">{oops</script>').length, 0);
  });
  test('reads name and property meta tags', () => {
    const m = extractMeta('<meta name="description" content="d"><meta property="og:title" content="t">');
    assert.equal(m.description, 'd');
    assert.equal(m['og:title'], 't');
  });
});

describe('section resolution', () => {
  test('finds the nearest sectioning ancestor with an id', () => {
    const b = extractBlocks('<body><section id="outer"><div id="inner"><p>text</p></div></section></body>');
    assert.equal(b[0].section, 'inner');
  });
  test('reports null when no ancestor has an id', () => {
    assert.equal(extractBlocks('<body><div><p>text</p></div></body>')[0].section, null);
  });
});

describe('client-rendered detection', () => {
  test('flags an empty app root with heavy script', () => {
    const r = looksClientRendered(`<body><div id="root"></div><script>${'x'.repeat(5000)}</script></body>`);
    assert.equal(r.likely, true);
    assert.ok(r.reasons.length > 0);
  });
  test('does not flag a server-rendered page, even a script-heavy one', () => {
    const body = '<main><p>' + 'A real sentence about the platform. '.repeat(60) + '</p></main>'
      + Array.from({ length: 20 }, (_, i) => `<script src="/a${i}.js"></script>`).join('');
    assert.equal(looksClientRendered(`<body>${body}</body>`).likely, false);
  });
  test('reports the visible text length either way', () => {
    assert.equal(typeof looksClientRendered('<body><p>hi</p></body>').textLength, 'number');
  });
});
