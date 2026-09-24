# AI Evidence Manifest — Specification

**Version 1.0.0** · Status: proposed open web convention · [Apache-2.0](LICENSE)

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT and MAY are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174).

---

## 1. Purpose and non-purpose

An AI Evidence Manifest is a publisher-declared index mapping claims a publisher considers important to the first-party content that supports them.

The manifest is an **index and provenance layer**. It does not replace the underlying evidence and does not assert that any claim is true.

A conforming consumer MUST NOT treat the presence of a claim in a manifest as evidence that the claim is true. The only assertion a manifest makes is:

> the publisher states that supporting evidence is located here.

The manifest is explicitly **not**:

- an authorization or authentication mechanism,
- cryptographic proof of truth,
- a means of establishing identity,
- a ranking, citation or inclusion mechanism for any search or AI system.

## 2. Discovery

The primary location is the site root:

```
GET /ai.json
```

The resource SHOULD be served:

- over HTTPS,
- with `Content-Type: application/json`,
- publicly, without authentication, so ordinary crawlers and agents can retrieve it,
- with `Access-Control-Allow-Origin: *`, so browser-based agents can read it.

It SHOULD NOT be disallowed in `robots.txt`.

Publishers MAY additionally advertise the manifest:

```html
<link rel="ai-evidence" href="/ai.json">
```

```
Link: </ai.json>; rel="ai-evidence"
```

Discovery is convention-based. No registry, crawler protocol or central authority is defined, and none is required. This specification does not modify `robots.txt` semantics.

## 3. Document structure

A manifest is a JSON object with two REQUIRED members, `manifest` and `claims`, and two OPTIONAL members, `publisher` and `extensions`.

```
manifest        object    REQUIRED   header
publisher       object    OPTIONAL   who publishes the manifest
claims          array     REQUIRED   one or more claims, each with evidence
extensions      object    OPTIONAL   namespaced extension data
```

Unknown members MUST be rejected at the top level and within defined objects; the schema sets `additionalProperties: false`. Forward-compatible data belongs under `extensions`, which consumers MUST ignore when they do not understand it.

### 3.1 `manifest`

| Field | Type | | Notes |
|---|---|---|---|
| `version` | string | REQUIRED | Specification version, semantic versioning, e.g. `1.0.0` |
| `site` | https URL | REQUIRED | Origin the manifest describes |
| `generated_at` | date-time | OPTIONAL | RFC 3339 |
| `generator` | string | OPTIONAL | Tool that produced the file |
| `language` | string | OPTIONAL | BCP 47 default language |

### 3.2 `claims[]`

| Field | Type | | Notes |
|---|---|---|---|
| `id` | string | REQUIRED | `^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$`, unique within the manifest |
| `type` | enum | REQUIRED | See §4 |
| `claim` | string | REQUIRED | The assertion, 1–1000 characters |
| `description` | string | OPTIONAL | Context for a consumer |
| `scope` | string | OPTIONAL | Where the claim applies, e.g. `EU customers` |
| `importance` | enum | OPTIONAL | `primary` or `secondary` |
| `language` | string | OPTIONAL | BCP 47 |
| `evidence` | array | REQUIRED | At least one evidence record |

### 3.3 `evidence[]`

| Field | Type | | Notes |
|---|---|---|---|
| `url` | https URL | REQUIRED | Where the evidence is published |
| `text` | string | REQUIRED | Exact text as it appears at that location |
| `title` | string | OPTIONAL | Title of the source page |
| `locator` | object | OPTIONAL | `fragment`, `section`, `selector` — see §6 |
| `integrity` | object | OPTIONAL | `sha256` of the normalized `text` — see §5 |
| `source_type` | enum | REQUIRED | See §7 |
| `authority` | enum | OPTIONAL | See §7 |
| `scope` | string | OPTIONAL | |
| `language` | string | OPTIONAL | BCP 47 |
| `published_at` | date | OPTIONAL | |
| `modified_at` | date | OPTIONAL | |
| `verification` | object | OPTIONAL | See §8 |

`http://` URLs MUST be rejected, so that a manifest cannot induce a consumer to fetch over plaintext.

## 4. Claim types

A controlled but extensible vocabulary:

`capability` · `product` · `service` · `organization` · `person` · `location` · `credential` · `certification` · `technical_claim` · `business_fact` · `statistic` · `policy` · `pricing` · `availability` · `contact` · `announcement` · `research` · `documentation` · `other`

