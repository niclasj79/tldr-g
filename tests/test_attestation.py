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
import importlib.util
import json
from pathlib import Path

import pytest

pytest.importorskip("cryptography")

# Temporal-manifold enrichment is an engine feature. The engine-free public
# package ships attestation.py without tp_vrg.kro_temporal, so the render trace
# omits temporal_summary there. Boundary assertions run in both builds; the
# temporal assertions only when the engine module is present.
_HAS_KRO_TEMPORAL = importlib.util.find_spec("tp_vrg.kro_temporal") is not None

import tp_vrg.attestation as attestation_module
from tp_vrg.attestation import (
    RESOLUTION_DISCLOSURE,
    build_did_web_document,
    build_render_trace,
    canonical_json_bytes,
    citation_is_verbatim,
    get_attestation_key_path,
    key_fingerprint,
    load_or_create_signing_key,
    payload_hash_hex,
    provenance_coverage,
    resolve_signed_by,
    sign_envelope,
    verify_envelope,
)
from tp_vrg.provenance_storage import ProvenanceBackend


@pytest.fixture(autouse=True)
def _no_spacy_sentence_pipeline(monkeypatch: pytest.MonkeyPatch):
    """The v1 trace's temporal summary splits cited text into sentences, which on
    the engine build reaches ``spacy.blank("en")``. Pinned to the regex splitter
    (the fallback a box without spaCy takes; every assertion here, the v1 golden
    included, holds on it), so this file builds no spaCy pipeline. The public
    build has no sentence splitter to pin."""
    try:
        import tp_vrg.compression as compression_module
    except ImportError:  # the public, engine-free build: nothing to pin
        return
    monkeypatch.setattr(compression_module, "_get_spacy_sentencizer", lambda: None)


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


def _generate_with_hook(monkeypatch, hook):
    """Run ``hook`` inside every key generation, between the caller's exists()
    check and its publish -- the window two first-use callers race in."""
    real_private, real_public, serialization = attestation_module._require_crypto()

    class _HookedPrivateKey:
        @staticmethod
        def generate():
            key = real_private.generate()
            hook()
            return key

    monkeypatch.setattr(
        attestation_module,
        "_require_crypto",
        lambda: (_HookedPrivateKey, real_public, serialization),
    )
    return real_private, serialization


