# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The specification uses semantic versioning; the tooling is versioned separately.

## [Unreleased]

## [2.1.0] — 2026-09-24

Specification 2.1.0, tooling 0.3.0. Adds optional signing. A minor version:
every valid 2.0.0 document remains valid, and `signatures` is OPTIONAL.

### The bug this release starts with

Section 12 of 2.0.0 said the `integrity` object was "deliberately open so
mechanisms can be added without a breaking change". Neither half was true.
`integrity` is a per-evidence hash object with `additionalProperties: false`
and one permitted key, and the schema set `additionalProperties: false` in nine
places including the root — so a manifest carrying a top-level `signatures`
member was rejected by both implementations. Adding signing was exactly the
breaking change 2.0.0 promised it would not be.

### Added

- **Signing** (SPEC §12): detached-payload JWS (RFC 7515) over RFC 8785
  canonical JSON, Ed25519 only. Signatures survive an agent parsing and
  re-serializing the document, which is what makes a publisher assertion
  portable beyond the fetch that retrieved it.
- **Key discovery** (SPEC §12.6): a JWKS at `/.well-known/ai-evidence-jwks.json`,
  plus an optional DNS TXT anchor for consumers that will not trust the web
  host. The specification defines the record; neither implementation ships a
  DNS client, and resolution is the consumer's.
- `canonicalize` / `canonical_bytes` in both implementations, and
  `keygen`, `sign` and `verify` in both CLIs. `validate --jwks` checks
  signatures alongside everything else.
- Conformance vectors in `tests/conformance/`: canonical-JSON cases, and a
  fixed key, document and `iat` whose signature both implementations must
  reproduce byte for byte. Ed25519 is deterministic, so one comparison pins
  canonicalization, header encoding and signing-input construction at once.

### Changed

- **Unknown members are now MUST-ignore rather than MUST-reject** (SPEC §3).
  This only widens what validates, so no existing document breaks — but it had
  to happen before anything could be added to the format. Signature objects are
  the one exception and still reject unknown members, because nothing inside a
  signature may be silently skipped.
- The validator reports unknown members as `unknown-member` warnings, so a
  misspelled member name stays visible now that the schema permits it. `--strict`
  still fails on them.
- A verified signature lifts the §9b.3 rule that a manifest must be retrieved
  from `manifest.site` to carry any epistemic state (SPEC §12.8). Nothing else
  in §9b changes: a signature never confers OBSERVED, and never makes a claim
  true.
- `python`: `cryptography` is now a required dependency rather than an optional
  extra. Verification is the common operation and is performed by consumers who
  did not choose to install anything; a signature format that silently cannot
  be checked on a default install is worse than none.
- SPEC §13 records why RFC 9421 (HTTP Message Signatures) was considered and
  rejected: it signs an HTTP exchange rather than a document, so the signature
  is lost the moment a consumer stores the JSON.
- README: the Publishing section still advertised `GET /ai.json` as canonical
  and a bare `rel="ai-evidence"` link relation, both of which 2.0.0 had already
  changed.

### Fixed

- The JavaScript CLI parsed any flag outside a hard-coded list as a boolean, so
  a new value-taking flag silently swallowed its argument. `--key`, `--jwks` and
  `--site` are registered, and a value-taking flag given no value is now an
  error rather than a silent `true`.
- The Python canonicalizer raised `AttributeError` from its sort key on a
  non-string object key instead of refusing it.

### Security

- One algorithm, no negotiation: `alg` has exactly one permitted value, so there
  is no algorithm-confusion attack and no `none`.
- `kid` is the RFC 7638 thumbprint and is checked against the key it names, so
  an attacker who can serve the key set cannot publish their own key under an
  honest key's identifier.
- The protected header must carry exactly four parameters; unknown ones are
  rejected rather than ignored, so nothing can be smuggled into a signed region
  that verifiers skip.
- Canonicalization refuses non-integer numbers, integers outside the IEEE 754
  safe range, and lone surrogates — values whose canonical form two
  implementations would not agree on. Refusing at signing time beats a
  signature that fails to verify in someone else's stack.
- `keygen` writes the private key mode `0600`, created closed rather than
  chmod-ed afterwards, and `.gitignore` excludes it.

### Known limits

Stated in SPEC §12.9 and §14.4 rather than left to be discovered: signing does
not detect a withheld update, does not make a dishonest publisher honest, does
not authenticate `publisher.same_as`, and offers no revocation. Establishing a
key from the JWKS still reduces to trusting the web host on first contact; only
the DNS anchor avoids that.

