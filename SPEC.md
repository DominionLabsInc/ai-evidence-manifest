# AI Evidence Manifest — Specification

**Version 2.0.0** · Status: proposed open web convention · [Apache-2.0](LICENSE)

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

## 2. Discovery and location

### 2.1 Canonical location

```
GET /.well-known/ai-evidence.json
```

[RFC 8615](https://www.rfc-editor.org/rfc/rfc8615) reserves `/.well-known/` for
exactly this: site-wide metadata defined by a convention rather than by the
site. `robots.txt` and `sitemap.xml` sit at the root only because they predate
that registry; RFC 8615 says new conventions should not follow them there, and
a root path is not the proposal's to take. A site may already serve `/ai.json`
for its own purposes, and a second proposal wanting the same path has no way to
resolve the collision.

Publishers MAY additionally serve the identical document at:

```
GET /ai.json
```

This alias exists because it is short enough to say out loud and to type, which
matters for adoption. It is not canonical. Where both are served they MUST be
byte-identical. Consumers MUST try `/.well-known/ai-evidence.json` first and
MAY fall back to `/ai.json`.

### 2.2 Media type

The resource SHOULD be served as:

```
Content-Type: application/ai-evidence+json
```

The `+json` structured syntax suffix is [RFC 6839](https://www.rfc-editor.org/rfc/rfc6839).
This media type is **not yet registered with IANA**; until it is, publishers MAY
serve `application/json` and consumers MUST accept either. Consumers MUST NOT
reject a document solely on content type, because misconfigured static hosts are
common and the document is self-describing via `manifest.version`.

### 2.3 Transport

The resource:

- MUST be served over HTTPS;
- MUST be publicly retrievable without authentication, so ordinary crawlers and
  agents can read it;
- SHOULD be served with `Access-Control-Allow-Origin: *`, so browser-based
  agents can read it;
- SHOULD NOT be disallowed in `robots.txt`.

### 2.4 Caching

The resource SHOULD be served with a `Cache-Control` `max-age` no greater than
`manifest.verification.recheck_interval_days`, so a consumer is not handed a
document the publisher has already superseded.

`checked_at` is not a cache directive and MUST NOT be used as one: it describes
when the publisher last verified evidence, not how long this representation may
be reused. Consumers SHOULD honour ordinary HTTP caching and SHOULD revalidate
with `ETag` or `Last-Modified` where offered.

### 2.5 Advertisement

Publishers MAY advertise the manifest in HTML or in a `Link` header:

```html
<link rel="https://ai-evidence.org/rel/manifest" href="/.well-known/ai-evidence.json">
```

```
Link: </.well-known/ai-evidence.json>; rel="https://ai-evidence.org/rel/manifest"
```

[RFC 8288](https://www.rfc-editor.org/rfc/rfc8288) requires that a link relation
which is not in the IANA registry be expressed as a URI. A bare token such as
`rel="ai-evidence"` is therefore non-conforming until registration, which is why
the extension URI is used above. Consumers MAY additionally accept the bare
token, since it will appear in the wild.

Advertisement is optional. The well-known location is the primary mechanism, and
a consumer that only ever probes it is conforming.

### 2.6 Relationship to robots.txt

This specification does not modify `robots.txt` semantics and defines no new
crawler directives. A publisher that disallows a path in `robots.txt` has not
made the evidence there unusable; it has said not to fetch it. Consumers MUST
continue to honour `robots.txt` when retrieving evidence URLs, and a consumer
that cannot fetch an evidence URL for that reason holds ASSERTED state only
(§9b), exactly as if the fetch had failed.

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
| `version` | string | REQUIRED | Specification version, semantic versioning, e.g. `2.0.0` |
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

## 9b. Epistemic status, and what each state licenses

This is the core of the protocol and the part most easily got wrong in both
directions. Requiring a consumer to refetch every source makes the manifest
worthless — it does the same work as crawling. Permitting a consumer to treat a
manifest as fact makes it a vector. Neither is correct, and "read the claim,
done" is not a specification.

A manifest can transfer exactly one thing: **a publisher assertion**. Retrieval
is what converts an assertion into an **observation**. These are different
epistemic states and license different operations.

### 9b.1 The two states

**ASSERTED** — the consumer has parsed a valid manifest and read a claim. The
consumer knows:

> The operator of `manifest.site` states that claim C is supported by text Q,
> which they say appears at URL U, and which they say they last confirmed
> present at time T.

Every element of that is the publisher's word, including T. Nothing has been
observed.

**OBSERVED** — the consumer has retrieved U, extracted its text, and found Q
present under §5 normalization. The consumer now knows:

> Text Q was served from U at time T′ (when the consumer fetched it).

Note what OBSERVED still does not establish: that C is true, that U is
authoritative, or that Q means what the publisher says it means. Retrieval
upgrades provenance, not truth. No state defined here ever establishes that a
claim is true; that is outside what a publisher-authored index can do.

### 9b.2 Operations

| Operation | Minimum state | Notes |
|---|---|---|
| Discover that a publisher makes claim C at all | ASSERTED | This is the manifest's primary purpose |
| Locate the evidence for C without crawling | ASSERTED | The efficiency the format exists to provide |
| Rank, filter or route on C | ASSERTED | Consequences fall on the consumer, are reversible |
| Repeat C to a user **with attribution to the publisher** | ASSERTED | See §9b.4 |
| Repeat C **without attribution**, or as the consumer's own finding | OBSERVED | |
| Use C as a premise in a chain the consumer will act on | OBSERVED | |
| Take an action that is costly, irreversible, or affects a third party | OBSERVED, and see §9b.5 | |

A conforming consumer MUST NOT perform an operation without holding at least
the state that operation requires.

### 9b.3 When ASSERTED is not available

A consumer MUST treat a claim as carrying **no state at all** — neither
ASSERTED nor OBSERVED — when any of the following holds. In that case the claim
conveys only that some bytes were served; it does not even establish a
publisher assertion, because the manifest may not reflect the publisher's
current position:

- the manifest fails schema validation (§14);
- `manifest.verification` is absent;
- `manifest.verification.checked_at` is older than
  `recheck_interval_days`, or older than 365 days when that field is absent;
- the specific evidence record has no `last_seen`, or its `last_seen` is older
  than `checked_at`;
- the manifest was not retrieved over HTTPS from the origin named in
  `manifest.site`.

The last condition matters: a manifest describing origin A but served from
origin B asserts nothing, because the party making the assertion cannot be
identified. Consumers MUST check this.

### 9b.4 Attribution

Repeating an ASSERTED claim to a user requires attribution that makes the
epistemic state recoverable. The attribution MUST identify `manifest.site` as
the source and MUST NOT present the claim as independently established.
Wording is not prescribed; the requirement is that a reader could tell the
difference between "this organisation says X" and "X".

This is the difference between the format being useful and the format
laundering marketing copy into apparent fact.

### 9b.5 What the freshness record cannot do

`manifest.verification` is unauthenticated. It is a field in a document the
publisher controls entirely. A publisher that never runs a check can write
`evidence_present` equal to `evidence_total` and a current `checked_at`. No
part of this specification prevents that.

It is nonetheless load-bearing, for one reason: **it is falsifiable at the cost
of a single request.** Any consumer can retrieve one evidence URL and compare.
A publisher reporting checks it did not run is detectable by the first consumer
that spot-checks, and the cost of detection is that the domain's assertions
stop being worth reading.

Consumers SHOULD spot-check. A reasonable policy is to verify one randomly
chosen evidence record per manifest per fetch, which costs one extra request
and makes systematic fabrication untenable. Consumers that never verify
anything are relying on other consumers doing so.

Three specific limits, stated because implementers will otherwise assume
otherwise:

- **No rollback protection.** A publisher, a compromised CDN, or a stale cache
  can serve an older manifest whose `checked_at` was accurate when written.
  Nothing here detects that. A consumer that has previously seen a manifest
  from an origin SHOULD reject a later one whose `checked_at` is earlier.
- **No binding between the freshness record and the evidence.** `checked_at`
  is not covered by any hash or signature. It is a claim about a process,
  not a commitment to content.
- **`evidence_present` is an aggregate.** It says how many quotes were found
  across the whole manifest, not which. Per-record `last_seen` is the only
  field that speaks to a specific piece of evidence, and it is the one a
  consumer should key on.

### 9b.6 Not machine-checkable

"High-impact" and "hard to reverse" appear in §9b.2 and are properties of the
consumer's situation, not of the manifest. They cannot be tested by a
conformance suite and are therefore guidance, not conformance criteria. The
testable requirements are those in §9b.2 and §9b.3, which depend only on fields
in the document.

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

### 11.1 Version history

**2.0.0** supersedes 1.0.0 and is a breaking change, because a document that
was valid under 1.0.0 may be invalid under 2.0.0: `verification.verified` may
no longer be `true` alongside `method: automatically-generated` (§8). The
canonical location also moved to `/.well-known/ai-evidence.json` (§2.1),
though the 1.0.0 location remains a valid alias.

1.0.0 was published and superseded the same day, after a standards review. It
should not be implemented. A 2.x consumer MUST NOT process a 1.x manifest, per
the rule above — including this one.

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

### 14.1 Conforming manifest

A conforming manifest validates against `schema/ai-evidence-manifest.schema.json`
and satisfies the REQUIRED clauses of this document.

### 14.2 Conforming generator

A conforming generator:

- MUST NOT emit an evidence record whose `text` it did not find, verbatim after
  §5 normalization, in the retrieved source (§9);
- MUST compute `integrity.sha256` over the normalized text (§5);
- MUST encode `locator.fragment` per §5.1;
- MUST mark records it has not had confirmed by a person as
  `method: automatically-generated` with `verified: false` (§8);
- MUST write byte-identical content to every location it serves (§2.1).

Each of these is mechanically testable and exercised by the test suite.

### 14.3 Conforming consumer

A conforming consumer:

- MUST validate against the schema before reading any field;
- MUST treat every field as untrusted input;
- MUST determine epistemic state per §9b.3 before use, and MUST NOT perform an
  operation without the state §9b.2 requires for it;
- MUST attribute an ASSERTED claim to `manifest.site` when repeating it (§9b.4);
- MUST NOT treat any state defined here as establishing that a claim is true;
- MUST NOT execute any content from a manifest;
- MUST reject a manifest served from an origin other than `manifest.site`
  (§9b.3);
- SHOULD reject a manifest whose `checked_at` precedes one it has already seen
  from the same origin (§9b.5);
- SHOULD spot-check at least one evidence record per manifest (§9b.5);
- SHOULD enforce the limits in §10 and the protections in [SECURITY.md](SECURITY.md).

### 14.4 What this specification does not define

Stated so implementers do not assume otherwise:

- **Authentication of the publisher.** There is no signature. A manifest served
  over HTTPS from an origin carries that origin's transport authenticity and
  nothing more. `publisher.same_as` is informational; anyone can list any URL.
- **Rollback detection.** Nothing binds a manifest to a point in time in a way a
  consumer can check. §9b.5 gives a heuristic, not a guarantee.
- **Conflict resolution.** Two claims in one manifest may contradict each other,
  and two manifests from different origins certainly may. This document defines
  no precedence. A consumer encountering a contradiction holds two publisher
  assertions and should treat the contradiction as information.
- **Partial validity.** Validation is all-or-nothing. A manifest with one
  schema-invalid claim is not a manifest with one bad claim; it is an invalid
  document, and §9b.3 gives it no state.
- **Completeness.** A manifest is not a closed-world description. Absence of a
  claim means nothing.