def test_a_key_published_by_another_caller_mid_create_wins(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The first-use race, made deterministic: another caller publishes its key
    after this call found no file and before it wrote one. This call must sign
    with THAT key (the file's), never overwrite it with its own -- otherwise
    every envelope the other caller signed names a key_id no file holds."""
    path = tmp_path / "keys" / "attestation_ed25519.pem"
    published = {}

    def other_caller_publishes():
        if path.exists():
            return
        other = real_private.generate()
        published["fingerprint"] = key_fingerprint(other.public_key())
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(
            other.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )

    real_private, serialization = _generate_with_hook(monkeypatch, other_caller_publishes)
    key = load_or_create_signing_key(path)

    on_disk = serialization.load_pem_private_key(path.read_bytes(), password=None)
    assert key_fingerprint(key.public_key()) == published["fingerprint"]
    assert key_fingerprint(on_disk.public_key()) == published["fingerprint"]
    assert not [p for p in path.parent.iterdir() if p.name != path.name], (
        "the temporary publish file was left behind"
    )


def test_two_first_use_callers_sign_with_the_one_key_the_file_holds(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Two threads both find no key and both generate one (a barrier holds each
    inside generation until both are there); each must come back with the key
    the file holds, so no envelope either signs names a vanished key."""
    import threading

    path = tmp_path / "keys" / "attestation_ed25519.pem"
    barrier = threading.Barrier(2, timeout=30)
    _real_private, serialization = _generate_with_hook(monkeypatch, barrier.wait)
    results: dict[int, str] = {}
    errors: list[BaseException] = []

    def first_use(slot: int) -> None:
        try:
            results[slot] = key_fingerprint(load_or_create_signing_key(path).public_key())
        except BaseException as exc:  # noqa: BLE001 -- reported below
            errors.append(exc)

    threads = [threading.Thread(target=first_use, args=(slot,)) for slot in (0, 1)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    assert not errors, errors
    on_disk = key_fingerprint(
        serialization.load_pem_private_key(path.read_bytes(), password=None).public_key()
    )
    assert results == {0: on_disk, 1: on_disk}


def _refuse_hard_links(*_args, **_kwargs):
    import errno

    raise PermissionError(errno.EPERM, "this filesystem refuses hard links")


@pytest.mark.parametrize("os_name", ["posix", "nt"])
def test_first_use_creates_a_key_where_hard_links_are_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, os_name: str
) -> None:
    """exFAT / vfat homes and some SMB or FUSE mounts refuse ``os.link``. Before
    the atomic publish, ``write_bytes`` worked there; the publish must not turn
    such a home into one where no key can ever be created (every receipt
    unavailable, every signed export failing). Off Windows the fallback is an
    exclusive create of the key path itself, which still never replaces a file."""
    path = tmp_path / "keys" / "k.pem"
    with monkeypatch.context() as patched:
        patched.setattr(attestation_module.os, "link", _refuse_hard_links)
        patched.setattr(attestation_module.os, "name", os_name)
        key = load_or_create_signing_key(path)
    assert path.exists()
    on_disk = load_or_create_signing_key(path)
    assert key_fingerprint(on_disk.public_key()) == key_fingerprint(key.public_key())
    assert [p.name for p in path.parent.iterdir()] == ["k.pem"]  # no temporary left


def test_where_hard_links_are_refused_a_published_key_still_wins(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The fallback keeps the never-overwrite rule: a key another caller published
    first is the one this call returns, and its file is untouched."""
    path = tmp_path / "keys" / "attestation_ed25519.pem"
    published = {}

    def other_caller_publishes():
        if path.exists():
            return
        other = real_private.generate()
        published["fingerprint"] = key_fingerprint(other.public_key())
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(
            other.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )

    real_private, serialization = _generate_with_hook(monkeypatch, other_caller_publishes)
    with monkeypatch.context() as patched:
        patched.setattr(attestation_module.os, "link", _refuse_hard_links)
        patched.setattr(attestation_module.os, "name", "posix")
        key = load_or_create_signing_key(path)
    assert key_fingerprint(key.public_key()) == published["fingerprint"]
    on_disk = serialization.load_pem_private_key(path.read_bytes(), password=None)
    assert key_fingerprint(on_disk.public_key()) == published["fingerprint"]


def test_a_failed_temporary_cleanup_never_costs_the_published_key(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The key is published; then removing the temporary file fails (a Windows
    scanner holding the fresh file). The publish already happened, so the call
    must return the published key and log its generation -- not raise, which made
    the first receipt unavailable and hid the 'generated NEW' warning an operator
    must see -- and it must say where the leftover private-key copy is."""
    import logging

    path = tmp_path / "keys" / "k.pem"
    real_unlink = Path.unlink

    def unlink(self, *args, **kwargs):
        if self.name.endswith(".tmp"):
            raise PermissionError(13, "held by a scanner", str(self))
        return real_unlink(self, *args, **kwargs)

    caplog.set_level(logging.WARNING, logger="tp_vrg.attestation")
    with monkeypatch.context() as patched:
        patched.setattr(Path, "unlink", unlink)
        key = load_or_create_signing_key(path)
    on_disk = load_or_create_signing_key(path)
    assert key_fingerprint(key.public_key()) == key_fingerprint(on_disk.public_key())
    messages = [r.getMessage() for r in caplog.records]
    assert any("generated NEW" in m for m in messages), messages
    leftovers = [p for p in path.parent.iterdir() if p.name.endswith(".tmp")]
    assert leftovers and any(leftovers[0].name in m for m in messages), messages


def test_an_existing_key_is_loaded_not_regenerated(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = tmp_path / "keys" / "attestation_ed25519.pem"
    first = load_or_create_signing_key(path)

    def never():
        raise AssertionError("an existing key file must be loaded, never regenerated")

    _generate_with_hook(monkeypatch, never)
    again = load_or_create_signing_key(path)
    assert key_fingerprint(again.public_key()) == key_fingerprint(first.public_key())


# ---------------------------------------------------------------------------
# the signer label: one chain for every envelope
# ---------------------------------------------------------------------------


def test_resolve_signed_by_is_the_chain_sign_envelope_uses(
    monkeypatch: pytest.MonkeyPatch, signing_key
) -> None:
    """Explicit, then the configured identity, then the key's own fingerprint --
    and ``sign_envelope`` writes exactly what ``resolve_signed_by`` returns."""
    public = signing_key.public_key()
    fingerprint = key_fingerprint(public)
    monkeypatch.delenv("TPVRG_ATTESTATION_IDENTITY", raising=False)
    assert resolve_signed_by(public) == fingerprint
    assert sign_envelope({"a": 1}, "render_trace", key=signing_key)["signed_by"] == fingerprint

    monkeypatch.setenv("TPVRG_ATTESTATION_IDENTITY", "  did:web:ops.example  ")
    assert resolve_signed_by(public) == "did:web:ops.example"
    assert (
        sign_envelope({"a": 1}, "render_trace", key=signing_key)["signed_by"]
        == "did:web:ops.example"
    )

    assert resolve_signed_by(public, " ops-desk ") == "ops-desk"
    assert (
        sign_envelope({"a": 1}, "render_trace", key=signing_key, signed_by=" ops-desk ")[
            "signed_by"
        ]
        == "ops-desk"
    )
    assert resolve_signed_by(public, "   ") == "did:web:ops.example"


def _two_keys():
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    return Ed25519PrivateKey.generate(), Ed25519PrivateKey.generate()


def test_a_fingerprint_signer_that_is_not_the_signing_key_never_reads_valid() -> None:
    """A stranger's key signs an envelope LABELLED with the victim install's
    fingerprint. Every check on the bytes passes (the stranger signed them), so
    without the signer rule it verified VALID and every verifier showed
    "Signed by ed25519:<victim>" -- the line the install doc tells a reader to
    compare with their own fingerprint."""
    install, other = _two_keys()
    victim = key_fingerprint(install.public_key())
    payload = {"trace_version": 2, "answer_id": "a",
               "principal": {"signer": victim, "signer_kind": "key-fingerprint"}}
    verdict = verify_envelope(sign_envelope(payload, "render_trace", key=other, signed_by=victim))
    assert not (verdict["valid"] and verdict["signed_by"] == victim and verdict["key_id"] != victim)
    assert verdict["valid"] is False and verdict["reason"].startswith("signer mismatch")

    # The label any way a reader might not tell apart from the fingerprint.
    for label in (victim.upper(), victim + " ", "key " + victim):
        forged = sign_envelope({"a": 1}, "portable_artifact", key=other, signed_by=label)
        assert verify_envelope(forged)["valid"] is False, label


def test_a_receipt_whose_payload_names_another_signer_never_reads_valid() -> None:
    """The envelope's own labels are consistent (the stranger's fingerprint), but
    the receipt's signed payload claims the victim's key signed it."""
    install, other = _two_keys()
    victim = key_fingerprint(install.public_key())
    stranger = key_fingerprint(other.public_key())
    claims_victim = {"trace_version": 2, "answer_id": "a",
                     "principal": {"signer": victim, "signer_kind": "key-fingerprint"}}
    assert verify_envelope(sign_envelope(claims_victim, "render_trace", key=other))["valid"] is False
    # signed_by agrees with the payload, but the payload calls a label a key fingerprint
    label_as_key = {"trace_version": 2, "answer_id": "a",
                    "principal": {"signer": "ops-desk", "signer_kind": "key-fingerprint"}}
    assert verify_envelope(
        sign_envelope(label_as_key, "render_trace", key=other, signed_by="ops-desk")
    )["valid"] is False
    # a principal with no signer at all
    no_signer = {"trace_version": 2, "answer_id": "a", "principal": {"caller": None}}
    assert verify_envelope(sign_envelope(no_signer, "render_trace", key=other))["valid"] is False
    # and the honest receipts still verify: the key's own fingerprint, a did, a label
    honest = {"trace_version": 2, "answer_id": "a",
              "principal": {"signer": stranger, "signer_kind": "key-fingerprint"}}
    assert verify_envelope(sign_envelope(honest, "render_trace", key=other))["valid"] is True
    for label, kind in (("did:web:ops.example", "did"), ("ops-desk", "operator-label")):
        configured = {"trace_version": 2, "answer_id": "a",
                      "principal": {"signer": label, "signer_kind": kind}}
        envelope = sign_envelope(configured, "render_trace", key=other, signed_by=label)
        assert verify_envelope(envelope)["valid"] is True, label


# ---------------------------------------------------------------------------
# small-order (keyless) keys and signature points
# ---------------------------------------------------------------------------
#
# Ed25519 verification checks [S]B == R + [k]A. With A of small order and
# R = identity, S = 0, the right side is [k]A, which is the identity whenever
# the order of A divides k -- always for the identity key, for half of all
# messages with the order-2 key. OpenSSL (and WebCrypto, and the pure-JS path in
# verify.html) accept such a signature, so before the blocklist an envelope
# signed by NO private key verified VALID for any payload the forger chose.

_P = 2**255 - 19
_IDENTITY = bytes([1]) + bytes(31)            # y = 1: the neutral element
_ORDER_TWO = (_P - 1).to_bytes(32, "little")  # y = p - 1: the point (0, -1)
_KEYLESS_SIGNATURE = _IDENTITY + bytes(32)    # R = identity, S = 0
_DEGENERATE = "degenerate (small-order) key or signature point"


def _forged_envelope(public_raw: bytes, signed_at: str, signature: bytes = _KEYLESS_SIGNATURE) -> dict:
    """An envelope nobody signed, labelled consistently with its embedded key."""
    import hashlib

    payload = {"anything": "the forger chose this", "n": 1}
    key_id = "ed25519:" + hashlib.sha256(public_raw).hexdigest()[:16]
    return {
        "attestation_version": attestation_module.ATTESTATION_VERSION,
        "payload_type": "portable_artifact",
        "payload_hash": payload_hash_hex(payload),
        "signed_at": signed_at,
        "signed_by": key_id,
        "key_id": key_id,
        "public_key": base64.b64encode(public_raw).decode("ascii"),
        "payload": payload,
        "signature": base64.b64encode(signature).decode("ascii"),
    }


_L = 2**252 + 27742317777372353535851937790883648493  # the prime order of B
_BASE_POINT = bytes.fromhex("58" + "66" * 31)  # B: prime order, on no blocklist
_ORDINARY_R_SIGNATURE = _BASE_POINT + (1).to_bytes(32, "little")  # R = B, S = 1


def _challenge(envelope: dict) -> int:
    """k = SHA-512(R || A || header) mod L, the scalar every verifier computes."""
    import hashlib

    signature = base64.b64decode(envelope["signature"])
    public_raw = base64.b64decode(envelope["public_key"])
    header = canonical_json_bytes(attestation_module._protected_header(envelope))
    return int.from_bytes(hashlib.sha512(signature[:32] + public_raw + header).digest(), "little") % _L


def _ground(public_raw: bytes, signature: bytes, order: int) -> dict:
    """signed_at ground until the key's order divides the challenge k. Then
    [S]B == R + [k]A holds exactly for a key A of that order, with no private
    key involved: the forgery satisfies the raw Ed25519 equation. k is computed
    from the hash here, so the pin does not depend on what OpenSSL accepts."""
    for i in range(1024):
        envelope = _forged_envelope(public_raw, f"2026-10-08T00:00:00.{i:06d}+00:00", signature)
        if _challenge(envelope) % order == 0:
            return envelope
    raise AssertionError(f"no header in 1024 tries with {order} | k")


def _ground_order_two_envelope() -> dict:
    """The order-2 key's keyless signature (R = identity, S = 0) verifies when k
    is even: about every second header."""
    return _ground(_ORDER_TWO, _KEYLESS_SIGNATURE, 2)


def test_the_identity_key_forgery_never_reads_valid() -> None:
    """Public key = the identity point, R = identity, S = 0: valid for every
    payload under the raw primitive, so the verifier must refuse the key."""
    for signed_at in ("2026-10-08T00:00:00+00:00", "2026-10-08T00:00:01+00:00"):
        verdict = verify_envelope(_forged_envelope(_IDENTITY, signed_at))
        assert verdict["valid"] is False
        assert verdict["reason"] == _DEGENERATE


def test_the_order_two_key_forgery_never_reads_valid() -> None:
    verdict = verify_envelope(_ground_order_two_envelope())
    assert verdict["valid"] is False
    assert verdict["reason"] == _DEGENERATE


_REVIEW_ORDER_TWO_FORGERY = {
    "attestation_version": 1,
    "payload_type": "portable_artifact",
    "payload_hash": "sha256:094aec33c6d2a18c34f94e8ede16500d3ef3ed157ec77e26cf7876816559d59b",
    "signed_at": "2026-10-09T01:00:01+00:00",
    "signed_by": "ed25519:ffe1ea08f3af443b",
    "key_id": "ed25519:ffe1ea08f3af443b",
    "public_key": "7P///////////////////////////////////////38=",
    "payload": {"forged": True},
    "signature": "ppGrigLRaWtKD3m6nEyfeqVUO3N2j3yBdNnTEDWJhj2I1hIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
}


def test_a_small_order_key_with_an_ordinary_r_never_reads_valid() -> None:
    """The key refusal on its own. R = B (prime order, on no blocklist) and S = 1
    satisfy [1]B == B + [k]A whenever the key's order divides k -- for the
    identity key always. The keyless forgeries above carry R = identity, which
    the R check also refuses; these carry an R it passes, so only the key check
    stands between them and VALID. Every blocklist encoding as the key, with and
    without the sign bit, ground until 8 | k (8 covers every order in the
    8-torsion subgroup)."""
    assert attestation_module._degenerate_point_reason(_BASE_POINT) is None
    for signed_at in ("2026-10-08T00:00:00+00:00", "2026-10-08T00:00:01+00:00"):
        identity = verify_envelope(_forged_envelope(_IDENTITY, signed_at, _ORDINARY_R_SIGNATURE))
        assert (identity["valid"], identity["reason"]) == (False, _DEGENERATE)
    order_two = verify_envelope(_ground(_ORDER_TWO, _ORDINARY_R_SIGNATURE, 2))
    assert (order_two["valid"], order_two["reason"]) == (False, _DEGENERATE)
    for encoding in attestation_module._SMALL_ORDER_ENCODINGS:
        for sign_bit in (0x00, 0x80):
            point = encoding[:31] + bytes([encoding[31] | sign_bit])
            verdict = verify_envelope(_ground(point, _ORDINARY_R_SIGNATURE, 8))
            assert (verdict["valid"], verdict["reason"]) == (False, _DEGENERATE), point.hex()


def test_the_reviewed_order_two_forgery_with_an_ordinary_r_never_reads_valid() -> None:
    """The adversarial review's envelope, verbatim: the order-2 key, R = [1234568]B,
    S = 1234568, signed_at ground so k is even. VALID on v0.3.0's verifier."""
    verdict = verify_envelope(dict(_REVIEW_ORDER_TWO_FORGERY))
    assert (verdict["valid"], verdict["reason"]) == (False, _DEGENERATE)


def test_every_small_order_encoding_is_refused_as_key_and_as_r(signing_key) -> None:
    """All seven blocklist encodings, with and without the sign bit, refused as
    the public key AND as the signature's R -- the latter on an envelope a
    genuine key signed, so the R check is what refuses it."""
    genuine = sign_envelope({"a": 1}, "portable_artifact", key=signing_key)
    genuine_sig = base64.b64decode(genuine["signature"])
    encodings = attestation_module._SMALL_ORDER_ENCODINGS
    assert len(encodings) == 7
    for encoding in encodings:
        for sign_bit in (0x00, 0x80):
            point = encoding[:31] + bytes([encoding[31] | sign_bit])
            as_key = _forged_envelope(point, "2026-10-08T00:00:00+00:00")
            assert verify_envelope(as_key)["reason"] == _DEGENERATE, point.hex()
            as_r = dict(genuine, signature=base64.b64encode(point + genuine_sig[32:]).decode())
            assert verify_envelope(as_r)["reason"] == _DEGENERATE, point.hex()
            assert verify_envelope(as_r)["valid"] is False


def test_non_canonical_point_encodings_are_refused(signing_key) -> None:
    """y >= p is no canonical encoding of any point (the small-order ones, y = p
    and y = p + 1, are on the blocklist); refused as key and as R."""
    genuine = sign_envelope({"a": 1}, "portable_artifact", key=signing_key)
    genuine_sig = base64.b64decode(genuine["signature"])
    for y in (_P + 2, _P + 3, _P + 18, 2**255 - 1):
        for sign_bit in (0x00, 0x80):
            raw = y.to_bytes(32, "little")
            point = raw[:31] + bytes([raw[31] | sign_bit])
            as_key = verify_envelope(_forged_envelope(point, "2026-10-08T00:00:00+00:00"))
            assert as_key["valid"] is False
            assert as_key["reason"].startswith("degenerate (non-canonical)"), (y, as_key["reason"])
            as_r = dict(genuine, signature=base64.b64encode(point + genuine_sig[32:]).decode())
            assert verify_envelope(as_r)["reason"].startswith("degenerate (non-canonical)"), y


def test_the_blocklist_is_exactly_the_eight_torsion_points() -> None:
    """Recompute the small-order subgroup from the curve equation, independent of
    the hard-coded bytes: its 8 points have 5 distinct y (the identity, the
    order-2 point, y = 0 for both order-4 points, 2 y for the 4 order-8 points),
    which with the two non-canonical aliases (p, p + 1) are libsodium's 7."""
    p = _P
    d = (-121665 * pow(121666, p - 2, p)) % p
    sqrt_m1 = pow(2, (p - 1) // 4, p)

    def sqrt(a: int) -> int | None:
        a %= p
        r = pow(a, (p + 3) // 8, p)
        if r * r % p == a:
            return r
        r = r * sqrt_m1 % p
        return r if r * r % p == a else None

    def add(a, b):
        (x1, y1), (x2, y2) = a, b
        t = d * x1 * x2 * y1 * y2 % p
        return ((x1 * y2 + x2 * y1) * pow(1 + t, p - 2, p) % p,
                (y1 * y2 + x1 * x2) * pow(1 - t, p - 2, p) % p)

    def on_curve(x, y):
        return (-x * x + y * y - 1 - d * x * x * y * y) % p == 0

    # order-8 points halve an order-4 point (x^2 = -y^2): d y^4 + 2 y^2 - 1 = 0
    torsion = {(0, 1), (0, p - 1), (sqrt_m1, 0), (p - sqrt_m1, 0)}
    s = sqrt(4 + 4 * d)
    for root in (s, p - s):
        y2 = (-2 + root) * pow(2 * d, p - 2, p) % p
        y = sqrt(y2)
        if y is None:
            continue
        for yy in (y, p - y):
            x = sqrt(-yy * yy)
            for xx in (x, p - x):
                torsion.add((xx, yy))
    assert len(torsion) == 8 and all(on_curve(x, y) for x, y in torsion)
    for point in torsion:
        acc = (0, 1)
        for _ in range(8):
            acc = add(acc, point)
        assert acc == (0, 1), point
    expected = {y.to_bytes(32, "little") for _, y in torsion}
    expected |= {p.to_bytes(32, "little"), (p + 1).to_bytes(32, "little")}
    assert set(attestation_module._SMALL_ORDER_ENCODINGS) == expected


def test_genuine_envelopes_still_verify_after_the_blocklist(signing_key) -> None:
    """The OFF path: every key the engine makes has prime order, so nothing an
    install signs meets the blocklist."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    for key in [signing_key] + [Ed25519PrivateKey.generate() for _ in range(32)]:
        envelope = sign_envelope({"a": 1}, "portable_artifact", key=key)
        assert verify_envelope(envelope) == {
            "valid": True,
            "reason": "signature valid; payload hash matches",
            "payload_type": "portable_artifact",
            "payload_hash": envelope["payload_hash"],
            "signed_by": envelope["signed_by"],
            "key_id": envelope["key_id"],
            "signed_at": envelope["signed_at"],
        }


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
    if _HAS_KRO_TEMPORAL:
        assert trace["temporal_summary"]["trace_hash"]
        assert trace["temporal_summary"]["durability_ceiling"] == 0.6
    else:
        # Engine-free public build: temporal_summary is omitted entirely.
        assert "temporal_summary" not in trace
    assert len(trace["citations"]) == 1
    assert trace["citations"][0]["segment_id"] == "seg-1"
    # seg-1 was never written to source_segments -> orphaned citation
    assert trace["provenance_coverage"] == "none"


def test_render_trace_signs_and_verifies(provenance_with_answer, signing_key) -> None:
    trace = build_render_trace("ans-1", provenance_with_answer)
    envelope = sign_envelope(trace, "render_trace", key=signing_key)
    assert verify_envelope(envelope)["valid"] is True


#: ``build_render_trace``'s output for the fixture below, captured on d981bfcf
#: (before its coverage and verbatim rules moved into shared functions, so the
#: answer receipt reads the same two rules), with ``answered_at`` dropped (it
#: is the clock). The refactor moved no byte of trace_version 1.
_V1_TRACE_GOLDEN = {
    "answer_id": "ans-g",
    "citations": [
        {"cite_order": 0, "content_hash": "sha256:" + "aa" * 32, "evidence_snippet": "snip",
         "segment_id": "seg-a0", "source_label": "a.md", "source_uri": "file:///private/a.md",
         "text": "Alpha verbatim document.", "verbatim": True},
        {"cite_order": 1, "content_hash": "sha256:" + "aa" * 32, "evidence_snippet": "",
         "segment_id": "seg-a1", "source_label": "a.md", "source_uri": "file:///private/a.md",
         "text": "Alpha resolved chunk.", "verbatim": False},
        {"cite_order": 2, "content_hash": None, "evidence_snippet": "",
         "segment_id": "seg-orphan", "source_label": None, "source_uri": None,
         "text": None, "verbatim": True},
    ],
    "model_label": "m-1",
    "pointers": [{"id": "seg-x", "lod": "reference", "reason": "rank 4: cut", "score": 0.5}],
    "provenance_coverage": "partial",
    "query_text": "What did alpha say?",
    "resolution_disclosure": (
        "One or more cited segments are RESOLVED renderings (coref / defined-term "
        "resolution applied), not verbatim source text. The verbatim document for each "
        "source is its seq=0 segment; content_hash is over the verbatim bytes; a "
        "reversible resolution overlay records every substitution. Verify cited text "
        "against the verbatim source."
    ),
    "temporal_summary": {
        "anchor": None, "currency_floor": 0.6, "durability_ceiling": 0.6,
        "extent_max": None, "extent_min": None,
        "trace_hash": "0eb2f7b103aab720d9f97fe618241969c0380acaa0c017084f9f07d565b325fc",
    },
    "trace_version": 1,
}


def test_the_v1_trace_is_byte_identical_to_its_base(tmp_path: Path) -> None:
    prov = ProvenanceBackend(tmp_path / "provenance.db")
    try:
        prov.upsert_source("src-a", "a.md", content_hash="sha256:" + "aa" * 32,
                           source_uri="file:///private/a.md")
        prov.upsert_segment("seg-a0", "src-a", 0, "Alpha verbatim document.")
        prov.upsert_segment("seg-a1", "src-a", 1, "Alpha resolved chunk.")
        prov.upsert_resolution_overlay("src-a", "[]")
        prov.record_answer(
            "ans-g", "What did alpha say?", model_label="m-1",
            render_pointers=[{"id": "seg-x", "lod": "reference", "reason": "rank 4: cut",
                              "score": 0.5}],
        )
        prov.record_citations("ans-g", [("seg-a0", 0, "snip"), ("seg-a1", 1, ""),
                                        ("seg-orphan", 2, "")])
        trace = build_render_trace("ans-g", prov)
    finally:
        prov.close()
    assert trace.pop("answered_at")
    expected = dict(_V1_TRACE_GOLDEN)
    if not _HAS_KRO_TEMPORAL:
        expected.pop("temporal_summary")
    assert canonical_json_bytes(trace) == canonical_json_bytes(expected)


def test_the_shared_citation_rules() -> None:
    """The two rules both trace versions read (one implementation, INV-7)."""
    assert citation_is_verbatim({"seq": 0, "has_overlay": 1}) is True  # the verbatim document
    assert citation_is_verbatim({"seq": 2, "has_overlay": 1}) is False  # a resolved chunk
    assert citation_is_verbatim({"seq": 2, "has_overlay": 0}) is True
    assert citation_is_verbatim({"seq": None, "has_overlay": 1}) is True  # an orphan
    assert provenance_coverage([]) == "none"
    assert provenance_coverage([{"source_label": None}]) == "none"
    assert provenance_coverage([{"source_label": "a"}, {"source_label": None}]) == "partial"
    assert provenance_coverage([{"source_label": "a"}, {"source_label": "b"}]) == "full"
    assert "RESOLVED renderings" in RESOLUTION_DISCLOSURE


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
