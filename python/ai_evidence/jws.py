"""Detached-payload JWS (RFC 7515) over canonical manifest JSON, with Ed25519.

A port of reference-implementation/jws.js. The rationale for every design
decision -- single algorithm, exact-octet header verification, detached
payload, closed header parameter set, signature-covered `iat` -- is documented
there and applies identically here.

`cryptography` is a hard dependency rather than an optional extra on purpose:
verification is the common operation, performed by consumers who did not choose
to install anything, and a signature format that silently cannot be checked on
a default install is worse than no signature format.
"""

import base64
import hashlib
import json
import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.exceptions import InvalidSignature

from .canonical import canonicalize, canonical_bytes, CanonicalizationError

__all__ = [
    "SignatureError", "SIGNATURE_TYP", "SIGNATURE_ALG", "SIGNATURE_CRV", "JWKS_PATH",
    "DEFAULT_SKEW_SECONDS", "jwk_thumbprint", "generate_key_pair", "public_jwk_of",
    "build_jwks", "signing_payload", "sign_manifest", "verify_manifest",
    "dns_txt_record", "parse_dns_txt_record",
]

SIGNATURE_TYP = "aem-signature+jws"
SIGNATURE_ALG = "EdDSA"
SIGNATURE_CRV = "Ed25519"
JWKS_PATH = "/.well-known/ai-evidence-jwks.json"
DEFAULT_SKEW_SECONDS = 300

_HEADER_PARAMS = ("alg", "typ", "kid", "iat")
_MAX_SAFE_INTEGER = 2 ** 53 - 1


class SignatureError(ValueError):
    """A signature could not be produced, or could not be trusted."""

    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def _b64u(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64u(s):
    if not isinstance(s, str):
        raise SignatureError("expected a base64url string", "malformed")
    pad = "=" * (-len(s) % 4)
    try:
        return base64.urlsafe_b64decode(s + pad)
    except Exception:
        raise SignatureError("value is not valid base64url", "malformed")


def jwk_thumbprint(jwk):
    """RFC 7638 JWK thumbprint, used as the `kid`."""
    if (not isinstance(jwk, dict) or jwk.get("kty") != "OKP"
            or jwk.get("crv") != SIGNATURE_CRV or not isinstance(jwk.get("x"), str)):
        raise SignatureError(
            'thumbprint requires an OKP/%s JWK with an "x" member' % SIGNATURE_CRV, "bad-key")
    required = {"crv": jwk["crv"], "kty": jwk["kty"], "x": jwk["x"]}
    return _b64u(hashlib.sha256(canonicalize(required).encode("utf-8")).digest())


def generate_key_pair():
    """Generate an Ed25519 signing key. The `kid` is the thumbprint of the public key."""
    private = Ed25519PrivateKey.generate()
    from cryptography.hazmat.primitives import serialization
    raw_private = private.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption())
    raw_public = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw)
    x = _b64u(raw_public)
    kid = jwk_thumbprint({"kty": "OKP", "crv": SIGNATURE_CRV, "x": x})
    return {
        "kid": kid,
        "public_jwk": {"kty": "OKP", "crv": SIGNATURE_CRV, "x": x,
                       "kid": kid, "use": "sig", "alg": SIGNATURE_ALG},
        "private_jwk": {"kty": "OKP", "crv": SIGNATURE_CRV, "x": x, "d": _b64u(raw_private),
                        "kid": kid, "use": "sig", "alg": SIGNATURE_ALG},
    }


def public_jwk_of(private_jwk):
    """The public half of a private JWK, in the form that belongs in a JWKS."""
    kid = jwk_thumbprint(private_jwk)
    return {"kty": private_jwk["kty"], "crv": private_jwk["crv"], "x": private_jwk["x"],
            "kid": kid, "use": "sig", "alg": SIGNATURE_ALG}


def build_jwks(public_jwks):
    """A JWKS document ready to serve at JWKS_PATH."""
    return {"keys": [
        {"kty": k["kty"], "crv": k["crv"], "x": k["x"],
         "kid": k.get("kid") or jwk_thumbprint(k), "use": "sig", "alg": SIGNATURE_ALG}
        for k in public_jwks]}


def signing_payload(doc):
    """The payload every signature covers: the manifest without its `signatures` member."""
    return canonical_bytes({k: v for k, v in doc.items() if k != "signatures"})


def sign_manifest(doc, private_jwk, iat=None, kid=None):
    """Sign a manifest, returning a new document with the signature appended."""
    if (not isinstance(private_jwk, dict) or private_jwk.get("kty") != "OKP"
            or private_jwk.get("crv") != SIGNATURE_CRV or not isinstance(private_jwk.get("d"), str)):
        raise SignatureError("signing requires an OKP/%s private JWK" % SIGNATURE_CRV, "bad-key")

    if iat is None:
        iat = int(time.time())
    if not isinstance(iat, int) or isinstance(iat, bool) or abs(iat) > _MAX_SAFE_INTEGER:
        raise SignatureError("iat must be an integer number of seconds", "bad-iat")

    header = {
        "alg": SIGNATURE_ALG,
        "typ": SIGNATURE_TYP,
        "kid": kid or private_jwk.get("kid") or jwk_thumbprint(private_jwk),
        "iat": iat,
    }

    payload = signing_payload(doc)
    protected_b64 = _b64u(canonicalize(header).encode("utf-8"))
    signing_input = ("%s.%s" % (protected_b64, _b64u(payload))).encode("ascii")

    key = Ed25519PrivateKey.from_private_bytes(_unb64u(private_jwk["d"]))
    signature = key.sign(signing_input)

    existing = doc.get("signatures") if isinstance(doc.get("signatures"), list) else []
    out = dict(doc)
    out["signatures"] = list(existing) + [{"protected": protected_b64, "signature": _b64u(signature)}]
    return out


