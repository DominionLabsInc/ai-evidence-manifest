"""Deterministic extraction: find claims and the quotes that support them.

The invariant that makes automatic extraction safe: a candidate is only ever
emitted if its text is present in the page's own visible text. Nothing is
summarised, paraphrased or invented, so extraction can miss evidence but cannot
fabricate it.

Claims themselves are summaries the publisher already wrote — a schema.org
description or a meta description — with the matching quotes clustered
beneath. Generating a summary is not something this tool can do
deterministically; most pages already contain one.
"""
from __future__ import annotations

import re
import unicodedata
from datetime import date, datetime, timezone
from urllib.parse import urljoin, urlsplit

from .fetch_safe import fetch_safe
from .html import (extract_blocks, extract_json_ld, extract_meta, extract_text,
                   extract_title, looks_client_rendered)
from .normalize import (contains_normalized, normalize_text, sha256_of_text,
                        text_fragment)
from .patterns import (ATOMIC_TYPES, CLAIM_PATTERNS, GATES, SCHEMA_TYPE_MAP,
                       SENTENCE, T)

EXTRACT_DEFAULTS = {
    "maxPages": 20,
    "maxCandidatesPerPage": T["maxCandidatesPerPage"],
    "maxPerType": T["maxPerType"],
    "minSentenceChars": T["minSentenceChars"],
    "maxSentenceChars": T["maxSentenceChars"],
    "claims": "summaries",
}

SUPPORT_THRESHOLD = T["supportThreshold"]
MAX_EVIDENCE_PER_CLAIM = T["maxEvidencePerClaim"]
_WORDS = re.compile(r"[^\W\d_]{3,}", re.UNICODE)
_TOKENS = re.compile(r"[^\W\d_]+|\d+", re.UNICODE)


def _assert_present(page_text: str, candidate: str) -> bool:
    return contains_normalized(page_text, candidate)


def _today() -> str:
    return date.today().isoformat()


# ----------------------------------------------------------------- sentences

def split_sentences(text: str) -> list[str]:
    parts = SENTENCE["splitAfter"].split(text)
    out: list[str] = []
    for part in parts:
        if part is None:
            continue
        prev = out[-1] if out else None
        # Re-join after an abbreviation, or after a single capital letter (an
        # initial, as in "Stefan R. Ragland").
        if prev is not None and (SENTENCE["abbreviations"].search(prev)
                                 or SENTENCE["initial"].search(prev)):
            out[-1] = f"{prev} {part}"
        else:
            out.append(part)
    return [s.strip() for s in out if s and s.strip()]


# --------------------------------------------------------------------- gates

def is_boilerplate(text: str) -> bool:
    """Sentences that are grammatical and useless as claims."""
    if GATES["obfuscatedValue"].search(text):
        return True
    if (GATES["selfReferential"].search(text) or GATES["consentFormula"].search(text)
            or GATES["governedBy"].search(text)):
        return True
    if GATES["danglingReference"].search(text):
        return True
    letters = re.sub(r"[^^\W\d_]", "", text) if False else "".join(
        ch for ch in text if ch.isalpha())
    if len(letters) > T["minUppercaseSampleChars"]:
        upper = sum(1 for ch in letters if ch.isupper())
        if upper / len(letters) > T["uppercaseRatioLimit"]:
            return True
    return False


# --------------------------------------------------------------------- tiers

def _tier1(page_text: str, jsonld: list[dict]) -> list[dict]:
    out = []
    for node in jsonld:
        raw_type = node.get("@type")
        if isinstance(raw_type, list):
            raw_type = raw_type[0] if raw_type else None
        ctype = SCHEMA_TYPE_MAP.get(raw_type)
        if not ctype:
            continue
        name = node.get("name") or node.get("headline")
        if not isinstance(name, str) or not name.strip():
            continue
        for field in ("description", "abstract", "disambiguatingDescription"):
            value = node.get(field)
            if isinstance(value, str) and value.strip() and _assert_present(page_text, value.strip()):
                v = value.strip()
                out.append({"tier": 1, "type": ctype, "claim": v, "text": v,
                            "why": f"schema.org {raw_type}.{field}", "block": None})
                break
        # A bare name is not a claim: it restates the markup.
    return out


