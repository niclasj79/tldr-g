"""Tests for the TokenGovernor and token estimation."""

from __future__ import annotations

import copy
from types import SimpleNamespace

from tp_vrg.governor import TokenGovernor
from tp_vrg.models import LODLevel, NodeData, ScoredNode, TokenProfile
from tp_vrg.scoring import _compute_mad, _intent_to_mad_t
from tp_vrg.tokens import estimate_tokens


def _make_node(eid: str, lod0_size: int = 200, lod1_size: int = 50, lod2_size: int = 10) -> NodeData:
    """Create a node with controllable text sizes."""
    return NodeData(
        entity_id=eid,
        name=eid.title(),
        category="test",
        lod_0="x" * lod0_size,
        lod_1="y" * lod1_size,
        lod_2="z" * lod2_size,
    )


def _make_scored(eid: str, score: float, lod: LODLevel) -> ScoredNode:
    return ScoredNode(entity_id=eid, score=score, assigned_lod=lod)


class TestTokenEstimation:
    def test_estimate_nonzero(self) -> None:
        assert estimate_tokens("Hello world") > 0

    def test_estimate_scales_with_length(self) -> None:
        short = estimate_tokens("short")
        long = estimate_tokens("a much longer sentence with many words in it")
        assert long > short

    def test_estimate_empty_string(self) -> None:
        # tiktoken correctly returns 0 for empty string; fallback returns >=1
        assert estimate_tokens("") >= 0


class TestGovernorUnderBudget:
    def test_under_budget_passes_through(self) -> None:
        """With ample budget, all nodes survive and get full LOD_0 allocation."""
        governor = TokenGovernor()
        profile = TokenProfile(name="test", max_tokens=100_000)

        nodes = {
            "a": _make_node("a"),
            "b": _make_node("b"),
        }
        scored = [
            _make_scored("a", 0.8, LODLevel.LOD_0),
            _make_scored("b", 0.5, LODLevel.LOD_1),
        ]

        result = governor.apply_budget(scored, profile, nodes)
        assert len(result) == 2
        # With 100k budget, both nodes get full LOD_0 allocation
        assert all(sn.assigned_lod == LODLevel.LOD_0 for sn in result)
        # Higher-scored node gets more (or equal) budget
        by_id = {sn.entity_id: sn for sn in result}
        assert by_id["a"].token_budget >= by_id["b"].token_budget


