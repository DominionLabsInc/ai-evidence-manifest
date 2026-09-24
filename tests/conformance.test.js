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
