# ai-evidence (Python)

Python implementation of the [AI Evidence Manifest](https://github.com/DominionLabsInc/ai-evidence-manifest) —
a static `/ai.json` file that links the claims a site makes to the first-party
evidence supporting them.

```bash
pip install ai-evidence
```

```bash
ai-evidence init https://example.com   # write ai-evidence.config.json
ai-evidence generate                   # read the site, write ai.json
ai-evidence check ai.json --update     # re-verify, record freshness
ai-evidence repair ai.json             # relocate quotes that have drifted
```

As a library:

```python
from ai_evidence import validate_manifest, parse_manifest

manifest, size = parse_manifest(open("ai.json").read())
result = validate_manifest(manifest, offline=False)

print(result["valid"], result["stats"])
```

## Parity with the JavaScript implementation

Both implementations load the same `shared/patterns.json` and validate against
the same JSON Schema, and a conformance corpus checks that they produce
identical output for identical input. Where the two regex engines differ — the
spelling of Unicode character classes — the shared file uses placeholders that
each language substitutes.

## Licence

The tooling is Elastic License 2.0; the specification and schema are
Apache-2.0. See `NOTICE` in the repository root.
