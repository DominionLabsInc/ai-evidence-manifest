import fs from 'node:fs';
import path from 'node:path';
import { validateManifest, parseManifest } from '../../reference-implementation/validate.js';
const dir = 'tests/fixtures';
const out = {};
for (const f of fs.readdirSync(dir).sort()) {
  const raw = fs.readFileSync(path.join(dir, f), 'utf8');
  try {
    const { manifest, bytes } = parseManifest(raw);
    const r = await validateManifest(manifest, { offline: true, rawBytes: bytes });
    out[f] = { valid: r.valid, codes: [...new Set(r.findings.map(x => x.code))].sort(), claims: r.stats.claims, evidence: r.stats.evidence };
  } catch (e) { out[f] = { parseError: e.code ?? 'error' }; }
}
process.stdout.write(JSON.stringify(out, null, 2));
