// Saves real pages as fixtures so both implementations can be run against
// identical bytes, offline and repeatably.
import { fetchSafe } from '../../reference-implementation/fetch-safe.js';
import fs from 'node:fs';
const urls = [
  'https://dmnlabs.org/',
  'https://dmnlabs.org/research',
  'https://dmnlabs.org/privacy',
  'https://dmnlabs.org/research/unified-substrate/',
  'https://dmnlabs.org/research/structure-before-meaning/',
  'https://example.com/'
];
const index = [];
for (const u of urls) {
  const r = await fetchSafe(u, { accept: 'text/html' });
  const name = (new URL(u).hostname + new URL(u).pathname).replace(/[^a-z0-9]+/gi, '_').replace(/_+$/, '') + '.html';
  fs.writeFileSync(`tests/conformance/pages/${name}`, r.body);
  index.push({ file: name, url: u });
  console.log(`  ${String(Math.round(r.bytes / 1024)).padStart(4)} KiB  ${name}`);
}
fs.writeFileSync('tests/conformance/index.json', JSON.stringify(index, null, 2) + '\n');
