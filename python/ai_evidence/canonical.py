"""RFC 8785 (JSON Canonicalization Scheme) -- restricted to the value space this
specification is willing to sign.

This is a direct port of reference-implementation/canonical.js and must produce
byte-identical output for every input both accept. The restrictions, and the
reasoning behind each, are documented there; the short version is that a
signature is computed over bytes, and any disagreement between the two
implementations about which bytes a document "is" surfaces as a valid signature
that fails to verify somewhere else.

Two places where the obvious Python is wrong and the code below is deliberate:

  * Keys sort by UTF-16 code unit, not by code point. Python's default sort
    orders U+FFFF before U+1F600; RFC 8785 requires the opposite, because in
    UTF-16 the emoji begins with the surrogate D83D. Encoding to UTF-16BE and
    comparing bytes reproduces the required order.
  * Escaping is written out rather than delegated to json.dumps, so the rule
    lives in this repository instead of in an agreement between two standard
    libraries that neither project controls.
"""

__all__ = ["CanonicalizationError", "canonicalize", "canonical_bytes"]

_MAX_SAFE_INTEGER = 2 ** 53 - 1

_SHORT_ESCAPES = {
    0x08: "\\b",
    0x09: "\\t",
    0x0A: "\\n",
    0x0C: "\\f",
    0x0D: "\\r",
    0x22: '\\"',
    0x5C: "\\\\",
}


class CanonicalizationError(ValueError):
    """A value has no canonical form this specification will sign."""


def _escape_string(s, path):
    out = ['"']
    for ch in s:
        cp = ord(ch)
        if 0xD800 <= cp <= 0xDFFF:
            raise CanonicalizationError(
                "lone surrogate U+%04X at %s cannot be encoded as UTF-8" % (cp, path or "/"))
        short = _SHORT_ESCAPES.get(cp)
        if short is not None:
            out.append(short)
        elif cp < 0x20:
            out.append("\\u%04x" % cp)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _utf16_key(k):
    """Sort key reproducing RFC 8785's UTF-16 code unit ordering."""
    return k.encode("utf-16-be", "surrogatepass")


def _serialize(value, path):
    if value is None:
        return "null"

    # bool before int: bool is a subclass of int in Python.
    if value is True:
        return "true"
    if value is False:
        return "false"

    if isinstance(value, str):
        return _escape_string(value, path)

    if isinstance(value, int):
        if abs(value) > _MAX_SAFE_INTEGER:
            raise CanonicalizationError(
                "integer %d at %s is outside the IEEE 754 safe range and does not "
                "round-trip identically across implementations" % (value, path or "/"))
        return str(value)

    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise CanonicalizationError(
                "%r at %s is not representable in JSON" % (value, path or "/"))
        if value.is_integer() and abs(value) <= _MAX_SAFE_INTEGER:
            # JSON has one number type; 1.0 and 1 are the same value and must
            # canonicalize the same way, exactly as they do in JavaScript.
            return str(int(value))
        raise CanonicalizationError(
            "non-integer number %r at %s cannot be signed: canonical float formatting "
            "is not byte-identical across implementations (see canonical.py)" % (value, path or "/"))

    if isinstance(value, (list, tuple)):
        return "[" + ",".join(
            _serialize(item, "%s/%d" % (path, i)) for i, item in enumerate(value)) + "]"

    if isinstance(value, dict):
        # Keys are checked before sorting: the sort key encodes to UTF-16, which
        # would raise an unrelated AttributeError on a non-string key. JSON has
        # no such keys, and Python will happily hold one.
        for k in value:
            if not isinstance(k, str):
                raise CanonicalizationError(
                    "non-string object key %r at %s has no JSON representation" % (k, path or "/"))
        parts = ["%s:%s" % (_escape_string(k, path), _serialize(value[k], "%s/%s" % (path, k)))
                 for k in sorted(value, key=_utf16_key)]
        return "{" + ",".join(parts) + "}"

    raise CanonicalizationError(
        "value of type %s at %s has no JSON representation" % (type(value).__name__, path or "/"))


def canonicalize(value):
    """Canonical JSON text (RFC 8785, restricted). Encode as UTF-8 for the signed bytes."""
    return _serialize(value, "")


def canonical_bytes(value):
    """Canonical bytes: what a signature is actually computed over."""
    return canonicalize(value).encode("utf-8")
