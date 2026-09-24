import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { candidatesFromHtml, toManifest } from '../reference-implementation/extract.js';

/**
 * Two implementations of the same format will drift unless something checks.
 * These run both against identical bytes and require identical output.
 *
 * The Python half is skipped when its virtualenv is absent, so a plain
 * `npm test` still works for contributors who only touch JavaScript.
 */
const ROOT = path.join(import.meta.dirname, '..');
const INDEX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/conformance/index.json'), 'utf8'));
const PY = path.join(ROOT, 'python/.venv/bin/python');

function jsOutput() {
  const out = {};
  for (const { file, url } of INDEX) {
    const html = fs.readFileSync(path.join(ROOT, 'tests/conformance/pages', file), 'utf8');
    for (const mode of ['summaries', 'all']) {
      const m = toManifest(new URL(url).origin, candidatesFromHtml(html, url, { claims: mode }).candidates);
      delete m.manifest.generated_at;
      delete m.manifest.generator;
      for (const c of m.claims) for (const e of c.evidence) delete e.verification.verified_at;
      out[`${file}::${mode}`] = m;
    }
  }
  return out;
}

describe('shared artifacts have not drifted', () => {
  // The Python package bundles copies so it works when installed from a wheel,
  // with no repository present. Copies go stale silently — this one did, and a
  // schema change shipped to one implementation and not the other.
  const pairs = [
    ['schema/ai-evidence-manifest.schema.json', 'python/ai_evidence/ai-evidence-manifest.schema.json'],
    ['shared/patterns.json', 'python/ai_evidence/patterns.json'],
    // Not bundled for the wheel but for the sdist: without these the sdist
    // cannot build a wheel, because pyproject.toml may not reach above its own
    // root. That failure shipped once, in 0.2.0.
    ['LICENSE', 'python/LICENSE'],
    ['NOTICE', 'python/NOTICE']
  ];
  for (const [source, copy] of pairs) {
    // A missing copy fails rather than skips. Skipping would let the packaging
    // break silently, which is the exact failure this suite exists to catch.
    test(`${copy} matches ${source}`, () => {
      assert.ok(fs.existsSync(path.join(ROOT, copy)), `${copy} is missing — run: npm run sync`);
      assert.equal(
        fs.readFileSync(path.join(ROOT, copy), 'utf8'),
        fs.readFileSync(path.join(ROOT, source), 'utf8'),
        `${copy} is stale — run: npm run sync`
      );
    });
  }
});

describe('cross-implementation conformance', () => {
  const js = jsOutput();

  test('the corpus covers both modes for every page', () => {
    assert.equal(Object.keys(js).length, INDEX.length * 2);
  });

  test('output is deterministic across runs', () => {
    assert.deepEqual(js, jsOutput());
  });

  test('every emitted quote hashes to its own text', async () => {
    const { sha256OfText } = await import('../reference-implementation/normalize.js');
    for (const m of Object.values(js)) {
      for (const c of m.claims) {
        for (const e of c.evidence) assert.equal(e.integrity.sha256, sha256OfText(e.text));
      }
    }
  });

  test('the Python implementation produces identical output', { skip: !fs.existsSync(PY) }, () => {
    const raw = execFileSync(PY, [path.join(ROOT, 'tools/dev/conformance-py.py')], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
    });
    const py = JSON.parse(raw);
    for (const key of Object.keys(js)) {
      assert.deepEqual(py[key], js[key], `implementations disagree on ${key}`);
    }
    assert.deepEqual(Object.keys(py).sort(), Object.keys(js).sort());
  });
});
