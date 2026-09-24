"""Validate a manifest: structure, internal consistency, limits, and — when
online — whether each quote is still present at its source.

Mirrors the JavaScript implementation. The schema is the shared normative
artifact; both implementations validate against the same file.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

from .fetch_safe import FetchRefused, fetch_safe
from .html import extract_text
from .jws import JWKS_PATH, verify_manifest
from .normalize import contains_normalized, sha256_of_text

_HERE = Path(__file__).resolve().parent
_SCHEMA_CANDIDATES = [
    _HERE / "ai-evidence-manifest.schema.json",
    _HERE.parent.parent / "schema" / "ai-evidence-manifest.schema.json",
]

SUPPORTED_MAJOR = 2

LIMITS = {
    "maxManifestBytes": 1024 * 1024,
    "maxClaims": 1000,
    "maxEvidencePerClaim": 20,
    "maxTextChars": 2000,
    "staleAfterDays": 365,
}

_validator = None


def _schema_validator() -> Draft202012Validator:
    global _validator
    if _validator is None:
        for p in _SCHEMA_CANDIDATES:
            if p.exists():
                # jsonschema ignores "format" unless a checker is supplied, so a
                # malformed date would pass here while ajv rejected it. The two
                # implementations must agree, so formats are checked.
                _validator = Draft202012Validator(
                    json.loads(p.read_text(encoding="utf-8")),
                    format_checker=FormatChecker())
                break
        else:
            raise FileNotFoundError("ai-evidence-manifest.schema.json not found")
    return _validator


_known_members = None


def _known() -> dict:
    """Members the schema declares, read from the schema itself so this check
    can never drift away from it."""
    global _known_members
    if _known_members is None:
        schema = _schema_validator().schema
        defs = schema["$defs"]

        def of(name):
            return list(defs[name].get("properties", {}))

        _known_members = {
            "": list(schema.get("properties", {})),
            "manifestHeader": of("manifestHeader"),
            "manifestVerification": of("manifestVerification"),
            "publisher": of("publisher"),
            "claim": of("claim"),
            "evidence": of("evidence"),
            "locator": of("locator"),
            "integrity": of("integrity"),
            "verification": of("verification"),
        }
    return _known_members


def _check_unknown_members(manifest: dict, findings: list) -> None:
    """Report members the schema does not declare.

    The schema permits them, because a format that rejects everything it has
    not seen cannot be extended without breaking every document already
    published. They are still worth surfacing: at this severity a misspelled
    member name is visible to the publisher who made the typo, while a consumer
    implementing a later minor version is not told its manifest is wrong.
    """
    known = _known()

    def visit(obj, defname, at):
        if not isinstance(obj, dict):
            return
        for k in obj:
            if k not in known[defname]:
                findings.append(_warn("unknown-member",
                    f'"{k}" is not declared by this version of the schema; consumers '
                    f"that do not understand it will ignore it", f"{at}/{k}"))

    visit(manifest, "", "")
    visit(manifest.get("manifest"), "manifestHeader", "/manifest")
    visit((manifest.get("manifest") or {}).get("verification"),
          "manifestVerification", "/manifest/verification")
    visit(manifest.get("publisher"), "publisher", "/publisher")
    for ci, c in enumerate(manifest.get("claims") or []):
        visit(c, "claim", f"/claims/{ci}")
        for ei, ev in enumerate(c.get("evidence") or []):
            at = f"/claims/{ci}/evidence/{ei}"
            visit(ev, "evidence", at)
            visit(ev.get("locator"), "locator", f"{at}/locator")
            visit(ev.get("integrity"), "integrity", f"{at}/integrity")
            visit(ev.get("verification"), "verification", f"{at}/verification")


def _err(code, message, where):
    return {"severity": "error", "code": code, "message": message, "where": where}


def _warn(code, message, where):
    return {"severity": "warning", "code": code, "message": message, "where": where}


class ManifestError(ValueError):
    def __init__(self, message, code="malformed-json"):
        super().__init__(message)
        self.code = code


def parse_manifest(raw: str) -> tuple[dict, int]:
    try:
        return json.loads(raw), len(raw.encode("utf-8"))
    except Exception as e:
        raise ManifestError(f"manifest is not valid JSON: {e}")


def validate_manifest(manifest: dict, offline: bool = True, strict: bool = False,
                      raw_bytes: int | None = None, limits: dict | None = None,
                      jwks: dict | None = None) -> dict:
    lim = {**LIMITS, **(limits or {})}
    findings: list[dict] = []
    stats = {"claims": 0, "evidence": 0, "checkedUrls": 0, "reachable": 0, "textPresent": 0,
             "signatures": 0, "signaturesValid": 0}

    errors = sorted(_schema_validator().iter_errors(manifest),
                    key=lambda e: list(e.absolute_path))
    if errors:
        for e in errors:
            where = "/" + "/".join(str(p) for p in e.absolute_path) if e.absolute_path else "/"
            findings.append(_err("schema", f"{where} {e.message}", where))
        return _finish(findings, stats, strict, offline, [])

    _check_unknown_members(manifest, findings)

    # A signature answers a question the transport cannot: whether this document
    # is still attributable to its publisher once it has been stored and passed
    # on. Checking it needs the publisher's key set, so a caller that supplies
    # none gets told the signature went unchecked rather than being left to
    # assume it passed.
    signatures = manifest.get("signatures")
    if isinstance(signatures, list) and signatures:
        if not jwks:
            findings.append(_warn("signature-unchecked",
                f"manifest carries {len(signatures)} signature(s) but no key set was "
                f"supplied; fetch {JWKS_PATH} from the manifest origin to check them",
                "/signatures"))
        else:
            result = verify_manifest(manifest, jwks)
            stats["signatures"] = len(result["results"])
            for i, r in enumerate(result["results"]):
                if r["valid"]:
                    stats["signaturesValid"] += 1
                else:
                    findings.append(_err("signature-invalid",
                        f"{r['code']}: {r['reason']}", f"/signatures/{i}"))
    elif jwks:
        findings.append(_warn("unsigned",
            "a key set was supplied but the manifest carries no signature, so its "
            "assertions are attributable only to the transport that delivered it", "/"))

    version = manifest["manifest"]["version"]
    if int(version.split(".")[0]) != SUPPORTED_MAJOR:
        findings.append(_err("version",
            f"manifest version {version} is not supported by this validator "
            f"(expects {SUPPORTED_MAJOR}.x.x)", "/manifest/version"))

    mv = manifest["manifest"].get("verification")
    if mv:
        checked = datetime.fromisoformat(mv["checked_at"].replace("Z", "+00:00"))
        age_days = (datetime.now(timezone.utc) - checked).total_seconds() / 86400
        limit = mv.get("recheck_interval_days", lim["staleAfterDays"])
        if age_days > limit:
            findings.append(_warn("verification-stale",
                f"last checked {round(age_days)} days ago, past the {limit}-day interval "
                f"the manifest declares", "/manifest/verification/checked_at"))
        if mv["evidence_present"] < mv["evidence_total"]:
            missing = mv["evidence_total"] - mv["evidence_present"]
            findings.append(_warn("verification-incomplete",
                f"{missing} of {mv['evidence_total']} quotes were not found at their "
                f"source when last checked", "/manifest/verification"))

    if raw_bytes is not None and raw_bytes > lim["maxManifestBytes"]:
        findings.append(_warn("size",
            f"manifest is {raw_bytes} bytes, above the recommended {lim['maxManifestBytes']}", "/"))
    if len(manifest["claims"]) > lim["maxClaims"]:
        findings.append(_warn("size",
            f"{len(manifest['claims'])} claims, above the recommended {lim['maxClaims']}", "/claims"))

    seen: dict[str, int] = {}
    for i, c in enumerate(manifest["claims"]):
        if c["id"] in seen:
            findings.append(_err("duplicate-id",
                f'claim id "{c["id"]}" is used more than once (also at /claims/{seen[c["id"]]})',
                f"/claims/{i}/id"))
        else:
            seen[c["id"]] = i

    site_origin = None
    try:
        from urllib.parse import urlsplit
        p = urlsplit(manifest["manifest"]["site"])
        site_origin = f"{p.scheme}://{p.netloc}"
    except Exception:
        pass

    now = datetime.now(timezone.utc)
    evidence_seen: list[dict] = []
    stats["claims"] = len(manifest["claims"])

    for ci, claim in enumerate(manifest["claims"]):
        if len(claim["evidence"]) > lim["maxEvidencePerClaim"]:
            findings.append(_warn("size",
                f'claim "{claim["id"]}" has {len(claim["evidence"])} evidence records, above '
                f'the recommended {lim["maxEvidencePerClaim"]}', f"/claims/{ci}/evidence"))

        for ei, ev in enumerate(claim["evidence"]):
            stats["evidence"] += 1
            at = f"/claims/{ci}/evidence/{ei}"

            if ev.get("integrity", {}).get("sha256"):
                actual = sha256_of_text(ev["text"])
                if actual != ev["integrity"]["sha256"]:
                    findings.append(_err("integrity-mismatch",
                        f"integrity.sha256 does not match the normalized text (expected {actual})",
                        f"{at}/integrity/sha256"))
            else:
                findings.append(_warn("no-integrity",
                    "no integrity.sha256; consumers cannot detect drift without refetching", at))

            if site_origin and ev["source_type"] == "first-party":
                from urllib.parse import urlsplit as _us
                q = _us(ev["url"])
                ev_origin = f"{q.scheme}://{q.netloc}"
                if ev_origin != site_origin:
                    findings.append(_warn("cross-origin-first-party",
                        f"marked first-party but {ev_origin} is not the manifest origin "
                        f"{site_origin}", f"{at}/url"))

            loc = ev.get("locator") or {}
            if loc.get("selector") and not loc.get("fragment") and not loc.get("section"):
                findings.append(_warn("selector-only",
                    "locator relies on a CSS selector alone; prefer fragment or section",
                    f"{at}/locator"))

            ver = ev.get("verification") or {}
            if ver.get("verified_at"):
                age = (now.date() - datetime.fromisoformat(ver["verified_at"]).date()).days
                if age > lim["staleAfterDays"]:
                    findings.append(_warn("stale",
                        f"last verified {age} days ago (stale after {lim['staleAfterDays']})",
                        f"{at}/verification/verified_at"))
            else:
                findings.append(_warn("unverified",
                    "no verification.verified_at; freshness is unknown", at))

            if len(ev["text"]) > lim["maxTextChars"]:
                findings.append(_warn("size",
                    f"evidence text is {len(ev['text'])} chars, above the recommended "
                    f"{lim['maxTextChars']}", f"{at}/text"))

    if not offline:
        cache: dict[str, dict] = {}
        for ci, claim in enumerate(manifest["claims"]):
            for ei, ev in enumerate(claim["evidence"]):
                at = f"/claims/{ci}/evidence/{ei}"
                key = ev["url"].split("#")[0]
                stats["checkedUrls"] += 1
                if key not in cache:
                    try:
                        res = fetch_safe(key, accept="text/html,*/*")
                        cache[key] = {"ok": True, "text": extract_text(res["body"])}
                    except FetchRefused as e:
                        cache[key] = {"ok": False, "reason": f"{e.code}: {e.message}"}
                    except Exception as e:
                        cache[key] = {"ok": False, "reason": str(e)}
                page = cache[key]
                if not page["ok"]:
                    findings.append(_err("unreachable",
                        f"evidence URL not retrievable ({page['reason']})", f"{at}/url"))
                    evidence_seen.append({"ci": ci, "ei": ei, "present": False})
                    continue
                stats["reachable"] += 1
                if contains_normalized(page["text"], ev["text"]):
                    stats["textPresent"] += 1
                    evidence_seen.append({"ci": ci, "ei": ei, "present": True})
                else:
                    findings.append(_err("text-absent",
                        "quoted text was not found at the evidence URL — the page may have "
                        "changed", f"{at}/text"))
                    evidence_seen.append({"ci": ci, "ei": ei, "present": False})

    return _finish(findings, stats, strict, offline, evidence_seen)


def _finish(findings, stats, strict, offline, seen):
    errors = [f for f in findings if f["severity"] == "error"]
    warnings = [f for f in findings if f["severity"] == "warning"]
    return {
        "valid": not errors and (not strict or not warnings),
        "errors": errors, "warnings": warnings, "findings": findings,
        "stats": stats, "seen": seen, "strict": strict, "offline": offline,
    }


def stamp_verification(manifest: dict, result: dict, method: str = "automated-recheck",
                       recheck_interval_days: int | None = None) -> dict:
    """Record a freshness result in the manifest.

    A consumer cannot take this on faith — it is a publisher assertion. But it
    is falsifiable: anyone who spot-checks a single quote can catch a publisher
    reporting checks it never ran. Freshness lets an agent verify in proportion
    to stakes instead of refetching everything every time.
    """
    at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    for s in result.get("seen", []):
        ev = manifest["claims"][s["ci"]]["evidence"][s["ei"]]
        if s["present"]:
            ev["last_seen"] = at
        else:
            ev.pop("last_seen", None)

    existing = (manifest["manifest"].get("verification") or {}).get("recheck_interval_days")
    v = {
        "checked_at": at,
        "method": method,
        "evidence_total": result["stats"]["evidence"],
        "evidence_present": result["stats"]["textPresent"],
    }
    interval = recheck_interval_days or existing
    if interval:
        v["recheck_interval_days"] = interval
    manifest["manifest"]["verification"] = v
    return manifest