def _tier2(blocks: list[dict], o: dict) -> list[dict]:
    out = []
    for block in blocks:
        if block["tag"] in ("h1", "h2", "h3", "h4"):
            continue
        for sentence in split_sentences(block["text"]):
            if not (o["minSentenceChars"] <= len(sentence) <= o["maxSentenceChars"]):
                continue
            hit = next(((t, p) for t, p in CLAIM_PATTERNS if p.search(sentence)), None)
            if not hit:
                continue
            out.append({"tier": 2, "type": hit[0], "claim": sentence, "text": sentence,
                        "why": f"pattern:{hit[0]}", "block": block})
    return out


# ----------------------------------------------------------------- summaries

def _publisher_summaries(html: str, meta: dict, blocks: list[dict]) -> list[dict]:
    out = []
    for node in extract_json_ld(html):
        raw_type = node.get("@type")
        if isinstance(raw_type, list):
            raw_type = raw_type[0] if raw_type else None
        for field in ("description", "abstract", "disambiguatingDescription"):
            v = node.get(field)
            if isinstance(v, str) and len(v.strip()) >= T["minSummaryChars"]:
                out.append({"text": v.strip(), "source": "schema.org",
                            "type": SCHEMA_TYPE_MAP.get(raw_type)})
    for key in ("description", "og:description"):
        v = meta.get(key)
        if v and len(v) >= T["minSummaryChars"]:
            out.append({"text": v, "source": "meta", "type": None})
    for lead in _section_leads(blocks):
        out.append({"text": lead, "source": "heading", "type": None})

    # A schema.org description and a meta description are often near-copies.
    deduped: list[dict] = []
    for s in out:
        dupe = next((d for d in deduped if _overlap(d["text"], s["text"]) > T["summaryDedupeThreshold"]), None)
        if dupe is None:
            deduped.append(s)
        elif len(s["text"]) > len(dupe["text"]):
            deduped[deduped.index(dupe)] = s
    return deduped


def _section_leads(blocks: list[dict]) -> list[str]:
    """First sentence of the first paragraph following each heading."""
    leads = []
    for i, b in enumerate(blocks):
        if not re.fullmatch(r"h[1-4]", b["tag"]):
            continue
        body = next((x for x in blocks[i + 1:] if x["tag"] == "p" and len(x["text"]) >= 60), None)
        if not body:
            continue
        parts = split_sentences(body["text"])
        first = parts[0].strip() if parts else ""
        if first and 50 <= len(first) <= 320:
            leads.append(first)
    return leads


def _overlap(a: str, b: str) -> float:
    A = set(w.lower() for w in _WORDS.findall(normalize_text(a)))
    B = set(w.lower() for w in _WORDS.findall(normalize_text(b)))
    if not A or not B:
        return 0.0
    return len(A & B) / min(len(A), len(B))


# ---------------------------------------------------------------- assembling

def _to_evidence(c: dict, ctx: dict) -> dict:
    locator = {}
    block = c.get("block")
    if block and block.get("id"):
        locator["section"] = block["id"]
    elif block and block.get("section"):
        locator["section"] = block["section"]
    locator["fragment"] = text_fragment(c["text"])

    ev = {
        "url": ctx["url"].split("#")[0],
        "text": c["text"],
    }
    if ctx.get("title"):
        ev["title"] = ctx["title"]
    ev["locator"] = locator
    ev["integrity"] = {"sha256": sha256_of_text(c["text"])}
    ev["source_type"] = "first-party"
    ev["authority"] = "publisher"
    published = (ctx["meta"].get("article:published_time") or "")[:10]
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", published):
        ev["published_at"] = published
    ev["verification"] = {"verified": False, "verified_at": _today(),
                          "method": "automatically-generated"}
    return ev


