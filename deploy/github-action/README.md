# GitHub Action

Validate `ai.json` on every push, and optionally confirm the quoted evidence is still live.

```yaml
name: ai.json
on: [push, pull_request]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: DominionLabsInc/ai-evidence-manifest/deploy/github-action@v1
        with:
          manifest: ai.json
          strict: 'true'
```

## Checking evidence on a schedule

Structural validation belongs on every push. Fetching evidence URLs does not — it is slow and depends on the live site. Run it on a schedule instead, so you find out that a page has drifted away from its manifest before an agent does:

```yaml
name: ai.json drift
on:
  schedule:
    - cron: '0 6 * * 1'     # Mondays, 06:00 UTC
  workflow_dispatch:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: DominionLabsInc/ai-evidence-manifest/deploy/github-action@v1
        with:
          check-evidence: 'true'
```

Exit codes: `0` valid, `1` invalid, `2` usage or transport error.
