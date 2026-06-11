"""Tests for the Pydantic data models."""

from __future__ import annotations

from tp_vrg.models import EdgeData, ExtractionResult, LODLevel, NodeData, PROFILES, TokenProfile


class TestNodeData:
    def test_get_at_lod_returns_correct_tier(self) -> None:
        node = NodeData(
            entity_id="test",
            name="Test",
            category="concept",
            lod_0="full detail here",
            lod_1="summary here",
            lod_2="Test [concept]",
        )
        assert node.get_at_lod(LODLevel.LOD_0) == "full detail here"
        assert node.get_at_lod(LODLevel.LOD_1) == "summary here"
        assert node.get_at_lod(LODLevel.LOD_2) == "Test [concept]"

    def test_default_category(self) -> None:
        node = NodeData(
            entity_id="x",
            name="X",
            lod_0="a",
            lod_1="b",
            lod_2="c",
        )
        assert node.category == "concept"


class TestEdgeData:
    def test_default_weight(self) -> None:
        edge = EdgeData(source="a", target="b", relation="knows")
        assert edge.weight == 1.0


class TestExtractionResult:
    def test_default_empty_lists(self) -> None:
        result = ExtractionResult()
        assert result.nodes == []
        assert result.edges == []


class TestLODLevel:
    def test_ordering(self) -> None:
        assert LODLevel.LOD_0 < LODLevel.LOD_1 < LODLevel.LOD_2

    def test_int_values(self) -> None:
        assert int(LODLevel.LOD_0) == 0
        assert int(LODLevel.LOD_1) == 1
        assert int(LODLevel.LOD_2) == 2


class TestQAProfile:
    """Regression tests for the 'qa' TokenProfile used in factoid QA benchmarks."""

    def test_qa_profile_exists(self) -> None:
        assert "qa" in PROFILES

    def test_qa_max_tokens(self) -> None:
        qa = PROFILES["qa"]
        assert qa.max_tokens == 4_000

    def test_qa_pool_ratios(self) -> None:
        qa = PROFILES["qa"]
        assert qa.node_pool_ratio == 0.90
        assert qa.edge_pool_ratio == 0.05
        assert qa.boundary_pool_ratio == 0.05

    def test_qa_pool_ratios_sum_to_one(self) -> None:
        qa = PROFILES["qa"]
        total = qa.node_pool_ratio + qa.edge_pool_ratio + qa.boundary_pool_ratio
        assert abs(total - 1.0) < 1e-9

    def test_qa_compute_pools(self) -> None:
        """Node pool should be 3600, edge 200, boundary 200."""
        qa = PROFILES["qa"]
        node_pool = int(qa.max_tokens * qa.node_pool_ratio)
        edge_pool = int(qa.max_tokens * qa.edge_pool_ratio)
        boundary_pool = int(qa.max_tokens * qa.boundary_pool_ratio)
        assert node_pool == 3_600
        assert edge_pool == 200
        assert boundary_pool == 200

    def test_qa_lod_biases(self) -> None:
        qa = PROFILES["qa"]
        assert qa.lod_0_bias == 1.2  # Prefer verbatim for top-scoring nodes
        assert qa.lod_1_bias == 0.9
        assert qa.lod_2_bias == 1.0
