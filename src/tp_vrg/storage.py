"""
Storage backend abstraction layer.

Defines the StorageBackend protocol and an InMemoryBackend implementation
using NetworkX + dict. Future backends (EdgeHDF5, etc.) implement the
same protocol without subclassing.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol, runtime_checkable

import networkx as nx
import numpy as np

from tp_vrg.centrality import compute_backbone_centrality
from tp_vrg.models import EdgeData, NodeData, SourcePassage


class StorageInitError(RuntimeError):
    """Raised when a StorageBackend cannot initialize cleanly.

    Per [[the pipeline invariant policy]] INV-2 (fail-loud) +
    [[docs/diagnostics/2026-05-14-cockpit-substrate-coherent-reframe.md]] §3 +
    [[GOTCHAS.md]] entry "/health wedge after backbone-load (2026-05-17)":
    storage init failures must raise rather than silently fall back to
    an alternate backend. Silent fallback masks the underlying issue
    (file lock, permission, schema mismatch, path misconfig) and produces
    "data that looks valid" — the most expensive failure mode because it
    propagates.

    Operator response: fix the underlying issue (check ~/.tp_vrg/internal/graph.db
    file permissions, lock contention, schema version compatibility),
    then restart the daemon. Do NOT add an exception handler that swallows
    this — that re-introduces the bug class.
    """


@runtime_checkable
class StorageBackend(Protocol):
    """Interface for graph storage backends."""

    def upsert_node(self, node: NodeData) -> None: ...
    def upsert_edge(self, edge: EdgeData) -> None: ...
    def upsert_edges_bulk(self, edges: list[EdgeData]) -> None: ...
    def delete_node(self, entity_id: str) -> bool: ...
    def begin_batch(self) -> None: ...
    def commit_batch(self) -> None: ...
    def rollback_batch(self) -> None: ...
    def get_node(self, entity_id: str) -> NodeData | None: ...
    def get_all_nodes(self) -> dict[str, NodeData]: ...
    def get_node_index(self) -> dict[str, str]: ...
    def get_nodes(self, ids: list[str]) -> dict[str, NodeData]: ...
    def get_neighbors(self, entity_id: str) -> list[str]: ...
    def get_neighbors_with_relations(self, entity_id: str) -> list[tuple[str, str]]:
        """Return (neighbor_entity_id, relation) for all edges touching entity_id."""
        ...
    def exact_name_match(self, name: str) -> set[str]:
        """Return entity_ids where node.name matches exactly (case-insensitive)."""
        ...
    def get_all_edges(self) -> list[tuple[str, str, dict]]: ...
    def node_count(self) -> int: ...
    def edge_count(self) -> int: ...
    def shortest_path_lengths(self, source: str) -> dict[str, int]: ...
    def bounded_neighborhood(self, source_ids: list[str], max_hops: int = 5) -> dict[str, int]: ...
    def betweenness_centrality(self) -> dict[str, float]: ...
    def get_backbone(self) -> dict[str, float]: ...
    def get_backbone_measure(self) -> str | None: ...
    def get_top_backbone_nodes(self, limit: int = 3) -> list[str]: ...
    def vector_search(
        self, query_embedding: np.ndarray, top_k: int = 5
    ) -> list[tuple[str, float]]: ...
    def passage_vector_search(
        self, query_embedding: np.ndarray, top_k: int = 10
    ) -> list[tuple[str, float]]: ...
    def save_question_embeddings(
        self, passage_id: str, question_vectors: list[np.ndarray]
    ) -> None: ...
    def save_question_embeddings_bulk(
        self, passage_id: str, question_vectors: list[np.ndarray]
    ) -> None: ...
    def question_vector_search(
        self, query_embedding: np.ndarray, top_k: int = 10
    ) -> list[tuple[str, float]]: ...
    def save_sentence_embeddings_bulk(
        self, passage_id: str, sentence_vectors: list[np.ndarray]
    ) -> None: ...
    def sentence_vector_search(
        self, query_embedding: np.ndarray, top_k: int = 10
    ) -> list[tuple[str, float]]: ...
    def sentence_vector_search_detailed(
        self, query_embedding: np.ndarray, top_k: int = 10
    ) -> list[tuple[str, int, float]]: ...
    def save_sentence_profiles_bulk(
        self,
        passage_id: str,
        profiles: list[tuple[str, int, list[str], list[str], list[str]]],
    ) -> None: ...
    def get_sentence_profiles_batch(
        self, sentence_hashes: list[str]
    ) -> dict[str, tuple[list[str], list[str], list[str]]]: ...
    def get_passages_without_profiles(self) -> list[tuple[str, str]]: ...
    def upsert_passage(self, passage: SourcePassage) -> None: ...
    def get_passage(self, passage_id: str) -> SourcePassage | None: ...
    def get_passages_batch(self, passage_ids: list[str]) -> dict[str, SourcePassage]: ...
    def get_passages_for_entity(self, entity_id: str) -> list[SourcePassage]: ...
    def get_similarity_passage_neighbors(
        self,
        passage_ids: list[str],
        *,
        limit_per_source: int = 3,
        weight: float = 0.35,
    ) -> dict[str, list[tuple[str, float, int]]]: ...
    def passage_count(self) -> int: ...
    def get_all_passages(self) -> dict[str, SourcePassage]: ...
    def get_passage_entity_map(self) -> dict[str, list[str]]: ...
    def get_asset_ids_for_passages(self, passage_ids: list[str]) -> dict[str, str | None]: ...
    def get_passage_ids_for_assets(
        self, asset_ids: list[str], *, limit_per_asset: int = 3
    ) -> dict[str, list[str]]: ...
    def asset_count(self) -> int: ...
    def backfill_assets_by_source_document(self) -> dict[str, int]: ...
    def get_node_timestamps(self) -> dict[str, str]: ...
    def rebuild_neighborhood_cache(self) -> int: ...
    def get_cached_neighborhoods(self, entity_ids: set[str]) -> dict[str, float]: ...
    def is_neighborhood_cache_clean(self) -> bool: ...
    def mark_neighborhood_dirty(self) -> None: ...
    def save(self, path: str | Path) -> None: ...
    def load(self, path: str | Path) -> None: ...


class InMemoryBackend:
    """
    In-memory storage using NetworkX for graph topology and a dict
    for node data. Persistence via JSON serialization.
    """

    def __init__(self) -> None:
        self._graph: nx.DiGraph = nx.DiGraph()
        self._nodes: dict[str, NodeData] = {}
        self._passages: dict[str, SourcePassage] = {}
        self._timestamps: dict[str, str] = {}  # entity_id -> ISO created_at
        self._neighborhood_cache: dict[str, dict[str, float]] = {}
        self._neighborhood_cache_clean: bool = False

    def upsert_node(self, node: NodeData) -> None:
        self._nodes[node.entity_id] = node
        self._graph.add_node(
            node.entity_id, name=node.name, category=node.category
        )
        # Track creation time; preserve existing timestamp on updates
        if node.entity_id not in self._timestamps:
            self._timestamps[node.entity_id] = datetime.now(timezone.utc).strftime(
                "%Y-%m-%d %H:%M:%S"
            )
        self.mark_neighborhood_dirty()

    def begin_batch(self) -> None:
        """No-op for InMemoryBackend — all operations are instantly visible."""
        pass

    def commit_batch(self) -> None:
        """No-op for InMemoryBackend."""
        pass

    def rollback_batch(self) -> None:
        """No-op for InMemoryBackend — rollback is not supported in-memory."""
        pass

    def upsert_edge(self, edge: EdgeData) -> None:
        if edge.source not in self._nodes or edge.target not in self._nodes:
            return
        self._graph.add_edge(
            edge.source,
            edge.target,
            relation=edge.relation,
            weight=edge.weight,
        )
        self.mark_neighborhood_dirty()

    def upsert_edges_bulk(self, edges: list[EdgeData]) -> None:
        for edge in edges:
            self.upsert_edge(edge)

    def delete_node(self, entity_id: str) -> bool:
        """Delete a node and all its edges from the in-memory graph.

        NetworkX remove_node() automatically removes all incident edges.
        Returns True if node existed and was deleted, False otherwise.
        """
        if entity_id not in self._nodes:
            return False
        del self._nodes[entity_id]
        self._graph.remove_node(entity_id)
        self._timestamps.pop(entity_id, None)
        self.mark_neighborhood_dirty()
        return True

    def get_node(self, entity_id: str) -> NodeData | None:
        return self._nodes.get(entity_id)

    def get_all_nodes(self) -> dict[str, NodeData]:
        return dict(self._nodes)

    def get_node_index(self) -> dict[str, str]:
        """Return {entity_id: category} for normalization seeding."""
        return {eid: node.category for eid, node in self._nodes.items()}

    def get_nodes(self, ids: list[str]) -> dict[str, NodeData]:
        """Batch fetch nodes by ID. Missing IDs are silently omitted."""
        return {eid: self._nodes[eid] for eid in ids if eid in self._nodes}

    def get_neighbors(self, entity_id: str) -> list[str]:
        """Return all adjacent nodes (successors + predecessors) to match SQLite behaviour."""
        if entity_id not in self._graph:
            return []
        return list(
            set(self._graph.successors(entity_id)) | set(self._graph.predecessors(entity_id))
        )

    def get_neighbors_with_relations(self, entity_id: str) -> list[tuple[str, str]]:
        """Return (neighbor_id, relation) for all edges touching entity_id."""
        if entity_id not in self._graph:
            return []
        result: list[tuple[str, str]] = []
        for _, target, data in self._graph.out_edges(entity_id, data=True):
            result.append((target, data.get("relation", "")))
        for source, _, data in self._graph.in_edges(entity_id, data=True):
            result.append((source, data.get("relation", "")))
        return result

    def exact_name_match(self, name: str) -> set[str]:
        """Return entity_ids where node.name matches exactly (case-insensitive)."""
        lower = name.lower()
        return {eid for eid, node in self._nodes.items() if node.name.lower() == lower}

    def get_all_edges(self) -> list[tuple[str, str, dict]]:
        return list(self._graph.edges(data=True))

    def node_count(self) -> int:
        return len(self._nodes)

    def edge_count(self) -> int:
        return self._graph.number_of_edges()

    def shortest_path_lengths(self, source: str) -> dict[str, int]:
        """BFS over undirected view so distances match the SQLite UNION traversal."""
        if source not in self._graph:
            return {}
        return dict(
            nx.single_source_shortest_path_length(self._graph.to_undirected(), source)
        )

    def bounded_neighborhood(
        self, source_ids: list[str], max_hops: int = 5
    ) -> dict[str, int]:
        """BFS from multiple sources up to max_hops over undirected topology."""
        if not source_ids:
            return {}
        graph = self._graph.to_undirected()
        distances: dict[str, int] = {}
        for source in source_ids:
            if source not in graph:
                continue
            hops = nx.single_source_shortest_path_length(graph, source, cutoff=max_hops)
            for target, dist in hops.items():
                if target not in distances or dist < distances[target]:
                    distances[target] = dist
        return distances

    def betweenness_centrality(self) -> dict[str, float]:
        if self._graph.number_of_nodes() == 0:
            return {}
        _, centralities = compute_backbone_centrality(self._graph)
        return centralities

    def get_backbone(self) -> dict[str, float]:
        """InMemoryBackend has no persistent cache — always compute on demand."""
        return self.betweenness_centrality()

    def get_backbone_measure(self) -> str | None:
        """Return the active backbone centrality measure for this process."""
        from tp_vrg.centrality import get_active_centrality_measure

        return get_active_centrality_measure()

    def get_top_backbone_nodes(self, limit: int = 3) -> list[str]:
        """Return top-N entity_ids by backbone centrality (SP-2 Backbone Orbit)."""
        centralities = self.betweenness_centrality()
        if not centralities:
            return []
        sorted_ids = sorted(centralities, key=lambda eid: centralities[eid], reverse=True)
        return sorted_ids[:limit]

    def vector_search(
        self, query_embedding: np.ndarray, top_k: int = 5
    ) -> list[tuple[str, float]]:
        """Find the top-k most similar nodes by cosine similarity."""
        scored: list[tuple[str, float]] = []
        query_norm = np.linalg.norm(query_embedding)
        if query_norm == 0:
            return []

        for eid, node in self._nodes.items():
            if node.embedding is None:
                continue
            node_emb = np.array(node.embedding, dtype=np.float32)
            node_norm = np.linalg.norm(node_emb)
            if node_norm == 0:
                continue
            sim = float(np.dot(query_embedding, node_emb) / (query_norm * node_norm))
            scored.append((eid, sim))

        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:top_k]

    def passage_vector_search(
        self, query_embedding: np.ndarray, top_k: int = 10
    ) -> list[tuple[str, float]]:
        """Find the top-k most similar passages by cosine similarity.

        Brute-force over passages that have embeddings set. Returns
        (passage_id, similarity) pairs sorted by similarity descending.
        Returns empty list if no passages have embeddings (backward-compat).
        """
        scored: list[tuple[str, float]] = []
        query_norm = np.linalg.norm(query_embedding)
        if query_norm == 0:
            return []

        for pid, passage in self._passages.items():
            if passage.embedding is None:
                continue
            p_emb = np.array(passage.embedding, dtype=np.float32)
            p_norm = np.linalg.norm(p_emb)
            if p_norm == 0:
                continue
            sim = float(np.dot(query_embedding, p_emb) / (query_norm * p_norm))
            scored.append((pid, sim))

        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:top_k]

    def get_node_timestamps(self) -> dict[str, str]:
        """Return {entity_id: created_at_iso} for all tracked nodes."""
        return dict(self._timestamps)

    def rebuild_neighborhood_cache(self) -> int:
        """Build a 2-hop neighborhood cache excluding structural relations."""
        from tp_vrg.models import STRUCTURAL_RELATIONS

        graph = nx.Graph()
        graph.add_nodes_from(self._graph.nodes())
        for src, tgt, meta in self._graph.edges(data=True):
            if meta.get("relation", "") in STRUCTURAL_RELATIONS:
                continue
            graph.add_edge(src, tgt)

        cache: dict[str, dict[str, float]] = {}
        rows = 0
        for source in graph.nodes():
            dists = nx.single_source_shortest_path_length(graph, source, cutoff=2)
            nbrs: dict[str, float] = {}
            for target, hop in dists.items():
                if target == source or hop < 1 or hop > 2:
                    continue
                nbrs[target] = 1.0 if hop == 1 else 0.6
            cache[source] = nbrs
            rows += len(nbrs)

        self._neighborhood_cache = cache
        self._neighborhood_cache_clean = True
        return rows

    def get_cached_neighborhoods(self, entity_ids: set[str]) -> dict[str, float]:
        if not entity_ids or not self._neighborhood_cache_clean:
            return {}
        merged: dict[str, float] = {}
        for source in entity_ids:
            for target, score in self._neighborhood_cache.get(source, {}).items():
                if score > merged.get(target, 0.0):
                    merged[target] = score
        return merged

    def is_neighborhood_cache_clean(self) -> bool:
        return self._neighborhood_cache_clean

    def mark_neighborhood_dirty(self) -> None:
        self._neighborhood_cache_clean = False
        self._neighborhood_cache = {}

    def save_question_embeddings(
        self, passage_id: str, question_vectors: list[np.ndarray]
    ) -> None:
        """Store HyPE-lite question embeddings for a passage (in-memory: no-op)."""
        pass

    def save_question_embeddings_bulk(
        self, passage_id: str, question_vectors: list[np.ndarray]
    ) -> None:
        """Bulk variant alias for API parity (in-memory: no-op)."""
        self.save_question_embeddings(passage_id, question_vectors)

    def question_vector_search(
        self, query_embedding: np.ndarray, top_k: int = 10
    ) -> list[tuple[str, float]]:
        """Find passages via question-embedding similarity (in-memory: not implemented)."""
        return []

    def save_sentence_embeddings_bulk(
        self, passage_id: str, sentence_vectors: list[np.ndarray]
    ) -> None:
        """Store sentence embeddings (in-memory: no-op)."""
        pass

    def sentence_vector_search(
        self, query_embedding: np.ndarray, top_k: int = 10
    ) -> list[tuple[str, float]]:
        """Find passages via sentence-embedding similarity (in-memory: not implemented)."""
        return []

    def sentence_vector_search_detailed(
        self, query_embedding: np.ndarray, top_k: int = 10
    ) -> list[tuple[str, int, float]]:
        """Detailed sentence hits (in-memory: not implemented)."""
        return []

    # -- Passage storage -------------------------------------------------------

    def save_sentence_profiles_bulk(
        self,
        passage_id: str,
        profiles: list[tuple[str, int, list[str], list[str], list[str]]],
    ) -> None:
        # In-memory: store in a dict for test compatibility
        if not hasattr(self, "_sentence_profiles"):
            self._sentence_profiles: dict[str, tuple[list[str], list[str], list[str]]] = {}
        for h, _idx, ents, pos, lem in profiles:
            self._sentence_profiles[h] = (ents, pos, lem)

    def get_sentence_profiles_batch(
        self, sentence_hashes: list[str]
    ) -> dict[str, tuple[list[str], list[str], list[str]]]:
        if not hasattr(self, "_sentence_profiles"):
            return {}
        return {h: self._sentence_profiles[h] for h in sentence_hashes if h in self._sentence_profiles}

    def get_passages_without_profiles(self) -> list[tuple[str, str]]:
        if not hasattr(self, "_sentence_profiles"):
            return [(p.passage_id, p.raw_text) for p in self._passages.values()]
        profiled = {h for h in self._sentence_profiles}
        # Approximate: return all passages (janitor will re-check)
        return [(p.passage_id, p.raw_text) for p in self._passages.values()]

    def upsert_passage(self, passage: SourcePassage) -> None:
        self._passages[passage.passage_id] = passage

    def get_passage(self, passage_id: str) -> SourcePassage | None:
        return self._passages.get(passage_id)

    def get_passages_batch(self, passage_ids: list[str]) -> dict[str, SourcePassage]:
        # Delegate to get_passage() so monkeypatches in tests are respected.
        result: dict[str, SourcePassage] = {}
        for pid in passage_ids:
            p = self.get_passage(pid)
            if p is not None:
                result[pid] = p
        return result

    def get_passages_for_entity(self, entity_id: str) -> list[SourcePassage]:
        return [
            p for p in self._passages.values()
            if entity_id in p.entity_ids
        ]

    def get_similarity_passage_neighbors(
        self,
        passage_ids: list[str],
        *,
        limit_per_source: int = 3,
        weight: float = 0.35,
    ) -> dict[str, list[tuple[str, float, int]]]:
        del limit_per_source, weight
        return {passage_id: [] for passage_id in passage_ids}

    def passage_count(self) -> int:
        return len(self._passages)

    def get_all_passages(self) -> dict[str, SourcePassage]:
        return dict(self._passages)

    def get_passage_entity_map(self) -> dict[str, list[str]]:
        """Return {passage_id: [entity_ids]} without loading raw_text."""
        return {pid: list(p.entity_ids) for pid, p in self._passages.items()}

    def get_asset_ids_for_passages(self, passage_ids: list[str]) -> dict[str, str | None]:
        return {
            pid: (self._passages.get(pid).asset_id if pid in self._passages else None)
            for pid in passage_ids
        }

    def get_passage_ids_for_assets(
        self, asset_ids: list[str], *, limit_per_asset: int = 3
    ) -> dict[str, list[str]]:
        result: dict[str, list[str]] = {}
        limit = max(1, int(limit_per_asset))
        for asset_id in dict.fromkeys(asset_ids):
            result[asset_id] = [
                passage.passage_id
                for passage in sorted(self._passages.values(), key=lambda p: p.passage_id)
                if passage.asset_id == asset_id
            ][:limit]
        return result

    def asset_count(self) -> int:
        return len({p.asset_id for p in self._passages.values() if p.asset_id})

    def backfill_assets_by_source_document(self) -> dict[str, int]:
        import hashlib
        import re

        groups: dict[str, list[SourcePassage]] = {}
        for passage in self._passages.values():
            label = (passage.source_label or "").strip()
            group = (
                re.sub(r"\s*\[chunk-\d+\]\s*$", "", label).strip()
                or "__missing_source_label__"
            )
            groups.setdefault(group, []).append(passage)

        for group, passages in groups.items():
            digest = hashlib.sha256(group.encode("utf-8")).hexdigest()[:16]
            asset_id = f"asset:{digest}"
            for passage in passages:
                passage.asset_id = asset_id

        return {
            "assets": len(groups),
            "passages_updated": len(self._passages),
            "asset_entities": sum(len(p.entity_ids) for p in self._passages.values()),
            "edge_provenance": 0,
        }

    @property
    def graph(self) -> nx.DiGraph:
        """Expose the raw NetworkX graph for advanced queries."""
        return self._graph

    def save(self, path: str | Path) -> None:
        data = {
            "nodes": [n.model_dump() for n in self._nodes.values()],
            "edges": [
                {
                    "source": u,
                    "target": v,
                    "relation": d["relation"],
                    "weight": d.get("weight", 1.0),
                }
                for u, v, d in self._graph.edges(data=True)
            ],
            "passages": [p.model_dump() for p in self._passages.values()],
        }
        Path(path).write_text(json.dumps(data, indent=2), encoding="utf-8")

    def load(self, path: str | Path) -> None:
        data = json.loads(Path(path).read_text(encoding="utf-8"))

        for node_data in data["nodes"]:
            node = NodeData(**node_data)
            self.upsert_node(node)

        for edge_data in data["edges"]:
            edge = EdgeData(**edge_data)
            self.upsert_edge(edge)

        for passage_data in data.get("passages", []):
            passage = SourcePassage(**passage_data)
            self.upsert_passage(passage)
