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

## What this is not

This matters more than what it is, so it comes first.

- **It is not proof.** A manifest records that a publisher says evidence exists at a location. It says nothing about whether the claim is true.
- **It is not an authority or authentication mechanism.** It establishes no identity and grants no permission.
- **It is not an SEO or ranking device.** It does not make search engines or AI systems trust, cite, rank or include anything.
- **It is not consumed universally.** This is a proposed convention. No search engine or AI system is obliged to read it, and today most do not.

The correct reading of an entry is *"the publisher states the supporting evidence is here"* — never *"this is true because it is in ai.json"*.

## Why it can be trusted mechanically

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

The same property makes automatic generation safe: the extractor only ever emits a quote that it found verbatim in the page's visible text, so it can miss evidence but cannot invent it.

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

Everything found automatically is marked `automatically-generated`. Review it, delete what is not important, and promote what is — a manifest that lists everything is barely better than the crawl it replaces.

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

1. Agent discovers the website.
2. Agent requests `/ai.json`.
3. Agent parses the manifest.
4. Agent identifies the relevant claim.
5. Agent retrieves the referenced evidence.
6. Agent verifies the evidence still exists.
7. Agent evaluates provenance — `source_type`, `authority`, `verification.method`.
8. Agent uses the evidence in its reasoning.

The manifest reduces evidence-discovery work. It does not remove the need for verification appropriate to how the information will be used.

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

Version 1.0.0 of the specification. A **proposed open web convention** — not a W3C standard, and not endorsed by any standards body.

Feedback on the data model, the security model and the discovery mechanism is the most useful thing you can contribute. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE).
