"""Command line interface. Mirrors the JavaScript tool, command for command."""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from .config import (ALIAS_PATH, CONFIG_FILENAME, WELL_KNOWN_PATH, ConfigError,
                     generate, init_config, load_config, write_config)
from .extract import extract_from_page, extract_from_site, to_manifest
from .fetch_safe import FetchRefused, fetch_safe
from .jws import (JWKS_PATH, SignatureError, build_jwks, dns_txt_record,
                  generate_key_pair, sign_manifest, verify_manifest)
from .repair import SIMILARITY_THRESHOLD, repair_manifest
from .validate import (ManifestError, parse_manifest, stamp_verification,
                       validate_manifest)

_TTY = sys.stdout.isatty()


def _c(code):
    return (lambda s: f"\x1b[{code}m{s}\x1b[0m") if _TTY else (lambda s: s)


RED, YELLOW, GREEN, DIM, BOLD = _c(31), _c(33), _c(32), _c(2), _c(1)


def _is_url(s: str) -> bool:
    return s.startswith(("http://", "https://"))


def _manifest_urls(target: str) -> list[str]:
    """A bare origin resolves to the canonical path first, then the alias."""
    from urllib.parse import urlsplit, urlunsplit
    p = urlsplit(target)
    if p.path not in ("", "/"):
        return [target]
    return [urlunsplit(p._replace(path="/" + WELL_KNOWN_PATH)),
            urlunsplit(p._replace(path="/" + ALIAS_PATH))]


def _read_manifest(target: str):
    if _is_url(target):
        res, last = None, None
        for candidate in _manifest_urls(target):
            try:
                res = fetch_safe(candidate,
                                 accept="application/ai-evidence+json, application/json")
                break
            except Exception as e:
                last = e
        if res is None:
            raise last
        if "json" not in (res["contentType"] or "").lower():
            sys.stderr.write(YELLOW(
                f'warning: {target} served as "{res["contentType"] or "no content-type"}"; '
                f"expected application/json\n"))
        return res["body"], res["url"]
    p = Path(target)
    if not p.exists():
        raise FileNotFoundError(f"no such file: {p.resolve()}")
    return p.read_text(encoding="utf-8"), str(p.resolve())


def _report(result, source, as_json):
    if as_json:
        print(json.dumps({"source": source, **result}, indent=2))
        return
    stats = result["stats"]
    print(f"\n{BOLD(source)}")
    line = f"  {stats['claims']} claims · {stats['evidence']} evidence records"
    if not result["offline"]:
        line += (f" · {stats['reachable']}/{stats['checkedUrls']} URLs reachable"
                 f" · {stats['textPresent']} quotes still present")
    print(DIM(line) + "\n")
    for f in result["errors"]:
        print(f"  {RED('error')}   {DIM(f['where'])} {f['message']}  {DIM('[' + f['code'] + ']')}")
    for f in result["warnings"]:
        print(f"  {YELLOW('warning')} {DIM(f['where'])} {f['message']}  {DIM('[' + f['code'] + ']')}")
    if result["errors"] or result["warnings"]:
        print()
    verdict = GREEN("VALID") if result["valid"] else RED("INVALID")
    strict = DIM(" (strict)") if result["strict"] else ""
    print(f"  {verdict}  {len(result['errors'])} error(s), {len(result['warnings'])} warning(s){strict}\n")


def _count_evidence(m):
    return sum(len(c["evidence"]) for c in m["claims"])


def _all_present(m):
    return [{"ci": ci, "ei": ei, "present": True}
            for ci, c in enumerate(m["claims"]) for ei, _ in enumerate(c["evidence"])]


def _read_jwks(target: str) -> dict:
    """Read a key set from a local file or a URL."""
    if _is_url(target):
        res = fetch_safe(target, accept="application/jwk-set+json, application/json")
        return json.loads(res["body"])
    p = Path(target)
    if not p.exists():
        raise FileNotFoundError(f"no such key set: {p.resolve()}")
    return json.loads(p.read_text(encoding="utf-8"))