def _parse_header(protected_b64):
    try:
        header = json.loads(_unb64u(protected_b64).decode("utf-8"))
    except SignatureError:
        raise SignatureError("protected header is not valid base64url-encoded JSON", "bad-header")
    except Exception:
        raise SignatureError("protected header is not valid base64url-encoded JSON", "bad-header")
    if not isinstance(header, dict):
        raise SignatureError("protected header is not a JSON object", "bad-header")
    if sorted(header) != sorted(_HEADER_PARAMS):
        raise SignatureError(
            "protected header must carry exactly %s (got %s)"
            % (", ".join(sorted(_HEADER_PARAMS)), ", ".join(sorted(header)) or "nothing"), "bad-header")
    if header["alg"] != SIGNATURE_ALG:
        raise SignatureError(
            "unsupported alg %s; only %s is defined" % (json.dumps(header["alg"]), SIGNATURE_ALG), "bad-alg")
    if header["typ"] != SIGNATURE_TYP:
        raise SignatureError("typ must be %s" % SIGNATURE_TYP, "bad-typ")
    if not isinstance(header["kid"], str) or not header["kid"]:
        raise SignatureError("kid must be a non-empty string", "bad-header")
    iat = header["iat"]
    if not isinstance(iat, int) or isinstance(iat, bool) or abs(iat) > _MAX_SAFE_INTEGER:
        raise SignatureError("iat must be an integer number of seconds", "bad-iat")
    return header


def verify_manifest(doc, jwks, now=None, skew_seconds=DEFAULT_SKEW_SECONDS):
    """Verify every signature on a manifest against a JWKS.

    Returns a result per signature, because "this manifest is signed" and "this
    manifest is signed by the key I trust" are different questions.
    """
    if now is None:
        now = int(time.time())

    signatures = doc.get("signatures") if isinstance(doc, dict) else None
    if not isinstance(signatures, list) or not signatures:
        return {"signed": False, "verified": False, "results": []}

    try:
        payload_b64 = _b64u(signing_payload(doc))
    except CanonicalizationError as err:
        return {"signed": True, "verified": False,
                "results": [{"valid": False, "code": "uncanonicalizable", "reason": str(err)}
                            for _ in signatures]}

    keys = {}
    for k in (jwks or {}).get("keys", []):
        try:
            keys[k.get("kid") or jwk_thumbprint(k)] = k
        except SignatureError:
            continue

    results = []
    for sig in signatures:
        try:
            if (not isinstance(sig, dict) or not isinstance(sig.get("protected"), str)
                    or not isinstance(sig.get("signature"), str)):
                raise SignatureError(
                    'signature entry needs string "protected" and "signature" members', "malformed")
            header = _parse_header(sig["protected"])
            key = keys.get(header["kid"])
            if key is None:
                raise SignatureError("no key with kid %s in the key set" % header["kid"], "unknown-kid")
            if key.get("kty") != "OKP" or key.get("crv") != SIGNATURE_CRV:
                raise SignatureError(
                    "key %s is not an OKP/%s key" % (header["kid"], SIGNATURE_CRV), "bad-key")
            thumb = jwk_thumbprint(key)
            if thumb != header["kid"]:
                raise SignatureError(
                    "kid %s does not match the key's thumbprint %s" % (header["kid"], thumb),
                    "kid-mismatch")
            if header["iat"] > now + skew_seconds:
                raise SignatureError(
                    "iat %d is more than %ds in the future" % (header["iat"], skew_seconds), "iat-future")

            signing_input = ("%s.%s" % (sig["protected"], payload_b64)).encode("ascii")
            public = Ed25519PublicKey.from_public_bytes(_unb64u(key["x"]))
            try:
                public.verify(_unb64u(sig["signature"]), signing_input)
            except InvalidSignature:
                raise SignatureError("signature does not verify over the canonical manifest", "invalid")

            results.append({"valid": True, "kid": header["kid"], "iat": header["iat"]})
        except SignatureError as err:
            results.append({"valid": False, "code": err.code, "reason": str(err)})

    return {"signed": True, "verified": any(r["valid"] for r in results), "results": results}


def dns_txt_record(public_jwk, host):
    """The DNS TXT record that anchors a key outside the web origin it signs for."""
    kid = public_jwk.get("kid") or jwk_thumbprint(public_jwk)
    return {"name": "_ai-evidence.%s" % host, "type": "TXT",
            "value": "v=aem1; k=ed25519; kid=%s; p=%s" % (kid, public_jwk["x"])}


def parse_dns_txt_record(value):
    """Parse a TXT record published per dns_txt_record() into a public JWK."""
    fields = {}
    for part in str(value).split(";"):
        part = part.strip()
        if not part:
            continue
        head, sep, tail = part.partition("=")
        fields[head.strip()] = tail.strip() if sep else ""
    if fields.get("v") != "aem1":
        raise SignatureError(
            "unsupported TXT record version %s" % json.dumps(fields.get("v")), "bad-txt")
    if fields.get("k") != "ed25519":
        raise SignatureError("unsupported key type %s" % json.dumps(fields.get("k")), "bad-txt")
    if not fields.get("p"):
        raise SignatureError("TXT record has no p= public key", "bad-txt")
    jwk = {"kty": "OKP", "crv": SIGNATURE_CRV, "x": fields["p"], "use": "sig", "alg": SIGNATURE_ALG}
    thumb = jwk_thumbprint(jwk)
    if fields.get("kid") and fields["kid"] != thumb:
        raise SignatureError(
            "TXT record kid %s does not match the key's thumbprint %s" % (fields["kid"], thumb),
            "kid-mismatch")
    jwk["kid"] = thumb
    return jwk
