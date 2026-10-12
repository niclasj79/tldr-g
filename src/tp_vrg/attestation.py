"""Signed-artifact attestation — the federation attestation artifact.

Sigstore-class detached signatures over the engine's two exportable
boundary objects: the PortableArtifact (rung-level subgraph export, GDPR
Art 20) and the render trace (the Provenance Layer's answer + citations +
reference pointers, the "memory you can audit" surface). Same family as Certificate
Transparency / Sigstore / eIDAS 2.0 qualified seals — explicitly NOT a
blockchain, no token, no distributed ledger.

Ed25519 detached signatures + did:web identity. This module is the single
canonical attestation implementation; the engine's MCP server, HTTP API, and
CLI all wire here.

Envelope shape (attestation_version 1):

    {
      "attestation_version": 1,
      "payload_type": "portable_artifact" | "render_trace" |
                      "rcg_divergence_census" | "verification_trace",
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
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tp_vrg.data_dir import get_data_dir

logger = logging.getLogger(__name__)

ATTESTATION_VERSION = 1
PAYLOAD_TYPES = (
    "portable_artifact",
    "render_trace",
    "rcg_divergence_census",
    # The last mile: per-claim grounding verdicts for one answer, with the
    # candidate set each verdict was scoped to and the pinned decomposer + NLI
    # model ids. Built by tp_vrg.output_verifier (engine-only); this module
    # only needs to know the type exists, so the public engine-free package
    # can still verify such an envelope's integrity offline.
    "verification_trace",
)

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

    First use is atomic. Two callers that both find no key (the Cockpit and an
    MCP process on one home, or two concurrent first answers now that every
    answer is receipted) each generate one, but only the first to publish its
    file keeps it: the file appears complete or not at all, it is never
    overwritten, and the loser returns the WINNER's key. Before 2026-10-02 the
    second writer replaced the first's file, so every envelope the first caller
    had signed named a key_id no file held.
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
    try:
        _publish_new_key_file(key_path, pem)
    except FileExistsError:
        # Another caller published a key between our exists() and our publish:
        # sign with THAT key, so every envelope names a key the file holds.
        return serialization.load_pem_private_key(
            key_path.read_bytes(), password=None
        )
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


def _publish_new_key_file(key_path: Path, pem: bytes) -> None:
    """Write ``pem`` to ``key_path`` only if no file is there.

    Raises ``FileExistsError`` when another caller published first, and
    replaces nothing. The bytes go to a private temporary file and are then
    LINKED into place: a hard link is created atomically and never replaces an
    existing name, so a concurrent reader sees either no key or a complete one.

    Where the filesystem refuses hard links (exFAT or vfat, some SMB and FUSE
    mounts), the publish falls back rather than failing, because the base's
    plain write worked there and a home where no key can ever be created would
    leave every receipt unavailable and every signed export failing. On Windows
    the fallback is ``rename``, which is atomic and never replaces a file;
    elsewhere it is an exclusive create of the key path itself
    (``O_CREAT | O_EXCL``), which never replaces a file either but is not atomic
    for a concurrent reader -- the price of a filesystem without links. Both
    raise ``FileExistsError`` when another caller published first.
    """
    tmp = key_path.with_name(f".{key_path.name}.{secrets.token_hex(8)}.tmp")
    try:
        _write_new_file(tmp, pem)  # inside the try: a failed write leaves no copy
        try:
            os.link(tmp, key_path)
        except FileExistsError:
            raise
        except OSError:
            if os.name == "nt":
                os.rename(tmp, key_path)  # never replaces an existing file on Windows
            else:
                _write_new_file(key_path, pem)
    finally:
        _remove_temporary(tmp)


def _remove_temporary(tmp: Path) -> None:
    """Remove the publish's temporary file; a failure is logged, never raised.

    By the time this runs the key may already be published, so a cleanup
    failure (a scanner holding the fresh file) must not undo a good publish by
    raising out of it. The leftover is a second name for the private key, so
    the warning says where it is and that it should be deleted.
    """
    try:
        tmp.unlink(missing_ok=True)
    except OSError as exc:
        logger.warning(
            "[attestation] could not remove the temporary key file %s (%s); it is a "
            "copy of the private signing key -- delete it",
            tmp,
            type(exc).__name__,
        )


def _write_new_file(path: Path, data: bytes) -> None:
    """Create ``path`` (owner-only) and write ``data`` to disk; raises
    ``FileExistsError`` if anything is already there, and replaces nothing."""
    fd = os.open(
        path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600
    )
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


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


def resolve_signed_by(public_key, signed_by: str | None = None) -> str:
    """The ``signed_by`` value an envelope signed with ``public_key`` carries.

    An explicit ``signed_by`` wins, then the operator's configured
    ``TPVRG_ATTESTATION_IDENTITY`` (a did:web or a label), then the key's own
    fingerprint -- which every install has, and which is what a fresh install
    signs with. ONE chain: ``sign_envelope`` resolves through it, and so does
    the answer receipt, which states its signer inside the signed payload, so
    the two can only agree. The value is a label: the offline verify proves
    the holder of ``key_id`` signed, never who that holder is.
    """
    return (
        (signed_by or "").strip()
        or os.environ.get("TPVRG_ATTESTATION_IDENTITY", "").strip()
        or key_fingerprint(public_key)
    )


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
        "signed_by": resolve_signed_by(public_key, signed_by),
        "key_id": key_fingerprint(public_key),
        "public_key": base64.b64encode(_public_key_raw(public_key)).decode("ascii"),
    }
    signature = signing_key.sign(canonical_json_bytes(_protected_header(envelope)))
    envelope["payload"] = payload
    envelope["signature"] = base64.b64encode(signature).decode("ascii")
    return envelope


_ED25519_P = 2**255 - 19

#: libsodium's small-order blocklist (``ed25519_ref10.c``), compared with the
#: sign bit masked: the encodings of every point in the 8-torsion subgroup
#: (y = 0 for both order-4 points, y = 1 the identity, two y for the four
#: order-8 points, y = p - 1 the order-2 point) plus the non-canonical aliases
#: y = p and y = p + 1 of y = 0 and y = 1. ``public/overlay/verify.html`` holds
#: the same seven (``SMALL_ORDER_ENCODINGS``); a differential test compares them.
_SMALL_ORDER_ENCODINGS: tuple[bytes, ...] = tuple(
    bytes.fromhex(h)
    for h in (
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0100000000000000000000000000000000000000000000000000000000000000",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    )
)


def _degenerate_point_reason(point: bytes) -> str | None:
    """Why a 32-byte public key or signature R is refused, or None.

    A small-order point carries no secret: with such a key, R = identity and
    S = 0 verify every message whose challenge k is a multiple of the key's
    order (for the identity key, every message), so an envelope nobody signed
    reads VALID under OpenSSL. Engine keys always have prime order, so nothing an
    install signs is refused. A y >= p is no canonical encoding of any point.
    Anything not 32 bytes long is left to the decoding and the signature check.
    """
    if len(point) != 32:
        return None
    masked = point[:31] + bytes([point[31] & 0x7F])
    if masked in _SMALL_ORDER_ENCODINGS:
        return "degenerate (small-order) key or signature point"
    if int.from_bytes(masked, "little") >= _ED25519_P:
        return "degenerate (non-canonical) key or signature point encoding"
    return None


def verify_envelope(envelope: dict) -> dict[str, Any]:
    """Verify an attestation envelope's integrity offline.

    Returns a verdict dict (never raises for *invalid* envelopes — only
    for structurally unusable input):

        {"valid": bool, "reason": str, "payload_type": ..., "key_id": ...}

    A ``valid: True`` verdict proves the payload is byte-identical (under
    canonical JSON) to what the holder of ``key_id`` signed. It does NOT
    by itself prove WHO that holder is — match ``key_id``/``public_key``
    against the signer's did:web document for identity trust.

    Before the signature check it refuses a public key or signature R that is
    a small-order or non-canonical point (``_degenerate_point_reason``): such a
    key has no secret, and the Ed25519 equation would hold for a payload nobody
    signed.

    It also proves the signer LABELS do not lie about the key (see
    ``_signer_mismatch``): a ``signed_by`` that names an ed25519 key must be
    this envelope's ``key_id``, and an answer receipt's own
    ``payload.principal`` must name the envelope's signer. Without that, a
    stranger's key could sign an envelope whose Signed-by line shows YOUR
    install's fingerprint, and every check above would pass.
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

    # The degenerate-point refusals run on the raw bytes: the key's before
    # from_public_bytes, R's before the verify call, the only OpenSSL call that
    # sees R (from_public_bytes copies the key bytes and validates nothing; it
    # accepts an off-curve key). A small-order key with R = identity and S = 0,
    # or with an ordinary R, satisfies the verification equation for a payload
    # nobody signed, and OpenSSL (like WebCrypto) accepts it. Order within the
    # block is unchanged (key, then signature), so a malformed envelope keeps
    # its old reason.
    try:
        public_raw = base64.b64decode(envelope["public_key"])
        degenerate = _degenerate_point_reason(public_raw)
        if degenerate is not None:
            return verdict(False, degenerate)
        public_key = Ed25519PublicKey.from_public_bytes(public_raw)
        signature = base64.b64decode(envelope["signature"])
    except Exception as exc:
        return verdict(False, f"malformed key or signature encoding: {exc}")

    degenerate = _degenerate_point_reason(signature[:32])
    if degenerate is not None:
        return verdict(False, degenerate)

    if key_fingerprint(public_key) != envelope["key_id"]:
        return verdict(False, "key_id does not match embedded public key")

    try:
        public_key.verify(
            signature, canonical_json_bytes(_protected_header(envelope))
        )
    except Exception:
        return verdict(False, "signature verification FAILED — header or signature tampered")

    mismatch = _signer_mismatch(envelope)
    if mismatch is not None:
        return verdict(False, mismatch)

    return verdict(True, "signature valid; payload hash matches")


