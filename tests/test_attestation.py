"""Tests for the signed-artifact attestation module (IV-2 Q1 federation artifact).

Sigstore-class detached signatures over the two exportable boundary
objects (PortableArtifact + render trace). NOT blockchain — Certificate
Transparency family, per the cryptographic-vocabulary discipline.

Properties under test: canonicalization determinism, sign/verify
round-trip, tamper-evidence (payload AND header AND signature), key
persistence + fingerprint stability, render-trace composition from the
Provenance Layer, did:web identity-document shape.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

pytest.importorskip("cryptography")

from tp_vrg.attestation import (
    build_did_web_document,
    build_render_trace,
    canonical_json_bytes,
    get_attestation_key_path,
    key_fingerprint,
    load_or_create_signing_key,
    payload_hash_hex,
    sign_envelope,
    verify_envelope,
)
from tp_vrg.provenance_storage import ProvenanceBackend


@pytest.fixture()
def signing_key(tmp_path: Path):
    return load_or_create_signing_key(tmp_path / "keys" / "test_ed25519.pem")


# ---------------------------------------------------------------------------
# canonicalization
# ---------------------------------------------------------------------------


def test_canonical_json_is_key_order_independent() -> None:
    a = {"b": 1, "a": {"y": [1, 2], "x": "ä"}}
    b = {"a": {"x": "ä", "y": [1, 2]}, "b": 1}
    assert canonical_json_bytes(a) == canonical_json_bytes(b)
    assert payload_hash_hex(a) == payload_hash_hex(b)


def test_canonical_json_rejects_nan_fail_loud() -> None:
    with pytest.raises(ValueError):
        canonical_json_bytes({"score": float("nan")})


# ---------------------------------------------------------------------------
# sign / verify round-trip + tamper-evidence
# ---------------------------------------------------------------------------


def test_sign_verify_round_trip(signing_key) -> None:
    payload = {"artifact_version": 1, "rung": "asset", "asset_id": "asset:x"}
    envelope = sign_envelope(payload, "portable_artifact", key=signing_key)

    assert envelope["attestation_version"] == 1
    assert envelope["payload"] == payload
    assert envelope["key_id"].startswith("ed25519:")

    verdict = verify_envelope(envelope)
    assert verdict["valid"] is True, verdict["reason"]
    assert verdict["payload_type"] == "portable_artifact"
    assert verdict["key_id"] == envelope["key_id"]


def test_envelope_survives_json_round_trip(signing_key) -> None:
    """The envelope is a file format — it must verify after dump/load."""
    payload = {"trace_version": 1, "answer_id": "ans-1", "citations": []}
    envelope = sign_envelope(payload, "render_trace", key=signing_key)
    reloaded = json.loads(json.dumps(envelope))
    assert verify_envelope(reloaded)["valid"] is True


def test_tampered_payload_is_detected(signing_key) -> None:
    envelope = sign_envelope(
        {"artifact_version": 1, "passages": [{"raw_text": "original"}]},
        "portable_artifact",
        key=signing_key,
    )
    envelope["payload"]["passages"][0]["raw_text"] = "tampered"
    verdict = verify_envelope(envelope)
    assert verdict["valid"] is False
    assert "hash mismatch" in verdict["reason"]


def test_tampered_header_is_detected(signing_key) -> None:
    envelope = sign_envelope({"a": 1}, "portable_artifact", key=signing_key)
    envelope["signed_by"] = "did:web:attacker.example"
    verdict = verify_envelope(envelope)
    assert verdict["valid"] is False
    assert "FAILED" in verdict["reason"]


def test_tampered_signature_is_detected(signing_key) -> None:
    envelope = sign_envelope({"a": 1}, "portable_artifact", key=signing_key)
    sig = bytearray(base64.b64decode(envelope["signature"]))
    sig[0] ^= 0xFF
    envelope["signature"] = base64.b64encode(bytes(sig)).decode("ascii")
    assert verify_envelope(envelope)["valid"] is False


def test_swapped_key_is_detected(tmp_path: Path, signing_key) -> None:
    """An attacker re-embedding their own key fails the key_id binding."""
    other = load_or_create_signing_key(tmp_path / "keys" / "other.pem")
    envelope = sign_envelope({"a": 1}, "portable_artifact", key=signing_key)
    from tp_vrg.attestation import _public_key_raw

    envelope["public_key"] = base64.b64encode(
        _public_key_raw(other.public_key())
    ).decode("ascii")
    verdict = verify_envelope(envelope)
    assert verdict["valid"] is False
    assert "key_id" in verdict["reason"]


def test_unsupported_payload_type_raises(signing_key) -> None:
    with pytest.raises(ValueError):
        sign_envelope({"a": 1}, "blockchain_block", key=signing_key)


def test_verify_rejects_missing_fields() -> None:
    verdict = verify_envelope({"attestation_version": 1})
    assert verdict["valid"] is False
    assert "missing envelope fields" in verdict["reason"]


# ---------------------------------------------------------------------------
# key management
# ---------------------------------------------------------------------------


def test_key_persists_and_fingerprint_is_stable(tmp_path: Path) -> None:
    path = tmp_path / "keys" / "attestation_ed25519.pem"
    first = load_or_create_signing_key(path)
    second = load_or_create_signing_key(path)
    assert path.exists()
    assert key_fingerprint(first.public_key()) == key_fingerprint(second.public_key())


def test_key_path_env_override(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    override = tmp_path / "custom" / "key.pem"
    monkeypatch.setenv("TPVRG_ATTESTATION_KEY_PATH", str(override))
    assert get_attestation_key_path() == override


# ---------------------------------------------------------------------------
# render trace composition (the Q1 payload)
# ---------------------------------------------------------------------------


@pytest.fixture()
def provenance_with_answer(tmp_path: Path):
    prov = ProvenanceBackend(tmp_path / "provenance.db")
    prov.record_answer("ans-1", "What did the merger agreement say?", model_label="test-model")
    prov.record_citations("ans-1", [("seg-1", 1, "the indemnity clause")])
    yield prov
    prov.close()


def test_build_render_trace_composes_answer_and_citations(
    provenance_with_answer,
) -> None:
    trace = build_render_trace("ans-1", provenance_with_answer)
    assert trace["trace_version"] == 1
    assert trace["answer_id"] == "ans-1"
    assert trace["query_text"] == "What did the merger agreement say?"
    assert trace["model_label"] == "test-model"
    assert len(trace["citations"]) == 1
    assert trace["citations"][0]["segment_id"] == "seg-1"
    # seg-1 was never written to source_segments -> orphaned citation
    assert trace["provenance_coverage"] == "none"


def test_render_trace_signs_and_verifies(provenance_with_answer, signing_key) -> None:
    trace = build_render_trace("ans-1", provenance_with_answer)
    envelope = sign_envelope(trace, "render_trace", key=signing_key)
    assert verify_envelope(envelope)["valid"] is True


def test_build_render_trace_unknown_answer_raises(provenance_with_answer) -> None:
    with pytest.raises(KeyError):
        build_render_trace("ans-missing", provenance_with_answer)
    with pytest.raises(ValueError):
        build_render_trace("", provenance_with_answer)
    with pytest.raises(ValueError):
        build_render_trace("ans-1", None)


# ---------------------------------------------------------------------------
# did:web identity document
# ---------------------------------------------------------------------------


def test_did_web_document_publishes_signing_key(signing_key) -> None:
    doc = build_did_web_document("example.com", key=signing_key)
    assert doc["id"] == "did:web:example.com"
    method = doc["verificationMethod"][0]
    assert method["publicKeyJwk"]["crv"] == "Ed25519"
    assert method["publicKeyJwk"]["kty"] == "OKP"
    # the published key is the envelope key: fingerprints must agree
    raw = base64.urlsafe_b64decode(method["publicKeyJwk"]["x"] + "==")
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    assert key_fingerprint(Ed25519PublicKey.from_public_bytes(raw)) == key_fingerprint(
        signing_key.public_key()
    )


def test_did_web_document_requires_domain(signing_key) -> None:
    with pytest.raises(ValueError):
        build_did_web_document("", key=signing_key)