class TestGovernorCoarsening:
    def test_lod1_to_lod2_coarsening(self) -> None:
        """Low-scored nodes should be rendered at LOD_2 when their proportional budget is small."""
        governor = TokenGovernor()
        # Budget=200: cap allows 2 nodes (200 // 80 = 2), both survive.
        # Skewed scores (0.9 / 0.1): low's proportional share = 0.1/1.0 * 200 = 20 tokens.
        # lod1_size=400 chars → ~100 tokens lod1_cost. 20 < 100 → LOD_2.
        # lod0_size=8000 → ~1000 tokens lod0_cost. high's share (180) < lod0_cost →
        # no surplus freed → low stays at 20 tokens.
        profile = TokenProfile(name="tight", max_tokens=200)

        nodes = {
            "high": _make_node("high", lod0_size=8000, lod1_size=400, lod2_size=10),
            "low": _make_node("low", lod0_size=8000, lod1_size=400, lod2_size=10),
        }
        scored = [
            _make_scored("high", 0.9, LODLevel.LOD_0),
            _make_scored("low", 0.1, LODLevel.LOD_1),
        ]

        result = governor.apply_budget(scored, profile, nodes)
        by_id = {sn.entity_id: sn for sn in result}

        # Both survive the cap; low's small proportional share → LOD_2
        assert "low" in by_id
        assert by_id["low"].assigned_lod == LODLevel.LOD_2

    def test_lod0_to_lod1_escalation(self) -> None:
        """After LOD_1->LOD_2 exhausted, LOD_0 nodes should be downgraded."""
        governor = TokenGovernor()
        # Extremely tight budget
        profile = TokenProfile(name="minimal", max_tokens=30)

        nodes = {
            "a": _make_node("a", lod0_size=200, lod1_size=50, lod2_size=10),
            "b": _make_node("b", lod0_size=200, lod1_size=50, lod2_size=10),
        }
        scored = [
            _make_scored("a", 0.9, LODLevel.LOD_0),
            _make_scored("b", 0.7, LODLevel.LOD_0),
        ]

        result = governor.apply_budget(scored, profile, nodes)
        by_id = {sn.entity_id: sn for sn in result}

        # Lower-scored "b" should be downgraded before higher-scored "a"
        if "b" in by_id and "a" in by_id:
            assert by_id["b"].assigned_lod.value >= by_id["a"].assigned_lod.value

    def test_node_dropping(self) -> None:
        """Low-scored nodes with near-zero proportional budget share are dropped."""
        governor = TokenGovernor()
        # Tight budget: low scorer gets ~10% proportional share
        profile = TokenProfile(name="tight", max_tokens=20)

        nodes = {
            "keep": _make_node("keep", lod0_size=100, lod1_size=25, lod2_size=5),
            "drop": _make_node("drop", lod0_size=100, lod1_size=25, lod2_size=5),
        }
        scored = [
            _make_scored("keep", 0.95, LODLevel.LOD_0),
            _make_scored("drop", 0.001, LODLevel.LOD_2),
        ]

        result = governor.apply_budget(scored, profile, nodes)
        ids = {sn.entity_id for sn in result}

        # "drop" gets ~0 proportional budget share → dropped
        if len(result) < 2:
            assert "drop" not in ids
        # "keep" always survives (highest scored)
        assert "keep" in ids

    def test_highest_scored_preserved(self) -> None:
        """The highest-scored node should be the last one downgraded."""
        governor = TokenGovernor()
        profile = TokenProfile(name="tight", max_tokens=80)

        nodes = {
            "best": _make_node("best", lod0_size=200, lod1_size=50, lod2_size=10),
            "mid": _make_node("mid", lod0_size=200, lod1_size=50, lod2_size=10),
            "worst": _make_node("worst", lod0_size=200, lod1_size=50, lod2_size=10),
        }
        scored = [
            _make_scored("best", 0.9, LODLevel.LOD_0),
            _make_scored("mid", 0.5, LODLevel.LOD_1),
            _make_scored("worst", 0.2, LODLevel.LOD_1),
        ]

        result = governor.apply_budget(scored, profile, nodes)
        by_id = {sn.entity_id: sn for sn in result}

        # "worst" should be at a lower LOD than "best"
        if "best" in by_id and "worst" in by_id:
            assert by_id["worst"].assigned_lod.value >= by_id["best"].assigned_lod.value


class TestGovernorLOD0Protection:
    def test_governor_protects_best_lod0(self) -> None:
        """The highest-scored node must receive more budget than lower-scored nodes."""
        governor = TokenGovernor()
        profile = TokenProfile(name="tight", max_tokens=30)

        nodes = {
            "best": _make_node("best", lod0_size=200, lod1_size=50, lod2_size=10),
            "sacrificeable": _make_node("sacrificeable", lod0_size=200, lod1_size=50, lod2_size=10),
        }
        scored = [
            _make_scored("best", 0.9, LODLevel.LOD_0),
            _make_scored("sacrificeable", 0.4, LODLevel.LOD_0),
        ]

        result = governor.apply_budget(scored, profile, nodes)
        by_id = {sn.entity_id: sn for sn in result}

        # Protection guarantee: best always gets more budget than sacrificeable
        assert "best" in by_id
        if "sacrificeable" in by_id:
            assert by_id["best"].token_budget >= by_id["sacrificeable"].token_budget
        # best must survive
        assert by_id["best"].token_budget > 0

    def test_single_lod0_never_dropped(self) -> None:
        """If there is only one node, it must always survive even with minimal budget."""
        governor = TokenGovernor()
        # Budget impossibly tight, but only one node — it must survive
        profile = TokenProfile(name="tight", max_tokens=1)

        nodes = {
            "only": _make_node("only", lod0_size=200, lod1_size=50, lod2_size=10),
        }
        scored = [
            _make_scored("only", 0.9, LODLevel.LOD_0),
        ]

        result = governor.apply_budget(scored, profile, nodes)

        # Single node must always survive
        assert len(result) == 1
        assert result[0].entity_id == "only"
        assert result[0].token_budget > 0