def _cluster(verified: list[dict], summaries: list[dict], ctx: dict) -> list[dict]:
    used: set[int] = set()
    claims: list[dict] = []
    summaries_only = ctx["o"].get("claims") != "all"
    if summaries_only:
        summaries = [s for s in summaries if s["source"] in ("schema.org", "meta")]

    for summary in summaries:
        scored = [(i, c, _overlap(summary["text"], c["text"])) for i, c in enumerate(verified)]
        supporting = sorted(
            [x for x in scored if x[0] not in used and x[2] >= SUPPORT_THRESHOLD],
            key=lambda x: -x[2])[:MAX_EVIDENCE_PER_CLAIM]
        if not supporting:
            continue
        for i, _, _ in supporting:
            used.add(i)
        types = [c["type"] for _, c, _ in supporting]
        # Most common type, ties broken by first appearance. max(set(...))
        # would iterate a set, whose order is arbitrary, so two runs could
        # disagree — and so could the two implementations.
        counts = {t: types.count(t) for t in types}
        best = max(counts.values())
        ctype = summary["type"] or next(t for t in types if counts[t] == best)
        claims.append({
            "type": ctype, "claim": summary["text"], "summary_source": summary["source"],
            "tier": 1, "why": f"summary from {summary['source']}, {len(supporting)} supporting quote(s)",
            "evidence": [_to_evidence(c, ctx) for _, c, _ in supporting],
        })

    for i, c in enumerate(verified):
        if i in used:
            continue
        if summaries_only and c["type"] not in ATOMIC_TYPES:
            continue
        if summaries_only and is_boilerplate(c["text"]):
            continue
        if summaries_only and c["type"] in ("certification", "credential") \
                and not GATES["namedCredential"].search(c["text"]):
            continue
        if summaries_only and c["type"] == "pricing" \
                and not GATES["concretePricing"].search(c["text"]):
            continue
        if len(claims) >= ctx["o"]["maxCandidatesPerPage"]:
            break
        claims.append({"type": c["type"], "claim": c["text"], "summary_source": "evidence",
                       "tier": c["tier"], "why": c["why"], "evidence": [_to_evidence(c, ctx)]})

    return _drop_subsumed(claims)[:ctx["o"]["maxCandidatesPerPage"]]


def _drop_subsumed(claims: list[dict]) -> list[dict]:
    """Two summaries often end up standing over the same quotes. Compare
    evidence sets rather than wording, and keep the better-supported claim."""
    def key(c):
        return {normalize_text(e["text"]).lower() for e in c["evidence"]}

    out: list[dict] = []
    for c in sorted(claims, key=lambda c: -len(c["evidence"])):
        ck = key(c)
        covered = any(len(ck & key(k)) / len(ck) >= T["subsumedEvidenceRatio"] for k in out)
        if not covered:
            out.append(c)
    # restore original relative order
    return [c for c in claims if c in out]


def candidates_from_html(html: str, url: str, opts: dict | None = None) -> dict:
    """The pure half of extraction: HTML in, candidates out, no network."""
    o = {**EXTRACT_DEFAULTS, **(opts or {})}
    page_text = extract_text(html)
    blocks = extract_blocks(html)
    title = extract_title(html)
    meta = extract_meta(html)

    candidates = _tier1(page_text, extract_json_ld(html)) + _tier2(blocks, o)

    seen: set[str] = set()
    verified: list[dict] = []
    for c in candidates:
        norm = normalize_text(c["text"]).lower()
        if norm in seen:
            continue
        if not _assert_present(page_text, c["text"]):
            continue
        seen.add(norm)
        block = c.get("block") or next(
            (b for b in blocks if contains_normalized(b["text"], c["text"])), None)
        verified.append({**c, "block": block})

    summaries = _publisher_summaries(html, meta, blocks)
    claims = _cluster(verified, summaries,
                      {"url": url.split("#")[0], "title": title, "meta": meta, "o": o})

    note = None
    if not claims:
        cr = looks_client_rendered(html)
        note = ({"code": "client-rendered", "reasons": cr["reasons"], "textLength": cr["textLength"]}
                if cr["likely"] else
                {"code": "no-candidates",
                 "reasons": [f"{cr['textLength']} characters of visible text, none matching a claim pattern"],
                 "textLength": cr["textLength"]})
    return {"url": url, "title": title, "candidates": claims, "note": note}


def extract_from_page(url: str, opts: dict | None = None) -> dict:
    o = {**EXTRACT_DEFAULTS, **(opts or {})}
    res = fetch_safe(url, accept="text/html,application/xhtml+xml")
    if "html" not in (res["contentType"] or "").lower():
        raise ValueError(f"not HTML ({res['contentType'] or 'no content-type'}) for {url}")
    return candidates_from_html(res["body"], res["url"], o)


