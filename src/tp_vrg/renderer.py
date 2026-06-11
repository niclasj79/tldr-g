"""
ContextRenderer — all rendering concerns extracted from LODGraphMemory.

Handles format_context() dispatch, F18 clean format, debug format,
entity full-text observation manifold, and relation phrase templates.
"""

from __future__ import annotations

import hashlib
import logging
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from tp_vrg.compression import compress
from tp_vrg.extraction.stopword_filter import filter_edge_rows_for_retrieval
from tp_vrg.models import (
    CHILD_FIRST_RELATIONS,
    HIERARCHICAL_RELATIONS,
    LODLevel,
    MAX_RENDERED_EDGES,
    MOTIF_THRESHOLD,
    STRUCTURAL_RELATIONS,
    STUBBLE_CAP,
    ScoredNode,
    SourcePassage,
    SPACY_CEILING_CHARS,
)
from tp_vrg.shading import apply_topological_shading
from tp_vrg.storage import StorageBackend
from tp_vrg.temporal import _extract_session_date, normalize_relative_dates
from tp_vrg.tokens import estimate_tokens


# ── Motif compression — module-level helpers ─────────────────────────────────
# Shared by both _format_context_debug and format_context_clean. Each caller
# renders the analysis to its own output format (debug uses arrow notation;
# clean uses natural-language phrasing). The analysis itself is format-agnostic.


@dataclass
class MotifGroup:
    """A compressed group of edges forming a single motif.

    Three motif kinds:
      * "hub_spoke": many distinct sources → 1 target via a single relation
        (pivot = target_id, relation = the shared relation, members = [(source_id, "")])
      * "fan_out": 1 source → many distinct targets via a single relation
        (pivot = source_id, relation = the shared relation, members = [(target_id, "")])
      * "compact_adj": 1 source → multiple (relation, target) pairs, mixed relations
        (pivot = source_id, relation = "" since heterogeneous, members = [(target_id, relation)])
    """

    kind: str
    pivot: str
    relation: str
    members: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class MotifAnalysis:
    """Result of motif analysis on a set of edges.

    Callers iterate `motifs` to render the compressed groups, then iterate
    `singletons` to emit per-edge bullets for the leftover edges. The
    `covered` set is the union of (u, v, relation) triples absorbed by any
    motif; provided for callers that need to filter edges externally.
    """

    motifs: list[MotifGroup] = field(default_factory=list)
    covered: set[tuple[str, str, str]] = field(default_factory=set)
    singletons: list[tuple[str, str, str]] = field(default_factory=list)


def _detect_chains(
    structural_edges: list[tuple[str, str, str]],
    min_chain_edges: int = 2,
) -> list[MotifGroup]:
    """Find ordered chains along structural edges.

    Per arch-edge-rendering-design.md §3c "Chain":
        [N1] --> [N2] --> [N3] --> [N4]  (via: calls)

    Structural relations (e.g., `_follows`, `_session_follows`, `_precedes`)
    encode document flow topology — by construction each chunk has at most
    one outgoing `_follows` edge to the next chunk, producing long uniform
    chains (per arch-edge-rendering-design.md Addendum Impact 5).

    A chain is a maximal directed path along edges sharing the same
    structural relation, where each interior node has exactly one outgoing
    edge under that relation. Branch points (multiple outgoing) and merge
    points (multiple incoming) terminate the chain.

    Args:
        structural_edges: list of (source_id, target_id, relation) triples
            already filtered to structural relations by the caller.
        min_chain_edges: minimum edge count to emit a chain motif.
            Default 2 — a chain of 2 edges (3 nodes) saves 2 bullets vs.
            singleton rendering, which is the smallest worthwhile compression.

    Returns:
        list of MotifGroup with kind="chain". Each chain's `members` is the
        ordered list of node ids in the chain (length = edge count + 1);
        `relation` is the shared structural relation; `pivot` is "" since
        chains have no central node.
    """
    chains: list[MotifGroup] = []

    # Group edges by relation — chain detection only joins edges of one type.
    by_relation: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for u, v, rel in structural_edges:
        by_relation[rel].append((u, v))

    for relation, edge_list in by_relation.items():
        # Build outgoing per source. Multi-out sources are NOT chain-eligible
        # (they're fan-out points). Multi-in targets terminate the incoming
        # chain.
        outgoing: dict[str, list[str]] = defaultdict(list)
        incoming: dict[str, list[str]] = defaultdict(list)
        for u, v in edge_list:
            outgoing[u].append(v)
            incoming[v].append(u)

        # next_node[u] = v iff u has exactly one outgoing edge under this
        # relation. Multi-outgoing nodes are excluded from chain construction
        # (they break the linearity assumption).
        next_node: dict[str, str] = {
            src: targets[0]
            for src, targets in outgoing.items()
            if len(targets) == 1
        }

        all_chain_sources = set(next_node.keys())
        # Chain start = a node that's a chain source (has unique outgoing) AND
        # is not the unique-incoming target of another chain link, OR is the
        # multi-incoming target (in which case the chain truly starts here).
        # A node N is a chain start if no other chain-eligible node points to N
        # under this relation.
        chain_starts = sorted(
            src for src in all_chain_sources
            if not any(prev in next_node and next_node[prev] == src for prev in incoming.get(src, []))
        )

        visited: set[str] = set()
        for start in chain_starts:
            if start in visited:
                continue
            chain_nodes = [start]
            visited.add(start)
            current = start
            while current in next_node:
                nxt = next_node[current]
                if nxt in visited:
                    break  # cycle guard (shouldn't happen for _follows but defensive)
                # If next has multiple incoming chain-edges under this relation,
                # the chain merges into a fan-in point; stop including the
                # merge target (it could equally belong to another chain).
                if len(incoming.get(nxt, [])) > 1:
                    chain_nodes.append(nxt)
                    visited.add(nxt)
                    break
                chain_nodes.append(nxt)
                visited.add(nxt)
                current = nxt

            if len(chain_nodes) >= min_chain_edges + 1:
                chains.append(
                    MotifGroup(
                        kind="chain",
                        pivot="",
                        relation=relation,
                        members=[(n, "") for n in chain_nodes],
                    )
                )

    return chains


def _join_natural(items: list[str]) -> str:
    """Join items with Oxford-comma natural-language conjunction.

    Used to format motif member lists for the clean (natural-language)
    rendering path. Examples:
      ["A"]            → "A"
      ["A", "B"]       → "A and B"
      ["A", "B", "C"]  → "A, B, and C"
    """
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} and {items[1]}"
    return ", ".join(items[:-1]) + f", and {items[-1]}"


# Edge admission threshold for the clean render path. An edge's type_weight
# must meet or exceed this value to be admitted into Zone 2 (motif compression
# input + per-edge bullet fallback). Hierarchical relations always score 0.0
# (rendered via nesting, never as edges). Semantic relations score 1.0
# (always admitted). Structural relations score 0.3 + 1.2 × intent.temporal,
# which crosses 0.5 once temporal intent passes ~0.17 — so non-temporal
# queries continue to suppress structural edges (preserving prior behavior),
# while temporal queries admit them.
EDGE_ADMISSION_WEIGHT_THRESHOLD: float = 0.5