Use `other` rather than inventing a value. New types require a minor version increment.

## 5. Text normalization and integrity

`integrity.sha256` is the lowercase hex SHA-256 of the evidence `text` after this exact normalization:

1. Unicode **NFC**.
2. Every run of Unicode whitespace (`\s+`, Unicode-aware) becomes a single U+0020.
3. Leading and trailing whitespace removed.
4. Encode as UTF-8.

Whitespace is collapsed because HTML authoring reflows it freely; reindenting a paragraph MUST NOT invalidate otherwise-intact evidence.

This supports two distinct checks:

- **Offline** — recompute the hash from the manifest's own `text`. A mismatch means the file was edited without regenerating, so the manifest is internally inconsistent.
- **Online** — fetch `url`, extract visible text, and confirm the quoted `text` is still present. A failure means the page has drifted away from its manifest.

Both are implemented by the reference validator. `integrity` is OPTIONAL in v1, but omitting it means consumers cannot detect drift without a full refetch and comparison, and the validator warns.

### 5.1 Fragment encoding

A `locator.fragment` built from evidence text MUST percent-encode using the
rules of `encodeURIComponent`: every character is escaped except
`A-Z a-z 0-9 - _ . ! ~ * ' ( )`.

This is stated because implementations disagree by default — JavaScript's
`encodeURIComponent` leaves `!~*'()` unescaped while Python's `urllib.parse.quote`
escapes them, so the same quote would otherwise produce two different fragments
and two different manifests.

## 6. Locating evidence within a source

`locator` narrows where in the page the evidence sits.

