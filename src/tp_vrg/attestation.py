"""Signed-artifact attestation — the federation attestation artifact.

Sigstore-class detached signatures over the engine's two exportable
boundary objects: the PortableArtifact (rung-level subgraph export, GDPR
Art 20) and the render trace (the Provenance Layer's answer + citations
record, the "memory you can audit" surface). Same family as Certificate
Transparency / Sigstore / eIDAS 2.0 qualified seals — explicitly NOT a
blockchain, no token, no distributed ledger.

Ed25519 detached signatures + did:web identity. This module is the single
canonical attestation implementation; the engine's MCP server, HTTP API, and
CLI all wire here.

Envelope shape (attestation_version 1):

    {
      "attestation_version": 1,
      "payload_type": "portable_artifact" | "render_trace",
      "payload": {...},                      # the artifact, verbatim
      "payload_hash": "sha256:<hex>",        # over canonical JSON of payload
      "signed_at": "<ISO-8601 UTC>",
      "signed_by": "<did:web:... or operator label>",
      "key_id": "ed25519:<fingerprint16>",
      "public_key": "<base64 raw Ed25519 public key>",
      "signature": "<base64 Ed25519 signature over the protected header>"
    }

The signature covers the *protected header* (every envelope field except
``payload`` and ``signature``, serialized canonically), which binds the
payload via its hash. The public key is embedded so any holder can check
INTEGRITY (tamper-evidence) offline; IDENTITY trust additionally requires
resolving the signer's did:web document (``build_did_web_document``) from
a domain the verifier trusts — embedding the key alone does not prove who
signed, and this module never claims it does.

Canonicalization: compact-separator, key-sorted, UTF-8 JSON (JCS-style;
``allow_nan=False`` so non-finite floats fail loud rather than producing
unverifiable output).
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tp_vrg.data_dir import get_data_dir

logger = logging.getLogger(__name__)

ATTESTATION_VERSION = 1
PAYLOAD_TYPES = ("portable_artifact", "render_trace")

_IMPORT_HINT = (
    "the 'cryptography' package is required for signed exports. "
    "Install with: pip install tp-vrg[attestation]"
)


def _require_crypto():
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PrivateKey,
            Ed25519PublicKey,
        )
        from cryptography.hazmat.primitives import serialization
    except ImportError as exc:  # pragma: no cover - exercised only without extras
        raise ImportError(_IMPORT_HINT) from exc
    return Ed25519PrivateKey, Ed25519PublicKey, serialization


# ---------------------------------------------------------------------------
# canonical serialization
# ---------------------------------------------------------------------------


def canonical_json_bytes(obj: Any) -> bytes:
    """Key-sorted, compact, UTF-8 JSON — the signing/hash input form.

    ``allow_nan=False``: a payload carrying NaN/Infinity raises instead of
    silently producing bytes that other JSON implementations cannot
    reproduce (INV-2 fail-loud).
    """
    return json.dumps(
        obj,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def payload_hash_hex(payload: dict) -> str:
    return "sha256:" + hashlib.sha256(canonical_json_bytes(payload)).hexdigest()


# ---------------------------------------------------------------------------
# key management
# ---------------------------------------------------------------------------


def get_attestation_key_path(data_dir: Path | None = None) -> Path:
    """The operator's Ed25519 signing key location.

    Override via ``TPVRG_ATTESTATION_KEY_PATH``; default
    ``<data_dir>/keys/attestation_ed25519.pem``.
    """
    override = os.environ.get("TPVRG_ATTESTATION_KEY_PATH", "").strip()
    if override:
        return Path(override)
    base = data_dir if data_dir is not None else get_data_dir()
    return Path(base) / "keys" / "attestation_ed25519.pem"


def load_or_create_signing_key(path: Path | None = None):
    """Load the operator signing key, generating one on first use.

    Generation is logged loudly — a new key means previously-issued
    envelopes verify against a DIFFERENT key_id, which an operator must
    know about.
    """
    Ed25519PrivateKey, _Ed25519PublicKey, serialization = _require_crypto()
    key_path = path if path is not None else get_attestation_key_path()
    if key_path.exists():
        key = serialization.load_pem_private_key(
            key_path.read_bytes(), password=None
        )
        return key

    key = Ed25519PrivateKey.generate()
    key_path.parent.mkdir(parents=True, exist_ok=True)
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    key_path.write_bytes(pem)
    try:
        os.chmod(key_path, 0o600)
    except OSError:  # pragma: no cover - Windows
        pass
    logger.warning(
        "[attestation] generated NEW Ed25519 signing key at %s "
        "(key_id %s) — envelopes signed before this point used a different key",
        key_path,
        key_fingerprint(key.public_key()),
    )
    return key


def _public_key_raw(public_key) -> bytes:
    _priv, _pub, serialization = _require_crypto()
    return public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )


def key_fingerprint(public_key) -> str:
    """``ed25519:<first-16-hex>`` of sha256 over the raw public key."""
    digest = hashlib.sha256(_public_key_raw(public_key)).hexdigest()
    return f"ed25519:{digest[:16]}"


# ---------------------------------------------------------------------------
# sign / verify
# ---------------------------------------------------------------------------


def _protected_header(envelope: dict) -> dict:
    """The signed field set — everything except payload + signature."""
    return {
        "attestation_version": envelope["attestation_version"],
        "payload_type": envelope["payload_type"],
        "payload_hash": envelope["payload_hash"],
        "signed_at": envelope["signed_at"],
        "signed_by": envelope["signed_by"],
        "key_id": envelope["key_id"],
        "public_key": envelope["public_key"],
    }


def sign_envelope(
    payload: dict,
    payload_type: str,
    *,
    key=None,
    signed_by: str | None = None,
    signed_at: str | None = None,
) -> dict:
    """Wrap ``payload`` in a signed attestation envelope.

    The payload travels verbatim; the detached signature covers the
    protected header, which binds the payload through its canonical-JSON
    sha256. Pure function over its inputs apart from key loading.
    """
    if payload_type not in PAYLOAD_TYPES:
        raise ValueError(
            f"unsupported payload_type {payload_type!r}; expected one of {PAYLOAD_TYPES}"
        )
    if not isinstance(payload, dict):
        raise ValueError("payload must be a dict (a PortableArtifact or render trace)")

    signing_key = key if key is not None else load_or_create_signing_key()
    public_key = signing_key.public_key()

    envelope: dict[str, Any] = {
        "attestation_version": ATTESTATION_VERSION,
        "payload_type": payload_type,
        "payload_hash": payload_hash_hex(payload),
        "signed_at": signed_at
        or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "signed_by": (signed_by or "").strip()
        or os.environ.get("TPVRG_ATTESTATION_IDENTITY", "").strip()
        or key_fingerprint(public_key),
        "key_id": key_fingerprint(public_key),
        "public_key": base64.b64encode(_public_key_raw(public_key)).decode("ascii"),
    }
    signature = signing_key.sign(canonical_json_bytes(_protected_header(envelope)))
    envelope["payload"] = payload
    envelope["signature"] = base64.b64encode(signature).decode("ascii")
    return envelope


def verify_envelope(envelope: dict) -> dict[str, Any]:
    """Verify an attestation envelope's integrity offline.

    Returns a verdict dict (never raises for *invalid* envelopes — only
    for structurally unusable input):

        {"valid": bool, "reason": str, "payload_type": ..., "key_id": ...}

    A ``valid: True`` verdict proves the payload is byte-identical (under
    canonical JSON) to what the holder of ``key_id`` signed. It does NOT
    by itself prove WHO that holder is — match ``key_id``/``public_key``
    against the signer's did:web document for identity trust.
    """
    _priv, Ed25519PublicKey, _ser = _require_crypto()
    if not isinstance(envelope, dict):
        raise ValueError("envelope must be a dict")

    def verdict(valid: bool, reason: str) -> dict[str, Any]:
        return {
            "valid": valid,
            "reason": reason,
            "payload_type": envelope.get("payload_type"),
            "payload_hash": envelope.get("payload_hash"),
            "signed_by": envelope.get("signed_by"),
            "key_id": envelope.get("key_id"),
            "signed_at": envelope.get("signed_at"),
        }

    if envelope.get("attestation_version") != ATTESTATION_VERSION:
        return verdict(False, f"unsupported attestation_version: {envelope.get('attestation_version')!r}")
    required = {"payload", "payload_hash", "payload_type", "signed_at", "signed_by", "key_id", "public_key", "signature"}
    missing = sorted(required - set(envelope))
    if missing:
        return verdict(False, f"missing envelope fields: {missing}")

    recomputed = payload_hash_hex(envelope["payload"])
    if recomputed != envelope["payload_hash"]:
        return verdict(
            False,
            f"payload hash mismatch: envelope says {envelope['payload_hash']}, "
            f"payload canonicalizes to {recomputed} — payload was modified",
        )

    try:
        public_key = Ed25519PublicKey.from_public_bytes(
            base64.b64decode(envelope["public_key"])
        )
        signature = base64.b64decode(envelope["signature"])
    except Exception as exc:
        return verdict(False, f"malformed key or signature encoding: {exc}")

    if key_fingerprint(public_key) != envelope["key_id"]:
        return verdict(False, "key_id does not match embedded public key")

    try:
        public_key.verify(
            signature, canonical_json_bytes(_protected_header(envelope))
        )
    except Exception:
        return verdict(False, "signature verification FAILED — header or signature tampered")

    return verdict(True, "signature valid; payload hash matches")


# ---------------------------------------------------------------------------
# render trace (the Q1 artifact's payload builder)
# ---------------------------------------------------------------------------


def build_render_trace(answer_id: str, provenance) -> dict[str, Any]:
    """Compose the exportable render-trace object from the Provenance Layer.

    Emission-time composition over the existing two-file provenance schema
    (per arch-provenance-rights-objects-2026-05-11.md line 226 — no schema
    migration). The trace is the auditable record of one rendered answer:
    the query, the model, and the citation chain back to source segments.

    Raises:
        KeyError: unknown ``answer_id``.
        ValueError: empty ``answer_id`` or no provenance store.
    """
    answer_id = (answer_id or "").strip()
    if not answer_id:
        raise ValueError("answer_id is required")
    if provenance is None:
        raise ValueError("a provenance store is required to build a render trace")

    answer = provenance.get_answer(answer_id)
    if answer is None:
        raise KeyError(f"answer_id not found: {answer_id}")

    citations = provenance.get_citations_for_answer(answer_id)
    from tp_vrg.kro_temporal import compute_kro_temporal_summary

    temporal_summary = compute_kro_temporal_summary(citations).as_dict()
    total = len(citations)
    null_sources = sum(1 for c in citations if c.get("source_label") is None)
    if total == 0 or null_sources == total:
        coverage = "none"
    elif null_sources == 0:
        coverage = "full"
    else:
        coverage = "partial"

    return {
        "trace_version": 1,
        "answer_id": answer["answer_id"],
        "query_text": answer["query_text"],
        "answered_at": answer["answered_at"],
        "model_label": answer["model_label"],
        "provenance_coverage": coverage,
        "temporal_summary": temporal_summary,
        "citations": [
            {
                "cite_order": c.get("cite_order"),
                "segment_id": c.get("segment_id"),
                "source_label": c.get("source_label"),
                "source_uri": c.get("source_uri"),
                "text": c.get("text"),
                "evidence_snippet": c.get("evidence_snippet"),
            }
            for c in citations
        ],
    }


# ---------------------------------------------------------------------------
# did:web identity document (the key-distribution stub)
# ---------------------------------------------------------------------------


def build_did_web_document(domain: str, *, key=None) -> dict[str, Any]:
    """A minimal W3C did:web DID document publishing the signing key.

    Serve this JSON at ``https://<domain>/.well-known/did.json`` and the
    envelope's ``key_id``/``public_key`` become verifiable against an
    identity a counterparty can trust. JWK form (no multibase dependency).
    """
    domain = (domain or "").strip()
    if not domain:
        raise ValueError("domain is required for a did:web identity")
    signing_key = key if key is not None else load_or_create_signing_key()
    public_key = signing_key.public_key()
    did = f"did:web:{domain.replace('/', ':')}"
    key_ref = f"{did}#{key_fingerprint(public_key).replace(':', '-')}"
    return {
        "@context": [
            "https://www.w3.org/ns/did/v1",
            "https://w3id.org/security/suites/jws-2020/v1",
        ],
        "id": did,
        "verificationMethod": [
            {
                "id": key_ref,
                "type": "JsonWebKey2020",
                "controller": did,
                "publicKeyJwk": {
                    "kty": "OKP",
                    "crv": "Ed25519",
                    "x": base64.urlsafe_b64encode(_public_key_raw(public_key))
                    .rstrip(b"=")
                    .decode("ascii"),
                },
            }
        ],
        "assertionMethod": [key_ref],
    }