def _edge_type_weight(relation: str, intent: Any = None) -> float:
    """Return the rendering type-weight for an edge relation.

    Per arch-edge-rendering-design.md Addendum Impact 2 + 3:
      semantic:     1.0 (full priority)
      hierarchical: 0.0 (rendered via implicit nesting, never competes
                         for edge budget)
      structural:   0.3 + 1.2 × intent.temporal_weight (intent-driven
                         promotion — structural edges suppressed under
                         non-temporal intent, promoted under temporal)

    The type weight is the multiplier in the design's priority formula:
        priority(edge) = (lod_value(source) + lod_value(target)) × type_weight

    The current clean render path doesn't use priority-based selection
    (it uses iteration order + budget cap), so this commit uses type_weight
    as a binary admission signal against EDGE_ADMISSION_WEIGHT_THRESHOLD.
    A future commit can wire type_weight into priority-ranked selection
    once the budget cap is reframed as a priority queue.

    Args:
        relation: the edge's relation string.
        intent: optional IntentSignal-like object exposing
            `content_axes["temporal"]` (float in [0, 1]). When None or
            missing, structural edges score the baseline 0.3.

    Returns:
        float in [0.0, 1.5+]: 0.0 hierarchical, 1.0 semantic,
        0.3-1.5 structural (varies with temporal intent).
    """
    if relation in HIERARCHICAL_RELATIONS:
        return 0.0
    if relation in STRUCTURAL_RELATIONS:
        temporal_weight = 0.0
        if intent is not None:
            content_axes = getattr(intent, "content_axes", None)
            if content_axes is not None:
                try:
                    temporal_weight = float(content_axes.get("temporal", 0.0) or 0.0)
                except (TypeError, ValueError):
                    temporal_weight = 0.0
        return 0.3 + 1.2 * temporal_weight
    return 1.0


def _pluralize_relation_phrase(phrase: str) -> str:
    """Convert a singular-subject relation phrase to plural-subject form.

    Used by hub_spoke motif rendering, where the subject is a list of N
    entities (plural) but RELATION_TEMPLATES phrases assume a singular
    subject ("is an instance of", "was born in", etc.).

    Crude but covers the common auxiliaries used in TP-VRG's relation
    templates (is, was, has). Phrases that don't start with a known
    singular auxiliary pass through unchanged — those typically use bare
    verbs that work for both singular and plural subjects ("worked at",
    "founded", "won").

    Examples:
      "is an instance of"   → "are an instance of"
      "was born in"         → "were born in"
      "has parent company"  → "have parent company"
      "worked at"           → "worked at"  (unchanged — bare verb)
      "founded"             → "founded"    (unchanged — past simple)
    """
    if phrase.startswith("is "):
        return "are " + phrase[3:]
    if phrase.startswith("was "):
        return "were " + phrase[4:]
    if phrase.startswith("has "):
        return "have " + phrase[4:]
    return phrase


def analyze_motifs(
    valid_edges: list[tuple[str, str, str]],
    threshold: int = MOTIF_THRESHOLD,
) -> MotifAnalysis:
    """Analyze edges for motif compression opportunities.

    Three sequential passes, each consuming edges not covered by the prior:

      1. Hub-and-spoke: groups by (target, relation); emits if N sources >= threshold.
         Captures the canonical "many things instance_of one thing" pattern.
      2. Fan-out: groups by (source, relation); emits if N targets >= threshold.
         Captures "one thing relates to many things via the same edge".
      3. Compact adjacency: groups by source; emits if 2+ outgoing edges remain.
         Captures the "this entity does many things" pattern, with mixed relations.

    Edges not absorbed by any pass land in `singletons` for per-edge bullet rendering.

    Format-agnostic: this function returns data structure only. Callers
    (debug renderer + clean renderer) format the motifs to their own output.

    Args:
        valid_edges: list of (source_id, target_id, relation) triples. Each
            triple must reference nodes the caller is already rendering;
            this function does no node-existence validation.
        threshold: minimum group size to trigger hub-and-spoke / fan-out
            compression. Defaults to MOTIF_THRESHOLD (3 as of 2026-04). Compact
            adjacency uses the hardcoded threshold of 2 (which is its
            information-theoretic minimum — one outgoing edge can't be "compact").

    Returns:
        MotifAnalysis with `motifs` (list of compressed groups), `covered` set
        (edges absorbed by motifs), and `singletons` (edges not absorbed).
        Sum invariant: len(covered) + len(singletons) == len(valid_edges).
    """
    motifs: list[MotifGroup] = []
    covered: set[tuple[str, str, str]] = set()

    # Pass 1 — Hub-and-spoke (many sources → 1 target via same relation)
    target_rel_sources: dict[tuple[str, str], list[str]] = defaultdict(list)
    for u, v, rel in valid_edges:
        target_rel_sources[(v, rel)].append(u)

    for (target, rel), sources in sorted(target_rel_sources.items()):
        if len(sources) >= threshold:
            motifs.append(
                MotifGroup(
                    kind="hub_spoke",
                    pivot=target,
                    relation=rel,
                    members=[(s, "") for s in sources],
                )
            )
            for s in sources:
                covered.add((s, target, rel))

    # Pass 2 — Fan-out (1 source → many targets via same relation)
    src_rel_targets: dict[tuple[str, str], list[str]] = defaultdict(list)
    for u, v, rel in valid_edges:
        if (u, v, rel) not in covered:
            src_rel_targets[(u, rel)].append(v)

    for (src, rel), targets in sorted(src_rel_targets.items()):
        if len(targets) >= threshold:
            motifs.append(
                MotifGroup(
                    kind="fan_out",
                    pivot=src,
                    relation=rel,
                    members=[(t, "") for t in targets],
                )
            )
            for t in targets:
                covered.add((src, t, rel))

    # Pass 3 — Compact adjacency (1 source → multiple (rel, target) pairs)
    src_outgoing: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for u, v, rel in valid_edges:
        if (u, v, rel) not in covered:
            src_outgoing[u].append((rel, v))

    singletons: list[tuple[str, str, str]] = []
    for src in sorted(src_outgoing):
        outgoing = src_outgoing[src]
        if len(outgoing) >= 2:
            motifs.append(
                MotifGroup(
                    kind="compact_adj",
                    pivot=src,
                    relation="",
                    members=[(t, rel) for rel, t in outgoing],
                )
            )
            for rel, t in outgoing:
                covered.add((src, t, rel))
        else:
            for rel, t in outgoing:
                singletons.append((src, t, rel))

    return MotifAnalysis(motifs=motifs, covered=covered, singletons=singletons)


