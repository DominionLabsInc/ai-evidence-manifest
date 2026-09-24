# AI Evidence Manifest — Specification

**Version 2.1.0** · Status: proposed open web convention · [Apache-2.0](LICENSE)

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
signatures      array     OPTIONAL   detached JWS signatures — see §12
extensions      object    OPTIONAL   namespaced extension data
```

Unknown members MUST be ignored, at the top level and within defined objects.
A consumer MUST NOT reject a document for carrying a member it does not
recognise, and MUST NOT act on one.

This must-ignore rule is what allows a later minor version to add a member
without invalidating every document already published. Version 2.0.0 set
`additionalProperties: false` throughout and so could not have been extended
that way; §12 was added in 2.1.0 only because the schema was relaxed first.
A validator MAY report unknown members as a warning, and the reference
validator does, so that a misspelled member name stays visible.

The single exception is a signature object (§12.3), where unknown members MUST
be rejected.

Publisher-specific data belongs under `extensions`, which is namespaced and
carries no meaning defined here.

### 3.1 `manifest`

| Field | Type | | Notes |
|---|---|---|---|
| `version` | string | REQUIRED | Specification version, semantic versioning, e.g. `2.1.0` |
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

A signature lifts that last condition, and only that one. When the manifest
carries a signature that verifies against a key established for
`manifest.site` per §12.6, the signer is identified directly and the manifest
may be treated as ASSERTED however it was obtained. See §12.8. Every other
condition in this section continues to apply to a signed manifest.

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
  from an origin SHOULD reject a later one whose `checked_at` is earlier. For
  an unsigned manifest this is a heuristic over a field anyone can write; §12.8
  gives a checkable version for signed manifests.
- **No binding between the freshness record and the evidence.** `checked_at`
  is not covered by any hash. It is a claim about a process, not a commitment
  to content. Signing the manifest (§12) makes the record tamper-evident and
  attributable, which is not the same as making it true.
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

Consumers MUST ignore unknown members wherever they appear, except inside a
signature object (§3, §12.3).

### 11.1 Version history

**2.0.0** supersedes 1.0.0 and is a breaking change, because a document that
was valid under 1.0.0 may be invalid under 2.0.0: `verification.verified` may
no longer be `true` alongside `method: automatically-generated` (§8). The
canonical location also moved to `/.well-known/ai-evidence.json` (§2.1),
though the 1.0.0 location remains a valid alias.

1.0.0 was published and superseded the same day, after a standards review. It
should not be implemented. A 2.x consumer MUST NOT process a 1.x manifest, per
the rule above — including this one.

**2.1.0** adds optional signing (§12). It is a minor version: every valid
2.0.0 document remains valid, and `signatures` is OPTIONAL.

It also relaxes unknown members from MUST-reject to MUST-ignore (§3). That
relaxation only widens what validates, so it breaks no existing document — but
it had to happen before signing could be added at all. 2.0.0 declared that
future mechanisms could be introduced without a breaking change while setting
`additionalProperties: false` throughout, which made that promise
unkeepable. A 2.0.0 validator will reject a signed manifest. This is a known
consequence of the 2.0.0 schema, not of anything in 2.1.0, and is the reason
the relaxation is recorded here rather than treated as an editorial change.

## 12. Signing

Signing is OPTIONAL. An unsigned manifest remains fully conforming, and a
consumer MUST NOT reject a manifest for being unsigned.

### 12.1 What a signature establishes, and what it does not

HTTPS already proves that a manifest came from an origin, to the client that
fetched it, at the moment it fetched it. Three things it does not do:

- **It is not transferable.** An agent that retrieves a manifest, stores it, and
  passes a claim to another system has nothing left to show. The transport
  authenticity was consumed at fetch time. §9b.3 therefore withholds ASSERTED
  from any manifest not retrieved over HTTPS from `manifest.site` — which is
  correct, and which makes caching, relaying and multi-hop agent pipelines
  unable to carry publisher assertions at all.
- **It does not order versions.** Every §9b.5 limit on the freshness record
  follows from this.
- **It does not survive the origin.** A consumer that distrusts the web host has
  no other way to establish who spoke.

A signature makes the document itself the evidence. It establishes exactly one
proposition:

> This byte sequence was signed by the holder of key K at time `iat`.

It establishes nothing about the truth of any claim, the authority of any
source, or whether any quoted text is still present at its URL. In particular,
**a signature does not confer OBSERVED status** (§9b.1). Only retrieving the
evidence does that. An implementation that treats "signed" as "verified" has
misread this section.

### 12.2 Canonical form

Signatures are computed over a canonical serialization, so that a document
which is parsed and re-serialized — as any storing consumer will do — still
verifies.

The canonical form is **RFC 8785 (JSON Canonicalization Scheme)**, with three
restrictions. A conforming implementation MUST refuse to canonicalize:

1. any number that is not an integer;
2. any integer outside the IEEE 754 double safe range, that is, outside
   −(2⁵³−1) to 2⁵³−1 inclusive;
3. any string containing an unpaired surrogate code point.

These restrictions exist because RFC 8785 canonicalizes non-integer numbers
with the ECMAScript `Number::toString` algorithm, which independent
implementations reproduce inconsistently at the edges of the range. A
disagreement there produces a valid signature that fails to verify in another
implementation — a failure that is silent, remote, and very hard to diagnose.
Refusing at signing time is preferable. No member defined by this
specification is a non-integer number; only `extensions` (§3) can introduce
one, and a publisher who does MUST be told the document cannot be signed
rather than given a signature of uncertain portability.

Implementations MUST sort object members by UTF-16 code unit, as RFC 8785
requires. This differs from sorting by Unicode code point for characters
outside the Basic Multilingual Plane, and the difference is observable.

### 12.3 The `signatures` member

A signed manifest carries a top-level `signatures` member: a non-empty array of
signature objects, each with exactly two members.

| Field | Type | Required | Notes |
|---|---|---|---|
| `protected` | string | REQUIRED | base64url (unpadded, RFC 7515 §2) of the UTF-8 protected header |
| `signature` | string | REQUIRED | base64url (unpadded) of the 64-byte Ed25519 signature |

Unknown members inside a signature object MUST be rejected. This is the one
place where the must-ignore rule of §3 does not apply: nothing inside a
signature may be silently skipped.

Multiple signatures MAY be present, which is how key rotation and
multi-party attestation work without a format change.

### 12.4 Protected header

The protected header MUST be a JSON object carrying **exactly** these four
parameters, and no others:

| Parameter | Value |
|---|---|
| `alg` | `"EdDSA"` — the only algorithm this version defines |
| `typ` | `"aem-signature+jws"` |
| `kid` | the RFC 7638 JWK thumbprint of the signing key |
| `iat` | signing time, integer seconds since the Unix epoch |

A verifier MUST reject a header carrying any other parameter, and MUST reject
one missing any of these. Ignoring unknown header parameters would let content
be smuggled into a signed region that verifiers skip.

There is no algorithm negotiation. `alg` has exactly one permitted value, so
there is no algorithm-confusion attack and no `none`. A verifier MUST compare
`alg` for string equality and MUST NOT accept a signature on the basis of any
algorithm named in the document.

`typ` is specific to this specification so that a signature produced by the
same key for some other protocol cannot be replayed as a manifest signature.

`iat` is inside the signed header deliberately. It is the only freshness
statement in the format that the publisher cannot backdate after signing and
that a cache cannot forge.

### 12.5 Procedure

The payload is **detached** (RFC 7515 Appendix F): it is not carried in the
serialization, because it is the document itself.

To sign:

1. Remove the top-level `signatures` member, if present.
2. Canonicalize the remainder per §12.2; call the UTF-8 bytes `P`.
3. Build the protected header per §12.4 and canonicalize it; call the UTF-8
   bytes `H`.
4. The JWS signing input is `ASCII(BASE64URL(H) || "." || BASE64URL(P))`.
5. Sign the input with Ed25519 (RFC 8032).
6. Append `{"protected": BASE64URL(H), "signature": BASE64URL(sig)}` to
   `signatures`.

To verify, recompute `P` from the received document and use the `protected`
string **exactly as received** — a verifier MUST NOT re-serialize the header,
because the signature covers the octets that were sent, not their meaning.

A verifier MUST reject a signature when any of the following holds:

- the protected header does not conform to §12.4;
- no key in the key set has the `kid` named in the header;
- the key's RFC 7638 thumbprint does not equal that `kid`;
- the key is not an `OKP` key on curve `Ed25519`;
- `iat` is in the future by more than the verifier's clock-skew allowance
  (RECOMMENDED: 300 seconds);
- the Ed25519 verification fails.

The thumbprint check is not redundant. Without it, `kid` is a label the
attacker chooses, and an attacker able to serve the key set can publish their
own key under an honest key's name.

Because Ed25519 is deterministic (RFC 8032 §5.1.6), the same key, document and
`iat` MUST produce byte-identical signatures in every conforming
implementation. This is a conformance requirement, and the test vectors in
`tests/conformance/signing/` depend on it.

### 12.6 Key discovery

The publisher's key set is a JWKS (RFC 7517) served at:

```
/.well-known/ai-evidence-jwks.json
```

on the same origin as the manifest, with media type
`application/jwk-set+json`. It MUST contain only public keys. Each key MUST
carry `kty: "OKP"`, `crv: "Ed25519"`, `alg: "EdDSA"`, `use: "sig"`, and a `kid`
equal to its RFC 7638 thumbprint.

This anchors key trust in the same web PKI that protects the manifest, which is
enough to make a manifest transferable and version-ordered, but not enough to
survive a compromised web host — an attacker who can replace the manifest can
replace the key set beside it.

A publisher MAY therefore additionally anchor a key in DNS:

```
_ai-evidence.<host>  TXT  "v=aem1; k=ed25519; kid=<thumbprint>; p=<base64url public key>"
```

Fields are semicolon-separated `name=value` pairs. `v` and `k` MUST be present
with exactly these values; `p` MUST be the base64url-encoded 32-byte public
key; `kid`, when present, MUST equal the key's thumbprint and a consumer MUST
reject the record otherwise. Unknown fields MUST be ignored, so later versions
can extend the record.

A consumer that establishes a key from DNS holds it independently of the web
origin, which is the case a signature is most needed for. Resolution is the
consumer's responsibility; this specification defines the record, not a
resolver, and the reference implementations deliberately ship no DNS client.

### 12.7 Rotation and compromise

To rotate, generate a new key, publish both in the JWKS, sign with the new one,
and remove the old one after the longest `max-age` any cache may hold (§2.4).
Both signatures MAY appear on one manifest during the overlap.

There is no revocation mechanism. Removing a key from the JWKS stops it
verifying for consumers that refetch the key set, and does nothing for a
consumer holding a cached copy. A publisher who believes a key is compromised
MUST rotate it and SHOULD assume every manifest that key ever signed remains
verifiable to someone. Consumers SHOULD NOT cache a key set for longer than
they would cache the manifest.

### 12.8 Effect on epistemic state

A valid signature changes exactly one thing in §9b: it makes ASSERTED
**transferable**.

§9b.3 withholds all state from a manifest not retrieved over HTTPS from the
origin named in `manifest.site`, because otherwise the party making the
assertion cannot be identified. When a manifest carries a signature that
verifies against a key established for `manifest.site` per §12.6, the signature
identifies that party directly. A consumer MAY therefore treat such a manifest
as ASSERTED **regardless of how it was obtained** — from a cache, a peer, an
aggregator, or storage.

Everything else in §9b is unchanged. A signature does not confer OBSERVED, does
not make a claim true, and does not license any operation that §9b.2 places
above ASSERTED.

A signature also sharpens §9b.5 in two ways:

- **Version ordering.** A consumer that records the highest `iat` seen for a key
  SHOULD reject a later document from that key with a lower `iat`. This is real
  rollback detection, where §9b.5 could offer only a heuristic over an
  unauthenticated field.
- **Attributable freshness.** `manifest.verification` becomes tamper-evident and
  attributable. A publisher can no longer attribute a false freshness record to
  a cache or an intermediary. The record is still the publisher's own word —
  signing makes a lie attributable, not impossible — but §9b.5's falsifiability
  argument only bites once the liar can be identified.

### 12.9 What signing does not solve

- **Withholding.** An attacker who can serve stale content can decline to serve
  a newer manifest. `iat` establishes an ordering, not a liveness guarantee. A
  consumer that has never seen a fresher document cannot tell it is being held
  back. Detecting that requires a transparency log, which this version does not
  define.
- **A dishonest publisher.** Signing authenticates the speaker, not the speech.
- **`publisher.same_as`.** Still informational. A signature proves who signed,
  not that they control any other listed identity.
- **First contact.** Establishing a key from the JWKS reduces to trusting the
  web host on first fetch. Only the DNS anchor of §12.6 avoids that, and only
  to the extent DNS is trusted.

A content hash is **not** a signature. `integrity.sha256` (§5) detects drift in
one quotation; it does not establish authorship of anything.

## 13. Relationship to existing standards

This convention complements rather than replaces:

| Standard | Purpose | Relationship |
|---|---|---|
| `robots.txt` | Controls crawler access | Untouched. `/ai.json` should not be disallowed. |
| `sitemap.xml` | Describes which URLs exist | Complementary: sitemap lists pages, manifest points inside them. |
| `llms.txt` | Concise LLM-oriented site context and links | Adjacent. `llms.txt` is prose for orientation; this is structured claim→evidence data. |
| Schema.org / JSON-LD | Semantic descriptions of entities | Complementary, and a useful extraction input. A future version may offer a JSON-LD representation. |
| W3C PROV | General provenance model | Conceptually related. `source_type` and `authority` map loosely onto PROV agents and attribution; a formal mapping is future work. |
| RFC 7515 / 7517 / 7638 (JOSE) | Signatures, key sets, key thumbprints | Used directly by §12, in a detached-payload profile restricted to one algorithm. |
| RFC 8785 (JCS) | Canonical JSON | Used directly by §12.2, restricted to integers so two implementations cannot disagree on the signed bytes. |
| RFC 8032 (EdDSA) | Ed25519 signatures | The only signature algorithm this version defines. |
| RFC 9421 (HTTP Message Signatures) | Signing HTTP exchanges | Deliberately **not** used. It signs a response, not a document, so the signature is lost as soon as a consumer stores the JSON — and it requires a dynamic server, which conflicts with publishing a static file alongside `robots.txt`. |

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

A generator that signs additionally:

- MUST canonicalize per §12.2, and MUST refuse to sign a document it cannot
  canonicalize rather than emitting a signature of uncertain portability;
- MUST produce the protected header of §12.4 exactly, with no other parameter;
- MUST produce byte-identical signatures for identical key, document and `iat`
  (§12.5);
- MUST NOT publish private key material in the JWKS (§12.6);
- SHOULD refuse to sign a manifest that does not already validate, since a
  signature over an invalid document only makes the invalidity authentic.

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
  (§9b.3), unless it carries a signature that verifies per §12.5 against a key
  established for `manifest.site` per §12.6;
- MUST, when checking a signature, reject it on any condition listed in §12.5,
  and MUST NOT select a verification algorithm named in the document;
- MUST NOT treat a valid signature as establishing that evidence is present,
  that a claim is true, or as conferring OBSERVED status (§12.1);
- SHOULD record the highest `iat` seen per key and reject a later document from
  that key bearing a lower one (§12.8);
- SHOULD reject a manifest whose `checked_at` precedes one it has already seen
  from the same origin (§9b.5);
- SHOULD spot-check at least one evidence record per manifest (§9b.5);
- SHOULD enforce the limits in §10 and the protections in [SECURITY.md](SECURITY.md).

### 14.4 What this specification does not define

Stated so implementers do not assume otherwise:

- **Authentication of the publisher, when unsigned.** An unsigned manifest
  served over HTTPS carries that origin's transport authenticity and nothing
  more, and that authenticity is not transferable (§12.1). §12 defines optional
  signing; it remains optional, so a consumer cannot assume it.
  `publisher.same_as` is informational whether or not the manifest is signed:
  a signature proves who signed, not that they control any other listed
  identity.
- **Liveness.** §12.8 lets a consumer order two signed manifests and reject the
  older. Nothing lets a consumer detect that a fresher manifest exists and is
  being withheld. That needs a transparency log, which is not defined here.
- **Revocation.** §12.7 defines rotation. There is no mechanism that tells a
  consumer holding a cached key that the key is no longer trusted.
- **Rollback detection, when unsigned.** Nothing binds an unsigned manifest to a
  point in time in a way a consumer can check. §9b.5 gives a heuristic, not a
  guarantee.
- **Conflict resolution.** Two claims in one manifest may contradict each other,
  and two manifests from different origins certainly may. This document defines
  no precedence. A consumer encountering a contradiction holds two publisher
  assertions and should treat the contradiction as information.
- **Partial validity.** Validation is all-or-nothing. A manifest with one
  schema-invalid claim is not a manifest with one bad claim; it is an invalid
  document, and §9b.3 gives it no state.
- **Completeness.** A manifest is not a closed-world description. Absence of a
  claim means nothing.