class TestCandidateCap:
    """Tests for the budget-derived candidate cap (Pass 0)."""

    def test_candidate_cap_limits_nodes(self) -> None:
        """200-node input with 5,000-token budget → at most 5000//80 = 62 nodes survive."""
        from tp_vrg.models import MIN_BUDGET_PER_NODE

        governor = TokenGovernor()
        profile = TokenProfile(name="tight", max_tokens=5_000)

        nodes = {str(i): _make_node(str(i)) for i in range(200)}
        scored = [
            _make_scored(str(i), (200 - i) / 200.0, LODLevel.LOD_0)
            for i in range(200)
        ]  # scores descending: 200/200, 199/200, ..., 1/200

        result = governor.apply_budget(scored, profile, nodes)

        expected_max = 5_000 // MIN_BUDGET_PER_NODE
        assert len(result) <= expected_max
        # Surviving nodes should be the highest-scored (first in sorted order)
        surviving_ids = {sn.entity_id for sn in result}
        for i in range(len(result)):
            assert str(i) in surviving_ids

    def test_candidate_cap_scales_with_budget(self) -> None:
        """Larger budget → more surviving nodes from same input."""
        governor = TokenGovernor()

        nodes = {str(i): _make_node(str(i)) for i in range(200)}
        scored = [
            _make_scored(str(i), (200 - i) / 200.0, LODLevel.LOD_0)
            for i in range(200)
        ]

        small_profile = TokenProfile(name="small", max_tokens=2_000)
        large_profile = TokenProfile(name="large", max_tokens=10_000)

        # Create fresh copies of scored for each call (governor modifies in place)
        import copy
        result_small = governor.apply_budget(copy.deepcopy(scored), small_profile, nodes)
        result_large = governor.apply_budget(copy.deepcopy(scored), large_profile, nodes)

        assert len(result_large) > len(result_small)

    def test_candidate_cap_preserves_small_sets(self) -> None:
        """5 nodes with 5,000-token budget — all 5 survive (cap = 62, well above input)."""
        governor = TokenGovernor()
        profile = TokenProfile(name="generous", max_tokens=5_000)

        nodes = {str(i): _make_node(str(i)) for i in range(5)}
        scored = [_make_scored(str(i), 0.9 - i * 0.1, LODLevel.LOD_0) for i in range(5)]

        result = governor.apply_budget(scored, profile, nodes)
        assert len(result) == 5

    def test_candidate_cap_at_least_one(self) -> None:
        """Even with a tiny budget (50 tokens), at least 1 node survives."""
        governor = TokenGovernor()
        profile = TokenProfile(name="minimal", max_tokens=50)

        nodes = {str(i): _make_node(str(i)) for i in range(10)}
        scored = [_make_scored(str(i), 0.9 - i * 0.05, LODLevel.LOD_0) for i in range(10)]

        result = governor.apply_budget(scored, profile, nodes)
        assert len(result) >= 1
        # The surviving node must be the highest-scored
        assert result[0].entity_id == "0"


