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

Consumers MUST NOT treat publisher assertions as independently verified facts, and SHOULD retrieve the referenced source before relying on a high-impact claim.

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

### Trust signals, in order of weight

1. Did you fetch the evidence yourself and find the quoted text present? — strongest.
2. Does `integrity.sha256` match the normalized text you retrieved?
3. Is `source_type` `first-party` and same-origin with `manifest.site`?
4. What is `authority`, and does it match the nature of the claim?
5. What is `verification.method`, and how old is `verified_at`?

A manifest entry with none of the above verified is a publisher assertion with a URL attached. Weight it accordingly.

## Obligations for publishers

- **Never place secrets in a manifest.** No credentials, API keys, tokens, internal hostnames, unreleased information or personal data. `/ai.json` is a public file, intended to be read by crawlers.
- **Only reference content you publish**, or clearly mark it with the appropriate `source_type`.
- **Regenerate after content changes.** A stale manifest that quotes text no longer on the page will fail verification and reflects badly on the site.
- **Do not overstate verification.** Marking machine output as `publisher-confirmed` destroys the only signal that distinguishes reviewed from unreviewed entries.

## Threat model summary

| Threat | Mitigation |
|---|---|
| Manifest claims something false | Out of scope by design — the format records provenance, not truth. Consumers verify. |
| Evidence URL points at internal infrastructure | SSRF guards, per-hop redirect checks, HTTPS-only |
| Redirect to an internal address | Every hop re-validated |
| Oversized manifest or evidence page | Size limits enforced while streaming, not from `Content-Length` alone |
| XSS via `claim` or `text` | Treated as inert text; consumers escape on output |
| Script injection via referenced page | Extraction discards `script`, `style`, `noscript`, `template` and `svg` before reading text |
| Hand-edited manifest | Offline hash check detects text/hash inconsistency |
| Page drifts away from manifest | Online check detects that the quote is no longer present |
| Fabricated quote from a generator | Generators MUST verify verbatim presence before emitting |
| Manifest claims to be independently verified | `verified: true` with `automatically-generated` is flagged |

## Known limitations

Stated plainly, because a security document that only lists strengths is not useful:

- **Content rendered solely by client-side JavaScript is invisible** to the reference extractor and validator. Evidence on such pages will appear absent. This fails safe — evidence is missed, never fabricated — but it is a real gap.
- **HTML reading is regex-based, not a full parser.** Pathological markup may be read imperfectly. Again, failure means a missed or unconfirmed quote.
- **No signing in v1.** A manifest served over HTTPS inherits transport authenticity and nothing more. Anyone who can modify the file can rewrite it.
- **DNS rebinding is not fully mitigated.** Addresses are checked at resolution time; a hostile resolver could return a different answer on a subsequent connection. Consumers needing a stronger guarantee should pin the resolved address for the duration of the request.
