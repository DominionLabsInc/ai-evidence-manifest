"""Python-side tests. Cross-implementation parity lives in the Node suite,
which runs both and compares; these cover the Python code on its own."""
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ai_evidence.extract import candidates_from_html, split_sentences, to_manifest
from ai_evidence.fetch_safe import FetchRefused, assert_fetchable, normalize_input_url
from ai_evidence.html import extract_blocks, extract_json_ld, extract_text
from ai_evidence.normalize import (contains_normalized, normalize_text,
                                   sha256_of_text, text_fragment)
from ai_evidence.repair import best_match, similarity
from ai_evidence.validate import parse_manifest, stamp_verification, validate_manifest

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
EXAMPLES = Path(__file__).resolve().parents[2] / "examples"


class TestNormalize:
    def test_collapses_whitespace_and_applies_nfc(self):
        assert normalize_text("  a \n\t b  ") == "a b"
        assert sha256_of_text("café") == sha256_of_text("café")

    def test_hash_stable_across_reflowed_whitespace(self):
        assert sha256_of_text("one   two") == sha256_of_text("one two")

    def test_hash_changes_when_text_changes(self):
        assert sha256_of_text("one two") != sha256_of_text("one three")

    def test_contains_ignores_case_and_spacing(self):
        assert contains_normalized("The  QUICK brown fox", "quick   Brown")
        assert not contains_normalized("the quick brown fox", "lazy dog")

    def test_fragment_encoding_matches_encodeuricomponent(self):
        # JavaScript leaves !~*'() unescaped; the spec pins that. See SPEC 5.1.
        assert text_fragment("a (b) c!") == "#:~:text=a%20(b)%20c!"


class TestSSRF:
    @pytest.mark.parametrize("url", [
        "http://example.com/", "https://localhost/", "https://127.0.0.1/",
        "https://169.254.169.254/latest/meta-data/", "https://10.0.0.1/",
        "https://192.168.1.1/", "https://172.16.0.1/", "https://100.64.0.1/",
        "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://[fe80::1]/",
        "https://[fd00::1]/", "https://vault.internal/", "https://user:pw@example.com/",
    ])
    def test_refuses(self, url):
        with pytest.raises(FetchRefused):
            assert_fetchable(url, resolve=False)

    @pytest.mark.parametrize("url", ["https://example.com/page", "https://[2606:4700::1111]/"])
    def test_allows_public(self, url):
        assert assert_fetchable(url, resolve=False)

    @pytest.mark.parametrize("given,expected", [
        ("example.com", "https://example.com/"),
        ("http://example.com", "https://example.com/"),
        ("  example.com  ", "https://example.com/"),
    ])
    def test_normalizes_input(self, given, expected):
        assert normalize_input_url(given) == expected


class TestHtml:
    TRICKY = ('<body><section id="s"><p title="a>b">First sentence here.</p>'
              '<p>unclosed<p>second</section><ul><li>alpha</li><li>beta</li></ul>'
              '<script>var a="LEAK";</script><noscript>LEAK</noscript></body>')

    def test_attribute_with_gt_does_not_truncate(self):
        assert "First sentence here." in extract_text(self.TRICKY)

    def test_unclosed_paragraphs_become_separate_blocks(self):
        texts = [b["text"] for b in extract_blocks(self.TRICKY)]
        assert texts[:3] == ["First sentence here.", "unclosed", "second"]

    def test_adjacent_blocks_do_not_run_together(self):
        assert "here.unclosed" not in extract_text(self.TRICKY)

    def test_script_and_noscript_never_leak(self):
        assert "LEAK" not in extract_text(self.TRICKY)

    def test_malformed_json_ld_is_ignored(self):
        assert extract_json_ld('<script type="application/ld+json">{oops</script>') == []


class TestSentences:
    def test_company_suffix_does_not_end_a_sentence(self):
        out = split_sentences("This explains how Dominion Labs Inc. collects data. Next one here.")
        assert any("Inc. collects" in s for s in out)

    def test_possessive_does_not_join_sentences(self):
        out = split_sentences("It is the substrate’s. The reason matters.")
        assert out[0].endswith("substrate’s.")