class ContextRenderer:
    """Renders scored entity graphs into LLM-ready context strings."""

    RELATION_TEMPLATES: dict[str, str] = {
        "born_in": "was born in",
        "died_in": "died in",
        "located_in": "is located in",
        "part_of": "is part of",
        "member_of": "is a member of",
        "works_at": "works at",
        "worked_at": "worked at",
        "married_to": "married",
        "founded": "founded",
        "founded_by": "was founded by",
        "created": "created",
        "created_by": "was created by",
        "won": "won",
        "awarded": "was awarded",
        "contains": "contains",
        "has": "has",
        "is_a": "is a",
        "instance_of": "is an instance of",
        "capital_of": "is the capital of",
        "occurred_at": "occurred at",
        "affiliated_with": "is affiliated with",
        "published_by": "was published by",
        "directed_by": "was directed by",
        "written_by": "was written by",
        "performed_by": "was performed by",
        "produced_by": "was produced by",
        "owned_by": "is owned by",
        "subsidiary_of": "is a subsidiary of",
        "parent_company": "has parent company",
        "succeeded_by": "was succeeded by",
        "preceded_by": "was preceded by",
        "plays_for": "plays for",
        "played_for": "played for",
        "studied_at": "studied at",
        "graduated_from": "graduated from",
        "elected_to": "was elected to",
        "appointed_to": "was appointed to",
        "borders": "borders",
        "named_after": "is named after",
    }

    def __init__(self, storage: StorageBackend, provenance: Any = None) -> None:
        self._storage = storage
        self._provenance = provenance  # F16+ ProvenanceBackend | None

    @staticmethod
    def relation_to_phrase(relation: str) -> str:
        """Convert an edge relation string to a natural language verb phrase."""
        if relation in ContextRenderer.RELATION_TEMPLATES:
            return ContextRenderer.RELATION_TEMPLATES[relation]
        return relation.replace("_", " ")

    @staticmethod
    def clean_entity_name(name: str) -> str:
        """Post-process entity name: strip artifacts from extraction."""
        name = name.strip().rstrip(".").rstrip(",").strip()
        if name and name == name.lower() and not name[0].isdigit():
            name = name.title()
        return name

    def get_entity_full_text(
        self, entity_id: str, entity_name: str | None = None,
    ) -> str | None:
        """Return combined raw_text from ALL passages containing entity_id.

        The observation manifold: each passage is an observation of the entity
        from a specific (time, facet, granularity) vantage point. Concatenating
        them gives LOD_Z the full content space to select from, instead of the
        single ``node.lod_0`` that only preserves the last chunk's content.

        When *entity_name* is provided (F5.1), the concatenated text is filtered
        to entity-relevant sentences + 1 context-window neighbor via
        ``extract_entity_sentences()``.  This reduces input to ``compress()``
        and improves sentence-selection precision.  Falls back to full text if
        no sentence matches the entity name.

        Returns ``None`` if no passages are found (caller falls back to node.lod_0).
        Deduplicates identical passage texts (multiple entities from same chunk).
        Preserves passage_id ordering for narrative coherence.
        """
        passages = self._storage.get_passages_for_entity(entity_id)
        if not passages:
            return None

        # Deduplicate identical raw_text (entities sharing a chunk get the same passage)
        seen_texts: set[int] = set()
        unique_texts: list[str] = []
        for p in sorted(passages, key=lambda p: p.passage_id):
            text_hash = hash(p.raw_text)
            if text_hash not in seen_texts:
                seen_texts.add(text_hash)
                unique_texts.append(p.raw_text)

        if not unique_texts:
            return None

        # F5.1: filter to entity-relevant sentences per-passage (NOT on the
        # joined blob). Per-passage filtering keeps spaCy's sentencizer input
        # bounded by chunk size (pipeline contract C1: ~2-4KB per passage),
        # preventing spaCy's 1M char limit from triggering on hot entities
        # that appear in hundreds of passages. Also keeps the ±context_window
        # expansion local to each passage (semantically correct — sentences
        # adjacent across passages aren't adjacent in the source document).
        if entity_name:
            from tp_vrg.compression import extract_entity_sentences
            filtered: list[str] = []
            for text in unique_texts:
                fragment = extract_entity_sentences(text, entity_name)
                session_date = _extract_session_date(text)
                if (
                    fragment
                    and session_date is not None
                    and _extract_session_date(fragment) is None
                ):
                    fragment = f"[Session date: {session_date.isoformat()}]\n\n{fragment}"
                filtered.append(fragment)
            candidate_fragments = [f for f in filtered if f and f.strip()]
        else:
            candidate_fragments = list(unique_texts)

        # Bound concatenation size before any downstream spaCy sentence splitting.
        pieces: list[str] = []
        total_chars = 0
        sep = "\n\n"
        truncated = False
        for frag in candidate_fragments:
            next_cost = len(frag) + (len(sep) if pieces else 0)
            if total_chars + next_cost <= SPACY_CEILING_CHARS:
                pieces.append(frag)
                total_chars += next_cost
                continue
            remaining = SPACY_CEILING_CHARS - total_chars - (len(sep) if pieces else 0)
            if remaining > 0:
                # Tail compression fallback: prefer query-agnostic deterministic compression.
                compressed = compress(frag, query=entity_name or "", budget=max(64, remaining // 4))
                pieces.append(compressed[:remaining])
            truncated = True
            break

        combined = sep.join(pieces)
        if truncated:
            logging.getLogger(__name__).info(
                "[extract] truncated_at_spacy_ceiling entity=%s chars=%d",
                entity_id, len(combined),
            )

        return combined

    def format_context(
        self,
        lods: dict[str, LODLevel],
        distances: dict[str, int],
        query: str,
        edge_budget: int = 0,
        boundary_budget: int = 0,
        scored_nodes: list[ScoredNode] | None = None,
        intent: Any = None,
        debug: bool = False,
    ) -> tuple[str, dict[str, int]]:
        """Dispatch to debug or clean format. Returns (context_str, dedup_stats)."""
        _scored = scored_nodes or []
        if not debug:
            return self.format_context_clean(
                lods, distances, query, edge_budget, boundary_budget, _scored, intent
            )
        return self._format_context_debug(
            lods, distances, query, edge_budget, boundary_budget, _scored, intent
        ), {"rendered": 0, "skipped": 0}

    def _format_context_debug(
        self,
        lods: dict[str, LODLevel],
        distances: dict[str, int],
        query: str,
        edge_budget: int = 0,
        boundary_budget: int = 0,
        scored_nodes: list[ScoredNode] | None = None,
        intent: Any = None,
    ) -> str:
        """Developer-facing debug format with LOD labels, aliases, arrow notation."""
        rendered_ids = set(lods.keys())

        # ── Sheaf-local fetch: induced subgraph only ─────────────────────────
        get_edges_bounded = getattr(self._storage, "get_edges_for_nodes", None)
        get_nodes_bounded = getattr(self._storage, "get_nodes", None)
        if callable(get_edges_bounded) and callable(get_nodes_bounded):
            edges = get_edges_bounded(rendered_ids)
            edge_node_ids = set()
            for u, v, _ in edges:
                edge_node_ids.add(u)
                edge_node_ids.add(v)
            all_needed_ids = rendered_ids | edge_node_ids
            nodes = get_nodes_bounded(list(all_needed_ids))
        else:
            nodes = self._storage.get_all_nodes()
            edges = self._storage.get_all_edges()
        edges = filter_edge_rows_for_retrieval(edges)

        # Build ScoredNode lookup for token_budget access (LOD_Z continuous rendering)
        sn_map: dict[str, ScoredNode] = {
            sn.entity_id: sn for sn in (scored_nodes or [])
        }

        # Content deduplication: hash COMPRESSED output (not raw manifold input).
        rendered_lod0_hashes: set[str] = set()

        lines: list[str] = [
            "=" * 70,
            "KNOWLEDGE GRAPH CONTEXT  (auto-assembled at variable resolution)",
            "=" * 70,
            f"Query: {query}",
            "",
        ]

        # Nodes sorted by distance (closest first), score descending within shell, then ID for determinism.
        sorted_nodes = sorted(
            lods.items(),
            key=lambda kv: (
                distances.get(kv[0], 999),
                -(sn_map[kv[0]].score if kv[0] in sn_map else 0.0),
                kv[0],
            ),
        )

        # ── LOD priority for endpoint-aware edge scoring ──────────────────────
        _lod_priority = {LODLevel.LOD_0: 3, LODLevel.LOD_1: 2, LODLevel.LOD_2: 1}

        # ── Phase C: Edge partitioning ────────────────────────────────────────
        hierarchical_edges: list[tuple[int, str, str, dict]] = []
        non_hierarchical_edges: list[tuple[int, str, str, dict]] = []
        raw_stubble: list[tuple[int, str, str, str, str]] = []

        for u, v, data in edges:
            u_in = u in rendered_ids
            v_in = v in rendered_ids
            relation = data.get("relation", "")

            if u_in and v_in:
                u_pri = _lod_priority.get(lods.get(u, LODLevel.LOD_2), 1)
                v_pri = _lod_priority.get(lods.get(v, LODLevel.LOD_2), 1)
                entry = (u_pri + v_pri, u, v, data)
                if relation in HIERARCHICAL_RELATIONS:
                    hierarchical_edges.append(entry)
                else:
                    non_hierarchical_edges.append(entry)

            elif u_in and not v_in:
                inner_node = nodes.get(u)
                outer_name = nodes[v].name if v in nodes else v
                if inner_node:
                    pri = _lod_priority.get(lods.get(u, LODLevel.LOD_2), 1)
                    raw_stubble.append((pri, u, outer_name, relation, "forward"))

            elif v_in and not u_in:
                inner_node = nodes.get(v)
                outer_name = nodes[u].name if u in nodes else u
                if inner_node:
                    pri = _lod_priority.get(lods.get(v, LODLevel.LOD_2), 1)
                    raw_stubble.append((pri, v, outer_name, relation, "backward"))

        # ── Phase C: Implicit Topology tree ──────────────────────────────────
        implicit_children: dict[str, list[tuple[str, str]]] = defaultdict(list)
        for _, u, v, data in hierarchical_edges:
            relation = data.get("relation", "")
            if relation in CHILD_FIRST_RELATIONS:
                parent_id, child_id = v, u
            else:
                parent_id, child_id = u, v
            implicit_children[parent_id].append((child_id, relation))

        child_to_parent: dict[str, str] = {}
        for nid, _ in sorted_nodes:
            for child_id, _ in implicit_children.get(nid, []):
                if child_id in lods and child_id not in child_to_parent:
                    child_to_parent[child_id] = nid
        rendered_as_child: set[str] = set(child_to_parent)

        # ── Non-hierarchical edge selection ───────────────────────────────────
        non_hierarchical_edges.sort(key=lambda x: x[0], reverse=True)
        if edge_budget:
            remaining = edge_budget
            top_edges: list[tuple[int, str, str, dict]] = []
            for edge in non_hierarchical_edges:
                _, u, v, data = edge
                u_node = nodes.get(u)
                v_node = nodes.get(v)
                if not (u_node and v_node):
                    continue
                cost = estimate_tokens(
                    f"  {u_node.name}  --[{data['relation']}]-->  {v_node.name}"
                )
                if cost > remaining:
                    break
                remaining -= cost
                top_edges.append(edge)
        else:
            top_edges = non_hierarchical_edges[:MAX_RENDERED_EDGES]
        skipped_edges = len(non_hierarchical_edges) - len(top_edges)

        # ── Phase C: Scene Index ──────────────────────────────────────────────
        edge_count_per_node: dict[str, int] = defaultdict(int)
        for _, u, v, _ in top_edges:
            edge_count_per_node[u] += 1
            edge_count_per_node[v] += 1

        alias_map: dict[str, str] = {}
        alias_idx = 1
        for nid, _ in sorted_nodes:
            node = nodes.get(nid)
            if not node:
                continue
            ec = edge_count_per_node.get(nid, 0)
            nt = estimate_tokens(node.name)
            if nt > 2 and ec * (nt - 2) > nt:
                alias_map[nid] = f"[N{alias_idx}]"
                alias_idx += 1

        def node_ref(nid: str) -> str:
            alias = alias_map.get(nid)
            if alias:
                return alias
            n = nodes.get(nid)
            return n.name if n else nid

        # ── Temporal annotation cache ─────────────────────────────────────────
        _temporal_for_entity: dict[str, tuple[int | None, int | None]] = {}
        get_passages_fn = getattr(self._storage, "get_passages_for_entities", None)
        if callable(get_passages_fn):
            passages_map = get_passages_fn(rendered_ids)
            _pe_lookup: dict[str, list[str]] = {}
            for pid, passage in passages_map.items():
                for eid in (passage.entity_ids or []):
                    _pe_lookup.setdefault(eid, []).append(pid)
            for eid in rendered_ids:
                pids = _pe_lookup.get(eid, [])
                best_min, best_max = None, None
                for pid in pids:
                    p = passages_map.get(pid)
                    if p and p.temporal_min is not None:
                        if best_min is None or p.temporal_min < best_min:
                            best_min = p.temporal_min
                        if best_max is None or p.temporal_max > best_max:
                            best_max = p.temporal_max
                if best_min is not None:
                    _temporal_for_entity[eid] = (best_min, best_max)
        _temporal_hashes_emitted: set[str] = set()

        # ── Node section with implicit topology nesting ───────────────────────
        current_section: str | None = None
        for nid, lod in sorted_nodes:
            if nid in rendered_as_child:
                continue

            node = nodes.get(nid)
            if not node:
                continue

            dist = distances.get(nid, "?")
            section = f"LOD_{lod.value}"
            if section != current_section:
                lines.append(f"-- {section} (hop distance {dist}) " + "-" * 40)
                current_section = section

            alias = alias_map.get(nid, "")
            display_name = f"{alias} {node.name}" if alias else node.name
            sn = sn_map.get(nid)

            # Observation manifold: read from ALL passages for this entity,
            # not just the single node.lod_0 (which only has the last chunk).
            # F5.1: filter to entity-relevant sentences via entity_name.
            raw_lod0 = self.get_entity_full_text(nid, entity_name=node.name) or node.lod_0

            if lod == LODLevel.LOD_0:
                raw_lod0 = normalize_relative_dates(raw_lod0)
                if sn and sn.token_budget > 0 and sn.token_budget < estimate_tokens(raw_lod0):
                    content = compress(raw_lod0, query, sn.token_budget, intent=intent)
                else:
                    content = apply_topological_shading(raw_lod0, query) if query else raw_lod0
                content_hash = hashlib.md5(content.encode()).hexdigest()
                if content_hash in rendered_lod0_hashes:
                    lines.append(
                        f"  [{display_name}]  (same source passage as above)"
                    )
                    lines.append("")
                    continue
                rendered_lod0_hashes.add(content_hash)
            elif lod == LODLevel.LOD_1:
                if raw_lod0 and sn and sn.token_budget > 0:
                    raw_lod0 = normalize_relative_dates(raw_lod0)
                    content = compress(raw_lod0, query, sn.token_budget, intent=intent)
                    content_hash = hashlib.md5(content.encode()).hexdigest()
                    if content_hash in rendered_lod0_hashes:
                        lines.append(f"  [{display_name}]  (same source passage as above)")
                        lines.append("")
                        continue
                    rendered_lod0_hashes.add(content_hash)
                else:
                    content = node.get_at_lod(lod)
            else:
                content = node.get_at_lod(lod)

            temporal_tag = ""
            t_data = _temporal_for_entity.get(nid)
            if t_data and lod in (LODLevel.LOD_0, LODLevel.LOD_1):
                if nid not in _temporal_hashes_emitted:
                    _temporal_hashes_emitted.add(nid)
                    tmin, tmax = t_data
                    if tmin == tmax:
                        temporal_tag = f"[Year: {tmin}] "
                    else:
                        temporal_tag = f"[Years: {tmin}–{tmax}] "

            lines.append(f"  [{display_name}]  {temporal_tag}{content}")

            # Implicit topology: hierarchical children as indented sub-bullets.
            for child_id, relation in implicit_children.get(nid, []):
                if child_to_parent.get(child_id) != nid:
                    continue
                child_node = nodes.get(child_id)
                if not child_node:
                    continue
                child_lod = lods.get(child_id, LODLevel.LOD_2)
                child_alias = alias_map.get(child_id, "")
                child_display = f"{child_alias} {child_node.name}" if child_alias else child_node.name
                child_sn = sn_map.get(child_id)
                if child_lod == LODLevel.LOD_0:
                    raw_child_lod0 = child_node.lod_0
                    raw_child_lod0 = normalize_relative_dates(raw_child_lod0)
                    if child_sn and child_sn.token_budget > 0 and child_sn.token_budget < estimate_tokens(raw_child_lod0):
                        child_content = compress(raw_child_lod0, query, child_sn.token_budget, intent=intent)
                    else:
                        child_content = apply_topological_shading(raw_child_lod0, query) if query else raw_child_lod0
                    child_hash = hashlib.md5(child_content.encode()).hexdigest()
                    if child_hash in rendered_lod0_hashes:
                        lines.append(
                            f"    * [{child_display}]  (same source passage as above)"
                        )
                        continue
                    rendered_lod0_hashes.add(child_hash)
                else:
                    child_content = child_node.get_at_lod(child_lod)
                lines.append(f"    * [{child_display}]  {child_content}")

            lines.append("")

        # ── NODE INDEX section (only when aliases exist) ──────────────────────
        if alias_map:
            lines.append("-- NODE INDEX (aliases used in relationship skeleton) " + "-" * 17)
            for nid, _ in sorted_nodes:
                if nid in alias_map:
                    node = nodes.get(nid)
                    if node:
                        lines.append(f"  {alias_map[nid]} = {node.name}")
            lines.append("")

        # ── Relationship skeleton ─────────────────────────────────────────────
        lines.append("-- RELATIONSHIP SKELETON " + "-" * 46)

        valid_edges: list[tuple[str, str, str]] = [
            (u, v, data["relation"])
            for _, u, v, data in top_edges
            if nodes.get(u) and nodes.get(v)
        ]

        motif_analysis = analyze_motifs(valid_edges, threshold=MOTIF_THRESHOLD)

        # Render motifs in debug-style arrow notation.
        for motif in motif_analysis.motifs:
            if motif.kind == "hub_spoke":
                srefs = ", ".join(node_ref(s) for s, _ in motif.members)
                lines.append(f"  {{{srefs}}}  --[{motif.relation}]-->  {node_ref(motif.pivot)}")
            elif motif.kind == "fan_out":
                trefs = ", ".join(node_ref(t) for t, _ in motif.members)
                lines.append(f"  {node_ref(motif.pivot)}  --[{motif.relation}]-->  {{{trefs}}}")
            elif motif.kind == "compact_adj":
                parts = ", ".join(f"{rel} {node_ref(t)}" for t, rel in motif.members)
                lines.append(f"  {node_ref(motif.pivot)}: {parts}")

        # Singleton fallback — edges not absorbed by motifs.
        for u, v, rel in motif_analysis.singletons:
            lines.append(f"  {node_ref(u)}  --[{rel}]-->  {node_ref(v)}")

        if skipped_edges > 0:
            lines.append(f"  ... and {skipped_edges} more relationships (lower priority, omitted).")
        lines.append("")

        # ── Boundary edges (stubble) ──────────────────────────────────────────
        scored_stubble: list[tuple[int, str]] = []
        for pri, inner_id, outer_name, relation, direction in raw_stubble:
            inner_node = nodes.get(inner_id)
            if not inner_node:
                continue
            inner_ref = alias_map.get(inner_id, inner_node.name)
            if direction == "forward":
                line = f"  {inner_ref}  --[{relation}]-->  {outer_name} [outside bundle]"
            else:
                line = f"  {outer_name} [outside bundle]  --[{relation}]-->  {inner_ref}"
            scored_stubble.append((pri, line))

        scored_stubble.sort(key=lambda x: x[0], reverse=True)
        if boundary_budget:
            remaining_b = boundary_budget
            top_stubble: list[str] = []
            for _, line in scored_stubble:
                cost = estimate_tokens(line)
                if cost > remaining_b:
                    break
                remaining_b -= cost
                top_stubble.append(line)
        else:
            top_stubble = [line for _, line in scored_stubble[:STUBBLE_CAP]]
        remaining_stubble = max(0, len(scored_stubble) - len(top_stubble))

        if top_stubble:
            lines.append("-- BOUNDARY EDGES (stubble — topology tendrils outside bundle) " + "-" * 7)
            lines.extend(top_stubble)
            if remaining_stubble > 0:
                lines.append(
                    f"  ... and {remaining_stubble} more connections to entities outside this view."
                )
            lines.append("")

        lines.append("=" * 70)

        return "\n".join(lines)

    def format_context_clean(
        self,
        lods: dict[str, LODLevel],
        distances: dict[str, int],
        query: str,
        edge_budget: int = 0,
        boundary_budget: int = 0,
        scored_nodes: list[ScoredNode] | None = None,
        intent: Any = None,
    ) -> tuple[str, dict[str, int]]:
        """F18 clean LLM-optimized format. Returns (context_str, dedup_stats)."""
        rendered_ids = set(lods.keys())

        # ── Fetch nodes and edges (bounded approach) ─────────────────────────
        get_edges_bounded = getattr(self._storage, "get_edges_for_nodes", None)
        get_nodes_bounded = getattr(self._storage, "get_nodes", None)
        if callable(get_edges_bounded) and callable(get_nodes_bounded):
            edges = get_edges_bounded(rendered_ids)
            edge_node_ids = set()
            for u, v, _ in edges:
                edge_node_ids.add(u)
                edge_node_ids.add(v)
            all_needed_ids = rendered_ids | edge_node_ids
            nodes = get_nodes_bounded(list(all_needed_ids))
        else:
            nodes = self._storage.get_all_nodes()
            edges = self._storage.get_all_edges()
        edges = filter_edge_rows_for_retrieval(edges)

        # ScoredNode lookup for token_budget access
        sn_map: dict[str, ScoredNode] = {
            sn.entity_id: sn for sn in (scored_nodes or [])
        }

        # ── Sort nodes by distance (closest first), score descending ─────────
        sorted_nodes = sorted(
            lods.items(),
            key=lambda kv: (
                distances.get(kv[0], 999),
                -(sn_map[kv[0]].score if kv[0] in sn_map else 0.0),
                kv[0],
            ),
        )

        # ── Temporal annotation cache ────────────────────────────────────────
        _temporal_for_entity: dict[str, tuple[int | None, int | None]] = {}
        get_passages_fn = getattr(self._storage, "get_passages_for_entities", None)
        if callable(get_passages_fn):
            passages_map = get_passages_fn(rendered_ids)
            _pe_lookup: dict[str, list[str]] = {}
            for pid, passage in passages_map.items():
                for eid in (passage.entity_ids or []):
                    _pe_lookup.setdefault(eid, []).append(pid)
            for eid in rendered_ids:
                pids = _pe_lookup.get(eid, [])
                best_min, best_max = None, None
                for pid in pids:
                    p = passages_map.get(pid)
                    if p and p.temporal_min is not None:
                        if best_min is None or p.temporal_min < best_min:
                            best_min = p.temporal_min
                        if best_max is None or p.temporal_max > best_max:
                            best_max = p.temporal_max
                if best_min is not None:
                    _temporal_for_entity[eid] = (best_min, best_max)

        # ── Track first-mention entities for type annotation ─────────────────
        seen_entities: set[str] = set()

        def entity_ref(nid: str) -> str:
            """Return entity name, with (category) on first mention."""
            node = nodes.get(nid)
            if not node:
                return nid
            name = ContextRenderer.clean_entity_name(node.name)
            if nid not in seen_entities:
                seen_entities.add(nid)
                cat = node.category
                if cat and cat.strip():
                    return f"**{name}** ({cat.strip()})"
                return f"**{name}**"
            return name

        # ── Content dedup (hash compressed output) + uniqueness tracking ─────
        rendered_lod0_hashes: set[str] = set()
        _dedup_rendered = 0
        _dedup_skipped = 0

        # ── Build output ─────────────────────────────────────────────────────
        lines: list[str] = []

        # ── Preamble ─────────────────────────────────────────────────────────
        lines.append(
            "The following contains verified facts relevant to your question. "
            "Focus on the Evidence section for your answer."
        )
        lines.append("")

        # ── Query decomposition for multi-hop ────────────────────────────────
        _is_multihop = False
        if intent is not None:
            _is_multihop = intent.reasoning_depth > 0.5
            if not _is_multihop:
                query_lower = query.lower()
                _chain_kw = any(w in query_lower for w in (
                    "of the", "who played", "whose", "the same",
                    "named after", "went to the same", "parent company",
                    "record label of", "singer of", "director of",
                ))
                _is_multihop = _chain_kw

        if _is_multihop and intent is not None:
            entities = getattr(intent, 'entities', []) or []
            if len(entities) >= 2:
                lines.append("**Reasoning steps:**")
                for i, ent in enumerate(entities, 1):
                    ent_name = ent.get("text", ent) if isinstance(ent, dict) else str(ent)
                    if i < len(entities):
                        lines.append(f"- Step {i}: Identify {ent_name}")
                    else:
                        lines.append(f"- Step {i}: Find the answer using {ent_name}")
                lines.append("")
            elif intent.temporal_reference_date is not None:
                lines.append(
                    "**Note:** Pay attention to dates and time periods in the evidence."
                )
                lines.append("")

        # ── Zone 1: Evidence (LOD_0 and LOD_1 passages) ──────────────────────
        evidence_blocks: list[tuple[str, str, int | None]] = []  # (nid, content, temporal_min)

        for nid, lod in sorted_nodes:
            if lod not in (LODLevel.LOD_0, LODLevel.LOD_1):
                continue

            node = nodes.get(nid)
            if not node:
                continue

            sn = sn_map.get(nid)

            # Observation manifold: read from ALL passages for this entity.
            # F5.1: filter to entity-relevant sentences via entity_name.
            raw_lod0 = self.get_entity_full_text(nid, entity_name=node.name) or node.lod_0

            if lod == LODLevel.LOD_0:
                raw_lod0 = normalize_relative_dates(raw_lod0)
                if sn and sn.token_budget > 0 and sn.token_budget < estimate_tokens(raw_lod0):
                    content = compress(raw_lod0, query, sn.token_budget, intent=intent)
                else:
                    content = apply_topological_shading(raw_lod0, query) if query else raw_lod0
                content_hash = hashlib.md5(content.encode()).hexdigest()
                if content_hash in rendered_lod0_hashes:
                    _dedup_skipped += 1
                    continue
                rendered_lod0_hashes.add(content_hash)
                _dedup_rendered += 1

            elif lod == LODLevel.LOD_1:
                # LOD_Z: compress from observation manifold with query awareness.
                if raw_lod0 and sn and sn.token_budget > 0:
                    raw_lod0 = normalize_relative_dates(raw_lod0)
                    content = compress(raw_lod0, query, sn.token_budget, intent=intent)
                    content_hash = hashlib.md5(content.encode()).hexdigest()
                    if content_hash in rendered_lod0_hashes:
                        _dedup_skipped += 1
                        continue
                    rendered_lod0_hashes.add(content_hash)
                    _dedup_rendered += 1
                else:
                    content = node.get_at_lod(lod)
            else:
                continue

            # Get temporal_min for chronological sorting
            t_data = _temporal_for_entity.get(nid)
            t_min = t_data[0] if t_data else None

            evidence_blocks.append((nid, content, t_min))

        # Temporal ordering
        _use_temporal_order = False
        if intent is not None:
            temporal_axis = intent.content_axes.get("temporal", 0.0)
            _use_temporal_order = (
                temporal_axis > 0.3
                or intent.temporal_reference_date is not None
            )
        if _use_temporal_order:
            evidence_blocks.sort(key=lambda x: (x[2] is None, x[2] or 9999))

        if evidence_blocks:
            lines.append("## Evidence")
            lines.append("")
            for nid, content, t_min in evidence_blocks:
                ref = entity_ref(nid)
                # Temporal tag
                t_data = _temporal_for_entity.get(nid)
                temporal_tag = ""
                if t_data:
                    tmin, tmax = t_data
                    if tmin == tmax:
                        temporal_tag = f" [Year: {tmin}]"
                    else:
                        temporal_tag = f" [Years: {tmin}-{tmax}]"

                lines.append(f"{ref}{temporal_tag}:")
                # Answer highlighting
                _content_lines = content.strip().split("\n")
                if len(_content_lines) > 2 and query:
                    from tp_vrg.compression import query_words as get_query_words
                    qw = get_query_words(query)
                    best_idx = 0
                    best_score = -1
                    for idx, sent in enumerate(_content_lines):
                        sw = set(sent.lower().split())
                        overlap = len(qw & sw)
                        if overlap > best_score:
                            best_score = overlap
                            best_idx = idx
                    if best_score > 0:
                        _content_lines[best_idx] = ">>> " + _content_lines[best_idx]
                lines.append("\n".join(_content_lines))
                lines.append("")

        # ── Zone 2: How Things Connect ────────────────────────────────────────
        relationship_sentences: list[str] = []

        # Pre-pass: motif compression on internal (both endpoints rendered)
        # edges that pass the type-weighted admission gate. Captures
        # hub-and-spoke, fan-out, and compact-adjacency patterns into
        # single natural-language sentences instead of N bullets.
        #
        # Admission per arch-edge-rendering-design.md Addendum Impact 2+3:
        #   semantic edges    → type_weight 1.0 (always admitted)
        #   hierarchical      → type_weight 0.0 (always rejected; rendered via nesting)
        #   structural edges  → type_weight 0.3 + 1.2 × intent.temporal_weight
        #                       (suppressed under non-temporal intent;
        #                        promoted under temporal — chain rendering
        #                        in Phase 4 will additionally compress
        #                        structural sequences as chain motifs).
        internal_valid: list[tuple[str, str, str]] = []
        for u, v, data in edges:
            if u not in rendered_ids or v not in rendered_ids:
                continue
            if not (nodes.get(u) and nodes.get(v)):
                continue
            relation = data.get("relation", "")
            type_weight = _edge_type_weight(relation, intent)
            if type_weight < EDGE_ADMISSION_WEIGHT_THRESHOLD:
                continue
            internal_valid.append((u, v, relation))

        # Split admitted edges by relation class. Semantic motifs (hub-spoke
        # / fan-out / compact-adj) come from analyze_motifs; chain motifs
        # come from _detect_chains over structural edges only.
        non_structural_edges: list[tuple[str, str, str]] = []
        structural_edges_admitted: list[tuple[str, str, str]] = []
        for u, v, rel in internal_valid:
            if rel in STRUCTURAL_RELATIONS:
                structural_edges_admitted.append((u, v, rel))
            else:
                non_structural_edges.append((u, v, rel))

        motif_analysis = analyze_motifs(non_structural_edges, threshold=MOTIF_THRESHOLD)
        chain_motifs = _detect_chains(structural_edges_admitted, min_chain_edges=2)

        # Build the union of covered (u, v, relation) triples across both
        # semantic motifs and chain motifs, so the per-edge fallback loop
        # can skip everything absorbed by either.
        chain_covered: set[tuple[str, str, str]] = set()
        for chain in chain_motifs:
            for i in range(len(chain.members) - 1):
                chain_covered.add(
                    (chain.members[i][0], chain.members[i + 1][0], chain.relation)
                )

        all_covered = motif_analysis.covered | chain_covered

        # Emit motifs as natural-language sentences (clean format).
        for motif in motif_analysis.motifs + chain_motifs:
            if motif.kind == "hub_spoke":
                pivot_node = nodes.get(motif.pivot)
                if not pivot_node:
                    continue
                pivot_ref = entity_ref(motif.pivot)
                member_refs = [entity_ref(m) for m, _ in motif.members]
                joined = _join_natural(member_refs)
                phrase = ContextRenderer.relation_to_phrase(motif.relation)
                # Convert singular-subject phrase to plural for the N-member
                # list. "is an instance of" → "are an instance of" etc.
                plural_phrase = _pluralize_relation_phrase(phrase)
                connector = "all" if len(member_refs) > 2 else "both"
                relationship_sentences.append(
                    f"- {joined} {connector} {plural_phrase} {pivot_ref}."
                )
            elif motif.kind == "fan_out":
                pivot_node = nodes.get(motif.pivot)
                if not pivot_node:
                    continue
                pivot_ref = entity_ref(motif.pivot)
                target_refs = [entity_ref(t) for t, _ in motif.members]
                joined = _join_natural(target_refs)
                phrase = ContextRenderer.relation_to_phrase(motif.relation)
                relationship_sentences.append(
                    f"- {pivot_ref} {phrase} {joined}."
                )
            elif motif.kind == "compact_adj":
                pivot_node = nodes.get(motif.pivot)
                if not pivot_node:
                    continue
                pivot_ref = entity_ref(motif.pivot)
                parts: list[str] = []
                for t, rel in motif.members:
                    t_ref = entity_ref(t)
                    phrase = ContextRenderer.relation_to_phrase(rel)
                    parts.append(f"{phrase} {t_ref}")
                relationship_sentences.append(
                    f"- {pivot_ref}: " + ", ".join(parts) + "."
                )
            elif motif.kind == "chain":
                # Chain motif: ordered node sequence with shared relation.
                # Per arch-edge-rendering-design.md §3c, chain notation:
                #   [N1] → [N2] → [N3] (via: calls)
                # Skips chain if any node along the path is missing from
                # the rendered nodes dict (defensive).
                if any(not nodes.get(n) for n, _ in motif.members):
                    continue
                node_refs = [entity_ref(n) for n, _ in motif.members]
                chain_arrow = " → ".join(node_refs)
                relationship_sentences.append(
                    f"- {chain_arrow} (via: {motif.relation})."
                )

        # Per-edge fallback loop: emit bullets for boundary edges + internal
        # edges not absorbed by motifs. Singletons are rendered here rather
        # than via motif_analysis.singletons because we also need the
        # boundary-edge handling that's specific to clean format (one
        # endpoint not rendered → use clean_entity_name for the outer side).
        motif_covered = all_covered
        for u, v, data in edges:
            if u not in rendered_ids or v not in rendered_ids:
                u_in = u in rendered_ids
                v_in = v in rendered_ids
                if not (u_in or v_in):
                    continue
                relation = data.get("relation", "")
                # Boundary edges follow the same type-weight admission rule
                # as internal edges. Without this, structural-flow edges to
                # outer nodes (e.g., "_follows" to a chunk we didn't admit)
                # would render under temporal intent, violating the Phase 3
                # contract.
                if _edge_type_weight(relation, intent) < EDGE_ADMISSION_WEIGHT_THRESHOLD:
                    continue
                if u_in:
                    u_node = nodes.get(u)
                    v_node = nodes.get(v)
                    if u_node and v_node:
                        u_ref = entity_ref(u)
                        v_name = ContextRenderer.clean_entity_name(v_node.name)
                        phrase = ContextRenderer.relation_to_phrase(relation)
                        relationship_sentences.append(
                            f"- {u_ref} {phrase} {v_name}."
                        )
                elif v_in:
                    u_node = nodes.get(u)
                    v_node = nodes.get(v)
                    if u_node and v_node:
                        u_name = ContextRenderer.clean_entity_name(u_node.name)
                        v_ref = entity_ref(v)
                        phrase = ContextRenderer.relation_to_phrase(relation)
                        relationship_sentences.append(
                            f"- {u_name} {phrase} {v_ref}."
                        )
                continue

            relation = data.get("relation", "")
            if _edge_type_weight(relation, intent) < EDGE_ADMISSION_WEIGHT_THRESHOLD:
                continue
            if (u, v, relation) in motif_covered:
                continue  # absorbed by motif rendering above

            u_node = nodes.get(u)
            v_node = nodes.get(v)
            if not (u_node and v_node):
                continue

            u_ref = entity_ref(u)
            v_ref = entity_ref(v)
            phrase = ContextRenderer.relation_to_phrase(relation)
            relationship_sentences.append(f"- {u_ref} {phrase} {v_ref}.")

        # Budget limit on relationships
        if edge_budget:
            remaining = edge_budget
            capped_rels: list[str] = []
            for s in relationship_sentences:
                cost = estimate_tokens(s)
                if cost > remaining:
                    break
                remaining -= cost
                capped_rels.append(s)
            relationship_sentences = capped_rels

        if relationship_sentences:
            lines.append("## How Things Connect")
            lines.append("")
            lines.extend(relationship_sentences)
            lines.append("")

        # ── LOD_2 entities as compact list ────────────────────────────────────
        lod2_entities: list[str] = []
        for nid, lod in sorted_nodes:
            if lod != LODLevel.LOD_2:
                continue
            node = nodes.get(nid)
            if not node:
                continue
            name = ContextRenderer.clean_entity_name(node.name)
            cat = node.category
            if cat and cat.strip():
                lod2_entities.append(f"{name} ({cat.strip()})")
            else:
                lod2_entities.append(name)

        if lod2_entities:
            lines.append(f"**Also relevant:** {', '.join(lod2_entities)}")
            lines.append("")

        dedup_stats = {"rendered": _dedup_rendered, "skipped": _dedup_skipped}
        return "\n".join(lines), dedup_stats

    def format_passages(
        self,
        passages: list[SourcePassage],
        query: str,
        token_budget: int = 4000,
        intent: Any = None,
    ) -> tuple[str, dict[str, int], list[str]]:
        """Render passages directly with LOD_Z compression. No entity pipeline.

        Tier 1 rendering: passages arrive pre-sorted by cosine relevance from
        macro_search. Greedy budget fill with per-passage LOD_Z compression.
        F18 format: preamble + ## Evidence + passage blocks with source headers.

        Returns (context_str, dedup_stats, rendered_passage_ids).

        The third return element lists the passage_ids of passages that
        actually made it into the rendered context (not skipped by dedup or
        budget). Used by F16 citation capture. Order matches the rendering
        order in the final context.
        """
        if not passages:
            return "", {"rendered": 0, "skipped": 0}, []

        rendered_hashes: set[str] = set()
        rendered = 0
        skipped = 0
        remaining_budget = token_budget
        rendered_passage_ids: list[str] = []

        lines: list[str] = []
        lines.append(
            "The following contains verified facts relevant to your question. "
            "Focus on the Evidence section for your answer."
        )
        lines.append("")
        lines.append("## Evidence")
        lines.append("")

        # Reading-order fiber: collect seq-neighbor text to inject alongside
        # rendered passages. Adds legend/context for table chunks and section
        # references without additional retrieval or LLM calls.
        fiber_context: dict[str, list[dict]] = {}
        if self._provenance is not None:
            for passage in passages:
                if not (passage.raw_text or "").strip():
                    continue
                ctx_segs = self._provenance.get_segment_context(
                    passage.passage_id, window=1,
                )
                if len(ctx_segs) > 1:
                    fiber_context[passage.passage_id] = ctx_segs

        for passage in passages:
            raw = passage.raw_text or ""
            if not raw.strip():
                continue

            # Per-passage budget: give each passage a fair share but allow greedy fill
            passage_token_estimate = estimate_tokens(raw)
            if remaining_budget <= 0:
                break

            passage_budget = min(passage_token_estimate, remaining_budget)

            # Normalize relative dates before compression
            raw = normalize_relative_dates(raw)

            # --- Reading-order fiber: prepend/append neighbor context ---
            # When provenance is available, inject seq-neighbor text from the
            # same source document. This recovers table legends, anaphora
            # antecedents, and section introductions that chunking severed.
            fiber_prefix = ""
            fiber_suffix = ""
            if passage.passage_id in fiber_context:
                segments = fiber_context[passage.passage_id]
                # Find self's seq to determine before/after
                self_seq = None
                for seg in segments:
                    if seg["segment_id"] == passage.passage_id:
                        self_seq = seg["seq"]
                        break
                if self_seq is not None:
                    rendered_pid_set = {p.passage_id for p in passages}
                    for seg in segments:
                        if seg["segment_id"] == passage.passage_id:
                            continue  # skip self
                        neighbor_text = (seg.get("text") or "").strip()
                        if not neighbor_text:
                            continue
                        # Don't re-inject if the neighbor is also a rendered passage
                        if seg["segment_id"] in rendered_pid_set:
                            continue
                        neighbor_tokens = estimate_tokens(neighbor_text)
                        if remaining_budget - passage_budget - neighbor_tokens < 0:
                            continue  # skip if no budget
                        if seg["seq"] < self_seq:
                            fiber_prefix = f"[preceding context]\n{neighbor_text}\n\n"
                        else:
                            fiber_suffix = f"\n\n[following context]\n{neighbor_text}"
                        passage_budget += neighbor_tokens

            content_with_fiber = fiber_prefix + raw + fiber_suffix

            # LOD_Z compression: select query-relevant sentences within budget
            if passage_budget < estimate_tokens(content_with_fiber):
                content = compress(content_with_fiber, query, passage_budget, intent=intent)
            else:
                content = content_with_fiber

            # Content dedup: hash compressed output
            content_hash = hashlib.md5(content.encode()).hexdigest()
            if content_hash in rendered_hashes:
                skipped += 1
                continue
            rendered_hashes.add(content_hash)

            # Consume budget
            actual_tokens = estimate_tokens(content)
            remaining_budget -= actual_tokens
            rendered += 1
            rendered_passage_ids.append(passage.passage_id)

            # Source label as header
            source_label = passage.source_label or passage.passage_id
            lines.append(f"**{source_label}:**")
            lines.append(content)
            lines.append("")

        # --- Long-range structural-reference resolution (reading-order fiber) ---
        #
        # General pattern: a short identifier phrase in one chunk points to the
        # CONTENT of that identifier living elsewhere in the same source. This
        # is domain-independent — the identifier keyword varies (Schedule /
        # Section / Figure / Theorem / Chapter) but the shape is constant:
        #
        #   <structural-keyword> <short-identifier>
        #       ("Schedule A", "Section 2.3", "Figure 5", "Theorem 4.1",
        #        "Article IV", "Exhibit B", "Chapter 3", "Table 2", ...)
        #
        # SP-8 solves LOCALITY — seq-neighbors of retrieved passages.
        # This block solves CROSS-REFERENCE — content that lives at a NAMED
        # section heading which can be arbitrarily far (seq-distance) from the
        # retrieved passage. The two mechanisms are ORTHOGONAL, not substitutive.
        # Mode 7 Q5 ("Which stockholders are named on Schedule A…?") is the
        # empirical proof: SP-8 alone fails Q5 (confirmed 2026-04-16 in run
        # sp8_validation_18q_v3) because "Schedule A" as a TABLE lives dozens
        # of chunks after the body prose that first mentions it.
        #
        # Generality of THIS implementation (the 2026-04-16 keystone fix):
        #   1. Pattern matches structural-keyword + identifier across SEVEN
        #      domain-pattern families (legal, technical, visual, academic,
        #      numbered, formal-statements, document-forms) — covers far more
        #      than the original legal-only (Schedule / Exhibit / Appendix /
        #      Annex) regex. Case-insensitive.
        #   2. Scans BOTH the user's QUERY (highest-signal source of the
        #      reference intent) and the already-rendered CONTEXT (in case the
        #      query is implicit and the retrieved body makes the reference).
        #   3. Delegates the semantic heading-vs-body distinction to
        #      `provenance.find_segment_by_heading`, which already prefers
        #      bold-markdown headings, then `#`-markdown headings, then
        #      fall-back last-mention-by-seq. Provenance owns the
        #      what-is-a-heading decision; the renderer just hands it candidates.
        #   4. Reserved budget (2000 tokens) independent of the main rendering
        #      budget — the referenced section IS often the answer, so starving
        #      it against body content would defeat the purpose. Total context
        #      may temporarily exceed token_budget by up to section_ref_budget
        #      tokens; the Governor handles final trimming downstream.
        #
        # Remaining gaps (future-work items, not blockers):
        #   - No support for "[12]"-style footnote/citation references.
        #   - No support for back-reference phrases without a structural keyword
        #     ("as discussed above", "per the previous paragraph").
        #   - No GLiNER-entity-driven detection of user-defined reference names
        #     that don't match the structural keyword family.
        section_ref_budget = 2000
        if self._provenance is not None:
            # Domain-general structural-reference pattern. The keyword classes
            # cover: legal (Schedule/Exhibit/Appendix/Annex/Attachment),
            # document-structural (Section/Subsection/Article/Chapter/Part/
            # Clause/Paragraph/Item), visual (Figure/Fig./Table/Diagram/Chart),
            # academic (Theorem/Lemma/Corollary/Proposition/Definition), and
            # forms/notes (Form/Box/Footnote/Fn./Note/Endnote). The identifier
            # is a letter (A-Z), a number (possibly dotted like 2.3), a Roman
            # numeral (I-X family), or a dotted mix. Word-boundary or
            # end-of-string terminator keeps the match tight.
            section_ref_pattern = re.compile(
                r"(?:Schedule|Exhibit|Appendix|Annex|Attachment|"
                r"Section|Subsection|Article|Chapter|Part|Clause|Paragraph|Item|"
                r"Figure|Fig\.|Table|Diagram|Chart|"
                r"Theorem|Lemma|Corollary|Proposition|Definition|"
                r"Form|Box|Footnote|Fn\.|Note|Endnote)"
                r"\s+"
                r"(?:[A-Z]|\d+(?:\.\d+)*|[IVXLC]+)"
                r"(?:\b|$)",
                re.IGNORECASE,
            )
            # Scan query FIRST (highest signal of user intent), then context.
            # Dedupe by lowercase to merge "Schedule A" and "schedule a".
            scan_targets = [
                (query or ""),
                "\n".join(lines),
            ]
            seen_refs_lc: set[str] = set()
            unique_refs: list[str] = []
            for target in scan_targets:
                for m in section_ref_pattern.findall(target):
                    key = m.strip().lower()
                    if key and key not in seen_refs_lc:
                        seen_refs_lc.add(key)
                        unique_refs.append(m.strip())

            if unique_refs:
                for ref in unique_refs[:5]:  # cap to avoid budget explosion
                    for pid in rendered_passage_ids:
                        source_id = self._provenance.get_source_id_for_segment(pid)
                        if source_id is None:
                            continue
                        heading_seg = self._provenance.find_segment_by_heading(
                            source_id, ref,
                        )
                        if heading_seg is None:
                            continue
                        section_segs = self._provenance.get_segment_context(
                            heading_seg["segment_id"], window=2,
                        )
                        for seg in section_segs:
                            if seg["segment_id"] in rendered_hashes:
                                continue
                            seg_text = (seg.get("text") or "").strip()
                            if not seg_text:
                                continue
                            seg_tokens = estimate_tokens(seg_text)
                            if section_ref_budget - seg_tokens < 0:
                                continue
                            seg_hash = hashlib.md5(seg_text.encode()).hexdigest()
                            if seg_hash in rendered_hashes:
                                continue
                            rendered_hashes.add(seg_hash)
                            section_ref_budget -= seg_tokens
                            rendered += 1
                            rendered_passage_ids.append(seg["segment_id"])
                            source_label = (
                                heading_seg.get("source_label")
                                or seg.get("source_label")
                                or seg["segment_id"]
                            )
                            lines.append(f"**{source_label}[{ref}]:**")
                            lines.append(seg_text)
                            lines.append("")
                        break  # found in this source, don't check other passages

        return "\n".join(lines), {"rendered": rendered, "skipped": skipped}, rendered_passage_ids