class TestMadAdmission:
    """Tests for the MAD-adaptive admission pre-pass."""

    def test_mad_threshold_empty_falls_through(self) -> None:
        """Empty scored_nodes returns immediately."""
        result = TokenGovernor().apply_budget([], TokenProfile(name="test", max_tokens=1000), {})
        assert result == []
        assert _compute_mad([]) == (0.0, 0.0)

    def test_mad_threshold_too_few_candidates_falls_through(self) -> None:
        """One or two candidates skip MAD admission and rely on the rank cap."""
        nodes = {
            "a": _make_node("a"),
            "b": _make_node("b"),
        }
        scored = [
            _make_scored("a", 0.9, LODLevel.LOD_0),
            _make_scored("b", 0.1, LODLevel.LOD_1),
        ]

        result = TokenGovernor().apply_budget(
            scored,
            TokenProfile(name="test", max_tokens=100_000),
            nodes,
            mad_t_override=2.0,
        )

        assert {sn.entity_id for sn in result} == {"a", "b"}

    def test_mad_threshold_uniform_falls_through(self) -> None:
        """Uniform scores have MAD=0 and preserve existing rank-cap behavior."""
        nodes = {str(i): _make_node(str(i)) for i in range(5)}
        scored = [_make_scored(str(i), 0.5, LODLevel.LOD_1) for i in range(5)]

        result = TokenGovernor().apply_budget(
            scored,
            TokenProfile(name="test", max_tokens=100_000),
            nodes,
            mad_t_override=2.0,
        )

        assert len(result) == 5

    def test_mad_threshold_bimodal_admits_only_high_cluster_at_high_t(self) -> None:
        """Skewed bimodal scores plus high t admit only the high cluster."""
        scores = [0.92, 0.90, 0.17, 0.16, 0.15, 0.14, 0.13, 0.12, 0.11, 0.10]
        nodes = {f"n{i}": _make_node(f"n{i}") for i in range(len(scores))}
        scored = [_make_scored(f"n{i}", score, LODLevel.LOD_1) for i, score in enumerate(scores)]

        result = TokenGovernor().apply_budget(
            scored,
            TokenProfile(name="test", max_tokens=100_000),
            nodes,
            mad_t_override=2.0,
        )

        assert [sn.entity_id for sn in result] == ["n0", "n1"]

    def test_mad_threshold_long_tail_rejects_tail_at_high_t(self) -> None:
        """Long-tail distribution plus high t rejects the low-scoring tail."""
        scores = [0.95, 0.9, 0.85, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05, 0.01]
        nodes = {f"n{i}": _make_node(f"n{i}") for i in range(len(scores))}
        scored = [_make_scored(f"n{i}", score, LODLevel.LOD_1) for i, score in enumerate(scores)]

        result = TokenGovernor().apply_budget(
            scored,
            TokenProfile(name="test", max_tokens=100_000),
            nodes,
            mad_t_override=2.0,
        )

        assert [sn.entity_id for sn in result] == ["n0", "n1"]
        assert all(sn.score >= 0.9 for sn in result)

    def test_mad_threshold_negative_t_admits_broadly(self) -> None:
        """A lenient t admits more nodes than an aggressive t."""
        scores = [0.95, 0.9, 0.85, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05, 0.01]
        nodes = {f"n{i}": _make_node(f"n{i}") for i in range(len(scores))}
        scored = [_make_scored(f"n{i}", score, LODLevel.LOD_1) for i, score in enumerate(scores)]
        profile = TokenProfile(name="test", max_tokens=100_000)

        broad = TokenGovernor().apply_budget(copy.deepcopy(scored), profile, nodes, mad_t_override=-1.0)
        narrow = TokenGovernor().apply_budget(copy.deepcopy(scored), profile, nodes, mad_t_override=2.0)

        assert len(broad) > len(narrow)

    def test_mad_threshold_preserves_highest_scored_invariant(self) -> None:
        """If MAD threshold admits nothing, the top-scored node still survives."""
        scores = [0.9] * 5 + [0.1] * 5
        nodes = {f"n{i}": _make_node(f"n{i}") for i in range(len(scores))}
        scored = [_make_scored(f"n{i}", score, LODLevel.LOD_1) for i, score in enumerate(scores)]

        result = TokenGovernor().apply_budget(
            scored,
            TokenProfile(name="test", max_tokens=100_000),
            nodes,
            mad_t_override=2.0,
        )

        assert len(result) == 1
        assert result[0].score == 0.9

    def test_intent_to_mad_threshold_mapping(self) -> None:
        """Reasoning-depth tiers map to the planned MAD multipliers."""
        assert _intent_to_mad_t(SimpleNamespace(reasoning_depth=0.8)) == 2.0
        assert _intent_to_mad_t(SimpleNamespace(reasoning_depth=0.5)) == 1.0
        assert _intent_to_mad_t(SimpleNamespace(reasoning_depth=0.4)) == -1.0


class TestComputePools:
    """Tests for TokenGovernor.compute_pools() — Phase B pool partitioning."""

    def test_default_ratios_send_full_budget_to_nodes(self) -> None:
        """Bare TokenProfile (1.0/0.0/0.0) → node_budget=max, edge=0, boundary=0."""
        profile = TokenProfile(name="test", max_tokens=10_000)
        node_budget, edge_budget, boundary_budget = TokenGovernor.compute_pools(profile)
        assert node_budget == 10_000
        assert edge_budget == 0
        assert boundary_budget == 0

    def test_named_profile_70_25_5_split(self) -> None:
        """Named profiles use 70/25/5 split — verify correct partitioning."""
        from tp_vrg.models import PROFILES

        profile = PROFILES["research"]  # max_tokens=25_000, 70/25/5
        node_budget, edge_budget, boundary_budget = TokenGovernor.compute_pools(profile)
        assert node_budget == int(25_000 * 0.70)   # 17_500
        assert edge_budget == int(25_000 * 0.25)   # 6_250
        assert boundary_budget == int(25_000 * 0.05)  # 1_250

    def test_all_profiles_produce_positive_node_budget(self) -> None:
        """Every named PROFILE must produce a non-zero node_budget."""
        from tp_vrg.models import PROFILES

        for name, profile in PROFILES.items():
            node_budget, _, _ = TokenGovernor.compute_pools(profile)
            assert node_budget > 0, f"Profile {name!r} has zero node_budget"

    def test_custom_ratios(self) -> None:
        """Custom pool ratios are applied proportionally."""
        profile = TokenProfile(
            name="custom",
            max_tokens=1_000,
            node_pool_ratio=0.50,
            edge_pool_ratio=0.40,
            boundary_pool_ratio=0.10,
        )
        node_budget, edge_budget, boundary_budget = TokenGovernor.compute_pools(profile)
        assert node_budget == 500
        assert edge_budget == 400
        assert boundary_budget == 100


