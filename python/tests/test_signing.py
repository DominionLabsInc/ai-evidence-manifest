"""Signing tests, mirroring tests/signing.test.js case for case.

The conformance section is the one that matters most: it pins the Python
implementation to bytes produced by the JavaScript one, so canonicalization or
header encoding cannot drift between them without a test going red.
"""
import base64
import hashlib
import json
from pathlib import Path

import pytest

from ai_evidence.canonical import CanonicalizationError, canonicalize
from ai_evidence.jws import (SignatureError, build_jwks, dns_txt_record,
                             generate_key_pair, jwk_thumbprint,
                             parse_dns_txt_record, sign_manifest,
                             signing_payload, verify_manifest)

ROOT = Path(__file__).resolve().parents[2]
CONF = ROOT / "tests" / "conformance"


def read(p):
    return json.loads((ROOT / p).read_text(encoding="utf-8"))


def b64u(obj):
    raw = json.dumps(obj).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


class TestCanonical:
    VECTORS = read("tests/conformance/canonical/vectors.json")["vectors"]

    @pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
    def test_vector(self, vector):
        assert canonicalize(vector["input"]) == vector["expected"]

    def test_refuses_values_that_are_not_portable(self):
        """Each of these would canonicalize differently, or not at all, in the
        JavaScript implementation."""
        for bad in [1.5, -0.5, 1e21, 2 ** 53, -(2 ** 53), float("nan"), float("inf")]:
            with pytest.raises(CanonicalizationError):
                canonicalize(bad)
        with pytest.raises(CanonicalizationError):
            canonicalize("\ud800")
        with pytest.raises(CanonicalizationError):
            canonicalize({1: "non-string key"})

    def test_source_order_does_not_matter(self):
        assert canonicalize({"a": 1, "b": 2}) == canonicalize({"b": 2, "a": 1})


class TestKeys:
    def test_kid_is_the_thumbprint(self):
        kp = generate_key_pair()
        assert kp["kid"] == jwk_thumbprint(kp["public_jwk"])
        assert kp["kid"] == jwk_thumbprint(kp["private_jwk"])

    def test_thumbprint_uses_required_members_only(self):
        kp = generate_key_pair()
        noisy = {**kp["public_jwk"], "ext": True, "key_ops": ["verify"]}
        assert jwk_thumbprint(noisy) == kp["kid"]

    def test_jwks_carries_no_private_material(self):
        kp = generate_key_pair()
        jwks = build_jwks([kp["public_jwk"]])
        assert kp["private_jwk"]["d"] not in json.dumps(jwks)
        assert "d" not in jwks["keys"][0]

    def test_dns_record_round_trip_and_relabelling(self):
        kp = generate_key_pair()
        rec = dns_txt_record(kp["public_jwk"], "example.com")
        assert rec["name"] == "_ai-evidence.example.com"
        assert parse_dns_txt_record(rec["value"])["kid"] == kp["kid"]
        relabelled = rec["value"].replace(kp["kid"], "A" * 43)
        with pytest.raises(SignatureError, match="thumbprint"):
            parse_dns_txt_record(relabelled)
        with pytest.raises(SignatureError, match="version"):
            parse_dns_txt_record("v=aem2; k=ed25519; p=x")


