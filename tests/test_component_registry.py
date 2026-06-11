"""Tests for the Unified Component Registry (K-B, L1 + L2).

The load-bearing test is `test_standard_mode_matches_canonical_defaults` +
`test_standard_modedefaults_equal_live_models_defaults`: together they prove the
SAFETY INVARIANT — `standard` == current behavior, and (with `apply_mode_profile`'s
no-op-when-unset semantics) default engine behavior is byte-unchanged by this module.
"""

from __future__ import annotations

import pytest

from tp_vrg import component_registry as reg
from tp_vrg.component_registry import (
    AuditStatus,
    ComponentClass,
    ComponentDescriptor,
    Stage,
)


# --- L1: registry integrity ------------------------------------------------

def test_registry_nonempty_and_unique_ids() -> None:
    comps = reg.all_components()
    assert len(comps) >= 20
    ids = [c.component_id for c in comps]
    assert len(ids) == len(set(ids)), "duplicate component_id"


def test_fire_and_water_partition_the_registry() -> None:
    assert len(reg.fire()) + len(reg.water()) == len(reg.all_components())
    assert len(reg.water()) == 3  # the 3 water.py injectors
    assert all(c.klass is ComponentClass.WATER for c in reg.water())
    assert all(c.klass is ComponentClass.FIRE for c in reg.fire())


def test_by_stage_covers_all_components() -> None:
    total = sum(len(reg.by_stage(s)) for s in Stage)
    assert total == len(reg.all_components())


def test_get_unknown_raises() -> None:
    with pytest.raises(KeyError):
        reg.get("does_not_exist")


def test_descriptor_rejects_incomplete_mode_defaults() -> None:
    with pytest.raises(ValueError):
        ComponentDescriptor(
            "x", "X", ComponentClass.FIRE, Stage.QUERY, "f.py:x", True,
            {"lean": True, "standard": True},  # missing "full"
            AuditStatus.PRIOR,
        )
    with pytest.raises(ValueError):
        ComponentDescriptor(
            "x", "X", ComponentClass.FIRE, Stage.QUERY, "f.py:x", True,
            {"lean": True, "standard": True, "full": True, "bogus": True},
            AuditStatus.PRIOR,
        )


# --- L2: resolve_mode_profile (pure) ---------------------------------------

def test_resolve_mode_profile_covers_every_component() -> None:
    for mode in reg.MODES:
        resolved = reg.resolve_mode_profile(mode)
        assert set(resolved) == {c.component_id for c in reg.all_components()}


def test_resolve_mode_profile_values() -> None:
    assert reg.resolve_mode_profile("lean")["sentence_embeddings"] is False
    assert reg.resolve_mode_profile("standard")["sentence_embeddings"] is True
    assert reg.resolve_mode_profile("full")["water_query_expander"] is True
    assert reg.resolve_mode_profile("standard")["water_query_expander"] is False


def test_resolve_mode_profile_rejects_bad_mode() -> None:
    with pytest.raises(ValueError):
        reg.resolve_mode_profile("turbo")


# --- L2: apply_mode_profile (env translation; the safety semantics) --------

def test_apply_is_noop_when_no_mode() -> None:
    env: dict[str, str] = {}
    applied = reg.apply_mode_profile(environ=env)
    assert applied == {}
    assert env == {}, "default behavior must be byte-unchanged when TPVRG_MODE unset"


def test_apply_lean_sets_env_toggles() -> None:
    env: dict[str, str] = {}
    applied = reg.apply_mode_profile("lean", environ=env)
    # an env-toggled fire component is set, serialized to the engine's convention
    assert env["TPVRG_SENTENCE_EMBEDDINGS"] == "false"
    assert env["TPVRG_RRF_FUSION"] == "true"
    assert applied["TPVRG_SENTENCE_EMBEDDINGS"] == "false"


def test_apply_skips_non_env_toggles() -> None:
    env: dict[str, str] = {}
    reg.apply_mode_profile("full", environ=env)
    # WaterConfig-gated + hardcoded components are NOT env-set (Phase 2)
    assert not any(k.startswith("WaterConfig") for k in env)
    assert "TPVRG_MODE" not in env  # we don't echo the mode back as a toggle


def test_apply_preserves_explicit_override_setdefault() -> None:
    env = {"TPVRG_SENTENCE_EMBEDDINGS": "true"}  # explicit override
    applied = reg.apply_mode_profile("lean", environ=env)
    # lean would set it "false", but the explicit override wins
    assert env["TPVRG_SENTENCE_EMBEDDINGS"] == "true"
    assert "TPVRG_SENTENCE_EMBEDDINGS" not in applied


def test_apply_reads_mode_from_env() -> None:
    env = {"TPVRG_MODE": "full"}
    reg.apply_mode_profile(environ=env)
    assert env["TPVRG_SP7_ENABLED"] == "true"


def test_apply_rejects_bad_mode() -> None:
    with pytest.raises(ValueError):
        reg.apply_mode_profile("turbo", environ={})


def test_active_mode() -> None:
    assert reg.active_mode({"TPVRG_MODE": "Lean"}) == "lean"
    assert reg.active_mode({}) is None


# --- THE safety invariant: standard == canonical == live models defaults ---

def test_standard_mode_matches_canonical_default() -> None:
    """Registry-internal: every component's `standard` mode-default IS its canonical
    default. This is what makes TPVRG_MODE=standard reproduce current behavior."""
    for c in reg.all_components():
        assert c.mode_defaults["standard"] == c.default, (
            f"{c.component_id}: standard ({c.mode_defaults['standard']!r}) != default ({c.default!r})"
        )


def test_standard_modedefaults_equal_live_models_defaults() -> None:
    """INV-1 cross-check: the registry's canonical default equals the live models.py
    value (where a models attribute mirrors it AND no env override is active). This is
    the guard against the registry drifting from the real engine defaults."""
    import os

    from tp_vrg import models

    checked = 0
    for c in reg.all_components():
        if c.models_attr is None:
            continue
        if c.env_toggle and c.env_toggle in os.environ:
            continue  # an override is active in this env → skip (would not equal canonical)
        assert hasattr(models, c.models_attr), f"{c.component_id}: models.{c.models_attr} missing"
        live = getattr(models, c.models_attr)
        assert c.default == live, (
            f"{c.component_id}: registry default ({c.default!r}) != models.{c.models_attr} ({live!r})"
        )
        checked += 1
    assert checked >= 10, "expected the cross-check to cover the verified-toggle components"


# --- Observability ---------------------------------------------------------

def test_registry_summary_shape() -> None:
    s = reg.registry_summary({})
    assert s["total"] == len(reg.all_components())
    assert s["fire"] + s["water"] == s["total"]
    assert s["active_mode"].startswith("unset")
    assert isinstance(s["components"], list) and len(s["components"]) == s["total"]
    assert set(s["by_stage"]) == {st.value for st in Stage}

    s2 = reg.registry_summary({"TPVRG_MODE": "lean"})
    assert s2["active_mode"] == "lean"
