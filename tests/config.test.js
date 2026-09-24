import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, writeConfig, CONFIG_DEFAULTS } from '../reference-implementation/config.js';
import { normalizeInputUrl, FetchRefused } from '../reference-implementation/fetch-safe.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aem-'));
const write = (dir, obj) => {
  const f = path.join(dir, 'c.json');
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return f;
};

describe('url normalization', () => {
  test('accepts a bare domain', () => assert.equal(normalizeInputUrl('example.com'), 'https://example.com/'));
  test('upgrades http to https', () => assert.equal(normalizeInputUrl('http://example.com'), 'https://example.com/'));
  test('trims surrounding whitespace', () => assert.equal(normalizeInputUrl('  example.com  '), 'https://example.com/'));
  test('keeps a path', () => assert.equal(normalizeInputUrl('example.com/about'), 'https://example.com/about'));
  test('rejects empty input', () => assert.throws(() => normalizeInputUrl('  '), e => e instanceof FetchRefused));
});

describe('config loading', () => {
  test('applies defaults', () => {
    const f = write(tmp(), { site: 'example.com' });
    const c = loadConfig(f);
    assert.equal(c.site, 'https://example.com/');
    assert.equal(c.discover, CONFIG_DEFAULTS.discover);
    assert.deepEqual(c.pin, []);
  });
  test('requires a site', () => {
    const f = write(tmp(), { discover: 'sitemap' });
    assert.throws(() => loadConfig(f), /must have a "site"/);
  });
  test('rejects an unknown discover mode', () => {
    const f = write(tmp(), { site: 'example.com', discover: 'telepathy' });
    assert.throws(() => loadConfig(f), /discover/);
  });
  test('rejects a non-array exclude', () => {
    const f = write(tmp(), { site: 'example.com', exclude: '/privacy' });
    assert.throws(() => loadConfig(f), /must be an array/);
  });
  test('reports malformed JSON clearly', () => {
    const f = write(tmp(), '{ "site": ');
    assert.throws(() => loadConfig(f), /not valid JSON/);
  });
  test('explains a missing config rather than throwing ENOENT', () => {
    assert.throws(() => loadConfig(path.join(tmp(), 'absent.json')), /ai-evidence init/);
  });
  test('round-trips through writeConfig', () => {
    const dir = tmp();
    const f = path.join(dir, 'c.json');
    writeConfig({ ...CONFIG_DEFAULTS, site: 'https://example.com/' }, f);
    assert.equal(loadConfig(f).site, 'https://example.com/');
  });
});
