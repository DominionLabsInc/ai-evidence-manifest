# Security model

## Reporting a vulnerability

Open a [private security advisory](https://github.com/DominionLabsInc/ai-evidence-manifest/security/advisories/new). Please do not open a public issue for an unfixed vulnerability. We aim to acknowledge within five working days.

---

## The central rule

**A manifest is untrusted input from a third party, in every case.**

That includes a manifest served from a site you believe you trust. A site can be compromised, a CDN can be poisoned, and a publisher can simply be wrong. Anything a consumer does with manifest contents must be safe under the assumption that an attacker wrote the file.

## What a manifest is not

A conforming consumer MUST NOT treat a manifest as any of the following:

- **An authorization mechanism.** It grants no access and carries no permissions.
- **Cryptographic proof of truth.** A SHA-256 over quoted text detects drift; it proves nothing about authorship or accuracy.
- **An identity mechanism.** `publisher.same_as` is informational. Anyone can list any URL.
- **Independent verification.** `verification.method: publisher-confirmed` means the publisher said so, and nothing more.

Consumers MUST NOT treat publisher assertions as independently verified facts. That does not mean refetching every source: a manifest records the result of checking its own evidence (§8), and a consumer that repeats all of it gains nothing over crawling. Retrieve the source when the freshness record says to — stale, incomplete, or no `last_seen` on the entry — and when a decision is high-impact and hard to reverse. Spot-checking a single quote is cheap and is what keeps the publisher's record honest.

## Obligations for consumers

### Fetching referenced evidence

Evidence URLs are attacker-controlled strings. Fetching them naively turns a consumer into a request proxy.

- **Prevent SSRF.** Resolve the hostname and refuse any address outside public unicast space: loopback, link-local (including `169.254.169.254`, the cloud metadata endpoint), RFC 1918 private ranges, CGNAT, multicast and reserved ranges, plus IPv6 equivalents — unique-local, link-local, and IPv4-mapped forms. Note that the WHATWG URL parser rewrites `::ffff:127.0.0.1` to `::ffff:7f00:1`, so match on parsed address bits, never on the textual form.
- **Re-check every redirect hop.** A public hostname may redirect to `127.0.0.1`. Validate the target of each hop, not just the first URL.
- **Require HTTPS.** The schema rejects `http://` so a manifest cannot induce plaintext fetches.
- **Reject credentials in URLs** (`https://user:pass@host/`).
- **Impose limits:** response size, request timeout, redirect count, and total URLs fetched per manifest.

The reference implementation does all of the above in [`reference-implementation/fetch-safe.js`](reference-implementation/fetch-safe.js), and the test suite asserts each protection.

### Handling manifest content

- **Never execute anything.** A manifest contains data. No field is code, and no field may be evaluated, templated into a script context, or passed to a shell.
- **Sanitize before rendering.** `claim` and `text` are arbitrary publisher strings and routinely contain markup characters. Escape on output. The format stores text; it never carries markup for rendering.
- **Validate against the schema first.** Do not read fields from an unvalidated document.
- **Enforce size and count limits** before parsing where possible, and certainly before iterating.
- **Bound recursion.** v1 defines no manifest-to-manifest references. If a future extension adds them, consumers must cap depth and detect cycles. A manifest that references itself must not cause unbounded work.

### Epistemic state

The specification defines two states and what each licenses; see
[SPEC.md §9b](SPEC.md). The security-relevant summary:

- A manifest conveys a **publisher assertion** and nothing stronger. Retrieval
  of the evidence upgrades that to an **observation** of provenance. No state
  defined anywhere establishes that a claim is true.
- Several conditions void even the assertion — schema failure, a missing or
  stale freshness record, a missing `last_seen`, or a manifest served from an
  origin other than `manifest.site`. That last one matters: a manifest
  describing origin A but served from origin B identifies no asserting party.
  Consumers MUST check it.
- `manifest.verification` is unauthenticated and can be fabricated wholesale.
  Its value is that it is falsifiable for one request. Spot-check one record per
  manifest; a consumer that never verifies anything is relying on other
  consumers to do it.
- There is no rollback protection for an unsigned manifest. An older one can be
  replayed. Reject a `checked_at` earlier than one already seen from that
  origin. For a signed manifest, `iat` is inside the signature: record the
  highest you have seen per key and reject a lower one (SPEC §12.8).
- **A signature authenticates the speaker, not the speech.** It establishes that
  a document was signed by the holder of a key at a stated time. It does not
  establish that any claim is true, that any evidence is present, or that the
  publisher checked anything. Treating "signed" as "verified" is the single
  most likely way to misuse this format.
- When checking a signature, reject anything not matching SPEC §12.5 exactly,
  and never select an algorithm named in the document. A verifier that honours
  `alg` from the header it is verifying has no security at all.

### Trust signals, in order of weight

1. Did you fetch the evidence yourself and find the quoted text present? — strongest, and rarely necessary.
2. Is `manifest.verification` recent, with `evidence_present` equal to `evidence_total`, and does this entry carry a `last_seen`? — the normal basis for relying on a claim.
3. Does `integrity.sha256` match the normalized text, if you retrieved it?
4. Is `source_type` `first-party` and same-origin with `manifest.site`?
5. What is `authority`, and does it match the nature of the claim?

A valid signature sits alongside this list rather than inside it. It does not
raise a claim's standing; it tells you **who** the claim belongs to, and lets
that survive the document being stored and passed on. An unsigned manifest you
fetched yourself over HTTPS and a signed manifest handed to you by a peer carry
the same epistemic weight.

A manifest entry with none of the above verified is a publisher assertion with a URL attached. Weight it accordingly.

## Obligations for publishers

- **Never place secrets in a manifest.** No credentials, API keys, tokens, internal hostnames, unreleased information or personal data. `/ai.json` is a public file, intended to be read by crawlers.
- **Only reference content you publish**, or clearly mark it with the appropriate `source_type`.
- **Regenerate after content changes.** A stale manifest that quotes text no longer on the page will fail verification and reflects badly on the site.
- **Do not overstate verification.** Marking machine output as `publisher-confirmed` destroys the only signal that distinguishes reviewed from unreviewed entries.
- **If you sign, guard the key.** `ai-evidence keygen` writes the private key
  mode `0600`; it belongs outside the repository and outside the published
  directory. Publish only the JWKS. There is no revocation (SPEC §12.7): a
  compromised key can be rotated, but every manifest it ever signed stays
  verifiable to anyone holding a cached copy of the key set.
- **Do not sign a manifest you have not validated.** A signature over an invalid
  document only makes the invalidity authentic. The reference tooling refuses.

## Threat model summary

| Threat | Mitigation |
|---|---|
| Manifest claims something false | Out of scope by design — the format records provenance, not truth. Consumers verify. |
| Evidence URL points at internal infrastructure | SSRF guards, per-hop redirect checks, HTTPS-only |
| Redirect to an internal address | Every hop re-validated |
| Oversized manifest or evidence page | Size limits enforced while streaming, not from `Content-Length` alone |
| XSS via `claim` or `text` | Treated as inert text; consumers escape on output |
| Script injection via referenced page | HTML is parsed with parse5 and `script`, `style`, `noscript`, `template`, `svg`, `iframe` and `object` subtrees are discarded before any text is read. Nothing is evaluated. |
| Mis-parsed markup causing false drift reports | A spec-compliant parser is used rather than regular expressions, so attributes containing `>`, unclosed tags and implied elements do not corrupt extracted text |
| Hand-edited manifest | Offline hash check detects text/hash inconsistency |
| Page drifts away from manifest | Online check detects that the quote is no longer present |
| Fabricated quote from a generator | Generators MUST verify verbatim presence before emitting |
| Manifest claims to be independently verified | `verified: true` with `automatically-generated` is flagged |
| Manifest modified in storage or in transit after retrieval | Optional signature over RFC 8785 canonical JSON; any covered byte changing invalidates it (SPEC §12) |
| Signature replayed from another protocol by the same key | `typ` is specific to this specification and MUST match |
| Algorithm confusion, or `alg: none` | One permitted algorithm, compared for equality; no negotiation |
| Attacker publishes their own key under an honest `kid` | `kid` MUST equal the key's RFC 7638 thumbprint, and verifiers check it |
| Content smuggled into a signed region verifiers skip | The protected header must carry exactly four parameters; unknown ones are rejected |
| Two implementations disagreeing on the signed bytes | Canonicalization refuses every value whose canonical form is not provably portable, and a deterministic test vector pins both implementations |
| Compromised web host replaces manifest and key set together | Not mitigated by the JWKS alone. Optional DNS anchor (SPEC §12.6) establishes the key independently of the web origin |

## Known limitations

Stated plainly, because a security document that only lists strengths is not useful:

- **Content rendered solely by client-side JavaScript is invisible** to the reference extractor and validator, because both fetch HTML rather than running a browser. Evidence on such pages appears absent. This fails safe — evidence is missed, never fabricated — but it is a real gap, so `extract` and `generate` detect the condition and say so rather than silently reporting no claims. Point the config at server-rendered URLs, or generate from build output.
- **Signing is optional, so a consumer cannot assume it.** An unsigned manifest served over HTTPS inherits transport authenticity and nothing more, and that authenticity is not transferable: once the document is stored or relayed, nothing identifies who published it. SPEC §12 defines signing; SPEC §9b.3 states what an unsigned manifest does and does not convey.
- **Signing does not detect a withheld update.** `iat` orders two documents you have both seen. A consumer that has never been served a fresher manifest cannot tell one is being held back. Detecting that needs a transparency log, which is not defined.
- **There is no revocation.** Removing a key from the JWKS stops it verifying for consumers that refetch the key set, and does nothing for one holding a cached copy.
- **First contact still trusts the web host.** Establishing a key from the JWKS reduces to the same TLS trust that protects the manifest. Only the DNS anchor avoids that, and only as far as DNS is trusted.
- **DNS rebinding is not fully mitigated.** Addresses are checked at resolution time; a hostile resolver could return a different answer on a subsequent connection. Consumers needing a stronger guarantee should pin the resolved address for the duration of the request.