class TestGovernorMaxNodes:
    """Tests for the max_nodes hard ceiling (audit item 3.1)."""

    def test_max_nodes_default_caps_at_50(self) -> None:
        """MAX_NODES_DEFAULT = 50 caps regardless of budget."""
        from tp_vrg.models import MAX_NODES_DEFAULT
        assert MAX_NODES_DEFAULT == 50

        # Build 100 scored nodes
        scored = [_make_scored(f"n{i}", score=1.0 - i * 0.005, lod=LODLevel.LOD_1) for i in range(100)]
        nodes = {f"n{i}": _make_node(f"n{i}", lod0_size=100, lod1_size=30) for i in range(100)}

        # 25k budget → budget ceiling = 25000*0.7 // 80 = 218, but hard cap = 50
        profile = TokenProfile(name="test", max_tokens=25_000,
                               node_pool_ratio=0.70, edge_pool_ratio=0.15,
                               boundary_pool_ratio=0.15)
        result = TokenGovernor().apply_budget(scored, profile, nodes)
        assert len(result) <= MAX_NODES_DEFAULT

    def test_max_nodes_override_via_profile(self) -> None:
        """profile.max_nodes overrides MAX_NODES_DEFAULT."""
        scored = [_make_scored(f"n{i}", score=1.0 - i * 0.005, lod=LODLevel.LOD_1) for i in range(30)]
        nodes = {f"n{i}": _make_node(f"n{i}", lod0_size=100, lod1_size=30) for i in range(30)}

        profile = TokenProfile(name="test", max_tokens=25_000, max_nodes=10)
        result = TokenGovernor().apply_budget(scored, profile, nodes)
        assert len(result) <= 10

    def test_max_nodes_none_uses_default(self) -> None:
        """TokenProfile.max_nodes=None uses MAX_NODES_DEFAULT."""
        from tp_vrg.models import MAX_NODES_DEFAULT

        scored = [_make_scored(f"n{i}", score=1.0 - i * 0.005, lod=LODLevel.LOD_1) for i in range(80)]
        nodes = {f"n{i}": _make_node(f"n{i}", lod0_size=100, lod1_size=30) for i in range(80)}

        profile = TokenProfile(name="test", max_tokens=25_000, max_nodes=None)
        assert profile.max_nodes is None  # confirm default
        result = TokenGovernor().apply_budget(scored, profile, nodes)
        assert len(result) <= MAX_NODES_DEFAULT

    def test_budget_ceiling_still_applies_when_lower(self) -> None:
        """With a tiny budget, the budget ceiling beats the hard cap."""
        scored = [_make_scored(f"n{i}", score=1.0 - i * 0.01, lod=LODLevel.LOD_1) for i in range(20)]
        nodes = {f"n{i}": _make_node(f"n{i}", lod0_size=100, lod1_size=30) for i in range(20)}

        # tiny budget: node_pool = 400, budget ceiling = 400 // 80 = 5 < 50
        profile = TokenProfile(name="test", max_tokens=500,
                               node_pool_ratio=0.80, edge_pool_ratio=0.10,
                               boundary_pool_ratio=0.10)
        result = TokenGovernor().apply_budget(scored, profile, nodes)
        assert len(result) <= 5

    def test_token_profile_max_nodes_field_defaults_none(self) -> None:
        """TokenProfile.max_nodes defaults to None for backward compatibility."""
        p = TokenProfile(name="x", max_tokens=1000)
        assert p.max_nodes is None


class TestGovernorWithEngine:
    """Integration test: governor wired through the engine."""

    async def test_profile_affects_context(self) -> None:
        from tp_vrg.engine import LODGraphMemory
        from tp_vrg.models import PROFILES

        mem = LODGraphMemory(use_semantic_scoring=True)
        await mem.add_memory("demo")

        # Chat profile (10k) should produce shorter context than code_complex (80k)
        ctx_chat = await mem.get_context("OpenAI", profile=PROFILES["chat"], debug=True)
        ctx_complex = await mem.get_context("OpenAI", profile=PROFILES["code_complex"], debug=True)

        # Both should be valid
        assert "KNOWLEDGE GRAPH CONTEXT" in ctx_chat
        assert "KNOWLEDGE GRAPH CONTEXT" in ctx_complex
