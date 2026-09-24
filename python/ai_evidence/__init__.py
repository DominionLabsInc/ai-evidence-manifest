"""AI Evidence Manifest — reference implementation."""
from .config import CONFIG_FILENAME, generate, init_config, load_config, write_config
from .extract import (candidates_from_html, extract_from_page, extract_from_site,
                      to_manifest)
from .fetch_safe import FetchRefused, assert_fetchable, fetch_safe, normalize_input_url
from .canonical import CanonicalizationError, canonical_bytes, canonicalize
from .html import (extract_blocks, extract_json_ld, extract_meta, extract_text,
                   extract_title, looks_client_rendered)
from .jws import (JWKS_PATH, SIGNATURE_ALG, SIGNATURE_CRV, SIGNATURE_TYP,
                  SignatureError, build_jwks, dns_txt_record, generate_key_pair,
                  jwk_thumbprint, parse_dns_txt_record, public_jwk_of,
                  sign_manifest, signing_payload, verify_manifest)
from .normalize import (contains_normalized, normalize_text, sha256_of_text,
                        text_fragment)
from .repair import repair_manifest, similarity
from .validate import (LIMITS, SUPPORTED_MAJOR, parse_manifest, stamp_verification,
                       validate_manifest)

__version__ = "0.3.0"
__all__ = [
    "normalize_text", "sha256_of_text", "contains_normalized", "text_fragment",
    "fetch_safe", "assert_fetchable", "normalize_input_url", "FetchRefused",
    "extract_text", "extract_title", "extract_meta", "extract_json_ld",
    "extract_blocks", "looks_client_rendered",
    "candidates_from_html", "extract_from_page", "extract_from_site", "to_manifest",
    "validate_manifest", "parse_manifest", "stamp_verification", "LIMITS", "SUPPORTED_MAJOR",
    "repair_manifest", "similarity",
    "load_config", "write_config", "init_config", "generate", "CONFIG_FILENAME",
    "canonicalize", "canonical_bytes", "CanonicalizationError",
    "generate_key_pair", "public_jwk_of", "build_jwks", "jwk_thumbprint",
    "sign_manifest", "verify_manifest", "signing_payload",
    "dns_txt_record", "parse_dns_txt_record", "SignatureError",
    "JWKS_PATH", "SIGNATURE_ALG", "SIGNATURE_TYP", "SIGNATURE_CRV",
]
