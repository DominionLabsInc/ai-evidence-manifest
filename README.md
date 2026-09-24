# AI Evidence Manifest

**AI Evidence Manifest is an open specification for publishing machine-readable relationships between important website claims and the first-party evidence supporting them.**

```
Claim
  ↓
Evidence
  ↓
Source
  ↓
Provenance
```

You add one file to your site, the same way you add `robots.txt` or `sitemap.xml`:

```
/robots.txt                         what crawlers may fetch
/sitemap.xml                        which pages exist
/.well-known/ai-evidence.json       which claims matter, and where the evidence is
```

It is a plain static file. Nothing runs, nothing is added to your pages, no account and no service is involved.

```jsonc
{
  "manifest": { "version": "2.0.0", "site": "https://example.com" },
  "claims": [
    {
      "id": "capability-autonomous-ai",
      "type": "capability",
      "claim": "The company develops autonomous AI systems.",
      "evidence": [
        {
          "url": "https://example.com/research",
          "text": "Our research program develops autonomous AI systems.",
          "integrity": { "sha256": "f1d2…" },
          "source_type": "first-party",
          "authority": "publisher",
          "verification": { "verified": true, "verified_at": "2026-09-24", "method": "publisher-confirmed" }
        }
      ]
    }
  ]
}
```

You do not write that by hand unless you want to. You write a short config once, and the claims and their evidence are found for you:

```bash
ai-evidence init https://example.com   # writes ai-evidence.config.json, ~10 lines
ai-evidence generate                   # reads your site, writes ai.json
```

```jsonc
// ai-evidence.config.json — the only file you maintain
{
  "site": "https://example.com/",
  "discover": "sitemap",
  "exclude": ["/privacy", "/terms"],
  "types": ["organization", "capability", "product", "service", "technical_claim", "certification"],
  "maxPerType": 6,
  "pin": []
}
```

Commit `ai.json`, serve it at your site root, and regenerate when your content changes.

## The problem

Autonomous agents frequently need to locate and evaluate evidence before using information from a website. Conventional webpages require agents to search, navigate, extract, and interpret information. AI Evidence Manifest provides a lightweight index that points agents directly toward publisher-identified evidence.

On a real 13-page site, a reviewed manifest is roughly **15 KB against 499 KB to crawl everything** — and it points at the claims that matter rather than the cookie policy.

## Why it is verifiable

An entry states **where the publisher says the supporting evidence is**. That is a narrower claim than "this is true", and the narrowness is the point: it is a claim a machine can actually check.

Every evidence record carries the **exact quoted text** and a **SHA-256 of that text** under a fixed normalization. A consumer can therefore:

1. fetch the referenced URL,
2. check the quoted text is still present,
3. recompute the hash,

and detect a page that has drifted away from its manifest. The reference validator does exactly this:

```
$ ai-evidence check https://example.com/ai.json

  7 claims · 8 evidence records · 8/8 URLs reachable · 8 quotes still present
  VALID  0 error(s), 0 warning(s)
```

The same property makes automatic generation safe: the extractor only ever emits a quote it found verbatim in the page's visible text, so it can miss evidence but cannot invent it.

For what a consumer should and should not infer from an entry, see [SPEC.md §1](SPEC.md) and [SECURITY.md](SECURITY.md).

## Install

| | |
|---|---|
| **npx** — nothing to install | `npx ai-evidence generate` |
| **npm** | `npm install -g ai-evidence` |
| **pip** | `pip install ai-evidence` |
| **Homebrew** | `brew tap dominionlabsinc/tap && brew install ai-evidence` |
| **Docker** | `docker run --rm -v "$PWD:/work" ghcr.io/dominionlabsinc/ai-evidence generate` |
| **From source** | `git clone … && npm install && npm link` |

> npm and PyPI are live. Homebrew and the container image are packaged but not
> yet published; use the npm or pip install above.

The Python and JavaScript implementations are equivalent — same commands, same
output. A conformance suite runs both over the same corpus and requires
byte-identical results, so either is a faithful implementation of the spec.
Pick whichever fits your build.