# ------------------------------------------------------------------ manifest

def _slugify(s: str, max_len: int = 48) -> str:
    s = unicodedata.normalize("NFKD", s).lower()
    s = re.sub(r"[^\w\s-]", "-", s, flags=re.UNICODE)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:max_len].rstrip("-") or "claim"


def to_manifest(site: str, candidates: list[dict]) -> dict:
    used: set[str] = set()
    claims = []
    for c in candidates:
        base = f"{str(c['type']).replace('_', '-')}-{_slugify(c['claim'], 40)}"
        cid, n = base, 2
        while cid in used:
            cid = f"{base}-{n}"
            n += 1
        used.add(cid)
        claim = {"id": cid, "type": c["type"], "claim": c["claim"]}
        if c.get("summary_source"):
            claim["summary_source"] = c["summary_source"]
        claim["evidence"] = c["evidence"] if isinstance(c.get("evidence"), list) else [c["evidence"]]
        claims.append(claim)

    return {
        "manifest": {
            "version": "2.0.0",
            "site": site,
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "generator": "ai-evidence-py/0.2.0",
        },
        "claims": claims,
    }


# ---------------------------------------------------------------------- site

def _discover_urls(site_url: str, o: dict) -> list[str]:
    parts = urlsplit(site_url)
    origin = f"{parts.scheme}://{parts.netloc}"
    urls, seen = [site_url], {site_url}
    asset = re.compile(r"\.(pdf|png|jpe?g|gif|svg|webp|zip|xml|json|css|js)$", re.I)
    try:
        sm = fetch_safe(urljoin(origin, "/sitemap.xml"), accept="application/xml,text/xml")
        for m in re.finditer(r"<loc>\s*([^<\s]+)\s*</loc>", sm["body"], re.I):
            u = m.group(1).strip()
            if u.startswith(origin) and not asset.search(u) and u not in seen:
                seen.add(u)
                urls.append(u)
            if len(urls) >= o["maxPages"]:
                break
    except Exception:
        pass   # no sitemap is normal; fall back to links on the entry page

    if len(urls) < o["maxPages"]:
        try:
            home = fetch_safe(site_url, accept="text/html")
            for m in re.finditer(r'<a\b[^>]*href\s*=\s*["\']([^"\'#]+)["\']', home["body"], re.I):
                u = urljoin(site_url, m.group(1)).split("#")[0]
                q = urlsplit(u)
                if f"{q.scheme}://{q.netloc}" != origin or asset.search(q.path):
                    continue
                if u not in seen:
                    seen.add(u)
                    urls.append(u)
                if len(urls) >= o["maxPages"]:
                    break
        except Exception:
            pass
    return urls[: o["maxPages"]]


def _cap_per_type(candidates: list[dict], max_per_type: int) -> list[dict]:
    """Keep the first N of each type, so a boilerplate-heavy page cannot crowd
    out capabilities."""
    if not max_per_type:
        return candidates
    seen: dict[str, int] = {}
    out = []
    for c in candidates:
        n = seen.get(c["type"], 0) + 1
        seen[c["type"]] = n
        if n <= max_per_type:
            out.append(c)
    return out


def extract_from_site(site_url: str, opts: dict | None = None) -> dict:
    o = {**EXTRACT_DEFAULTS, **(opts or {})}
    parts = urlsplit(site_url)
    origin = f"{parts.scheme}://{parts.netloc}"
    pages = _discover_urls(site_url, o)
    all_candidates, page_results, errors = [], [], []

    for url in pages:
        try:
            r = extract_from_page(url, o)
            page_results.append({"url": url, "candidates": len(r["candidates"]),
                                 "note": r.get("note")})
            all_candidates.extend(r["candidates"])
            if callable(o.get("onPage")):
                o["onPage"](url, len(r["candidates"]), None, r.get("note"))
        except Exception as e:
            errors.append({"url": url, "error": str(e)})
            if callable(o.get("onPage")):
                o["onPage"](url, 0, str(e), None)

    capped = _cap_per_type(all_candidates, o["maxPerType"])
    return {"manifest": to_manifest(origin, capped), "pages": page_results,
            "errors": errors, "candidateCount": len(capped),
            "droppedByCap": len(all_candidates) - len(capped)}
