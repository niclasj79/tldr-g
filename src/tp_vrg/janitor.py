"""
Janitor V0.1 — Graph maintenance and remediation.

The Janitor is a background maintenance process that:
1. Task "Shred":    Finds and retroactively re-chunks oversized LOD0 nodes
2. Task "Polish":   Generates unique per-chunk LOD1 summaries to replace inherited ones
3. Task "Backbone": Pre-computes betweenness centrality cache
4. Task "Merge":    Detects and merges duplicate entities by embedding similarity
5. Task "Stitch":   Retroactively applies Layer 0 + Layer 2 stitching edges to existing
                    passages — "upload once, improve forever" (strategy.md principle #7).
                    Layer 0: groups session passages by source_label family, sorts
                    chronologically, creates _session_follows edges.
                    Layer 2: sliding-window _follows edges from entity_ids order.
                    Idempotent — safe to run repeatedly.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import os
from dataclasses import dataclass
import time

import numpy as np

from tp_vrg.models import CHUNK_MAX_CHARS, MERGE_COSINE_THRESHOLD, EdgeData, NodeData
from tp_vrg.progress import progress
from tp_vrg.repo_doc_ingest import REPO_INGEST_TASK
from tp_vrg.storage import StorageBackend

# Retroactive Layer 2 stitching: approximate chunk size in entity_ids space.
# A chunk of ~500 tokens typically produces 3-7 entities. Using 5 as the window
# gives reasonable chunk boundary approximation from entity extraction order.
_STITCH_WINDOW_SIZE: int = 5
_BAKE_PARTITIONS_TASK: str = "bake_partitions"
_BAKE_SIMILARITY_EDGES_TASK: str = "bake_similarity_edges"
_BACKFILL_NODE_PROVENANCE_TASK: str = "backfill_node_provenance"


@dataclass
class JanitorReport:
    """Summary of Janitor work."""

    task_name: str
    nodes_scanned: int
    nodes_affected: int
    nodes_modified: int
    errors: list[str] = None

    def __post_init__(self):
        if self.errors is None:
            self.errors = []

    def __str__(self) -> str:
        return (
            f"JanitorReport(task={self.task_name}, scanned={self.nodes_scanned}, "
            f"affected={self.nodes_affected}, modified={self.nodes_modified}, "
            f"errors={len(self.errors)})"
        )


class GraphJanitor:
    """
    Background maintenance for TP-VRG knowledge graphs.

    Performs graph maintenance tasks:
    1. Shred:    Retroactively chunks oversized LOD0 nodes (>CHUNK_MAX_CHARS)
    2. Polish:   Generates unique per-chunk LOD1 summaries for chunk nodes
    3. Backbone: Pre-computes betweenness centrality cache
    4. Merge:    Detects and merges duplicate entities by embedding similarity
    5. Stitch:   Retroactively applies stitching edges (Layer 0 + Layer 2)
    6. Temporal: Extracts dates, creates TEMPORAL_ANCHOR nodes + edges (F14)
    7. FTS5 Sync Repair: Removes orphan full-text index rows.
    8. Integrity Verify: Runs full SQLite integrity verification and caches result.
    9. Repo-doc ingest: Ingests changed repo docs through the canonical ingest path.
    10. Similarity-edge bake: writes bounded sibling similarity_edges.
    11. Node provenance backfill: repairs the source-cascade reverse index.
    """

    def __init__(self, memory, dry_run: bool = False) -> None:
        """
        Initialize Janitor.

        Args:
            memory: LODGraphMemory instance (has _llm, _embedder, _storage)
            dry_run: If True, report what would be done without modifying graph
        """
        self.memory = memory
        self._storage = memory._storage
        self._llm = memory._llm
        self._embedder = memory._embedder
        self.dry_run = dry_run

    async def scan(self) -> JanitorReport:
        """
        Dry-run scan: identify what the Janitor would fix.

        Returns report without modifying the graph.
        """
        # Contract C8 (pipeline-contracts.md): this scans storage synchronously;
        # keep the public async API from blocking whichever loop calls it.
        return await asyncio.to_thread(self._scan_sync)

    def _scan_sync(self) -> JanitorReport:
        self.dry_run = True
        report = JanitorReport(
            task_name="scan",
            nodes_scanned=0,
            nodes_affected=0,
            nodes_modified=0,
        )

        try:
            nodes_dict = self._storage.get_all_nodes()
            report.nodes_scanned = len(nodes_dict) if isinstance(nodes_dict, dict) else 0

            # Fetch actual NodeData objects from the dict
            for node_id in (nodes_dict.keys() if isinstance(nodes_dict, dict) else []):
                node = self._storage.get_node(node_id)
                if node:
                    if len(node.lod_0) > CHUNK_MAX_CHARS and not node.is_chunk:
                        report.nodes_affected += 1

                    if node.is_chunk and not node.refined:
                        report.nodes_affected += 1

        except Exception as e:
            report.errors.append(f"Scan failed: {str(e)}")

        return report

    async def shred(self, dry_run: bool = False) -> JanitorReport:
        """
        Task 1: Retroactively chunk and re-ingest oversized LOD0 nodes.

        Process:
        1. Find all nodes with len(lod_0) > CHUNK_MAX_CHARS
        2. Re-chunk using DeterministicChunker
        3. Re-ingest each chunk via engine.add_memory() (this handles entity extraction)
        4. Tombstone the original oversized node

        Args:
            dry_run: If True, report what would be done without modifying

        Returns:
            JanitorReport with statistics
        """
        from tp_vrg.chunker import DeterministicChunker

        report = JanitorReport(
            task_name="shred",
            nodes_scanned=0,
            nodes_affected=0,
            nodes_modified=0,
        )

        try:
            # Contract C8 (pipeline-contracts.md): the graph-wide oversized-node
            # scan is synchronous storage work, so perform it off the event loop.
            report, oversized = await asyncio.to_thread(
                self._find_oversized_nodes_for_shred_sync
            )

            if dry_run:
                return report

            total = len(oversized)
            for idx, node in enumerate(oversized, 1):
                try:
                    original_size = len(node.lod_0)
                    # Chunk the oversized node
                    chunks = await asyncio.to_thread(
                        DeterministicChunker.chunk,
                        node.lod_0,
                    )

                    # Progress indicator
                    print(f"[{idx:2d}/{total}] Shredding '{node.entity_id[:30]}' ({original_size:5d}c -> {len(chunks):2d} chunks)", flush=True)

                    # Re-ingest each chunk (this will create child nodes + edges)
                    for chunk_idx, chunk_text in enumerate(chunks, 1):
                        await self.memory.add_memory(chunk_text, source=f"janitor-shred:{node.entity_id}[{chunk_idx}]")

                    # Tombstone the original: clear LOD0, mark as processed
                    await asyncio.to_thread(
                        self._tombstone_shredded_node_sync,
                        node,
                        original_size,
                        len(chunks),
                    )

                    report.nodes_modified += 1

                except Exception as e:
                    report.errors.append(f"Failed to shred {node.entity_id}: {str(e)}")

        except Exception as e:
            report.errors.append(f"Shred task failed: {str(e)}")

        return report

    def _find_oversized_nodes_for_shred_sync(
        self,
    ) -> tuple[JanitorReport, list[NodeData]]:
        report = JanitorReport(
            task_name="shred",
            nodes_scanned=0,
            nodes_affected=0,
            nodes_modified=0,
        )
        nodes_dict = self._storage.get_all_nodes()
        report.nodes_scanned = len(nodes_dict) if isinstance(nodes_dict, dict) else 0

        oversized = []
        for node_id in (nodes_dict.keys() if isinstance(nodes_dict, dict) else []):
            node = self._storage.get_node(node_id)
            if node and len(node.lod_0) > CHUNK_MAX_CHARS and not node.is_chunk:
                oversized.append(node)

        report.nodes_affected = len(oversized)
        return report, oversized

    def _tombstone_shredded_node_sync(
        self,
        node: NodeData,
        original_size: int,
        chunk_count: int,
    ) -> None:
        node.lod_0 = ""
        node.lod_1 = (
            f"[Shredded: was {original_size} chars, "
            f"re-chunked into {chunk_count} chunks]"
        )
        node.lod_2 = f"{node.name} [chunked]"
        self._storage.upsert_node(node)

    async def polish(self, dry_run: bool = False) -> JanitorReport:
        """
        Task 2: Generate unique per-chunk LOD1 summaries.

        Process:
        1. Find chunk nodes where refined=False (still using inherited LOD1)
        2. Call LLM to generate unique summary for each chunk's LOD0
        3. Update node.lod_1 and set refined=True
        4. Batch calls to LLM for efficiency

        Args:
            dry_run: If True, report what would be done without modifying

        Returns:
            JanitorReport with statistics
        """
        report = JanitorReport(
            task_name="polish",
            nodes_scanned=0,
            nodes_affected=0,
            nodes_modified=0,
        )
        try:
            # Contract C8 (pipeline-contracts.md): the graph-wide unrefined-node
            # scan is synchronous storage work, so perform it off the event loop.
            report, unrefined = await asyncio.to_thread(
                self._find_unrefined_chunks_for_polish_sync
            )

            if dry_run:
                return report

            # Process each chunk
            for node in unrefined:
                try:
                    # Generate unique LOD1 for this chunk
                    summary = await self._llm.summarize(node.lod_0, target_sentences=2)

                    # Update node
                    await asyncio.to_thread(
                        self._update_polished_node_sync,
                        node,
                        summary,
                    )

                    report.nodes_modified += 1

                except Exception as e:
                    report.errors.append(f"Failed to polish {node.entity_id}: {str(e)}")

        except Exception as e:
            report.errors.append(f"Polish task failed: {str(e)}")

        return report

    def _find_unrefined_chunks_for_polish_sync(
        self,
    ) -> tuple[JanitorReport, list[NodeData]]:
        report = JanitorReport(
            task_name="polish",
            nodes_scanned=0,
            nodes_affected=0,
            nodes_modified=0,
        )
        nodes_dict = self._storage.get_all_nodes()
        report.nodes_scanned = len(nodes_dict) if isinstance(nodes_dict, dict) else 0

        unrefined = []
        for node_id in (nodes_dict.keys() if isinstance(nodes_dict, dict) else []):
            node = self._storage.get_node(node_id)
            if node and node.is_chunk and not node.refined:
                unrefined.append(node)

        report.nodes_affected = len(unrefined)
        return report, unrefined

    def _update_polished_node_sync(self, node: NodeData, summary: str) -> None:
        node.lod_1 = summary
        node.refined = True
        self._storage.upsert_node(node)

    async def run_backbone(self, dry_run: bool = False) -> JanitorReport:
        """
        Task 3: Pre-compute and cache betweenness centrality in the backbone table.

        This moves the O(V*E) centrality computation from query-time to background,
        so every subsequent get_context() call can read from the cache rather than
        recomputing it. Only meaningful for SQLiteBackend — other backends fall back
        to on-the-fly computation gracefully.

        Args:
            dry_run: If True, report edge/node counts without writing to the DB.

        Returns:
            JanitorReport with nodes_scanned = node count, nodes_modified = 1 if
            backbone was written.
        """
        # Contract C8 (pipeline-contracts.md): backbone computation builds a
        # NetworkX graph and must not run on the asyncio event loop thread.
        return await asyncio.to_thread(self._run_backbone_sync, dry_run)

    def _run_backbone_sync(self, dry_run: bool = False) -> JanitorReport:
        report = JanitorReport(
            task_name="backbone",
            nodes_scanned=0,
            nodes_affected=0,
            nodes_modified=0,
        )

        try:
            nodes_dict = self._storage.get_all_nodes()
            report.nodes_scanned = len(nodes_dict)
            report.nodes_affected = report.nodes_scanned  # all nodes get a centrality score

            if dry_run:
                return report

            if not hasattr(self._storage, "calculate_backbone"):
                report.errors.append(
                    "Storage backend does not support calculate_backbone(); "
                    "backbone task is only available with SQLiteBackend."
                )
                return report

            progress.emit("janitor", message=f"Computing backbone centrality ({report.nodes_scanned} nodes)...")
            centralities = self._storage.calculate_backbone()
            report.nodes_modified = len(centralities)
            progress.emit("janitor", message=f"Backbone complete — {len(centralities)} centralities cached")

        except Exception as e:
            report.errors.append(f"Backbone task failed: {str(e)}")

        return report

    async def run_neighborhood_cache(self, dry_run: bool = False) -> JanitorReport:
        """Task: pre-compute and cache 2-hop semantic neighborhoods."""
        # Contract C8 (pipeline-contracts.md): cache rebuild is graph-wide SQL
        # work and must not run on the asyncio event loop thread.
        return await asyncio.to_thread(self._run_neighborhood_cache_sync, dry_run)

    def _run_neighborhood_cache_sync(self, dry_run: bool = False) -> JanitorReport:
        report = JanitorReport(
            task_name="neighborhood_cache",
            nodes_scanned=0,
            nodes_affected=0,
            nodes_modified=0,
        )

        try:
            nodes_dict = self._storage.get_all_nodes()
            report.nodes_scanned = len(nodes_dict)
            report.nodes_affected = report.nodes_scanned

            if dry_run:
                return report

            if not hasattr(self._storage, "rebuild_neighborhood_cache"):
                report.errors.append(
                    "Storage backend does not support rebuild_neighborhood_cache()."
                )
                return report

            report.nodes_modified = self._storage.rebuild_neighborhood_cache()
        except Exception as e:
            report.errors.append(f"Neighborhood cache task failed: {str(e)}")

        return report

    async def find_merge_candidates(
        self,
        threshold: float = MERGE_COSINE_THRESHOLD,
    ) -> list[tuple[str, str, float]]:
        """Find entity pairs that are merge candidates.

        Returns list of (survivor_id, duplicate_id, cosine_similarity) tuples.
        A pair qualifies if:
          1. cosine(embedding_a, embedding_b) >= threshold
          2. category matches (same entity type)
          3. Neither is a chunk node (is_chunk=False for both)

        Survivor = longer LOD_0. If equal length, alphabetically first entity_id.
        """
        # Contract C8 (pipeline-contracts.md): body is O(V) × vector_search — must
        # not run on the asyncio event loop thread. Offload to a worker thread so
        # callers from async handlers (e.g. /janitor/status) stay responsive.
        return await asyncio.to_thread(self._find_merge_candidates_sync, threshold)

    def _find_merge_candidates_sync(
        self,
        threshold: float,
    ) -> list[tuple[str, str, float]]:
        nodes = self._storage.get_all_nodes()
        # Filter to non-chunk nodes with embeddings
        candidates: list[NodeData] = []
        for node in nodes.values():
            if node.is_chunk:
                continue
            if node.embedding is None:
                continue
            candidates.append(node)

        if len(candidates) < 2:
            return []

        # For each node, search for similar nodes
        seen_pairs: set[tuple[str, str]] = set()
        merge_pairs: list[tuple[str, str, float]] = []

        for node in candidates:
            emb = np.array(node.embedding, dtype=np.float32)
            # top_k=6: one will be itself, need at least 5 others
            results = self._storage.vector_search(emb, top_k=6)

            for other_id, similarity in results:
                if other_id == node.entity_id:
                    continue
                if similarity < threshold:
                    continue

                # Canonical ordering to avoid (A,B) and (B,A) duplicates
                pair_key = tuple(sorted([node.entity_id, other_id]))
                if pair_key in seen_pairs:
                    continue
                seen_pairs.add(pair_key)

                # Check: same category, not a chunk
                other = self._storage.get_node(other_id)
                if other is None or other.is_chunk:
                    continue
                if node.category != other.category:
                    continue

                # Determine survivor: longer LOD_0, or alphabetically first
                a, b = node, other
                if len(b.lod_0) > len(a.lod_0) or (
                    len(b.lod_0) == len(a.lod_0) and b.entity_id < a.entity_id
                ):
                    a, b = b, a
                merge_pairs.append((a.entity_id, b.entity_id, similarity))

        # Sort by similarity descending
        merge_pairs.sort(key=lambda x: x[2], reverse=True)
        return merge_pairs

    async def merge(self, dry_run: bool = False) -> JanitorReport:
        """Task 4: Merge duplicate entities.

        For each candidate pair (survivor, duplicate):
        1. Redirect all duplicate's edges to survivor
        2. Delete duplicate node
        3. Report results

        Args:
            dry_run: If True, report candidates without modifying graph

        Returns:
            JanitorReport with merge statistics
        """
        report = JanitorReport(
            task_name="merge",
            nodes_scanned=0,
            nodes_affected=0,
            nodes_modified=0,
        )

        try:
            report.nodes_scanned = await asyncio.to_thread(self._storage.node_count)
            progress.emit("janitor", message="Scanning for merge candidates...")
            candidates = await self.find_merge_candidates()
            report.nodes_affected = len(candidates)
            progress.emit("janitor", message=f"Found {len(candidates)} merge candidates")

            if dry_run or not candidates:
                return report

            # Contract C8 (pipeline-contracts.md): candidate discovery already
            # yields via find_merge_candidates(); the actual merge writes are
            # synchronous storage work and must also stay off the event loop.
            return await asyncio.to_thread(
                self._merge_candidates_sync,
                candidates,
                report,
            )

        except Exception as e:
            report.errors.append(f"Merge task failed: {e}")

        return report

    def _merge_candidates_sync(
        self,
        candidates: list[tuple[str, str, float]],
        report: JanitorReport,
    ) -> JanitorReport:
        # Track which nodes have already been merged (as duplicates) in this run
        merged_away: set[str] = set()

        for survivor_id, duplicate_id, similarity in candidates:
            # Skip if either node was already merged in this run
            if survivor_id in merged_away or duplicate_id in merged_away:
                continue

            try:
                # Redirect edges from duplicate to survivor.
                # Prefer SQL-native update path on SQLiteBackend.
                if hasattr(self._storage, "redirect_edges"):
                    self._storage.redirect_edges(duplicate_id, survivor_id)
                else:
                    # Fallback for backends without redirect_edges support.
                    all_edges = self._storage.get_all_edges()
                    for src, tgt, data in all_edges:
                        new_src, new_tgt = src, tgt
                        if src == duplicate_id:
                            new_src = survivor_id
                        if tgt == duplicate_id:
                            new_tgt = survivor_id
                        # Skip self-loops that would result from merge
                        if new_src == new_tgt:
                            continue
                        if new_src != src or new_tgt != tgt:
                            edge = EdgeData(
                                source=new_src,
                                target=new_tgt,
                                relation=data.get("relation", "related_to"),
                                weight=data.get("weight", 1.0),
                            )
                            self._storage.upsert_edge(edge)

                # Reconcile passage_entities: point duplicate's passages at survivor.
                # Without this, the observation manifold stays split after merge —
                # survivor can't see passages that referenced the duplicate.
                if hasattr(self._storage, '_conn'):
                    self._storage._conn.execute(
                        """INSERT OR IGNORE INTO passage_entities (passage_id, entity_id)
                           SELECT passage_id, ? FROM passage_entities
                           WHERE entity_id = ?""",
                        (survivor_id, duplicate_id),
                    )
                    self._storage._conn.execute(
                        "DELETE FROM passage_entities WHERE entity_id = ?",
                        (duplicate_id,),
                    )
                if hasattr(self._storage, "redirect_node_provenance"):
                    self._storage.redirect_node_provenance(duplicate_id, survivor_id)

                # Delete the duplicate node
                self._storage.delete_node(duplicate_id)
                merged_away.add(duplicate_id)
                report.nodes_modified += 1

            except Exception as e:
                report.errors.append(
                    f"Failed to merge {duplicate_id} → {survivor_id}: {e}"
                )

        return report

    async def stitch(self, dry_run: bool = False) -> JanitorReport:
        """Retroactively apply Layer 0 + Layer 2 stitching to existing passages.

        Enforces "upload once, improve forever" (strategy.md principle #7):
        graphs ingested before the Stitching Protocol shipped receive stitching
        edges without any re-ingestion.

        **Layer 0 (inter-session, exact):** Groups session passages (ps_ prefix)
        by source_label family (e.g. all "chatgpt/*" passages form one family).
        Sorts by ingested_at (ISO string — chronological proxy). Creates
        _session_follows edges via memory.stitch_sequence(). Idempotent because
        upsert_edge uses (source, target, relation) PRIMARY KEY.

        **Layer 2 (intra-session, approximate):** For session passages with >6
        entity_ids (suggesting multi-chunk ingestion), applies a sliding window
        of size _STITCH_WINDOW_SIZE on entity_ids in extraction order as a proxy
        for original chunk boundaries. Creates _follows edges between the last 3
        entities of window K and the first 3 of window K+1.

        Args:
            dry_run: If True, report what would be done without modifying graph.

        Returns:
            JanitorReport with:
                nodes_scanned = total passages examined
                nodes_affected = passages where stitching was applied
                nodes_modified = total edges created (or would-be in dry_run)
        """
        # Contract C8 (pipeline-contracts.md): stitching scans passages and may
        # perform many synchronous edge writes, so keep it off the event loop.
        return await asyncio.to_thread(self._stitch_sync, dry_run)

    def _stitch_sync(self, dry_run: bool = False) -> JanitorReport:
        report = JanitorReport(
            task_name="stitch",
            nodes_scanned=0,
            nodes_affected=0,
            nodes_modified=0,
        )

        try:
            progress.emit("janitor", message="Loading passages for stitching...")
            all_passages = list(self._storage.get_all_passages().values())
            report.nodes_scanned = len(all_passages)

            # --- Layer 0: inter-session stitching (_session_follows) ---
            # Only applies to session passages (ps_ prefix).
            session_passages = [p for p in all_passages if p.passage_id.startswith("ps_")]

            # Group by source_label prefix ("chatgpt/Title" → family "chatgpt").
            # Passages with no source_label are ungrouped — skip (no sequence context).
            families: dict[str, list] = {}
            for p in session_passages:
                family = p.source_label.split("/")[0] if p.source_label else ""
                if family:
                    families.setdefault(family, []).append(p)

            for _family, family_passages in families.items():
                if len(family_passages) < 2:
                    continue  # single session in family — nothing to stitch

                # Sort chronologically by ingested_at (ISO string, lex-sortable).
                # parse_conversations() ingests in create_time order, so ingested_at
                # faithfully reflects original chronological sequence.
                sorted_passages = sorted(
                    family_passages, key=lambda p: p.ingested_at or ""
                )
                ordered_ids = [p.passage_id for p in sorted_passages]

                if not dry_run:
                    new_edges = self.memory.stitch_sequence(ordered_ids)
                    edge_count = len(new_edges)
                else:
                    new_edges = self._simulate_stitch_sequence(ordered_ids)
                    edge_count = len(new_edges)

                if edge_count > 0:
                    report.nodes_modified += edge_count
                    report.nodes_affected += len(sorted_passages)

            # --- Layer 2: intra-session stitching (_follows, approximate) ---
            # Approximate chunk boundaries from entity_ids extraction order.
            # Only applies when there are enough entities to suggest multi-chunk
            # ingestion (>6 entities = likely 2+ original chunks).
            for p in session_passages:
                if len(p.entity_ids) <= 6:
                    continue  # too few entities — skip approximation

                windows = [
                    p.entity_ids[i: i + _STITCH_WINDOW_SIZE]
                    for i in range(0, len(p.entity_ids), _STITCH_WINDOW_SIZE)
                ]
                if len(windows) < 2:
                    continue

                session_edges = 0
                for k in range(len(windows) - 1):
                    tail_ids = windows[k][-3:]      # last ≤3 of window K
                    head_ids = windows[k + 1][:3]  # first ≤3 of window K+1

                    for tail in tail_ids:
                        for head in head_ids:
                            if tail == head:
                                continue  # skip self-loops
                            if not dry_run:
                                self._storage.upsert_edge(EdgeData(
                                    source=tail,
                                    target=head,
                                    relation="_follows",
                                    weight=0.5,
                                ))
                            session_edges += 1

                if session_edges > 0:
                    report.nodes_modified += session_edges
                    report.nodes_affected += 1

        except Exception as exc:
            report.errors.append(f"Stitch task failed: {exc}")

        return report

    def _simulate_stitch_sequence(self, passage_ids: list[str]) -> list[tuple[str, str]]:
        """Dry-run helper: return (tail, head) pairs stitch_sequence would create."""
        simulated: list[tuple[str, str]] = []
        # SQL-B1: batch fetch eliminates N+1 queries
        _batch = self._storage.get_passages_batch(passage_ids)
        for k in range(len(passage_ids) - 1):
            prev = _batch.get(passage_ids[k])
            nxt = _batch.get(passage_ids[k + 1])
            if not prev or not nxt:
                continue
            if not prev.entity_ids or not nxt.entity_ids:
                continue
            for tail in prev.entity_ids[-3:]:
                for head in nxt.entity_ids[:3]:
                    if tail != head:
                        simulated.append((tail, head))
        return simulated

    async def temporal(self, dry_run: bool = False) -> JanitorReport:
        """Retroactively extract temporal info and create TEMPORAL_ANCHOR nodes.

        F14 Temporal Reasoning — "Upload once, improve forever" pattern:
        1. Iterate all passages
        2. Extract years from LOD_0 raw_text via regex
        3. Set passage temporal_min / temporal_max
        4. Create TEMPORAL_ANCHOR nodes (t_YYYY, category=temporal_anchor)
        5. Create covers_period edges (structural: passage → anchor)
        6. Create occurred_at edges (semantic: entity → anchor)

        Idempotent: upsert_node, upsert_edge, upsert_passage.
        """
        # Contract C8 (pipeline-contracts.md): temporal backfill scans passages
        # and performs synchronous DB writes, so it belongs in a worker thread.
        return await asyncio.to_thread(self._temporal_sync, dry_run)

    def _temporal_sync(self, dry_run: bool = False) -> JanitorReport:
        from .models import EdgeData, NodeData
        from .temporal import extract_temporal, make_temporal_anchor_id

        all_passages = list(self._storage.get_all_passages().values())
        affected = 0
        anchors_created = 0
        edges_created = 0

        for passage in all_passages:
            temporal_info = extract_temporal(passage.raw_text)

            if temporal_info.temporal_min is None:
                continue  # no dates found

            affected += 1

            if dry_run:
                continue

            # Update passage temporal range
            passage.temporal_min = temporal_info.temporal_min
            passage.temporal_max = temporal_info.temporal_max
            self._storage.upsert_passage(passage)

            # Create TEMPORAL_ANCHOR nodes + covers_period edges
            for year in temporal_info.anchor_years:
                anchor_id = make_temporal_anchor_id(year)
                anchor_node = NodeData(
                    entity_id=anchor_id,
                    name=str(year),
                    category="temporal_anchor",
                    lod_0=str(year),
                    lod_1=str(year),
                    lod_2=str(year),
                    refined=True,
                )
                self._storage.upsert_node(anchor_node)
                anchors_created += 1

                # covers_period: passage → anchor (structural)
                self._storage.upsert_edge(EdgeData(
                    source=passage.passage_id,
                    target=anchor_id,
                    relation="_covers_period",
                    weight=0.5,
                ))
                edges_created += 1

            # occurred_at: entity → anchor (semantic — NOT structural)
            for year in temporal_info.anchor_years:
                anchor_id = make_temporal_anchor_id(year)
                for eid in passage.entity_ids:
                    self._storage.upsert_edge(EdgeData(
                        source=eid,
                        target=anchor_id,
                        relation="occurred_at",
                        weight=0.6,
                    ))
                    edges_created += 1

        return JanitorReport(
            task_name="temporal",
            nodes_scanned=len(all_passages),
            nodes_affected=affected,
            nodes_modified=anchors_created,
            errors=[],
        )

    async def profiles(self, dry_run: bool = False) -> JanitorReport:
        """Backfill sentence profiles for passages ingested before fiber-basis.

        Iterates passages that have no cached sentence profiles, splits them
        into sentences, computes NER/POS/lemma profiles via spaCy, and stores
        them in the sentence_profiles table. Idempotent — skips passages that
        already have profiles.
        """
        # Contract C8 (pipeline-contracts.md): profile backfill runs spaCy and
        # synchronous storage writes, so keep it off the event loop.
        return await asyncio.to_thread(self._profiles_sync, dry_run)

    def _profiles_sync(self, dry_run: bool = False) -> JanitorReport:
        from tp_vrg.compression import split_sentences
        from tp_vrg.render_confidence import compute_sentence_profiles

        if not hasattr(self._storage, "get_passages_without_profiles"):
            return JanitorReport(
                task_name="profiles",
                nodes_scanned=0, nodes_affected=0, nodes_modified=0,
                errors=["Storage backend does not support sentence profiles."],
            )

        missing = self._storage.get_passages_without_profiles()
        affected = 0

        for passage_id, raw_text in missing:
            sents = split_sentences(raw_text)
            if not sents:
                continue
            affected += 1
            if dry_run:
                continue
            profs = compute_sentence_profiles(sents)
            self._storage.save_sentence_profiles_bulk(passage_id, profs)

        if not dry_run and affected > 0:
            # Commit outside batch mode
            if hasattr(self._storage, "_conn"):
                self._storage._conn.commit()

        return JanitorReport(
            task_name="profiles",
            nodes_scanned=len(missing),
            nodes_affected=affected,
            nodes_modified=affected if not dry_run else 0,
            errors=[],
        )

    async def fts5_sync_repair(self, dry_run: bool = False) -> JanitorReport:
        """Repair FTS5 index rows that no longer point at canonical rows."""
        return await asyncio.to_thread(self._fts5_sync_repair_sync, dry_run)

    def _fts5_sync_repair_sync(self, dry_run: bool = False) -> JanitorReport:
        if not hasattr(self._storage, "fts5_sync_repair"):
            return JanitorReport(
                task_name="fts5_sync_repair",
                nodes_scanned=0,
                nodes_affected=0,
                nodes_modified=0,
                errors=["Storage backend does not support FTS5 sync repair."],
            )

        result = self._storage.fts5_sync_repair(dry_run=dry_run)
        try:
            nodes_scanned = self._storage.node_count() + self._storage.passage_count()
        except Exception:
            nodes_scanned = 0

        return JanitorReport(
            task_name="fts5_sync_repair",
            nodes_scanned=nodes_scanned,
            nodes_affected=int(result["orphan_rows_found"])
            + int(result.get("missing_rows_found", 0)),
            nodes_modified=int(result["rows_deleted"])
            + int(result.get("rows_inserted", 0)),
            errors=(
                []
                if dry_run or result["fts5_in_sync_after"]
                else ["FTS5 rows remain out of sync."]
            ),
        )

    async def backfill_node_provenance(self, dry_run: bool = False) -> JanitorReport:
        """Backfill the node_provenance reverse index from passages/provenance."""
        return await asyncio.to_thread(self._backfill_node_provenance_sync, dry_run)

    def _backfill_node_provenance_sync(self, dry_run: bool = False) -> JanitorReport:
        if not hasattr(self._storage, "backfill_node_provenance"):
            return JanitorReport(
                task_name=_BACKFILL_NODE_PROVENANCE_TASK,
                nodes_scanned=0,
                nodes_affected=0,
                nodes_modified=0,
                errors=["Storage backend does not support node_provenance backfill."],
            )

        provenance = getattr(self.memory, "_provenance", None)
        source_lookup = (
            provenance.get_source_id_for_segment
            if provenance is not None and hasattr(provenance, "get_source_id_for_segment")
            else None
        )
        try:
            result = self._storage.backfill_node_provenance(
                source_lookup=source_lookup,
                dry_run=dry_run,
            )
            unresolved = int(result.get("unresolved_passages", 0))
            errors = []
            if unresolved:
                errors.append(
                    f"{unresolved} passage(s) could not be mapped to a source_id."
                )
            return JanitorReport(
                task_name=_BACKFILL_NODE_PROVENANCE_TASK,
                nodes_scanned=int(result.get("passages_scanned", 0)),
                nodes_affected=unresolved,
                nodes_modified=(
                    0
                    if dry_run
                    else int(result.get("node_provenance_rows_written", 0))
                ),
                errors=errors,
            )
        except Exception as exc:
            return JanitorReport(
                task_name=_BACKFILL_NODE_PROVENANCE_TASK,
                nodes_scanned=0,
                nodes_affected=0,
                nodes_modified=0,
                errors=[f"Node provenance backfill failed: {exc}"],
            )

    async def integrity_verify(self, dry_run: bool = False) -> JanitorReport:
        """Run full SQLite integrity verification on the janitor timeline."""
        return await asyncio.to_thread(self._integrity_verify_sync, dry_run)

    def _integrity_verify_sync(self, dry_run: bool = False) -> JanitorReport:
        report = JanitorReport(
            task_name="integrity_verify",
            nodes_scanned=0,
            nodes_affected=0,
            nodes_modified=0,
        )

        if os.environ.get("TPVRG_SKIP_INTEGRITY_VERIFY", "").strip() == "1":
            return report

        if not hasattr(self._storage, "run_integrity_verify"):
            report.errors.append(
                "Storage backend does not support integrity verification."
            )
            return report

        raw_interval = os.environ.get("TPVRG_INTEGRITY_VERIFY_INTERVAL_HOURS", "24")
        try:
            interval_hours = float(raw_interval)
        except ValueError:
            report.errors.append(
                "TPVRG_INTEGRITY_VERIFY_INTERVAL_HOURS must be a number."
            )
            return report

        try:
            if (
                hasattr(self._storage, "integrity_verify_due")
                and not self._storage.integrity_verify_due(interval_hours)
            ):
                return report

            try:
                report.nodes_scanned = (
                    self._storage.node_count() + self._storage.passage_count()
                )
            except Exception:
                report.nodes_scanned = 0

            report.nodes_affected = 1
            if dry_run:
                return report

            result = self._storage.run_integrity_verify()
            report.nodes_modified = 1
            if not result.get("ok", False):
                report.errors.append(
                    f"SQLite integrity verification failed: {result.get('result', 'unknown')}"
                )
        except Exception as exc:
            report.errors.append(f"Integrity verification task failed: {exc}")

        return report

    def _sqlite_connection_for_partition_bake(self):
        conn = getattr(self._storage, "conn", None)
        if conn is not None:
            return conn
        conn = getattr(self._storage, "_conn", None)
        if conn is not None:
            return conn
        raise RuntimeError(
            "bake_partitions requires a SQLite-backed storage connection."
        )

    async def bake_partitions(
        self,
        *,
        force_rebake: bool = False,
        recompute_centroids: bool = True,
        dry_run: bool = False,
        on_phase=None,
    ) -> dict[str, object]:
        """Run the multi-resolution partition bake as a standard Janitor task.

        ``on_phase(name, index, total)`` is forwarded to the orchestrator so the
        async HTTP job surface can report live phase/progress; ``None`` for the
        synchronous MCP / CLI / janitor-task callers (which still get the
        unconditional per-phase log markers).
        """
        conn = self._sqlite_connection_for_partition_bake()
        if dry_run:
            from tp_vrg.janitor.bake_island_rung import get_partition_algorithm
            from tp_vrg.storage.per_rung_centroids import centroid_counts

            started = time.perf_counter()
            return {
                "asset_count": 0,
                "island_count": 0,
                "continent_count": 0,
                "centroid_counts": centroid_counts(conn),
                "algorithm": get_partition_algorithm(),
                "baked_at": datetime.now(timezone.utc).isoformat(),
                "wall_time_s": time.perf_counter() - started,
            }

        from tp_vrg.janitor.bake_partitions import bake_partitions

        progress.emit(
            "janitor",
            message=f"task={_BAKE_PARTITIONS_TASK} started",
        )
        result = await bake_partitions(
            conn,
            force_rebake=force_rebake,
            recompute_centroids=recompute_centroids,
            on_phase=on_phase,
        )
        progress.emit(
            "janitor",
            message=(
                f"task={_BAKE_PARTITIONS_TASK} completed "
                f"(asset_count={result['asset_count']} "
                f"island_count={result['island_count']} "
                f"continent_count={result['continent_count']} "
                f"wall_time_s={float(result['wall_time_s']):.2f})"
            ),
        )
        return result

    async def bake_similarity_edges(
        self,
        *,
        dry_run: bool = False,
        rung: str = "asset",
        k: int = 10,
        hub_cap: int | None = None,
    ) -> dict[str, object]:
        """Run the materialized similarity-edge bake as a Janitor task."""
        conn = self._sqlite_connection_for_partition_bake()
        model_id = getattr(self._embedder, "model_id", None)
        if dry_run:
            from tp_vrg.storage.similarity_edges import (
                resolve_model_id,
                similarity_edge_counts,
                similarity_edges_enabled,
            )

            return {
                "enabled": similarity_edges_enabled(),
                "rung": rung,
                "k": int(k),
                "model_id": resolve_model_id(model_id),
                "edge_counts": similarity_edge_counts(conn),
                "hub_cap": hub_cap,
                "dry_run": True,
            }

        from tp_vrg.janitor.bake_similarity_edges import bake_similarity_edges

        progress.emit(
            "janitor",
            message=f"task={_BAKE_SIMILARITY_EDGES_TASK} started",
        )
        result = await asyncio.to_thread(
            bake_similarity_edges,
            conn,
            rung=rung,
            k=int(k),
            model_id=model_id,
            hub_cap=hub_cap,
        )
        if result.get("enabled"):
            progress.emit(
                "janitor",
                message=(
                    f"task={_BAKE_SIMILARITY_EDGES_TASK} completed "
                    f"(rung={result['rung']} edge_count={result['edge_count']} "
                    f"wall_time_s={float(result['wall_time_s']):.2f})"
                ),
            )
        return result

    async def repo_ingest_new_docs(
        self,
        *,
        repo_root: str | os.PathLike[str] | None = None,
        roots=None,
        dry_run: bool = False,
        rebake: bool = False,
    ) -> dict[str, object]:
        """Ingest changed repo docs as a Janitor task."""
        from pathlib import Path
        from tp_vrg.repo_doc_ingest import (
            ingest_changed_repo_docs,
            repo_doc_ingest_summary,
        )
        from tp_vrg.repo_doc_watch import DEFAULT_ROOTS

        resolved_root = Path(
            repo_root or os.environ.get("TPVRG_REPO_ROOT") or Path.cwd()
        ).expanduser().resolve()
        resolved_roots = tuple(roots) if roots is not None else DEFAULT_ROOTS
        if dry_run:
            conn = self._sqlite_connection_for_partition_bake()
            return repo_doc_ingest_summary(resolved_root, conn, resolved_roots)
        return await ingest_changed_repo_docs(
            self.memory,
            resolved_root,
            resolved_roots,
            rebake=rebake,
        )

    async def run_task(
        self,
        task: str,
        dry_run: bool = False,
        **kwargs,
    ) -> JanitorReport | dict[str, object]:
        """Run a single Janitor task by registry name."""
        if task == "shred":
            return await self.shred(dry_run=dry_run)
        if task == "polish":
            return await self.polish(dry_run=dry_run)
        if task == "backbone":
            return await self.run_backbone(dry_run=dry_run)
        if task == "merge":
            return await self.merge(dry_run=dry_run)
        if task == "stitch":
            return await self.stitch(dry_run=dry_run)
        if task == "temporal":
            return await self.temporal(dry_run=dry_run)
        if task == "neighborhood_cache":
            return await self.run_neighborhood_cache(dry_run=dry_run)
        if task == "profiles":
            return await self.profiles(dry_run=dry_run)
        if task == "fts5_sync_repair":
            return await self.fts5_sync_repair(dry_run=dry_run)
        if task == "integrity_verify":
            return await self.integrity_verify(dry_run=dry_run)
        if task == _BACKFILL_NODE_PROVENANCE_TASK:
            return await self.backfill_node_provenance(dry_run=dry_run)
        if task == _BAKE_PARTITIONS_TASK:
            return await self.bake_partitions(
                force_rebake=bool(kwargs.get("force_rebake", False)),
                recompute_centroids=bool(kwargs.get("recompute_centroids", True)),
                dry_run=dry_run,
            )
        if task == _BAKE_SIMILARITY_EDGES_TASK:
            return await self.bake_similarity_edges(
                dry_run=dry_run,
                rung=str(kwargs.get("rung", "asset")),
                k=int(kwargs.get("k", 10)),
                hub_cap=(
                    int(kwargs["hub_cap"])
                    if kwargs.get("hub_cap") is not None
                    else None
                ),
            )
        if task == REPO_INGEST_TASK:
            return await self.repo_ingest_new_docs(
                repo_root=kwargs.get("repo_root"),
                dry_run=dry_run,
                rebake=bool(
                    kwargs.get("rebake", False)
                    or kwargs.get("rebake_after_ingest", False)
                ),
            )
        raise ValueError(f"Unknown Janitor task: {task}")

    async def run(
        self,
        tasks: list[str] | None = None,
        dry_run: bool = False,
    ) -> dict[str, JanitorReport | dict[str, object]]:
        """
        Run Janitor tasks in sequence.

        Args:
            tasks: List of task names: ["shred", "polish", "backbone",
                   "merge", "stitch", "temporal", "neighborhood_cache",
                   "fts5_sync_repair", "backfill_node_provenance",
                   "bake_partitions", "bake_similarity_edges",
                   "repo_ingest_new_docs"]
                   or any subset. Default: ["shred", "polish"].
            dry_run: If True, report without modifying

        Returns:
            Dict of task_name -> JanitorReport
        """
        if tasks is None:
            tasks = ["shred", "polish"]

        results = {}
        self.dry_run = dry_run

        for task in tasks:
            results[task] = await self.run_task(task, dry_run=dry_run)

        return results


# -- CLI surface has moved to Cockpit commands in src/tp_vrg/cli.py -----------
# Use: tp-vrg status / tp-vrg backup / tp-vrg janitor
# (see design/janitor-cockpit-concept.md — Phase 1)
