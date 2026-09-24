"""Emit this implementation's output for the conformance corpus, canonically."""
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
from ai_evidence.extract import candidates_from_html, to_manifest  # noqa: E402

root = Path(__file__).resolve().parents[2]
index = json.loads((root / "tests/conformance/index.json").read_text())
out = {}
for entry in index:
    html = (root / "tests/conformance/pages" / entry["file"]).read_text(encoding="utf-8")
    for mode in ("summaries", "all"):
        r = candidates_from_html(html, entry["url"], {"claims": mode})
        p = urlsplit(entry["url"])
        m = to_manifest(f"{p.scheme}://{p.netloc}", r["candidates"])
        m["manifest"].pop("generated_at", None)
        m["manifest"].pop("generator", None)
        for c in m["claims"]:
            for e in c["evidence"]:
                e["verification"].pop("verified_at", None)
        out[f"{entry['file']}::{mode}"] = m
print(json.dumps(out, indent=2, ensure_ascii=False))