## [2.0.0] — 2026-09-24

Specification 2.0.0, tooling 0.2.0. **Breaking**, and superseding 1.0.0 the
same day it was published, after a standards review.

### Why this is a major version

A document valid under 1.0.0 can be invalid under 2.0.0: `verification.verified`
may no longer be `true` alongside `method: automatically-generated`. Section 11
says a breaking change takes a major version and that a consumer must not
process a major version it does not implement. Applying that rule to a
specification published hours earlier is uncomfortable, and doing anything else
would make the rule worthless. Validators now reject 1.x manifests, including
the ones the 0.1.0 tooling produced.

1.0.0 should not be implemented.

### Changed

- **Canonical location is `/.well-known/ai-evidence.json`** (RFC 8615).
  `/ai.json` remains a valid, non-canonical alias and must be byte-identical.
  `generate` writes both; consumers probe the well-known path first.
- **Media type `application/ai-evidence+json`** (RFC 6839), unregistered for
  now; `application/json` accepted and content type is never grounds for
  rejection.
- **Link relations expressed as URIs** (RFC 8288).
- **Caching specified**: `max-age` no greater than the recheck interval;
  `checked_at` is not a cache directive.
- **`verified: true` with `automatically-generated` is a schema error**, not a
  warning.
- **Section 9b replaces the informal trust guidance** with two named epistemic
  states, the operations each licenses, the conditions under which a manifest
  conveys no state at all, an attribution requirement, and an explicit account
  of what the freshness record cannot do.
- **Section 14.4 records what the specification does not define**: publisher
  authentication, rollback detection, conflict resolution, partial validity,
  completeness.
- Licence is Apache-2.0 throughout; the earlier Apache/Elastic split is gone.

### Fixed

- A `ReferenceError` in `generate` that threw after writing correct output.
- The Python wheel's bundled schema copy had gone stale; a test now fails on
  drift.


## [1.0.0] — 2026-09-24

