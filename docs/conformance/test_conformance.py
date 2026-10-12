"""Conformance suite v0 — the fixture-driven test.

Point pytest at this file. ``conformance.py`` sits beside it, so pytest's
default prepend import mode puts it on sys.path — no package wiring needed.

The two tests that exercise the reference backend skip when ``jsonschema`` is
not installed; every other test runs on the standard library alone.
"""

from __future__ import annotations

import json

import pytest

import conformance


def test_schemas_are_loadable_and_well_formed() -> None:
    env = conformance.load_schema(conformance.ENVELOPE_SCHEMA)
    assert env["title"] == "Attestation Envelope v1"
    names = [*conformance.PAYLOAD_SCHEMA_BY_TYPE.values(),
             *conformance.PAYLOAD_SCHEMA_BY_VERSION.values()]
    for name in names:
        schema = conformance.load_schema(name)
        assert schema["$schema"].startswith("https://json-schema.org/draft/2020-12")


def test_a_render_trace_is_dispatched_on_its_trace_version() -> None:
    """v2 (the answer receipt) arrives beside v1, never underneath it: each
    version is checked against its own schema, and an unknown version is
    rejected rather than waved through."""
    v2 = json.loads(
        (conformance.FIXTURE_DIR / "valid" / "envelope-render-trace-v2.json").read_text(encoding="utf-8")
    )
    assert conformance.payload_schema_name("render_trace", v2["payload"]) == "render-trace-v2.schema.json"
    assert conformance.validate_envelope(v2)["conforms"] is True
    v1 = json.loads(
        (conformance.FIXTURE_DIR / "valid" / "envelope-render-trace.json").read_text(encoding="utf-8")
    )
    assert conformance.payload_schema_name("render_trace", v1["payload"]) == "render-trace-v1.schema.json"
    for version in (3, True, 2.0, "2"):
        odd = json.loads(json.dumps(v2))
        odd["payload"]["trace_version"] = version
        assert conformance.validate_envelope(odd)["conforms"] is False, version
        assert conformance.validate_envelope(odd, force_stdlib=True)["conforms"] is False, version


def test_jsonschema_is_the_active_backend() -> None:
    # Where jsonschema is installed (every dev environment), the reference
    # backend must be the one in use, not the fallback.
    pytest.importorskip("jsonschema")
    assert conformance.active_backend() == "jsonschema"


def test_every_valid_fixture_conforms() -> None:
    report = conformance.run_conformance()
    for r in report["results"]:
        if r["expected"] == "conform":
            assert r["ok"], f"{r['fixture']} should conform but: {r['errors']}"


def test_every_invalid_fixture_is_rejected() -> None:
    report = conformance.run_conformance()
    for r in report["results"]:
        if r["expected"] == "reject":
            assert r["ok"], f"{r['fixture']} should be rejected but conformed"


def test_full_suite_passes() -> None:
    assert conformance.run_conformance()["all_conform"] is True


def test_stdlib_backend_agrees_with_jsonschema() -> None:
    """The dependency-free fallback reaches the same verdict on every fixture —
    so an external party without jsonschema gets the same conformance result."""
    pytest.importorskip("jsonschema")  # the comparison needs the reference backend
    js = conformance.run_conformance(force_stdlib=False)
    sl = conformance.run_conformance(force_stdlib=True)
    assert sl["backend"] == "stdlib"
    js_ok = {r["fixture"]: r["ok"] for r in js["results"]}
    sl_ok = {r["fixture"]: r["ok"] for r in sl["results"]}
    assert js_ok == sl_ok
    assert sl["all_conform"] is True


def test_dispatch_validates_payload_against_its_type() -> None:
    """A structurally-valid envelope whose render_trace payload is malformed is
    rejected by the payload dispatch (not just the envelope shape)."""
    good = json.loads(
        (conformance.FIXTURE_DIR / "valid" / "envelope-render-trace.json").read_text(encoding="utf-8")
    )
    good["payload"]["provenance_coverage"] = "bogus"
    verdict = conformance.validate_envelope(good)
    assert verdict["conforms"] is False
    assert any("payload/" in e for e in verdict["errors"])


def test_validate_envelope_clean_on_a_valid_fixture() -> None:
    env = json.loads(
        (conformance.FIXTURE_DIR / "valid" / "envelope-portable-artifact-asset.json").read_text(encoding="utf-8")
    )
    verdict = conformance.validate_envelope(env)
    assert verdict["conforms"] is True
    assert verdict["errors"] == []
    assert verdict["payload_type"] == "portable_artifact"
