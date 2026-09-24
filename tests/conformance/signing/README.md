# Signing conformance vectors

Ed25519 is deterministic (RFC 8032 §5.1.6): the same key, the same document and
the same `iat` produce the same 64 bytes every time. That makes a signature a
usable conformance vector for everything underneath it — canonical JSON member
ordering and escaping, protected-header serialization, base64url encoding, and
the construction of the JWS signing input.

Both implementations must reproduce `expected.signature` exactly. If either
drifts in any of those layers, this test fails rather than the drift surfacing
later as a signature that verifies on one side and not the other.

`key.json` is a published test key, seeded with the byte `0x07` repeated 32
times. It is secret from nobody and must never sign a real manifest.