Published as `ai-evidence` 0.1.0 on [npm](https://www.npmjs.com/package/ai-evidence)
and [PyPI](https://pypi.org/project/ai-evidence/). The specification is version
1.0.0; the tooling is versioned separately and starts at 0.1.0.

First public specification and reference implementation.

### Specification

- `CLAIM → EVIDENCE → SOURCE` data model, published at `/ai.json`.
- 19 claim types; `source_type` and `authority` as separate provenance axes.
- Fixed text normalization (NFC, whitespace collapse) with SHA-256 integrity over the normalized evidence text.
- Locator model preferring W3C Text Fragments and element ids; CSS selectors advisory only.
- Verification object distinguishing publisher confirmation from independent verification.
- Recommended size limits, and an explicit statement that the manifest is not proof, authorization or identity.

### Tooling

- JSON Schema (draft 2020-12).
- `ai-evidence init` and `generate`: a small hand-maintained config produces `ai.json`, so a publisher never writes claims by hand. Claims placed in `pin` survive regeneration untouched.
- `ai-evidence validate` / `check` / `extract`, with `--offline`, `--online`, `--strict` and `--json`.
- Deterministic two-tier extractor: declared structured data, then pattern-matched sentence candidates. A candidate is only emitted if its text is found verbatim in the page's visible text.
- Safe fetching: HTTPS only, SSRF guards including IPv4-mapped IPv6, per-hop redirect validation, streamed size limits. Bare domains and `http://` inputs are normalized rather than refused.
- HTML read with parse5, and pages that assemble their content in the browser are detected and reported instead of silently yielding nothing.
- 51 tests covering schema, semantics, Unicode, XSS payloads, SSRF and HTML extraction.

### Second implementation

A Python package with the same commands and the same behaviour, so the tooling
installs with pip as well as npm, plus Homebrew and Docker. Both load
`shared/patterns.json` and validate against the same schema, and a conformance
corpus requires byte-identical output from identical input.

Writing the second implementation found four real bugs that one alone would
not have:

- **JavaScript**: `sectionLeads` split sentences with an inline regex instead
  of `splitSentences`, bypassing abbreviation handling. "This Privacy Policy
  explains how Dominion Labs Inc." was published truncated at "Inc.". The same
  inline split existed in `repair.js`.
- **JavaScript**: claims were emitted sorted by evidence count rather than in
  document order.
- **Python**: `max(set(types), key=...)` broke ties by set iteration order,
  which is arbitrary — two runs could disagree.
- **Both**: percent-encoding of text fragments differed. JavaScript's
  `encodeURIComponent` leaves `!~*'()` unescaped, Python's `quote` does not, so
  the same quote produced two different fragments. The spec now pins it (5.1).

### Licensing

Apache-2.0 throughout — specification, schema, both implementations, examples.

An earlier draft split it: Apache-2.0 for the specification, Elastic License 2.0
for the tooling, to stop a competitor reselling the tooling as a service. That
was the wrong trade for a proposed convention. A source-available licence is not
OSI open source, which puts it outside some organisations' procurement rules and
out of Linux distributions entirely, and it makes the reference implementation
something to be wary of rather than something to copy. For a format whose only
value is adoption, friction in the reference implementation is friction on the
format.

### Standards and conformance audit

Reviewed against the standards this would have to live alongside. Fixed:

- **`/ai.json` moved to `/.well-known/ai-evidence.json`.** RFC 8615 reserves
  `/.well-known/` for exactly this, and says new conventions should not take
  root paths. `robots.txt` and `sitemap.xml` sit at the root because they
  predate the registry. A root path is not a proposal's to claim, and a site
  may already use it. The short alias remains, optional and non-canonical, and
  must be byte-identical; consumers try the well-known path first.
- **Media type `application/ai-evidence+json`** (RFC 6839 structured suffix),
  unregistered for now, with `application/json` accepted and content type never
  a reason to reject.
- **Link relation expressed as a URI.** RFC 8288 requires a relation outside the
  IANA registry to be a URI; `rel="ai-evidence"` was non-conforming.
- **Caching specified.** `max-age` no greater than the recheck interval, and
  `checked_at` explicitly is not a cache directive.
- **`verified: true` with `automatically-generated` is now a schema error**
  rather than a warning. Two fields holding one fact could disagree.
- **Bundled-copy drift.** The Python wheel carries its own schema and pattern
  copies so it works without the repository; the schema copy had already gone
  stale. A test now fails on drift, and `npm run sync` refreshes them.

Documented as known limits rather than fixed: no publisher authentication, no
rollback detection, no conflict-resolution rules, all-or-nothing validation, and
no completeness guarantee. See SPEC 14.4.

### Design decisions worth recording

- **Verification lives in one place.** An earlier draft carried `verified_at` directly on evidence *and* a `verification` object. Two homes for one fact invites drift, so only the object exists.
- **Hashes cover the quoted text, not the page.** Hashing whole pages produces false alarms on every unrelated edit. Hashing the normalized quote detects exactly the change that matters.
- **"Read the claim, done" was not a specification.** The README said
  `GET /ai.json -> read the claim -> done`, which reads as marketing and
  under-specifies the trust boundary in the permissive direction, just as the
  earlier "verify everything" text did in the restrictive one. Replaced with a
  protocol-level treatment: two named states, ASSERTED and OBSERVED, a table of
  which operations each licenses, and explicit conditions under which a manifest
  conveys no state at all.
- **Reading the manifest is the normal path.** An earlier draft had a consumer fetch the manifest, then retrieve and re-verify every referenced source. That is incoherent: the manifest records the result of checking its own evidence, so repeating all of it gains nothing over crawling and the format saves no work at all. The evidence exists to make a claim checkable, not to require that every reader check it. Refetching is now the exception — when the freshness record is stale or incomplete, when an entry has no `last_seen`, or when a decision is high-impact and hard to reverse. This rests on a publisher assertion, which is acceptable because it is falsifiable for the price of one request.
- **A spec-compliant parser, not regular expressions.** HTML reading began as regex matching to avoid dependencies. For a verification tool that is the wrong trade: mis-parsed markup makes a quote that is present read as absent, so `check` reports drift that does not exist. False alarms are worse than missed evidence, so parse5 was adopted.
- **Silence is a bad answer.** Returning "no claims found" for a client-rendered page leads a publisher to conclude their site has nothing worth publishing. The condition is now detected and explained.
- **No browser tool.** An early version shipped a local authoring UI. It made the project read as a web product when the deliverable is a static file you drop in beside `robots.txt`, so it was removed. The config plus `generate` covers the same ground without the framing problem.
- **A bare entity name is not a claim.** Tier 1 originally emitted "X is described on this page as an Organization" from a schema.org `name`. That restates the markup rather than making a claim, so only publisher-written descriptions that appear in the visible text are emitted.
- **Extraction caps output per page and per type.** An uncapped run over a 13-page site produced 133 candidates at 169 KiB — barely smaller than crawling. Capped, the same site yields 38 candidates at 36 KiB, and a reviewed manifest is smaller still. The point is selection.
