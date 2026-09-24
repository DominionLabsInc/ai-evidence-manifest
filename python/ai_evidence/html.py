"""HTML reading, built on html5lib — a spec-compliant parser.

This mirrors the JavaScript implementation, which uses parse5. Both follow the
HTML5 parsing algorithm, so an attribute containing ``>``, unclosed tags and
implied elements are read the same way in either language.

Regular expressions were tried first and were wrong for a verification tool:
mis-parsed markup makes a quote that IS on the page read as absent, and the
check then reports drift that does not exist.

Nothing here executes anything. Script, style, noscript, template and svg
subtrees are discarded before any text is returned.
"""
from __future__ import annotations

import json
import re
from typing import Any, Iterator

import html5lib

from .patterns import HTML_SETS

SKIP = HTML_SETS["skipElements"]
BLOCK = HTML_SETS["blockElements"]
SECTIONING = HTML_SETS["sectioningElements"]
# Elements that imply a break in the text. Without these, adjacent blocks run
# together and a quote can appear to span a boundary it never crossed.
SEPARATES = BLOCK | SECTIONING | HTML_SETS["separatingElements"]

_WS = re.compile(r"\s+", re.UNICODE)


def _collapse(s: str) -> str:
    return _WS.sub(" ", s).strip()


def _tag(el: Any) -> str:
    t = el.tag
    if not isinstance(t, str):
        return ""
    return t.rsplit("}", 1)[-1].lower()


def _parse(html: str | Any):
    if isinstance(html, str):
        return html5lib.parse(html, namespaceHTMLElements=False)
    return html


def _text_of(el: Any) -> str:
    """Concatenated text of a subtree, skipping non-content elements."""
    name = _tag(el)
    if name in SKIP:
        return ""
    out = el.text or ""
    for child in el:
        if _tag(child) in SKIP:
            out += child.tail or ""
            continue
        sep = " " if _tag(child) in SEPARATES else ""
        out += sep + _text_of(child) + sep + (child.tail or "")
    return out


def _walk(el: Any, ancestors: tuple = ()) -> Iterator[tuple]:
    for child in el:
        if _tag(child) in SKIP:
            continue
        yield child, ancestors
        yield from _walk(child, ancestors + (child,))


def _find(doc: Any, name: str) -> Any:
    for el in doc.iter():
        if _tag(el) == name:
            return el
    return None


def extract_text(html: str | Any) -> str:
    doc = _parse(html)
    body = _find(doc, "body")
    return _collapse(_text_of(body if body is not None else doc))


def extract_title(html: str | Any) -> str | None:
    el = _find(_parse(html), "title")
    if el is None:
        return None
    return _collapse(_text_of(el)) or None


def extract_meta(html: str | Any) -> dict[str, str]:
    """name= and property= meta tags, keyed by whichever attribute was present."""
    out: dict[str, str] = {}
    for el in _parse(html).iter():
        if _tag(el) != "meta":
            continue
        key = el.get("name") or el.get("property")
        content = el.get("content")
        if key and content is not None:
            out[key.lower()] = _collapse(content)
    return out


def _flatten_graph(node: Any) -> list:
    if isinstance(node, list):
        return [x for n in node for x in _flatten_graph(n)]
    if isinstance(node, dict):
        if "@graph" in node:
            return [node] + _flatten_graph(node["@graph"])
        return [node]
    return []


def extract_json_ld(html: str | Any) -> list[dict]:
    """Parsed application/ld+json blocks. Malformed blocks are skipped, never guessed at."""
    out: list[dict] = []
    for el in _parse(html).iter():
        if _tag(el) != "script":
            continue
        if "application/ld+json" not in (el.get("type") or "").lower():
            continue
        raw = (el.text or "").strip()
        if not raw:
            continue
        try:
            out.extend(_flatten_graph(json.loads(raw)))
        except Exception:
            continue  # ignored rather than inferred
    return out


def extract_blocks(html: str | Any) -> list[dict]:
    """Visible text blocks with their own id and nearest sectioning ancestor id."""
    doc = _parse(html)
    blocks = []
    for el, ancestors in _walk(doc):
        name = _tag(el)
        if name not in BLOCK:
            continue
        text = _collapse(_text_of(el))
        if not text:
            continue
        section = None
        for a in reversed(ancestors):
            if _tag(a) in SECTIONING and a.get("id"):
                section = a.get("id")
                break
        blocks.append({"tag": name, "id": el.get("id"), "section": section, "text": text})
    return blocks


def looks_client_rendered(html: str | Any) -> dict:
    """Does this look like a page whose content is assembled in the browser?

    Fetching cannot see client-rendered content. Reporting "no claims found"
    without saying why leads a publisher to conclude their site has nothing
    worth publishing, so the condition is surfaced explicitly.
    """
    doc = _parse(html)
    text = extract_text(doc)
    scripts = [el for el in doc.iter() if _tag(el) == "script"]
    script_bytes = sum(len(el.text or "") for el in scripts if not el.get("src"))
    roots = [el for el in doc.iter() if (el.get("id") or "") in ("root", "app", "__next", "__nuxt")]

    reasons = []
    if len(text) < 400:
        reasons.append(f"only {len(text)} characters of visible text")
    if roots and len(text) < 1500:
        reasons.append(f"an empty-looking app root (#{roots[0].get('id')})")
    if len(scripts) > 8 and len(text) < 1500:
        reasons.append(f"{len(scripts)} script tags but little text")
    if script_bytes > len(text) * 4 and len(text) < 2000:
        reasons.append("far more inline script than text")

    return {"likely": bool(reasons), "reasons": reasons,
            "textLength": len(text), "scriptCount": len(scripts)}
