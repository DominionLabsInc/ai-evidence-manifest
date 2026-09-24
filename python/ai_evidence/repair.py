"""Repair evidence whose quoted text has drifted away from its source.

Detection alone is not enough: a scheduled check that only reports "2 of 19
quotes are gone" leaves the published file wrong until a human intervenes, and
agents read it in the meantime.

The danger in automatic repair is obvious — silently substituting different
text would turn an evidence index into a fabrication engine. So relocation is
gated: a replacement is only accepted when it is demonstrably a near-variant of
the text it replaces, and comes from the same URL. Anything below that is
reported as lost and left for a person. The tool would rather leave a hole than
invent a patch.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from .fetch_safe import FetchRefused, fetch_safe
from .html import extract_blocks, extract_text
from .normalize import (contains_normalized, normalize_text, sha256_of_text,
                        text_fragment)
from .extract import split_sentences
from .patterns import T

SIMILARITY_THRESHOLD = T["repairSimilarityThreshold"]
_TOKENS = re.compile(r"[^\W\d_]+|\d+", re.UNICODE)


def _tokens(s: str) -> set[str]:
    return set(t.lower() for t in _TOKENS.findall(normalize_text(s)))


def similarity(a: str, b: str) -> float:
    """Jaccard overlap of word sets: order- and punctuation-insensitive."""
    A, B = _tokens(a), _tokens(b)
    if not A or not B:
        return 0.0
    shared = len(A & B)
    return shared / (len(A) + len(B) - shared)


def _candidate_texts(blocks: list[dict]) -> list[dict]:
    """Whole blocks and the sentences inside them.

    Evidence is captured at sentence level, so comparing a sentence against a
    whole paragraph dilutes the score and a repairable drift reads as lost.
    """
    out = []
    for b in blocks:
        out.append({"block": b, "text": b["text"]})
        parts = split_sentences(b["text"])
        if len(parts) > 1:
            out.extend({"block": b, "text": t} for t in parts)
    return out


def best_match(blocks: list[dict], missing_text: str,
               threshold: float = SIMILARITY_THRESHOLD) -> dict | None:
    best = None
    for c in _candidate_texts(blocks):
        score = similarity(missing_text, c["text"])
        if best is None or score > best["score"]:
            best = {"block": c["block"], "text": c["text"], "score": score}
    return best if best and best["score"] >= threshold else None


def repair_manifest(manifest: dict, threshold: float = SIMILARITY_THRESHOLD,
                    prune: bool = False, on_event=None) -> dict:
    pages: dict[str, dict] = {}
    events: list[dict] = []
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def emit(e):
        events.append(e)
        if on_event:
            on_event(e)

    for claim in manifest["claims"]:
        for ei, ev in enumerate(claim["evidence"]):
            key = ev["url"].split("#")[0]
            if key not in pages:
                try:
                    res = fetch_safe(key, accept="text/html")
                    pages[key] = {"ok": True, "text": extract_text(res["body"]),
                                  "blocks": extract_blocks(res["body"])}
                except FetchRefused as e:
                    pages[key] = {"ok": False, "reason": f"{e.code}: {e.message}"}
                except Exception as e:
                    pages[key] = {"ok": False, "reason": str(e)}
            page = pages[key]
            where = f"{claim['id']}[{ei}]"

            if not page["ok"]:
                emit({"kind": "unreachable", "where": where, "url": key, "reason": page["reason"]})
                continue

            if contains_normalized(page["text"], ev["text"]):
                ev["last_seen"] = now
                emit({"kind": "present", "where": where})
                continue

            match = best_match(page["blocks"], ev["text"], threshold)
            if match:
                before = ev["text"]
                ev["text"] = match["text"]
                ev["integrity"] = {**(ev.get("integrity") or {}),
                                   "sha256": sha256_of_text(match["text"])}
                locator = {}
                if match["block"].get("id"):
                    locator["section"] = match["block"]["id"]
                elif match["block"].get("section"):
                    locator["section"] = match["block"]["section"]
                locator["fragment"] = text_fragment(match["text"])
                ev["locator"] = locator
                ev["last_seen"] = now
                # The publisher confirmed the old wording, not this one.
                ev["verification"] = {**(ev.get("verification") or {}), "verified": False,
                                      "verified_at": now[:10], "method": "automatically-generated"}
                emit({"kind": "relocated", "where": where, "url": key,
                      "score": round(match["score"], 3), "before": before, "after": match["text"]})
            else:
                ev.pop("last_seen", None)
                emit({"kind": "lost", "where": where, "url": key, "text": ev["text"]})

    pruned = 0
    if prune:
        for claim in manifest["claims"]:
            keep = [e for e in claim["evidence"] if e.get("last_seen")]
            pruned += len(claim["evidence"]) - len(keep)
            claim["evidence"] = keep
        before_n = len(manifest["claims"])
        # A claim with no surviving evidence is an assertion with nothing behind it.
        manifest["claims"] = [c for c in manifest["claims"] if c["evidence"]]
        if len(manifest["claims"]) != before_n:
            emit({"kind": "claims-dropped", "count": before_n - len(manifest["claims"])})

    counts: dict[str, int] = {}
    for e in events:
        counts[e["kind"]] = counts.get(e["kind"], 0) + 1
    return {"manifest": manifest, "events": events, "counts": counts, "pruned": pruned}
