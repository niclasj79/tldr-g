"""Public smoke — the contracts + verification surface imports and works,
without the engine."""

from tp_vrg.attestation import sign_envelope, verify_envelope


def test_sign_verify_roundtrip_and_tamper_detection() -> None:
    payload = {"answer_id": "smoke", "answer": "x", "citations": []}
    envelope = sign_envelope(payload, "render_trace")
    assert verify_envelope(envelope)["valid"] is True
    envelope["payload"]["answer"] = "tampered"
    assert verify_envelope(envelope)["valid"] is False


def test_adapter_contract_surface_imports() -> None:
    # The boundary integration interface must import without the engine.
    from tp_vrg.adapters import AdapterRegistry, get_registry

    assert get_registry() is not None
    assert AdapterRegistry is not None


def test_package_import_is_engine_free() -> None:
    import tp_vrg

    # The minimal public package exposes only the boundary surface.
    assert hasattr(tp_vrg, "attestation")
    assert hasattr(tp_vrg, "adapters")