def _signer_mismatch(envelope: dict) -> str | None:
    """Why the envelope's signer labels contradict its key, or None.

    Every verifier shows ``signed_by`` as the signer, and a fresh install's
    ``signed_by`` IS its key fingerprint (``ed25519:<16 hex>``), so a reader
    compares that line with the install's fingerprint. ``signed_by`` is signed
    text the signer chooses, though, so without this rule a stranger's key could
    sign an envelope labelled with someone else's fingerprint and verify VALID.
    Two rules, the same in ``public/overlay/verify.html``:

    * a ``signed_by`` that names an ed25519 key at all (``ed25519:`` anywhere,
      any case) must be exactly this envelope's ``key_id``;
    * a ``render_trace`` payload that names a ``principal`` (the answer receipt,
      ``trace_version`` 2) must name the envelope's ``signed_by`` as its
      ``signer``, and a ``signer_kind`` of ``key-fingerprint`` must be this
      envelope's ``key_id`` -- so the receipt's own signed claim about its
      signer is checked, not just carried.

    A configured did:web or operator label passes both, and stays what it was:
    configured text the offline verify does not resolve.
    """
    signed_by = envelope.get("signed_by")
    key_id = envelope.get("key_id")
    if isinstance(signed_by, str) and "ed25519:" in signed_by.lower() and signed_by != key_id:
        return (
            f"signer mismatch: signed_by {signed_by!r} names an ed25519 key, but this "
            f"envelope was signed by key_id {key_id!r}"
        )
    payload = envelope.get("payload")
    if (
        envelope.get("payload_type") == "render_trace"
        and isinstance(payload, dict)
        and "principal" in payload
    ):
        principal = payload["principal"]
        signer = principal.get("signer") if isinstance(principal, dict) else None
        if not isinstance(signer, str) or signer != signed_by:
            return (
                f"signer mismatch: the receipt's payload names signer {signer!r}, but the "
                f"envelope is signed_by {signed_by!r}"
            )
        if principal.get("signer_kind") == "key-fingerprint" and signer != key_id:
            return (
                f"signer mismatch: the receipt says its signer {signer!r} is the signing "
                f"key's fingerprint, but this envelope was signed by key_id {key_id!r}"
            )
    return None


