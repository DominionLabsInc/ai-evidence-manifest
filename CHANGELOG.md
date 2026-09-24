# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The specification uses semantic versioning; the tooling is versioned separately.

## [Unreleased]

## [1.0.0] — 2026-09-24

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

### Design decisions worth recording

- **Verification lives in one place.** An earlier draft carried `verified_at` directly on evidence *and* a `verification` object. Two homes for one fact invites drift, so only the object exists.
- **Hashes cover the quoted text, not the page.** Hashing whole pages produces false alarms on every unrelated edit. Hashing the normalized quote detects exactly the change that matters.
- **A spec-compliant parser, not regular expressions.** HTML reading began as regex matching to avoid dependencies. For a verification tool that is the wrong trade: mis-parsed markup makes a quote that is present read as absent, so `check` reports drift that does not exist. False alarms are worse than missed evidence, so parse5 was adopted.
- **Silence is a bad answer.** Returning "no claims found" for a client-rendered page leads a publisher to conclude their site has nothing worth publishing. The condition is now detected and explained.
- **No browser tool.** An early version shipped a local authoring UI. It made the project read as a web product when the deliverable is a static file you drop in beside `robots.txt`, so it was removed. The config plus `generate` covers the same ground without the framing problem.
- **A bare entity name is not a claim.** Tier 1 originally emitted "X is described on this page as an Organization" from a schema.org `name`. That restates the markup rather than making a claim, so only publisher-written descriptions that appear in the visible text are emitted.
- **Extraction caps output per page and per type.** An uncapped run over a 13-page site produced 133 candidates at 169 KiB — barely smaller than crawling. Capped, the same site yields 38 candidates at 36 KiB, and a reviewed manifest is smaller still. The point is selection.