class TestSigning:
    manifest = read("examples/ai.json")

    def test_round_trip(self):
        kp = generate_key_pair()
        signed = sign_manifest(self.manifest, kp["private_jwk"])
        r = verify_manifest(signed, build_jwks([kp["public_jwk"]]))
        assert r["verified"]
        assert r["results"][0]["kid"] == kp["kid"]

    def test_reserializing_does_not_break_the_signature(self):
        """The reason the payload is canonical JSON rather than the bytes as
        served: an agent that stores a manifest and hands it on re-serializes it."""
        kp = generate_key_pair()
        signed = sign_manifest(self.manifest, kp["private_jwk"])
        round_tripped = json.loads(json.dumps(signed, indent=4))
        reordered = dict(reversed(list(round_tripped.items())))
        assert verify_manifest(reordered, build_jwks([kp["public_jwk"]]))["verified"]

    @pytest.mark.parametrize("what", [
        "claim text", "evidence quote", "evidence url", "manifest site",
        "integrity hash", "an added claim", "a removed claim", "an added member",
    ])
    def test_tampering_is_detected(self, what):
        kp = generate_key_pair()
        jwks = build_jwks([kp["public_jwk"]])
        signed = sign_manifest(self.manifest, kp["private_jwk"])
        m = json.loads(json.dumps(signed))
        if what == "claim text":
            m["claims"][0]["claim"] = "A different claim."
        elif what == "evidence quote":
            m["claims"][0]["evidence"][0]["text"] += " "
        elif what == "evidence url":
            m["claims"][0]["evidence"][0]["url"] = "https://evil.example/"
        elif what == "manifest site":
            m["manifest"]["site"] = "https://evil.example"
        elif what == "integrity hash":
            m["claims"][0]["evidence"][0]["integrity"]["sha256"] = "f" * 64
        elif what == "an added claim":
            m["claims"].append(json.loads(json.dumps(m["claims"][0])))
        elif what == "a removed claim":
            m["claims"].pop()
        elif what == "an added member":
            m["publisher"] = {**m.get("publisher", {}), "injected": True}
        r = verify_manifest(m, jwks)
        assert not r["verified"], f"tampering with {what} went undetected"
        assert r["results"][0]["code"] == "invalid"

    def test_signatures_member_is_outside_the_payload(self):
        a, b = generate_key_pair(), generate_key_pair()
        signed = sign_manifest(sign_manifest(self.manifest, a["private_jwk"]), b["private_jwk"])
        assert len(signed["signatures"]) == 2
        r = verify_manifest(signed, build_jwks([a["public_jwk"], b["public_jwk"]]))
        assert sum(1 for x in r["results"] if x["valid"]) == 2

    def test_judged_only_against_the_key_set_supplied(self):
        mine, theirs = generate_key_pair(), generate_key_pair()
        signed = sign_manifest(self.manifest, mine["private_jwk"])
        r = verify_manifest(signed, build_jwks([theirs["public_jwk"]]))
        assert not r["verified"]
        assert r["results"][0]["code"] == "unknown-kid"

    def test_refuses_a_document_it_cannot_canonicalize(self):
        kp = generate_key_pair()
        bad = {**self.manifest, "extensions": {"vendor.example": {"ratio": 0.5}}}
        with pytest.raises(CanonicalizationError):
            sign_manifest(bad, kp["private_jwk"])

    def test_refuses_a_key_that_is_not_ed25519(self):
        with pytest.raises(SignatureError):
            sign_manifest(self.manifest, {"kty": "EC", "crv": "P-256", "d": "x"})


class TestForgery:
    manifest = read("examples/minimal.json")

    @staticmethod
    def _fixture():
        kp = generate_key_pair()
        jwks = build_jwks([kp["public_jwk"]])
        signed = sign_manifest(TestForgery.manifest, kp["private_jwk"])
        head = signed["signatures"][0]["protected"]
        header = json.loads(base64.urlsafe_b64decode(head + "=" * (-len(head) % 4)))
        return kp, jwks, signed, header

    def _code(self, jwks, signed, header, **overrides):
        doc = {**self.manifest, "signatures": [
            {"protected": b64u({**header, **overrides}),
             "signature": signed["signatures"][0]["signature"]}]}
        return verify_manifest(doc, jwks)["results"][0]["code"]

    def test_rejects_alg_none(self):
        _, jwks, signed, header = self._fixture()
        assert self._code(jwks, signed, header, alg="none") == "bad-alg"

    @pytest.mark.parametrize("alg", ["HS256", "RS256", "ES256", "EdDSA "])
    def test_rejects_substituted_algorithms(self, alg):
        _, jwks, signed, header = self._fixture()
        assert self._code(jwks, signed, header, alg=alg) == "bad-alg"

    def test_rejects_a_signature_minted_for_another_protocol(self):
        _, jwks, signed, header = self._fixture()
        assert self._code(jwks, signed, header, typ="JWT") == "bad-typ"

    def test_rejects_unknown_or_missing_header_parameters(self):
        _, jwks, signed, header = self._fixture()
        assert self._code(jwks, signed, header, extra=1) == "bad-header"
        no_kid = {k: v for k, v in header.items() if k != "kid"}
        doc = {**self.manifest, "signatures": [
            {"protected": b64u(no_kid), "signature": signed["signatures"][0]["signature"]}]}
        assert verify_manifest(doc, jwks)["results"][0]["code"] == "bad-header"

    def test_rejects_a_key_relabelled_with_someone_elses_kid(self):
        """An attacker who can serve the JWKS puts their own key under the
        honest kid. The thumbprint check is what stops it."""
        kp, _, signed, _ = self._fixture()
        attacker = generate_key_pair()
        swapped = {"keys": [{**attacker["public_jwk"], "kid": kp["kid"]}]}
        assert verify_manifest(signed, swapped)["results"][0]["code"] == "kid-mismatch"

    def test_rejects_a_signing_time_in_the_future(self):
        _, jwks, signed, header = self._fixture()
        early = verify_manifest(signed, jwks, now=header["iat"] - 3600)
        assert early["results"][0]["code"] == "iat-future"
        assert verify_manifest(signed, jwks, now=header["iat"] - 60)["verified"]

    @pytest.mark.parametrize("bad", [{}, {"protected": 1, "signature": "x"},
                                     {"protected": "!!", "signature": "x"}, None])
    def test_rejects_malformed_entries_without_raising(self, bad):
        _, jwks, _, _ = self._fixture()
        r = verify_manifest({**self.manifest, "signatures": [bad]}, jwks)
        assert not r["verified"]

    def test_unsigned_is_reported_as_unsigned(self):
        _, jwks, _, _ = self._fixture()
        r = verify_manifest(self.manifest, jwks)
        assert r["signed"] is False
        assert r["verified"] is False