# ---------------------------------------------------------------------------
# render trace (the Q1 artifact's payload builder)
# ---------------------------------------------------------------------------

#: The sentence a render trace carries when any cited segment is a RESOLVED
#: rendering. Shared by both trace versions (``build_render_trace`` here, and the
#: answer receipt's ``trace_version`` 2 in the engine's ``answer_receipt``), so
#: the two cannot drift into two different disclosures of one fact.
RESOLUTION_DISCLOSURE = (
    "One or more cited segments are RESOLVED renderings (coref / "
    "defined-term resolution applied), not verbatim source text. The "
    "verbatim document for each source is its seq=0 segment; content_hash "
    "is over the verbatim bytes; a reversible resolution overlay records "
    "every substitution. Verify cited text against the verbatim source."
)


def citation_is_verbatim(citation: dict[str, Any]) -> bool:
    """Whether a cited segment's stored text is verbatim source text.

    The coref-verbatim-contamination fix: a cited chunk segment may be a
    RESOLVED rendering (coref / defined-term resolution applied), not verbatim
    source text, and a signed trace must never imply otherwise -- the verbatim
    document is each source's seq=0 segment, content_hash is over the verbatim
    bytes, and the reversible overlay records every substitution. A segment's
    text is verbatim UNLESS it is a chunk (seq>0) of a source whose resolution
    overlay is present. ``citation`` is a ``get_citations_for_answer`` row.
    """
    seq = citation.get("seq")
    has_overlay = bool(citation.get("has_overlay"))
    return not (has_overlay and seq is not None and seq > 0)


