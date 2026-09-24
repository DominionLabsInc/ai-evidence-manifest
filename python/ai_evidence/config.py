"""Configuration-driven generation.

A publisher maintains roughly ten lines; the claims and their evidence are
found for them. Claims listed under ``pin`` are emitted unchanged and never
replaced by generation, so hand-written entries survive regeneration.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from .extract import EXTRACT_DEFAULTS, extract_from_page, to_manifest
from .fetch_safe import fetch_safe, normalize_input_url

CONFIG_FILENAME = "ai-evidence.config.json"

CONFIG_DEFAULTS = {
    "discover": "sitemap",       # sitemap | links | none
    "include": [],               # path patterns to keep; empty means everything discovered
    "exclude": [],               # path patterns to drop, applied after include
    "types": [],                 # claim types to keep; empty means all
    "maxPages": EXTRACT_DEFAULTS["maxPages"],
    "maxPerType": EXTRACT_DEFAULTS["maxPerType"],
    "claims": "summaries",       # summaries | all
    "pin": [],                   # hand-written claims, always included
}

_ASSET = re.compile(r"\.(pdf|png|jpe?g|gif|svg|webp|zip|xml|json|css|js)$", re.I)


class ConfigError(ValueError):
    def __init__(self, message, code="bad-config"):
        super().__init__(message)
        self.code = code


def _matches(pathname: str, pattern: str) -> bool:
    """`/blog/*` style matching. Deliberately simpler than glob: one wildcard."""
    return re.fullmatch(".*".join(re.escape(p) for p in pattern.split("*")), pathname) is not None


def load_config(file: str = CONFIG_FILENAME) -> dict:
    p = Path(file)
    if not p.exists():
        raise ConfigError(f'no {file} found. Run "ai-evidence init <url>" to create one.',
                          "no-config")
    try:
        parsed = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        raise ConfigError(f"{file} is not valid JSON: {e}")
    if not parsed.get("site"):
        raise ConfigError(f'{file} must have a "site"')

    cfg = {**CONFIG_DEFAULTS, **parsed, "site": normalize_input_url(parsed["site"])}
    for key in ("include", "exclude", "types", "pin"):
        if not isinstance(cfg[key], list):
            raise ConfigError(f'{file}: "{key}" must be an array')
    if cfg["discover"] not in ("sitemap", "links", "none"):
        raise ConfigError(f'{file}: "discover" must be one of sitemap, links, none')
    if cfg["claims"] not in ("summaries", "all"):
        raise ConfigError(f'{file}: "claims" must be "summaries" or "all"')
    return cfg


def write_config(cfg: dict, file: str = CONFIG_FILENAME) -> str:
    Path(file).write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    return file


def init_config(site_input: str) -> dict:
    """Starter config, checking whether the site actually has a sitemap."""
    site = normalize_input_url(site_input)
    parts = urlsplit(site)
    origin = f"{parts.scheme}://{parts.netloc}"
    discover = "links"
    try:
        sm = fetch_safe(urljoin(origin, "/sitemap.xml"), accept="application/xml,text/xml")
        if "<loc>" in sm["body"].lower():
            discover = "sitemap"
    except Exception:
        pass   # absent or unreachable: fall back to following links
    return {
        "site": origin + "/",
        "discover": discover,
        "include": [],
        "exclude": ["/privacy", "/terms", "/legal/*"],
        "types": [],
        "claims": "summaries",
        "maxPages": CONFIG_DEFAULTS["maxPages"],
        "maxPerType": CONFIG_DEFAULTS["maxPerType"],
        "pin": [],
    }


def _discover_urls(cfg: dict) -> list[str]:
    parts = urlsplit(cfg["site"])
    origin = f"{parts.scheme}://{parts.netloc}"
    urls = [cfg["site"]]
    seen = {cfg["site"]}

    if cfg["discover"] == "sitemap":
        try:
            sm = fetch_safe(urljoin(origin, "/sitemap.xml"), accept="application/xml,text/xml")
            for m in re.finditer(r"<loc>\s*([^<\s]+)\s*</loc>", sm["body"], re.I):
                u = m.group(1).strip()
                if u.startswith(origin) and not _ASSET.search(u) and u not in seen:
                    seen.add(u)
                    urls.append(u)
        except Exception:
            pass
    elif cfg["discover"] == "links":
        try:
            home = fetch_safe(cfg["site"], accept="text/html")
            for m in re.finditer(r'<a\b[^>]*href\s*=\s*["\']([^"\'#]+)["\']', home["body"], re.I):
                u = urljoin(cfg["site"], m.group(1)).split("#")[0]
                q = urlsplit(u)
                if f"{q.scheme}://{q.netloc}" != origin or _ASSET.search(q.path):
                    continue
                if u not in seen:
                    seen.add(u)
                    urls.append(u)
        except Exception:
            pass

    kept = []
    for u in urls:
        path = urlsplit(u).path or "/"
        if cfg["include"] and not any(_matches(path, p) for p in cfg["include"]):
            continue
        if any(_matches(path, p) for p in cfg["exclude"]):
            continue
        kept.append(u)
    return kept[: cfg["maxPages"]]


def generate(cfg: dict, on_page=None) -> dict:
    pages = _discover_urls(cfg)
    found: list[dict] = []
    errors: list[dict] = []
    client_rendered: list[dict] = []

    for url in pages:
        try:
            r = extract_from_page(url, {"maxPerType": cfg["maxPerType"], "claims": cfg["claims"]})
            kept = ([c for c in r["candidates"] if c["type"] in cfg["types"]]
                    if cfg["types"] else r["candidates"])
            found.extend(kept)
            note = r.get("note")
            if note and note.get("code") == "client-rendered":
                client_rendered.append({"url": url, "reasons": note["reasons"]})
            if on_page:
                on_page(url, len(kept), None, note)
        except Exception as e:
            errors.append({"url": url, "error": str(e)})
            if on_page:
                on_page(url, 0, str(e), None)

    per_type: dict[str, int] = {}
    capped = []
    for c in found:
        if cfg["maxPerType"]:
            n = per_type.get(c["type"], 0) + 1
            per_type[c["type"]] = n
            if n > cfg["maxPerType"]:
                continue
        capped.append(c)

    parts = urlsplit(cfg["site"])
    manifest = to_manifest(f"{parts.scheme}://{parts.netloc}", capped)
    if cfg["pin"]:
        pinned_ids = {c["id"] for c in cfg["pin"]}
        manifest["claims"] = cfg["pin"] + [c for c in manifest["claims"]
                                           if c["id"] not in pinned_ids]
    return {"manifest": manifest, "pages": pages, "errors": errors,
            "clientRendered": client_rendered, "pinned": len(cfg["pin"]),
            "found": len(capped)}