def _iso(epoch_seconds: int) -> str:
    return datetime.fromtimestamp(epoch_seconds, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def cmd_keygen(args) -> int:
    out_dir = Path(args.out or ".").resolve()
    key_path = out_dir / "ai-evidence-signing-key.json"
    if key_path.exists() and not args.force:
        sys.stderr.write(RED(f"error: {key_path} already exists; refusing to overwrite "
                             f"a signing key (use --force)\n"))
        return 2
    jwks_path = out_dir / ".well-known" / "ai-evidence-jwks.json"

    kp = generate_key_pair()
    jwks_path.parent.mkdir(parents=True, exist_ok=True)

    # Opened with the narrow mode rather than chmod-ed afterwards, so the key is
    # never world-readable even briefly.
    fd = os.open(str(key_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(kp["private_jwk"], indent=2) + "\n")
    os.chmod(str(key_path), 0o600)
    jwks_path.write_text(json.dumps(build_jwks([kp["public_jwk"]]), indent=2) + "\n",
                         encoding="utf-8")

    site = args.site or "example.com"
    if _is_url(site):
        from urllib.parse import urlsplit
        site = urlsplit(site).hostname or site
    txt = dns_txt_record(kp["public_jwk"], site)

    print(f"\n  {BOLD('key id')}  {kp['kid']}\n")
    print(f"  {GREEN('private')}  {key_path}  {DIM('(mode 0600)')}")
    print(f"  {GREEN('public')}   {jwks_path}\n")
    print(f"  {YELLOW('Do not commit or publish the private key.')} Serve only the JWKS, at")
    print(f"  {DIM(JWKS_PATH)} on the same origin as the manifest.\n")
    print(DIM("  Optional — anchor the key in DNS as well, so a consumer can establish it"))
    print(DIM("  without trusting the web host:"))
    print(f'    {txt["name"]}  TXT  "{txt["value"]}"\n')
    return 0


def cmd_sign(args) -> int:
    file = Path(args.target)
    if not file.exists():
        sys.stderr.write(RED(f"error: no such file: {file.resolve()}\n"))
        return 2
    key_file = Path(args.key or "ai-evidence-signing-key.json")
    if not key_file.exists():
        sys.stderr.write(RED(f"error: no signing key at {key_file.resolve()}; "
                             f"run `ai-evidence keygen` first\n"))
        return 2
    try:
        manifest = json.loads(file.read_text(encoding="utf-8"))
        private_jwk = json.loads(key_file.read_text(encoding="utf-8"))
    except Exception as e:
        sys.stderr.write(RED(f"error: {e}\n"))
        return 2

    # A signature over a document that is already invalid only makes the
    # invalidity authentic, so check first and say so.
    pre = validate_manifest(manifest, offline=True)
    if not pre["valid"]:
        sys.stderr.write(RED(f"error: refusing to sign an invalid manifest "
                             f"({len(pre['errors'])} error(s))\n"))
        for f in pre["errors"]:
            sys.stderr.write(f"  {DIM(f['where'])} {f['message']}\n")
        return 1

    try:
        # Re-signing replaces rather than accumulates: a signature over an older
        # payload can never verify again, so keeping it only produces noise.
        unsigned = {k: v for k, v in manifest.items() if k != "signatures"}
        signed = sign_manifest(unsigned, private_jwk)
    except (SignatureError, ValueError) as e:
        sys.stderr.write(RED(f"error: {e}\n"))
        return 2

    out = Path(args.out or file)
    out.write_text(json.dumps(signed, indent=2) + "\n", encoding="utf-8")
    import base64
    head = signed["signatures"][-1]["protected"]
    header = json.loads(base64.urlsafe_b64decode(head + "=" * (-len(head) % 4)))
    print(f"\n  {GREEN('signed')}  {out.resolve()}")
    print(f"  {DIM('key ' + header['kid'] + ' · iat ' + _iso(header['iat']))}\n")
    return 0


def cmd_verify(args) -> int:
    try:
        raw, source = _read_manifest(args.target)
        jwks_target = args.jwks
        if not jwks_target:
            if not _is_url(args.target):
                sys.stderr.write(RED("error: verifying a local file needs --jwks <file|url>\n"))
                return 2
            from urllib.parse import urljoin
            jwks_target = urljoin(args.target, JWKS_PATH)
        jwks = _read_jwks(jwks_target)
    except FetchRefused as e:
        sys.stderr.write(RED(f"error: {e.code}: {e}\n"))
        return 2
    except Exception as e:
        sys.stderr.write(RED(f"error: {e}\n"))
        return 2

    try:
        manifest = json.loads(raw)
    except Exception as e:
        sys.stderr.write(RED(f"error: manifest is not valid JSON: {e}\n"))
        return 1

    result = verify_manifest(manifest, jwks)
    if args.json:
        print(json.dumps({"source": source, **result}, indent=2))
        return 0 if result["verified"] else 1

    print(f"\n{BOLD(source)}\n")
    if not result["signed"]:
        print(f"  {YELLOW('UNSIGNED')}  no signatures; this manifest is attributable only "
              f"to the transport that delivered it\n")
        return 1
    for r in result["results"]:
        if r["valid"]:
            print(f"  {GREEN('ok')}      {r['kid']}  {DIM('signed ' + _iso(r['iat']))}")
        else:
            print(f"  {RED('bad')}     {r['reason']}  {DIM('[' + str(r['code']) + ']')}")
    print()
    if result["verified"]:
        n = sum(1 for r in result["results"] if r["valid"])
        print(f"  {GREEN('VERIFIED')}  {n} of {len(result['results'])} signature(s) check out\n")
        return 0
    print(f"  {RED('UNVERIFIED')}  no signature checks out against this key set\n")
    return 1


def cmd_init(args) -> int:
    file = args.config or CONFIG_FILENAME
    if Path(file).exists() and not args.force:
        sys.stderr.write(RED(f"error: {file} already exists (use --force to overwrite)\n"))
        return 2
    try:
        cfg = init_config(args.url)
    except FetchRefused as e:
        sys.stderr.write(RED(f"error: {e.message}\n"))
        return 2
    write_config(cfg, file)
    print(f"\n  wrote {BOLD(file)}")
    found = " (sitemap.xml found)" if cfg["discover"] == "sitemap" else " (no sitemap.xml; following links)"
    print(DIM(f"  discovery: {cfg['discover']}{found}"))
    print(DIM("  edit it if you want, then run: ai-evidence generate\n"))
    return 0


def cmd_generate(args) -> int:
    file = args.config or CONFIG_FILENAME
    try:
        cfg = load_config(file)
    except ConfigError as e:
        sys.stderr.write(RED(f"error: {e}\n"))
        return 2

    sys.stderr.write(f"\n  reading {BOLD(file)} — {cfg['site']}\n")

    def on_page(url, n, err, note):
        flag = YELLOW(" content appears to be rendered in the browser") \
            if note and note.get("code") == "client-rendered" else ""
        pre = YELLOW(err[:60]) + " " if err else ""
        sys.stderr.write(f"  {str(n).rjust(3)}  {pre}{DIM(url)}{flag}\n")

    res = generate(cfg, on_page=on_page)
    check = validate_manifest(res["manifest"], offline=True)
    if not check["valid"]:
        sys.stderr.write(RED("\n  refusing to write an invalid manifest:\n"))
        for e in check["errors"]:
            sys.stderr.write(f"    {e['where']} {e['message']}\n")
        return 1

    n = _count_evidence(res["manifest"])
    stamp_verification(res["manifest"],
                       {"stats": {"evidence": n, "textPresent": n},
                        "seen": _all_present(res["manifest"])},
                       method="generated-from-source",
                       recheck_interval_days=cfg.get("recheckIntervalDays", 7))

    text = json.dumps(res["manifest"], indent=2) + "\n"
    # RFC 8615 canonical path, plus the short alias unless suppressed.
    targets = ([args.out] if args.out
               else [WELL_KNOWN_PATH] if args.no_alias
               else [WELL_KNOWN_PATH, ALIAS_PATH])
    for t in targets:
        Path(t).parent.mkdir(parents=True, exist_ok=True)
        Path(t).write_text(text, encoding="utf-8")
    v = res["manifest"]["manifest"]["verification"]
    sys.stderr.write(f"\n  wrote {BOLD(' and '.join(targets))} — "
                     f"{len(res['manifest']['claims'])} claims, "
                     f"{len(text.encode()) / 1024:.1f} KiB\n")
    if res["pinned"]:
        sys.stderr.write(DIM(f"  {res['pinned']} pinned claim(s) kept from the config\n"))
    sys.stderr.write(DIM(f"  {v['evidence_present']}/{v['evidence_total']} quotes read from the "
                         f"live pages and confirmed present\n"))
    sys.stderr.write(DIM("  what a human adds: which claims matter, and whether the types are right\n"))
    sys.stderr.write(DIM(f"  serve it at {cfg['site'].rstrip('/')}/{WELL_KNOWN_PATH}\n\n"))
    for e in res["errors"]:
        sys.stderr.write(YELLOW(f"  skipped {e['url']}: {e['error']}\n"))
    if res["clientRendered"]:
        sys.stderr.write(YELLOW(f"\n  {len(res['clientRendered'])} page(s) returned no claims "
                                f"and look client-rendered:\n"))
        for p in res["clientRendered"][:5]:
            sys.stderr.write(DIM(f"    {p['url']} — {p['reasons'][0]}\n"))
        sys.stderr.write(DIM("  Fetching cannot see content assembled in the browser. Point the "
                             "config at\n  server-rendered URLs, or generate from your build output.\n"))
    return 0


def cmd_validate(args, force_online=None) -> int:
    try:
        raw, source = _read_manifest(args.target)
    except Exception as e:
        sys.stderr.write(RED(f"error: {e}\n"))
        return 2
    try:
        manifest, nbytes = parse_manifest(raw)
    except ManifestError as e:
        if args.json:
            print(json.dumps({"source": source, "valid": False,
                              "errors": [{"code": e.code, "message": str(e)}]}, indent=2))
        else:
            print(f"\n{BOLD(source)}\n\n  {RED('error')} {e}  {DIM('[' + e.code + ']')}\n\n  {RED('INVALID')}\n")
        return 1

    offline = (not force_online) and (args.offline or not (args.online or _is_url(args.target)))
    if force_online:
        offline = False
    jwks = None
    if getattr(args, "jwks", None):
        try:
            jwks = _read_jwks(args.jwks)
        except Exception as e:
            sys.stderr.write(RED(f"error: {e}\n"))
            return 2
    result = validate_manifest(manifest, offline=offline, strict=args.strict,
                               raw_bytes=nbytes, jwks=jwks)
    _report(result, source, args.json)
    return 0 if result["valid"] else 1


def cmd_check(args) -> int:
    if not args.update:
        return cmd_validate(args, force_online=True)
    if _is_url(args.target):
        sys.stderr.write(RED("error: --update needs a local file to write back to\n"))
        return 2
    try:
        raw, source = _read_manifest(args.target)
        manifest, nbytes = parse_manifest(raw)
    except Exception as e:
        sys.stderr.write(RED(f"error: {e}\n"))
        return 2
    result = validate_manifest(manifest, offline=False, strict=args.strict, raw_bytes=nbytes)
    stamp_verification(manifest, result, method="automated-recheck",
                       recheck_interval_days=args.interval)
    Path(args.target).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    _report(result, source, args.json)
    v = manifest["manifest"]["verification"]
    print(DIM(f"  recorded in {args.target}: {v['evidence_present']}/{v['evidence_total']} "
              f"present at {v['checked_at']}\n"))
    return 0 if result["valid"] else 1


def cmd_repair(args) -> int:
    if _is_url(args.target):
        sys.stderr.write(RED("error: repair needs a local manifest file to rewrite\n"))
        return 2
    try:
        raw, source = _read_manifest(args.target)
        manifest, _ = parse_manifest(raw)
    except Exception as e:
        sys.stderr.write(RED(f"error: {e}\n"))
        return 2

    print(f"\n{BOLD(source)}\n")

    def on_event(e):
        if e["kind"] == "relocated":
            print(f"  {YELLOW('relocated')} {e['where']} {DIM('(overlap ' + str(e['score']) + ')')}")
            print(DIM(f"     was: {e['before'][:84]}\n     now: {e['after'][:84]}"))
        elif e["kind"] == "lost":
            print(f"  {RED('lost')}      {e['where']} {DIM('no sufficiently similar text on the page')}")
            print(DIM(f"     was: {e['text'][:84]}"))
        elif e["kind"] == "unreachable":
            print(f"  {RED('unreachable')} {e['where']} {DIM(e['reason'])}")
        elif e["kind"] == "claims-dropped":
            print(f"  {RED('dropped')}   {e['count']} claim(s) left with no evidence")

    res = repair_manifest(manifest, threshold=args.threshold or SIMILARITY_THRESHOLD,
                          prune=args.prune, on_event=on_event)
    c = res["counts"]
    print(f"\n  {c.get('present', 0)} present · {c.get('relocated', 0)} relocated · "
          f"{c.get('lost', 0)} lost · {c.get('unreachable', 0)} unreachable")

    if args.dry_run:
        print(DIM("  --dry-run: nothing written\n"))
        return 1 if (c.get("lost") or c.get("unreachable")) else 0

    after = validate_manifest(res["manifest"], offline=False)
    stamp_verification(res["manifest"], after, method="automated-recheck")
    Path(args.target).write_text(json.dumps(res["manifest"], indent=2) + "\n", encoding="utf-8")
    v = res["manifest"]["manifest"]["verification"]
    print(f"  wrote {BOLD(args.target)} — {v['evidence_present']}/{v['evidence_total']} "
          f"confirmed present")
    if c.get("lost") and not args.prune:
        print(DIM(f"  {c['lost']} unconfirmed entr(ies) kept without last_seen; "
                  f"use --prune to remove them"))
    print()
    return 1 if after["errors"] else 0


def cmd_extract(args) -> int:
    if not _is_url(args.url):
        sys.stderr.write(RED("error: extract needs a URL\n"))
        return 2
    opts = {}
    if args.max_pages:
        opts["maxPages"] = args.max_pages
    if args.per_type is not None:
        opts["maxPerType"] = args.per_type
    try:
        if args.page_only:
            r = extract_from_page(args.url, opts)
            from urllib.parse import urlsplit
            p = urlsplit(args.url)
            manifest = to_manifest(f"{p.scheme}://{p.netloc}", r["candidates"])
        else:
            manifest = extract_from_site(args.url, opts)["manifest"]
    except FetchRefused as e:
        sys.stderr.write(RED(f"error: {e.code}: {e.message}\n"))
        return 2
    text = json.dumps(manifest, indent=2) + "\n"
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        sys.stderr.write(f"\n  wrote {BOLD(args.out)} — {len(manifest['claims'])} claims, "
                         f"{len(text.encode()) / 1024:.1f} KiB\n")
    else:
        sys.stdout.write(text)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="ai-evidence",
        description="Reference tooling for the AI Evidence Manifest.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init", help="create ai-evidence.config.json for a site")
    p.add_argument("url")
    p.add_argument("--config")
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_init)

    p = sub.add_parser("generate", help="read the config, find evidence, write the manifest")
    p.add_argument("--config")
    p.add_argument("--out", help="write to this path instead of the default locations")
    p.add_argument("--no-alias", action="store_true",
                   help="write only the canonical .well-known path")
    p.set_defaults(fn=cmd_generate)

    for name, help_text in (("validate", "validate a manifest"),
                            ("check", "re-check that evidence is still present at source")):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("target")
        p.add_argument("--offline", action="store_true")
        p.add_argument("--online", action="store_true")
        p.add_argument("--strict", action="store_true")
        p.add_argument("--json", action="store_true")
        p.add_argument("--jwks", help="key set to check signatures against")
        if name == "check":
            p.add_argument("--update", action="store_true",
                           help="write the freshness result back into the manifest")
            p.add_argument("--interval", type=int,
                           help="days between intended re-checks, recorded in the manifest")
            p.set_defaults(fn=cmd_check)
        else:
            p.set_defaults(fn=cmd_validate)

    p = sub.add_parser("repair", help="re-check, relocate drifted quotes, rewrite the file")
    p.add_argument("target")
    p.add_argument("--prune", action="store_true")
    p.add_argument("--threshold", type=float)
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(fn=cmd_repair)

    p = sub.add_parser("extract", help="one-shot generate without a config file")
    p.add_argument("url")
    p.add_argument("--out")
    p.add_argument("--max-pages", type=int)
    p.add_argument("--per-type", type=int)
    p.add_argument("--page-only", action="store_true")
    p.set_defaults(fn=cmd_extract)

    p = sub.add_parser("keygen", help="create an Ed25519 signing key and a JWKS")
    p.add_argument("--out", help="where to write (default: the current directory)")
    p.add_argument("--site", help="host to print the optional DNS TXT record for")
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_keygen)

    p = sub.add_parser("sign", help="sign a manifest")
    p.add_argument("target")
    p.add_argument("--key", help="private key JWK (default ai-evidence-signing-key.json)")
    p.add_argument("--out", help="write the signed manifest here (default: in place)")
    p.set_defaults(fn=cmd_sign)

    p = sub.add_parser("verify", help="check a manifest's signatures against a JWKS")
    p.add_argument("target")
    p.add_argument("--jwks", help=f"key set (default: {JWKS_PATH} at the manifest origin)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_verify)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
