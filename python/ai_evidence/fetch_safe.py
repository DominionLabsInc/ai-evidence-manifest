"""Fetching that treats every URL as attacker-controlled.

A manifest is third-party input. Without these checks, "evidence" could point
at 169.254.169.254 and turn any consumer into a cloud-credential exfiltrator.

Mirrors the JavaScript implementation, including the IPv4-mapped IPv6 case: a
URL parser rewrites ``::ffff:127.0.0.1`` to ``::ffff:7f00:1``, so addresses are
judged on their bits, never on their textual form.
"""
from __future__ import annotations

import ipaddress
import re
import socket
import urllib.request
import urllib.error
from urllib.parse import urlsplit, urlunsplit

DEFAULTS = {
    "max_bytes": 8 * 1024 * 1024,   # pages are routinely >1 MiB; 1 MiB is the manifest limit
    "timeout": 15.0,
    "max_redirects": 5,
    "user_agent": "ai-evidence/0.1 (+https://github.com/DominionLabsInc/ai-evidence-manifest)",
}

_INTERNAL_HOST = re.compile(r"^(localhost|.*\.local|.*\.internal|.*\.localdomain)$", re.I)
_HAS_SCHEME = re.compile(r"^[a-z][a-z0-9+.\-]*://", re.I)


class FetchRefused(Exception):
    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.code = code
        self.message = message


def normalize_input_url(raw: str | None) -> str:
    """Accept what people actually type: a bare domain, or http://."""
    raw = (raw or "").strip()
    if not raw:
        raise FetchRefused("no URL given", "invalid-url")
    candidate = raw if _HAS_SCHEME.match(raw) else f"https://{raw}"
    parts = urlsplit(candidate)
    if not parts.netloc:
        raise FetchRefused(f"not a valid URL: {raw}", "invalid-url")
    if parts.scheme == "http":
        parts = parts._replace(scheme="https")      # upgrade rather than refuse
    return urlunsplit(parts._replace(path=parts.path or "/"))


def _is_blocked(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True                                  # unparseable: refuse rather than guess
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return not addr.is_global or addr.is_multicast or addr.is_reserved


def assert_fetchable(raw_url: str, resolve: bool = True) -> str:
    parts = urlsplit(raw_url)
    if parts.scheme != "https":
        raise FetchRefused(f"only https is allowed, got {parts.scheme}:", "not-https")
    if parts.username or parts.password:
        raise FetchRefused("credentials in URL are not allowed", "url-credentials")
    host = (parts.hostname or "").strip("[]")
    if not host:
        raise FetchRefused(f"not a valid URL: {raw_url}", "invalid-url")
    if _INTERNAL_HOST.match(host):
        raise FetchRefused(f"refusing internal hostname: {host}", "internal-host")
    try:
        ipaddress.ip_address(host)
        if _is_blocked(host):
            raise FetchRefused(f"refusing non-public address: {host}", "blocked-address")
        return raw_url
    except ValueError:
        pass
    if resolve:
        try:
            infos = socket.getaddrinfo(host, None)
        except socket.gaierror:
            raise FetchRefused(f"cannot resolve host: {host}", "dns-failure")
        for info in infos:
            address = info[4][0]
            if _is_blocked(address):
                raise FetchRefused(
                    f"{host} resolves to a non-public address ({address})", "blocked-address")
    return raw_url


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_safe(raw_url: str, accept: str = "*/*", **opts) -> dict:
    """Fetch with redirect, size and time limits. Every hop is re-checked."""
    o = {**DEFAULTS, **opts}
    url = raw_url
    opener = urllib.request.build_opener(_NoRedirect)

    for _ in range(o["max_redirects"] + 1):
        assert_fetchable(url)
        req = urllib.request.Request(
            url, headers={"User-Agent": o["user_agent"], "Accept": accept})
        try:
            res = opener.open(req, timeout=o["timeout"])
            status, headers, stream = res.status, res.headers, res
        except urllib.error.HTTPError as e:
            status, headers, stream = e.code, e.headers, e
        except Exception as e:                        # noqa: BLE001 - surfaced to the caller
            raise FetchRefused(f"request failed: {e}", "network")

        if 300 <= status < 400 and headers.get("Location"):
            url = urllib.parse.urljoin(url, headers["Location"])
            continue

        if status in (403, 429):
            raise FetchRefused(
                f"the site refused the request (HTTP {status}). Many sites block "
                f"non-browser clients; this page cannot be read automatically.",
                "blocked-by-site")
        if status == 404:
            raise FetchRefused("page not found (HTTP 404)", "not-found")
        if status >= 400:
            raise FetchRefused(f"server returned HTTP {status}", "http-error")

        declared = headers.get("Content-Length")
        if declared and declared.isdigit() and int(declared) > o["max_bytes"]:
            raise FetchRefused(
                f"response too large: {declared} > {o['max_bytes']}", "too-large")

        # Read in chunks so a lying Content-Length cannot exhaust memory.
        chunks, total = [], 0
        while True:
            chunk = stream.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > o["max_bytes"]:
                raise FetchRefused(
                    f"response exceeded {o['max_bytes']} bytes", "too-large")
            chunks.append(chunk)

        charset = headers.get_content_charset() or "utf-8"
        return {
            "url": url,
            "status": status,
            "contentType": headers.get("Content-Type", ""),
            "body": b"".join(chunks).decode(charset, errors="replace"),
            "bytes": total,
        }
    raise FetchRefused(f"too many redirects (> {o['max_redirects']})", "too-many-redirects")


import urllib.parse  # noqa: E402  (used by urljoin above)
