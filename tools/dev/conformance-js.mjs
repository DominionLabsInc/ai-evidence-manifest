// Emit this implementation's output for the corpus, in a canonical form.
import fs from 'node:fs';
import { candidatesFromHtml, toManifest } from '../../reference-implementation/extract.js';
const index = JSON.parse(fs.readFileSync('tests/conformance/index.json', 'utf8'));
const out = {};
for (const { file, url } of index) {
  const html = fs.readFileSync(`tests/conformance/pages/${file}`, 'utf8');
  for (const mode of ['summaries', 'all']) {
    const r = candidatesFromHtml(html, url, { claims: mode });
    const m = toManifest(new URL(url).origin, r.candidates);
    // generated_at is a timestamp; everything else must match exactly
    delete m.manifest.generated_at;
    delete m.manifest.generator;
    for (const c of m.claims) for (const e of c.evidence) delete e.verification.verified_at;
    out[`${file}::${mode}`] = m;
  }
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
