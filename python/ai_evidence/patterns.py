"""Extraction behaviour, loaded from the shared definition.

Both implementations read ``shared/patterns.json`` so a pattern can only be
changed in one place. The two regex engines spell Unicode classes differently,
so the shared file uses placeholders and each language substitutes its own
form: JavaScript uses ``\\p{Letter}`` with the ``u`` flag, Python uses
``[^\\W\\d_]``.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Pattern

_HERE = Path(__file__).resolve().parent
_CANDIDATES = [
    _HERE / "patterns.json",                       # packaged copy
    _HERE.parent.parent / "shared" / "patterns.json",  # repository checkout
]


def _load() -> dict:
    for p in _CANDIDATES:
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    raise FileNotFoundError("shared/patterns.json not found")


PATTERNS = _load()

_SUBSTITUTIONS = {
    "{{LETTER}}": r"[^\W\d_]",
    "{{NUMBER}}": r"\d",
    "{{UPPER}}": r"[A-ZÀ-ÞĀ-Ž]",
}

_FLAGS = {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL, "u": re.UNICODE}


def rx(source: str, flags: str = "i") -> Pattern[str]:
    for token, replacement in _SUBSTITUTIONS.items():
        source = source.replace(token, replacement)
    bits = 0
    for f in flags:
        bits |= _FLAGS.get(f, 0)
    return re.compile(source, bits)


T = PATTERNS["thresholds"]
CLAIM_PATTERNS = [(t, rx(src)) for t, src in PATTERNS["claimPatterns"]]
GATES = {k: rx(v) for k, v in PATTERNS["gates"].items() if k != "$comment"}
SENTENCE = {k: rx(v["source"], v["flags"]) for k, v in PATTERNS["sentences"].items()}
HTML_SETS = {k: set(v) for k, v in PATTERNS["html"].items()}
ATOMIC_TYPES = set(PATTERNS["atomicTypes"])
SCHEMA_TYPE_MAP = PATTERNS["schemaTypeMap"]