def provenance_coverage(citations: list[dict[str, Any]]) -> str:
    """``none`` (no citation resolves to a source), ``full`` (every one does) or
    ``partial``, over ``get_citations_for_answer`` rows."""
    total = len(citations)
    null_sources = sum(1 for c in citations if c.get("source_label") is None)
    if total == 0 or null_sources == total:
        return "none"
    if null_sources == 0:
        return "full"
    return "partial"


def build_render_trace(answer_id: str, provenance) -> dict[str, Any]:
    """Compose the exportable render-trace object from the Provenance Layer.

    Emission-time composition over the provenance store. The trace is the
    auditable record of one rendered answer: the query, the model, the
    citation chain back to source segments, and reference-only pointers for
    ranked candidates that were not spent as prompt text.

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

    # Temporal-manifold enrichment is an ENGINE feature, not part of the open
    # boundary. The public (engine-free) package ships attestation.py without
    # tp_vrg.kro_temporal; in that build the render trace simply omits
    # temporal_summary (the public render-trace-v1 contract does not promise it).
    # In the full engine the module is present and the summary is included.
    try:
        from tp_vrg.kro_temporal import compute_kro_temporal_summary

        temporal_summary = compute_kro_temporal_summary(citations).as_dict()
    except ImportError:
        temporal_summary = None

    coverage = provenance_coverage(citations)

    # Resolution disclosure: see citation_is_verbatim and RESOLUTION_DISCLOSURE.
    citations_out: list[dict[str, Any]] = []
    any_resolved = False
    for c in citations:
        is_verbatim = citation_is_verbatim(c)
        if not is_verbatim:
            any_resolved = True
        citations_out.append(
            {
                "cite_order": c.get("cite_order"),
                "segment_id": c.get("segment_id"),
                "source_label": c.get("source_label"),
                "source_uri": c.get("source_uri"),
                "text": c.get("text"),
                "evidence_snippet": c.get("evidence_snippet"),
                "verbatim": is_verbatim,
                "content_hash": c.get("content_hash"),
            }
        )

    trace: dict[str, Any] = {
        "trace_version": 1,
        "answer_id": answer["answer_id"],
        "query_text": answer["query_text"],
        "answered_at": answer["answered_at"],
        "model_label": answer["model_label"],
        "provenance_coverage": coverage,
        "citations": citations_out,
        "pointers": list(answer.get("render_pointers") or []),
    }
    if any_resolved:
        trace["resolution_disclosure"] = RESOLUTION_DISCLOSURE
    if temporal_summary is not None:
        trace["temporal_summary"] = temporal_summary
    # The citation chain this trace signs is the one a delete cuts: when a
    # delete removed evidence this answer cited, the trace says so instead of
    # signing a silently shorter chain. Absent when nothing was removed.
    # Read, never presumed: a store that cannot answer raises here rather than
    # signing a trace that says nothing was removed.
    from tp_vrg.provenance_storage import removal_marks_view

    removal_marks = removal_marks_view(
        provenance.get_removal_marks(answer_id), include_claim_text=True
    )
    if removal_marks:
        trace["evidence_removed"] = removal_marks
    return trace


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
