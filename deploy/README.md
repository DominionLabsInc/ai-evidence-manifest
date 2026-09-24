# Deploying `/ai.json`

`ai.json` is a static file. Put it at the site root and serve it like `robots.txt`.

Three things matter regardless of platform:

1. **`Content-Type: application/json`**
2. **`Access-Control-Allow-Origin: *`** — browser-based agents cannot read it otherwise
3. **Publicly reachable** — no authentication, and not `Disallow`ed in `robots.txt`

A short `Cache-Control` (an hour or so) is sensible. Agents should see content changes reasonably soon after you publish them.

Verify after deploying:

```bash
ai-evidence check https://example.com/ai.json
curl -sI https://example.com/ai.json | grep -iE 'content-type|access-control'
```

---

## Any static site

Copy `ai.json` next to `index.html`. Most static hosts infer `Content-Type` from the `.json` extension; confirm with the `curl` above.

## GitHub Pages

Place `ai.json` at the repository root (or in `/docs` if that is your Pages source). GitHub Pages serves `.json` as `application/json` and sets permissive CORS. No configuration needed.

## Cloudflare Pages

Drop `ai.json` in your output directory. To set headers explicitly, add `_headers`:

```
/ai.json
  Content-Type: application/json
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=3600
```

## Cloudflare Workers

Serving a manifest held in the Worker itself:

```js
import manifest from './ai.json';

export default {
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname !== '/ai.json') return fetch(request);
    return new Response(JSON.stringify(manifest), {
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=3600'
      }
    });
  }
};
```

## Netlify

Add to `netlify.toml`:

```toml
[[headers]]
  for = "/ai.json"
  [headers.values]
    Content-Type = "application/json"
    Access-Control-Allow-Origin = "*"
    Cache-Control = "public, max-age=3600"
```

## Vercel

Add to `vercel.json`:

```json
{
  "headers": [
    {
      "source": "/ai.json",
      "headers": [
        { "key": "Content-Type", "value": "application/json" },
        { "key": "Access-Control-Allow-Origin", "value": "*" },
        { "key": "Cache-Control", "value": "public, max-age=3600" }
      ]
    }
  ]
}
```

## nginx

```nginx
location = /ai.json {
    default_type application/json;
    add_header Access-Control-Allow-Origin "*";
    add_header Cache-Control "public, max-age=3600";
}
```

## Apache

```apache
<Files "ai.json">
    ForceType application/json
    Header set Access-Control-Allow-Origin "*"
    Header set Cache-Control "public, max-age=3600"
</Files>
```

## Application servers

If your site is served by an application rather than a file server, add an explicit route. Some frameworks only serve static files from a designated directory and will otherwise return the application's 404 for an unknown root path.

```js
// Express
app.get('/ai.json', (req, res) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' });
  res.type('application/json').sendFile(path.join(__dirname, 'ai.json'));
});
```

```python
# FastAPI
@app.get("/ai.json")
async def ai_manifest():
    return FileResponse("ai.json", media_type="application/json",
                        headers={"Access-Control-Allow-Origin": "*",
                                 "Cache-Control": "public, max-age=3600"})
```

## Keeping it current

A manifest quoting text that has since changed will fail verification. Regenerate when content changes — see [`github-action/`](github-action/) for a workflow that validates on every push and can fail the build on drift.

## Discovery hints (optional)

```html
<link rel="ai-evidence" href="/ai.json">
```

```
Link: </ai.json>; rel="ai-evidence"
```

Neither is required. `/ai.json` is the primary mechanism.
