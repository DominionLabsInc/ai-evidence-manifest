import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Extraction behaviour is defined once, in shared/patterns.json, and loaded by
 * every implementation. Keeping it as data rather than code is what stops the
 * JavaScript and Python ports drifting: a pattern can only be changed in one
 * place, and the conformance corpus proves both engines still agree.
 *
 * The two regex engines spell Unicode classes differently, so the shared file
 * uses placeholders and each language substitutes its own form.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const PATTERNS = JSON.parse(
  fs.readFileSync(path.join(here, '..', 'shared', 'patterns.json'), 'utf8')
);

const substitute = src => src
  .replaceAll('{{LETTER}}', '\\p{Letter}')
  .replaceAll('{{NUMBER}}', '\\p{Number}')
  .replaceAll('{{UPPER}}', '\\p{Uppercase_Letter}');

export const rx = (src, flags = 'i') => new RegExp(substitute(src), flags);

export const T = PATTERNS.thresholds;
export const CLAIM_PATTERNS = PATTERNS.claimPatterns.map(([type, src]) => [type, rx(src)]);
export const GATES = Object.fromEntries(
  Object.entries(PATTERNS.gates).filter(([k]) => k !== '$comment').map(([k, v]) => [k, rx(v)])
);
// Flags are declared alongside each pattern. Case-sensitivity is part of what
// a pattern means, not a detail of how it is compiled: defaulting `initial` to
// the i flag made it match the possessive in "the substrate's." and silently
// merged sentences.
export const SENTENCE = Object.fromEntries(
  Object.entries(PATTERNS.sentences).map(([k, v]) => [k, rx(v.source, v.flags)])
);
export const HTML_SETS = Object.fromEntries(
  Object.entries(PATTERNS.html).map(([k, v]) => [k, new Set(v)])
);
export const ATOMIC_TYPES = new Set(PATTERNS.atomicTypes);
export const SCHEMA_TYPE_MAP = PATTERNS.schemaTypeMap;