## Quick start

```bash
ai-evidence init https://example.com   # write ai-evidence.config.json
ai-evidence generate                   # read the site, write ai.json
ai-evidence check ai.json --update     # re-verify, record freshness
```

Commit `ai.json`, serve it at your site root, and re-run `generate` when your
content changes. `ai-evidence repair ai.json` relocates quotes that have
drifted; anything it cannot confidently relocate it reports rather than
patches.

Everything found automatically is marked `automatically-generated`. Every quote
is read out of the live page and confirmed present, so the evidence is verified
before it reaches the file. What a person adds is judgement: which claims
matter, and whether the types are right.

Claims you write by hand go in `pin` in the config. They are emitted first and
never overwritten by regeneration.

## Publishing

Serve it at the site root as a normal, publicly accessible static resource, so crawlers and agents can read it like `robots.txt`:

```
GET /ai.json
Content-Type: application/json
Access-Control-Allow-Origin: *
```

Do not put it behind authentication, and do not `Disallow` it in `robots.txt`. See [deploy/](deploy/) for per-platform instructions.

Optional discovery hints:

```html
<link rel="ai-evidence" href="/ai.json">
```

```
Link: </ai.json>; rel="ai-evidence"
```

## How an agent uses it

```
GET /.well-known/ai-evidence.json
```

What that gets you is a **publisher assertion**: this organisation says claim C
is supported by quote Q at URL U, and says it last confirmed Q present at time
T. Every part of that, including T, is the publisher's word.

That is genuinely useful — it is how an agent learns what a site claims, and
where the support is, without crawling. It is not the same as knowing C is
true, and the specification is precise about the difference because getting it
wrong in either direction ruins the format.

**Retrieval is what changes the state.** Fetch U, find Q, and you have moved
from *the publisher says Q is there* to *Q was there*. That still does not make
C true; it makes the provenance observed rather than asserted.

Roughly:

| You want to | You need |
|---|---|
| Find what a site claims, and where the evidence is | the manifest |
| Rank, filter or route on a claim | the manifest |
| Repeat a claim **attributed to the publisher** | the manifest |
| Repeat it as your own finding, or act on it | fetch the evidence |

[SPEC.md §9b](SPEC.md) states this as a protocol rather than a rule of thumb:
two named states, which operations each licenses, and the exact conditions
under which a manifest conveys no state at all.

**The freshness record is falsifiable, not trustworthy.** `manifest.verification`
says how many quotes the publisher last found present, and when. A publisher
that never checks can write whatever it likes there. What makes it useful is
that any consumer can disprove it with one request — so spot-check. A consumer
that verifies one random record per manifest costs itself almost nothing and
makes systematic fabrication untenable.

## Repository

| Path | Contents |
|---|---|
| [`SPEC.md`](SPEC.md) | The normative specification |
| [`schema/`](schema/) | JSON Schema (draft 2020-12) |
| [`examples/`](examples/) | A complete worked example and a minimal one |
| [`reference-implementation/`](reference-implementation/) | JavaScript library: normalize, fetch, extract, validate, repair |
| [`python/`](python/) | Python implementation, same behaviour |
| [`shared/`](shared/) | Patterns and thresholds both implementations load |
| [`validator/`](validator/) | `ai-evidence` command-line tool |
| [`tests/`](tests/) | Test suite and fixtures |
| [`deploy/`](deploy/) | Deployment recipes |
| [`SECURITY.md`](SECURITY.md) | Threat model and consumer obligations |

## Status

Version 1.0.0 of the specification. A **proposed open web convention**, published under Apache-2.0 so it can be implemented, criticised and improved by anyone. It is not a W3C standard.

Feedback on the data model, the security model and the discovery mechanism is the most useful thing you can contribute. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[Apache-2.0](LICENSE), for everything: the specification, the schema, both
reference implementations, the examples.

A convention is worth nothing if implementing it requires permission. Write
your own generator, validator or consumer in any language, for any purpose,
commercial or not. The patent grant is part of that guarantee.