class TestConformance:
    manifest = read("tests/conformance/signing/manifest.json")
    expected = read("tests/conformance/signing/expected.json")
    key = read("tests/conformance/signing/key.json")
    jwks = read("tests/conformance/signing/jwks.json")

    def test_canonical_form_matches_the_recorded_hash(self):
        canon = canonicalize(self.manifest).encode("utf-8")
        assert len(canon) == self.expected["canonical_bytes"]
        assert hashlib.sha256(canon).hexdigest() == self.expected["canonical_sha256"]

    def test_signature_reproduces_byte_for_byte(self):
        """Ed25519 is deterministic. Identical bytes here mean canonicalization,
        the protected header and the signing input all agree with the JavaScript
        implementation; any divergence shows up as a different signature rather
        than silently."""
        signed = sign_manifest(self.manifest, self.key, iat=self.expected["iat"])
        assert signed["signatures"][0] == self.expected["signature"]

    def test_recorded_signature_verifies(self):
        doc = {**self.manifest, "signatures": [self.expected["signature"]]}
        assert verify_manifest(doc, self.jwks, now=self.expected["iat"] + 10)["verified"]

    def test_payload_excludes_the_signatures_member(self):
        doc = {**self.manifest, "signatures": [self.expected["signature"]]}
        assert signing_payload(doc) == signing_payload(self.manifest)


class TestVersionCompatibility:
    def test_a_2_0_0_document_is_still_valid(self):
        """SPEC 11.1 claims 2.1.0 is a minor version. The fixtures are all
        written at 2.0.0 on purpose, so that claim is tested rather than
        asserted."""
        from ai_evidence.validate import validate_manifest
        doc = read("tests/fixtures/valid.json")
        assert doc["manifest"]["version"] == "2.0.0"
        assert validate_manifest(doc, offline=True, strict=True)["valid"]

    def test_unsigned_is_not_rejected_for_being_unsigned(self):
        from ai_evidence.validate import validate_manifest
        assert validate_manifest(read("examples/minimal.json"), offline=True)["valid"]


class TestCliRoundTrip:
    """keygen/sign/verify write files and are not otherwise covered; a stray
    identifier in any of them would only show up here."""

    def test_round_trip(self, tmp_path):
        import shutil
        import stat

        from ai_evidence.cli import main

        manifest = tmp_path / "ai.json"
        shutil.copyfile(ROOT / "examples" / "ai.json", manifest)
        jwks = tmp_path / ".well-known" / "ai-evidence-jwks.json"
        key = tmp_path / "ai-evidence-signing-key.json"

        assert main(["keygen", "--out", str(tmp_path), "--site", "https://example.com"]) == 0
        assert jwks.exists()
        assert stat.S_IMODE(key.stat().st_mode) == 0o600

        assert main(["sign", str(manifest), "--key", str(key)]) == 0
        assert main(["verify", str(manifest), "--jwks", str(jwks)]) == 0
        assert main(["validate", str(manifest), "--offline", "--jwks", str(jwks)]) == 0

        doc = json.loads(manifest.read_text())
        doc["claims"][0]["claim"] = "Something the publisher never signed."
        manifest.write_text(json.dumps(doc, indent=2))
        assert main(["verify", str(manifest), "--jwks", str(jwks)]) == 1

    def test_keygen_refuses_to_overwrite_an_existing_key(self, tmp_path):
        from ai_evidence.cli import main
        assert main(["keygen", "--out", str(tmp_path)]) == 0
        assert main(["keygen", "--out", str(tmp_path)]) == 2
        assert main(["keygen", "--out", str(tmp_path), "--force"]) == 0

    def test_refuses_to_sign_an_invalid_manifest(self, tmp_path):
        import shutil
        from ai_evidence.cli import main
        bad = tmp_path / "bad.json"
        shutil.copyfile(ROOT / "tests" / "fixtures" / "duplicate-ids.json", bad)
        assert main(["keygen", "--out", str(tmp_path)]) == 0
        assert main(["sign", str(bad), "--key", str(tmp_path / "ai-evidence-signing-key.json")]) == 1
