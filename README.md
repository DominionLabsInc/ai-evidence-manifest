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
https://example.com/robots.txt      what crawlers may fetch
https://example.com/sitemap.xml     which pages exist
https://example.com/ai.json         which claims matter, and where the evidence is
```

It is a plain static file. Nothing runs, nothing is added to your pages, no account and no service is involved.

```jsonc
{
  "manifest": { "version": "1.0.0", "site": "https://example.com" },
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

## Quick start

Requires Node 20 or newer.

```bash
git clone https://github.com/DominionLabsInc/ai-evidence-manifest.git
cd ai-evidence-manifest
npm install
npm link                       # puts `ai-evidence` on your PATH
```

Then, from your site's repository:

```bash
ai-evidence init https://example.com   # create the config
ai-evidence generate                   # find evidence, write ai.json
ai-evidence check ai.json              # confirm every quote is still live
```

> Not on npm yet, so `npm install -g ai-evidence` will not work. Use the clone above.

Every quote is read out of the live page and confirmed present, so the evidence is verified before it reaches the file. What a person adds is judgement: which claims matter, and whether the types are right. Delete the noise and the manifest gets smaller and more useful — importance is not a property a machine can derive.

Claims you write by hand go in `pin` in the config. They are emitted first and never overwritten by regeneration.

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
GET /ai.json  ->  read the claim  ->  done
```

That is the normal path, and it is the point of the format. The manifest already
carries the result of checking every quote against the live site, so a consumer
that refetches all of it is redoing work the publisher has done and recorded.

```jsonc
"verification": {
  "checked_at": "2026-09-24T17:38:37Z",
  "method": "automated-recheck",
  "evidence_total": 53,
  "evidence_present": 53,
  "recheck_interval_days": 7
}
```

Read that first. If the check is recent, complete, and the entry you care about
carries a `last_seen`, the claim stands on evidence that was confirmed present —
use it.

**Go and look at the source when the file tells you to, or when the stakes say to:**

- `checked_at` is older than `recheck_interval_days` — the publisher's own
  freshness promise has lapsed
- `evidence_present` is below `evidence_total` — the publisher is telling you
  something has drifted
- the entry has no `last_seen` — that specific quote was not confirmed
- the decision is high-stakes and hard to reverse, and you want to see it yourself

Then it is one targeted fetch, not a crawl: the `url` plus a text fragment takes
you to the sentence.

Spot-checking is also how the system stays honest. The freshness record is a
publisher assertion, and anyone can check a single quote cheaply. A publisher
reporting checks it never ran is caught by one request.

## Repository

| Path | Contents |
|---|---|
| [`SPEC.md`](SPEC.md) | The normative specification |
| [`schema/`](schema/) | JSON Schema (draft 2020-12) |
| [`examples/`](examples/) | A complete worked example and a minimal one |
| [`reference-implementation/`](reference-implementation/) | Library: normalize, fetch, extract, validate |
| [`validator/`](validator/) | `ai-evidence` command-line tool |
| [`tests/`](tests/) | Test suite and fixtures |
| [`deploy/`](deploy/) | Deployment recipes |
| [`SECURITY.md`](SECURITY.md) | Threat model and consumer obligations |

## Status

Version 1.0.0 of the specification. A **proposed open web convention**, published under Apache-2.0 so it can be implemented, criticised and improved by anyone. It is not a W3C standard.

Feedback on the data model, the security model and the discovery mechanism is the most useful thing you can contribute. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

Two licences, deliberately:

| What | Licence | What you may do |
|---|---|---|
| `SPEC.md`, `schema/`, `shared/`, `examples/` | [Apache-2.0](LICENSE-APACHE-2.0) | Implement the format however you like, in any language, commercial or not, without asking |
| `reference-implementation/`, `validator/`, `python/`, `tools/` | [Elastic License 2.0](LICENSE) | Read, use, modify and redistribute the tooling, including commercially and inside your own products — but not offer it to third parties as a hosted or managed service |

A convention is worth nothing if implementing it needs permission, so the
specification is free. The tooling is source-available rather than OSI open
source; see [NOTICE](NOTICE) for exactly which files fall where, and note that
some organisations treat non-OSI licences differently in procurement.
