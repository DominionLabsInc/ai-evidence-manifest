"""Canonical text normalization and integrity hashing.

Every consumer must derive the same hash from the same visible text, so the
steps are fixed: NFC, collapse every run of Unicode whitespace to a single
space, trim, encode UTF-8, SHA-256, lowercase hex.

Whitespace is collapsed because HTML authoring reflows it freely; reindenting a
paragraph must not invalidate otherwise-intact evidence.
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from urllib.parse import quote

_WHITESPACE = re.compile(r"\s+", re.UNICODE)


def normalize_text(text: str) -> str:
    if not isinstance(text, str):
        raise TypeError("normalize_text expects a string")
    return _WHITESPACE.sub(" ", unicodedata.normalize("NFC", text)).strip()


def sha256_of_text(text: str) -> str:
    return hashlib.sha256(normalize_text(text).encode("utf-8")).hexdigest()


def contains_normalized(haystack: str, needle: str) -> bool:
    """Case- and whitespace-insensitive containment, for confirming a quote."""
    return normalize_text(needle).lower() in normalize_text(haystack).lower()


# Percent-encoding must match across implementations or the same quote yields
# two different fragments. JavaScript's encodeURIComponent leaves these
# characters unescaped; Python's quote does not, so they are declared safe.
# See SPEC.md 5.1.
_FRAGMENT_SAFE = "!*\'()"


def text_fragment(text: str, max_words: int = 12) -> str:
    """A W3C Text Fragment, so an agent or browser lands on the quote."""
    words = normalize_text(text).split(" ")
    if len(words) <= max_words * 2:
        return "#:~:text=" + quote(" ".join(words), safe=_FRAGMENT_SAFE)
    start = quote(" ".join(words[:max_words]), safe=_FRAGMENT_SAFE)
    end = quote(" ".join(words[-max_words:]), safe=_FRAGMENT_SAFE)
    return f"#:~:text={start},{end}"
