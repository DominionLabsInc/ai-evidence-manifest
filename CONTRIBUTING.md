# Contributing

Thanks for looking. This is a proposed convention, so the most valuable contributions are usually arguments about the design rather than code.

## Most useful right now

- **Holes in the security model.** Especially the SSRF guards and anything a hostile manifest could make a consumer do. See [SECURITY.md](SECURITY.md).
- **Data model critique.** Is `CLAIM → EVIDENCE → SOURCE` the right shape? Is the `source_type` / `authority` split real or artificial?
- **Mappings to existing vocabularies.** A clean Schema.org or W3C PROV mapping would be a significant contribution.
- **Consumer implementations.** If you write an agent that reads `ai.json`, what was awkward?

## Running the project

```bash
npm install
npm test                       # no network required
npm run validate:examples

# the publisher flow, end to end
node validator/cli.js init https://example.com
node validator/cli.js generate
node validator/cli.js check ai.json
```

Requires Node 20 or newer. The only runtime dependencies are `ajv` and `ajv-formats`.

## Regenerating artifacts

The examples and fixtures are generated so their hashes stay correct:

```bash
node tools/dev/build-example.mjs     # examples/ai.json, examples/minimal.json
node tools/dev/build-fixtures.mjs    # tests/fixtures/*
```

Never hand-edit a `sha256` — regenerate.

## Changes to the specification

`SPEC.md` and `schema/ai-evidence-manifest.schema.json` must stay in step. The schema is normative for structure; the spec is normative for meaning.

- Adding an optional field or enum value → **minor** version.
- Changing a required field, removing a value, or altering normalization → **major** version.
- Wording or clarification only → **patch**.

Any change to §5 text normalization is breaking, because it invalidates every existing hash. Treat it as such.

Include tests with behavioural changes. If you fix a bug, add the fixture that would have caught it.

## Style

- No build step, anywhere. Plain ESM.
- The deliverable is a static file, not an application. If a feature would make this read as a web product rather than a web primitive, it does not belong here.
- Keep runtime dependencies near zero; a new one needs a reason.
- Comments explain *why*, not *what*.
- The system should feel like a web primitive, not a product. If a feature only makes sense with a hosted service behind it, it does not belong here.

## Licence

Contributions are accepted under [Apache-2.0](LICENSE).