class TestExtract:
    PAGE = ('<html><head><title>Acme</title><meta name="description" '
            'content="Acme builds autonomous warehouse robotics for regulated industries.">'
            '</head><body><section id="s">'
            '<p>We build autonomous warehouse systems for regulated industries.</p>'
            '<p>Acme completed a SOC 2 Type II audit covering security this year.</p>'
            '</section></body></html>')

    def test_never_emits_text_absent_from_the_page(self):
        html = ('<html><head><script type="application/ld+json">'
                '{"@type":"Organization","name":"Acme","description":"Nowhere on the page at all."}'
                '</script></head><body><p>Acme is an independent robotics company in Leeds.</p></body></html>')
        texts = [e["text"] for c in candidates_from_html(html, "https://a.example/", {"claims": "all"})["candidates"]
                 for e in c["evidence"]]
        assert not any("Nowhere on the page" in t for t in texts)

    def test_every_quote_hashes_to_its_own_text(self):
        for c in candidates_from_html(self.PAGE, "https://a.example/")["candidates"]:
            for e in c["evidence"]:
                assert e["integrity"]["sha256"] == sha256_of_text(e["text"])

    def test_marks_output_as_automatically_generated(self):
        for c in candidates_from_html(self.PAGE, "https://a.example/")["candidates"]:
            for e in c["evidence"]:
                assert e["verification"]["method"] == "automatically-generated"
                assert e["verification"]["verified"] is False

    def test_rejects_boilerplate(self):
        html = '<body><p>By using the Services, you acknowledge that you have read this Policy.</p></body>'
        claims = candidates_from_html(html, "https://a.example/")["candidates"]
        assert not any("By using the Services" in c["claim"] for c in claims)


class TestValidate:
    def test_examples_validate_strictly(self):
        for name in ("ai.json", "minimal.json"):
            manifest, nbytes = parse_manifest((EXAMPLES / name).read_text())
            r = validate_manifest(manifest, offline=True, strict=True, raw_bytes=nbytes)
            assert r["valid"], json.dumps(r["findings"], indent=1)

    @pytest.mark.parametrize("fixture,code", [
        ("duplicate-ids.json", "duplicate-id"),
        ("hash-mismatch.json", "integrity-mismatch"),
        ("stale.json", "stale"),
        ("auto-verified.json", "auto-verified"),
        ("selector-only.json", "selector-only"),
    ])
    def test_detects(self, fixture, code):
        manifest, nbytes = parse_manifest((FIXTURES / fixture).read_text())
        r = validate_manifest(manifest, offline=True, raw_bytes=nbytes)
        assert code in {f["code"] for f in r["findings"]}

    @pytest.mark.parametrize("fixture", [
        "missing-required.json", "invalid-url-http.json", "invalid-url-javascript.json",
        "malformed-date.json", "unknown-type.json", "unknown-field.json", "no-claims.json",
    ])
    def test_rejects(self, fixture):
        manifest, nbytes = parse_manifest((FIXTURES / fixture).read_text())
        assert not validate_manifest(manifest, offline=True, raw_bytes=nbytes)["valid"]

    def test_stamps_freshness(self):
        manifest, _ = parse_manifest((EXAMPLES / "minimal.json").read_text())
        result = {"stats": {"evidence": 1, "textPresent": 1}, "seen": [{"ci": 0, "ei": 0, "present": True}]}
        stamp_verification(manifest, result, method="automated-recheck", recheck_interval_days=7)
        v = manifest["manifest"]["verification"]
        assert v["evidence_present"] == 1 and v["recheck_interval_days"] == 7
        assert manifest["claims"][0]["evidence"][0]["last_seen"]


class TestRepair:
    def test_similarity_scores(self):
        assert similarity("a b c", "a b c") == 1.0
        assert similarity("we build systems", "we build machines") == pytest.approx(0.5)
        assert similarity("alpha beta", "gamma delta") == 0.0

    def test_relocates_a_minor_edit(self):
        blocks = [{"id": "s", "section": None, "tag": "p",
                   "text": "We build autonomous warehouse systems for regulated industries."}]
        m = best_match(blocks, "We build autonomous warehouse systems for regulated sectors.")
        assert m and m["score"] >= 0.6

    def test_refuses_an_unrelated_replacement(self):
        blocks = [{"id": "s", "section": None, "tag": "p",
                   "text": "Our privacy policy explains cookie retention."}]
        assert best_match(blocks, "We build autonomous warehouse systems.") is None
