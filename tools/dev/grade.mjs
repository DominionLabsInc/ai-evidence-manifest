/**
 * Auditable grader for a generated manifest.
 *
 * Any precision figure is meaningless without stated criteria — emitting one
 * claim would score 100%. These rules are deliberately explicit so the number
 * can be argued with, and coverage is always reported alongside precision.
 *
 *   A  a summary the publisher wrote, or a concrete checkable fact
 *   B  a real statement, but thin or needing page context
 *   C  true, but nobody would query it
 *   D  mistyped or meaningless standing alone
 *
 * Usage: node tools/dev/grade.mjs path/to/ai.json
 */
import fs from 'node:fs';

const CONCRETE = /\b\d[\d,.]*\s?(%|ms|s\b|seconds|minutes|hours|days|million|billion|thousand|users|customers|lines|modules)|\b(ISO\s?\d{4,5}|SOC\s?2|HIPAA|GDPR|FedRAMP|PCI[- ]DSS|Type\s?II)\b/i;
const COMMITMENT = /\b(we (do not|never|will not|always)|(?:is|are) licen[cs]ed,? not sold|we retain|runs? (entirely|fully) (within|inside|on-premise)|no outbound network|air-gapped)\b/i;
const SELF_REF = /^(this|these|the)\s+(privacy policy|terms|agreement|document|section|table|figure)\b|^(table|figure|section)\s+\d/i;
const VAGUE = /\b(described|listed)\s+(below|above)\b|\bas follows\b/i;

export function grade(claim) {
  const src = claim.summary_source;
  const text = claim.claim.trim();
  const type = claim.type;

  if (SELF_REF.test(text)) return ['D', 'about the document, not the organisation'];
  if (VAGUE.test(text)) return ['D', 'defers its content elsewhere'];
  if ((type === 'certification' || type === 'credential') && !/\b(ISO|SOC|HIPAA|GDPR|FedRAMP|PCI|Type\s?II|patent|trademark|licen[cs]ed,? not sold|registered in)\b/i.test(text))
    return ['D', `typed ${type} without naming a credential`];

  if (src === 'schema.org' || src === 'meta') {
    return text.length >= 40 ? ['A', `summary the publisher wrote (${src})`] : ['B', 'summary, but very short'];
  }
  if (CONCRETE.test(text)) return ['A', 'concrete, checkable fact'];
  if (COMMITMENT.test(text)) return ['A', 'explicit commitment, highly queryable'];
  if (text.length < 70) return ['B', 'real but thin'];
  if (/\bcontact us\b/i.test(text)) return ['B', 'actionable but generic'];
  return ['C', 'true, but unlikely to be queried'];
}

const file = process.argv[2];
if (file) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = m.claims.map(c => [...grade(c), c]);
  const dist = rows.reduce((a, [g]) => ({ ...a, [g]: (a[g] ?? 0) + 1 }), {});
  const n = rows.length;
  const pages = new Set(m.claims.flatMap(c => c.evidence.map(e => e.url))).size;
  const ev = m.claims.reduce((s, c) => s + c.evidence.length, 0);

  console.log(`\n${file}`);
  console.log(`  ${n} claims · ${ev} evidence records · ${pages} pages covered\n`);
  for (const g of 'ABCD') {
    const c = dist[g] ?? 0;
    console.log(`  ${g}: ${String(c).padStart(3)}  ${(c / n * 100).toFixed(1).padStart(5)}%  ${'#'.repeat(c)}`);
  }
  const a = dist.A ?? 0;
  console.log(`\n  grade A: ${(a / n * 100).toFixed(1)}%`);
  const bad = rows.filter(([g]) => g === 'C' || g === 'D');
  if (bad.length) {
    console.log('\n  not grade A or B:');
    for (const [g, why, c] of bad) console.log(`    ${g} [${c.type}] ${c.claim.slice(0, 66)}  <- ${why}`);
  }
}