| Field | Meaning |
|---|---|
| `fragment` | URL fragment, ideally a [W3C Text Fragment](https://wicg.github.io/scroll-to-text-fragment/) such as `#:~:text=Our%20research%20program` |
| `section` | `id` of the containing element |
| `selector` | CSS selector — **advisory only** |

Publishers SHOULD prefer `fragment` or `section`. A CSS selector MUST NOT be the sole means of locating evidence: selectors break on any markup change, and a consumer MAY ignore `selector` entirely.

The authoritative locator is always `text` itself. A consumer that cannot resolve any locator SHOULD fall back to searching the page for the normalized `text`.

## 7. Provenance: `source_type` and `authority`

These describe different things and are both needed.

**`source_type`** — where the evidence lives relative to the publisher:

`first-party` · `third-party` · `independent` · `regulatory` · `public-record` · `unknown`

**`authority`** — who stands behind the statement:

`publisher` · `author` · `regulator` · `certifier` · `independent-auditor` · `unknown`

A press release about a company, hosted by that company, is `first-party` / `publisher`. A regulator's filing the company links to is `public-record` / `regulator`.

Where `source_type` is `first-party`, the evidence `url` SHOULD share an origin with `manifest.site`. The validator warns otherwise.

This specification does not attempt to determine whether a claim is objectively true. It describes provenance only.

## 8. Verification

```json
"verification": { "verified": true, "verified_at": "2026-09-24", "method": "publisher-confirmed" }
```

`method` is REQUIRED when `verification` is present:

| Method | Meaning |
|---|---|
| `publisher-confirmed` | A human at the publisher asserted this |
| `automatically-generated` | Produced by a tool, not confirmed by a person |
| `externally-verified` | Checked by a party other than the publisher |
| `manually-reviewed` | Reviewed by a person, not necessarily the publisher |
| `unknown` | Not stated |

`publisher-confirmed` MUST NOT be presented as independent factual verification. It records only that the publisher stands behind the entry.

Setting `verified: true` together with `method: automatically-generated` is contradictory — machine extraction is not confirmation — and the validator warns.

## 9. Automatic generation

Tools MAY generate manifests. A conforming generator MUST NOT emit an evidence record whose `text` it did not find, verbatim after §5 normalization, in the retrieved source. A generator may therefore miss evidence, but cannot fabricate it.

Generated records SHOULD use `method: automatically-generated` with `verified: false` until a person reviews them.

## 9a. Configuration (non-normative)

Nothing in this specification requires a particular authoring method. `/ai.json` may be written by hand.

The reference tooling reads an `ai-evidence.config.json` alongside the site source and generates the manifest from it, so a publisher maintains roughly ten lines rather than the whole file:

```json
{
  "site": "https://example.com/",
  "discover": "sitemap",
  "exclude": ["/privacy", "/terms"],
  "types": ["organization", "capability", "product", "service", "technical_claim"],
  "maxPerType": 6,
  "pin": []
}
```

Claims listed under `pin` are emitted unchanged and are never replaced by generation, so hand-written entries survive regeneration. This file is a convenience of the reference implementation and is not part of the wire format; a consumer never sees it.

## 9b. What a consumer is expected to do

The normal path is: fetch `/ai.json`, read the claim, use it.

A manifest carries the result of checking its own evidence against the live
site (§8, `manifest.verification`). A consumer that refetches every source
anyway is repeating work the publisher has already done and published, which
removes the format's only advantage over crawling.

So: **the evidence exists to make a claim checkable, not to require that every
reader check it.**

A consumer SHOULD retrieve the source when the manifest itself says not to rely
on it — `checked_at` older than `recheck_interval_days`, `evidence_present`
below `evidence_total`, or a missing `last_seen` — and when a decision is
high-impact and hard to reverse.

This rests on a publisher assertion, and that is acceptable for one reason: it
is falsifiable at trivial cost. Any consumer can confirm a single quote with one
request. A publisher reporting checks it did not run is caught by the first
reader who looks, which is a far stronger constraint than asking every reader to
verify everything.

## 10. Size and limits

The manifest is an index, not a copy of the site. It MUST NOT embed whole documents, images, scripts or executable content.

Recommended v1 limits, which consumers SHOULD enforce and MAY configure:

| Limit | Recommended |
|---|---|
| Manifest size | 1 MiB |
| Claims | 1000 |
| Evidence records per claim | 20 |
| Evidence `text` length | 2000 characters |
| Staleness warning | 365 days since `verified_at` |

Exceeding a recommendation is a warning, not an error. A manifest that lists everything is little better than the crawl it replaces; selection is what makes it useful.

## 11. Versioning

Semantic versioning. `manifest.version` is REQUIRED.

- **Major** — breaking changes. A consumer MUST NOT process a major version it does not implement.
- **Minor** — backwards-compatible additions, such as new enum values.
- **Patch** — clarifications with no wire-format change.

Consumers MUST ignore unknown members under `extensions` rather than failing.

## 12. Integrity and signing (future)

v1 defines no signing. The `integrity` object is deliberately open so mechanisms can be added without a breaking change.

Candidates for a future version: signed manifests using established standards (JWS or HTTP Message Signatures), DNS-based domain verification, and third-party attestation. No proprietary cryptography will be introduced.

A content hash is **not** a signature. It detects drift; it does not establish authorship.

## 13. Relationship to existing standards

This convention complements rather than replaces:

| Standard | Purpose | Relationship |
|---|---|---|
| `robots.txt` | Controls crawler access | Untouched. `/ai.json` should not be disallowed. |
| `sitemap.xml` | Describes which URLs exist | Complementary: sitemap lists pages, manifest points inside them. |
| `llms.txt` | Concise LLM-oriented site context and links | Adjacent. `llms.txt` is prose for orientation; this is structured claim→evidence data. |
| Schema.org / JSON-LD | Semantic descriptions of entities | Complementary, and a useful extraction input. A future version may offer a JSON-LD representation. |
| W3C PROV | General provenance model | Conceptually related. `source_type` and `authority` map loosely onto PROV agents and attribution; a formal mapping is future work. |

This project is not a W3C standard and is not endorsed by any standards body.

## 14. Conformance

A **conforming manifest** validates against `schema/ai-evidence-manifest.schema.json` and satisfies the REQUIRED clauses here.

A **conforming consumer**:

- MUST validate against the schema before use;
- MUST treat all contents as untrusted input;
- MUST NOT treat publisher assertions as independently verified facts;
- MUST NOT execute any content from a manifest;
- MAY rely on a claim without refetching its evidence when `manifest.verification` is present, `checked_at` is within `recheck_interval_days`, `evidence_present` equals `evidence_total`, and the entry carries a `last_seen`;
- SHOULD retrieve and check the referenced evidence when any of those conditions fails, or when the decision is high-impact and hard to reverse;
- SHOULD enforce the limits in §10 and the protections in [SECURITY.md](SECURITY.md).
