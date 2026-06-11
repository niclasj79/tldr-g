"""Pydantic data models for the TP-VRG knowledge graph."""

from __future__ import annotations

from dataclasses import dataclass, field
import os
import time
from enum import IntEnum

from pydantic import BaseModel, Field

# Constants for LOD0 chunking
CHUNK_MAX_CHARS = 1500  # ~375 tokens at 4 chars/token, aligned to TARGET_TOKENS=384
# spaCy max_length ceiling guard.
# Default spaCy limit is 1_000_000 chars; keep headroom for call-site framing.
SPACY_CEILING_CHARS: int = 900_000

# Graph-per-Node: number of passages to retrieve in macro search (Stage 1)
# Override via TPVRG_MACRO_TOP_K env var for sweep experiments.
MACRO_TOP_K: int = int(os.environ.get("TPVRG_MACRO_TOP_K", "25"))

# SP-6: Passage-level topology expansion after macro search.
# Follows structural edges (_session_follows, _follows) from selected passages
# to adjacent passages before micro tessellation. Fractal application of the
# SP-6: Passage-level fractal stitching — same principle as entity-level stitching.
# Follows structural edges after macro search to pull in topologically adjacent passages.
# Default "both": you don't chop topology and then wonder why context is missing.
# "none" = disabled, "session" = _session_follows only, "follows" = _follows only, "both" = both.
MACRO_TOPOLOGY: str = os.environ.get("TPVRG_MACRO_TOPOLOGY", "both")
MACRO_TOPO_MAX_NEIGHBORS: int = int(os.environ.get("TPVRG_MACRO_TOPO_MAX", "10"))
SIMILARITY_EDGE_MAX_PER_SOURCE: int = int(
    os.environ.get("TPVRG_SIMILARITY_EDGE_MAX_PER_SOURCE", "3")
)
SIMILARITY_EDGE_MAX_TOTAL_ADDITIONS: int = int(
    os.environ.get("TPVRG_SIMILARITY_EDGE_MAX_TOTAL", "10")
)
# Conservative scalar for ordering baked similarity-edge candidates inside the
# topology expansion stage. It does not compute cosine on the query path; it only
# weights the persisted cosine so symbolic/topological seeds keep priority.
SIMILARITY_EDGE_TRAVERSAL_WEIGHT: float = float(
    os.environ.get("TPVRG_SIMILARITY_EDGE_TRAVERSAL_WEIGHT", "0.35")
)

# Edge rendering constants — configurable ceilings for context assembly.
# Phase B (unified governor budget) will replace MAX_RENDERED_EDGES with a
# proper token-budget-based limit; these are safety ceilings until then.
STUBBLE_CAP = 10  # Max boundary edges to render; remaining count shown as summary
MAX_RENDERED_EDGES = 200  # Safety ceiling for internal edge rendering (~3K tokens)
# Phase D: minimum group size to trigger hub-and-spoke / fan-out motif compression
MOTIF_THRESHOLD: int = 3

# Governor candidate cap: minimum tokens a node needs to justify rendering.
# Nodes that would receive less than this from proportional allocation are
# dropped before budget distribution, preventing LOD_2 flood.
# Budget-derived: max_nodes = node_budget // MIN_BUDGET_PER_NODE.
# Scales naturally with profiles: chat(2K)→25, code_simple(5K)→62, research(10K)→125.
MIN_BUDGET_PER_NODE: int = int(os.environ.get("TPVRG_MIN_BUDGET_PER_NODE", "80"))

# Hard ceiling on the number of nodes the governor will render, regardless of budget.
# Separates "breadth" from "budget depth": a larger token budget deepens detail on
# the same ~50 nodes rather than admitting hundreds of shallow LOD_2 labels.
# The benchmark finding is 25k budget (312 nodes) scores WORSE than 5k (62 nodes)
# because the LLM drowns in LOD_1 summaries. This cap forces depth over breadth.
# Stopgap until Liquid LOD Phase C (Intent Vector) handles this dynamically.
# Override via TokenProfile.max_nodes or by passing max_nodes to governor.apply_budget().
MAX_NODES_DEFAULT: int = int(os.environ.get("TPVRG_MAX_NODES_DEFAULT", "50"))
QUERY_BUDGET_BASE: int = int(os.environ.get("TPVRG_QUERY_BUDGET_BASE", "10000"))

# Phase C: Hierarchical relation types — rendered as markdown nesting in the
# node section, not as explicit edges in the skeleton (zero explicit tokens).
# "child-first": edge source=child, target=parent (e.g., car part_of vehicle)
CHILD_FIRST_RELATIONS: frozenset[str] = frozenset({"part_of", "is_a", "instance_of"})
# "parent-first": edge source=parent, target=child (e.g., vehicle contains engine)
PARENT_FIRST_RELATIONS: frozenset[str] = frozenset({"contains", "has_attribute", "has_property"})
# Union: all relation types that trigger implicit topology nesting
HIERARCHICAL_RELATIONS: frozenset[str] = CHILD_FIRST_RELATIONS | PARENT_FIRST_RELATIONS

# Structural edges — ingestion-time topology infrastructure.
# These encode document flow (chunk ordering, mention sequence, session ordering)
# and must be EXCLUDED from betweenness centrality computation.
# They are used only for: traversal (neighborhood expansion), rendering (temporal framing).
# Including them in backbone would cause a "PageRank Hijack": a 15-chunk article creates
# a 14-edge chain that artificially inflates centrality for all nodes along the chain.
STRUCTURAL_RELATIONS: frozenset[str] = frozenset({
    "_follows",           # Layer 2: chunk K tail → chunk K+1 head
    "_precedes",          # Layer 2: temporal chain across chunks
    "_co_doc",            # Layer 2: cross-chunk co-occurrence
    "_mentioned_before",  # Layer 2b (future): intra-chunk mention order
    "_session_follows",   # Layer 0 (future): inter-session ordering
    "_session_precedes",  # Layer 0 (future): inter-session temporal
    "_covers_period",      # F14: passage → TEMPORAL_ANCHOR (metadata, not semantic)
})
# NOTE: "occurred_at" (entity → TEMPORAL_ANCHOR) is intentionally NOT structural.
# It MUST participate in betweenness centrality so TEMPORAL_ANCHOR nodes become
# high-centrality backbone hubs that bridge temporal multi-hop queries.

# Bundle algebra relation-class axes.
# Canonical source for algebra sigma-vector width (INV-1): new modules import
# RELATION_CLASS_COUNT instead of redefining the five-axis taxonomy.
RELATION_CLASSES: tuple[str, ...] = (
    "temporal",
    "causal",
    "factual",
    "episodic",
    "authorial",
)
RELATION_CLASS_INDEX: dict[str, int] = {
    relation_class: idx for idx, relation_class in enumerate(RELATION_CLASSES)
}
RELATION_CLASS_COUNT: int = len(RELATION_CLASSES)

# Canonical backbone centrality default.
# Satellites and storage backends must resolve from this constant (INV-1).
DEFAULT_CENTRALITY_MEASURE: str = "pagerank"

# Canonical community-partition default.
# Offline bake tasks must resolve from this constant (INV-1).
DEFAULT_PARTITION_ALGORITHM: str = "leiden"

# Default-off similarity objective for the Asset -> Island partition bake.
# When enabled, baked Asset similarity edges are folded into the inter-Asset
# partition graph as integer weights. Existing bakes opt in explicitly.
PARTITION_USE_SIMILARITY_ENV: str = "TPVRG_PARTITION_USE_SIMILARITY"
PARTITION_SIMILARITY_WEIGHT_ENV: str = "TPVRG_PARTITION_SIMILARITY_WEIGHT"
TPVRG_PARTITION_USE_SIMILARITY: bool = (
    os.environ.get(PARTITION_USE_SIMILARITY_ENV, "off").strip().lower()
    in {"1", "true", "yes", "on"}
)
TPVRG_PARTITION_SIMILARITY_WEIGHT: float = float(
    (os.environ.get(PARTITION_SIMILARITY_WEIGHT_ENV) or "100").strip()
)
if TPVRG_PARTITION_SIMILARITY_WEIGHT <= 0.0:
    raise ValueError(f"{PARTITION_SIMILARITY_WEIGHT_ENV} must be > 0")

# Canonical graph-distance decay exponent.
# Engine/scoring defaults must resolve from this constant (INV-1).
# FLIPPED 2026-06-02 (founder decision a): 1.67 → 0.5 per EXP-037 evidence
# (0.5 won 18/18 on legal multi-hop; 1.67 = wrong Kolmogorov 5/3 turbulence value
# that was never validated for this domain). EXP-079 FRAMES confirmation owed but
# deferred — machine reboots under FRAMES load (thermal/PSU; kernel-power event 41).
DEFAULT_KOLMOGOROV_DECAY_EXPONENT: float = 0.5

# Janitor: entity merge — cosine similarity threshold for duplicate detection.
# Pairs above this threshold with matching category are merge candidates.
MERGE_COSINE_THRESHOLD: float = 0.92

# Entity normalization fuzzy deduplication threshold.
# Override via TPVRG_FUZZY_THRESHOLD for benchmark sweeps.
FUZZY_THRESHOLD: float = float(os.environ.get("TPVRG_FUZZY_THRESHOLD", "0.85"))

# Reciprocal Rank Fusion for macro search.
# When true, passage_embedding + question_embedding + FTS5 are fused via RRF
# instead of max-merge. Gives lexical (BM25) results co-equal ranking power.
RRF_FUSION: bool = os.environ.get("TPVRG_RRF_FUSION", "true").lower() == "true"
RRF_K: int = int(os.environ.get("TPVRG_RRF_K", "60"))

# Contextual chunk/session embedding during ingestion.
# When enabled, source metadata is prepended to embedding input only.
CONTEXTUAL_EMBEDDING: bool = os.environ.get(
    "TPVRG_CONTEXTUAL_EMBEDDING", "true"
).lower() == "true"

# Sentence-level embeddings for fine-grained macro retrieval.
# Each passage sentence gets its own embedding vector. At query time,
# sentence embeddings are an additional RRF channel alongside passage
# and HyPE question embeddings. Fixes the diagnosed macro retrieval
# bottleneck where passage-level single-vector embeddings miss topics
# that are minor within the passage but match the query exactly.
SENTENCE_EMBEDDINGS_ENABLED: bool = os.environ.get(
    "TPVRG_SENTENCE_EMBEDDINGS", "true"
).lower() == "true"

# Entity-level embedding cascade (B1 audit 2026-04-22; Path C-prime 2026-04-23).
#
# Default is OFF (lean-mode default) — the audit on the Mode 7 M&A corpus
# showed 0pp accuracy delta between cascade-on and cascade-off, with a
# 32% ingest speedup and 10% query speedup when disabled. See
# [[.claude/plans/lane-b/2026-04-22-whitepaper-audit-b1-b3/item-1-entity-embedding-audit.md]]
# for the full measurement.
#
# The flag (and the code behind it) is RETAINED because the cascade
# provides architectural optionality for Phase 2+ directions —
# Knowledge Maturity Model Tier 2 (latent topology via entity-embedding
# communities), Asset-level document retrieval, and Mode 3 structural-
# analogy (Glass Bead Game) all depend on entity-level embedding as a
# primitive. Deleting the code would force re-implementation when
# those directions ship. See [[docs/design/arch-mechanism-mode-profiles.md]]
# for the broader mode-profile architecture this flag exemplifies.
#
# When enabled, ingestion computes one BGE-large vector per entity and
# stores it in node_embeddings. Query paths use these embeddings in:
# (R1) Entity Bridge triple-union seed resolution at retrieval.py; (R2)
# the flat vector_search fallback when passage+ghost retrieval returns
# empty; (R3) the composite-score S (semantic proximity) signal in
# scoring.py; and (R4) the janitor merge task duplicate detection.
# When disabled, ingestion skips the per-entity embed() call and the
# entity vector_search read sites degrade to their non-embedding
# fallbacks (lexical/FTS5 seed resolution; substring retrieval fallback;
# sem=0.0 in the composite scoring — the other 5 signals carry the
# score). R4 (janitor merge) becomes a no-op when no entity embeddings
# exist; over time this means duplicate-entity detection degrades.
# Heterogeneous / multi-context corpora may want this re-enabled.
#
# To re-enable: TPVRG_ENTITY_EMBEDDING=on
ENTITY_EMBEDDINGS_ENABLED: bool = os.environ.get(
    "TPVRG_ENTITY_EMBEDDING", "off"
).lower() in ("on", "true", "1", "yes")

# LOD_0-survives invariant (B3 audit 2026-04-22; governor.py Pass 3).
#
# The Token Governor's Pass 3 was originally written to guarantee that the
# highest-scored node always receives at least its full LOD_0 budget — by
# stealing budget from lower-scored nodes if proportional allocation left it
# short. The B3 audit (sprint 2026-04-22-whitepaper-audit-b1-b3, Step 3 run
# 2026-04-23 → 04-24) measured the invariant's effect on the M&A Mode 7 corpus:
#   Strict accuracy  — 5.56% ON vs 5.56% OFF (0.00pp delta)
#   Lenient accuracy — 100% ON vs 100% OFF  (0.00pp delta)
#   Ingest wall-clock — 1290.9s ON vs 1193.8s OFF (flag-on is 8.1% slower)
#   Node/edge counts — identical (±17 edges within run variance)
# Verdict: CEREMONIAL. Founder rationale (2026-04-24): "With an accurate
# enough LOD_Z selection method, no LOD_0 will reasonably be necessary in
# rendered context." Default flipped OFF; flag kept as escape hatch (mirrors
# the B1 Path C-prime landing on TPVRG_ENTITY_EMBEDDING).
#
# Patent cross-check (Step 1, [[.claude/plans/lane-b/2026-04-22-whitepaper-audit-b1-b3/item-2-lod0-invariant-audit.md]]):
# GREEN — no independent or dependent claim in the filed application
# (P 26-0025SE) requires this specific invariant. Lowest-first coarsening
# order (Claim 1c, 3b) is a strictly weaker property that remains independent
# of this flag.
#
# The Governor's unconditional MIN_NODE_TOKENS floor on the top node
# (guaranteeing a non-empty render) is SEPARATE from this invariant and
# remains in effect regardless of the flag — that floor is about rendering
# liveness, not about LOD_0.
#
# To re-enable for comparison: TPVRG_LOD0_INVARIANT=on
LOD0_INVARIANT_ENABLED: bool = os.environ.get(
    "TPVRG_LOD0_INVARIANT", "off"
).lower() in ("on", "true", "1", "yes")

# USR (Unified Render Selector) strategy set — audit ablation flag,
# sprint 2026-04-23-usr-audit Step 3.
#
# Valid values:
#   "all"            — run all 4 strategies in _c3_select, pick highest L
#                      (current default; unchanged pipeline)
#   "topology-only"  — skip _c3_select entirely; always return the primary
#                      topology (passage-scope) render
#   "passage-only"   — bypass the topology render result; return cosine_fill
#                      output exclusively (pure semantic similarity,
#                      lean-mode baseline)
#   "2-primary"      — inside _c3_select, run topology + cosine_fill only;
#                      skip topology_relaxed + entity_topology
#   "tier1-all-no-entity" — run topology + topology_relaxed + cosine_fill;
#                      skip entity_topology only. Safe operational mitigation
#                      when Tier 2's compute cost is unacceptable but the
#                      relaxed-topology and cosine-fill alternatives should
#                      still compete (added 2026-04-28 after the Tier 2
#                      entity-render failure-trace synthesis surfaced that
#                      "2-primary" wrongly skips topology_relaxed, which
#                      wins on many slow Mode 7 queries).
#
# Only the winner strategy's confidence (L) is populated in the emitted
# RenderDecision under the restricted modes; other strategy_*_L fields are
# None (already supported by the dataclass).
#
# Invalid values raise at module import so typos surface immediately rather
# than silently degrading to the default.
_VALID_USR_STRATEGIES: frozenset[str] = frozenset(
    {"all", "topology-only", "passage-only", "2-primary", "tier1-all-no-entity"}
)
# Global default flipped 2026-05-14 morning from "all" -> "tier1-all-no-entity"
# per founder direction "greenlight global flip" + Option-A LongMemEval audit.
#
# Empirical evidence chain:
#
#   EXP-074 (Mode 7 mini×mini, with entity_topology):
#     17/18 lenient + 5/18 strict, max query 838s, 8/18 slow queries hit
#     entity_topology cascade at 770-1170s each.
#
#   EXP-075 (Mode 7 mini×mini, TPVRG_USR_STRATEGIES=tier1-all-no-entity):
#     IDENTICAL 17/18 lenient + 5/18 strict on SAME questions, max query 6.4s,
#     bimodal latency distribution collapsed (no slow queries).
#     → Entity_topology contributes ZERO accuracy on Mode 7 while consuming
#       ~2.6 hours of compute per 18Q run.
#
#   EXP-078 (LongMemEval pilot, TPVRG_USR_STRATEGIES=tier1-all-no-entity):
#     10/10 lenient + 8/10 strict at clean ~18min completion.
#     Strictly better than 2026-04-07 baseline (8/10 lenient + 6/10 strict; +20pp on both).
#
#   EXP-077 (LongMemEval pilot, default entity_topology enabled):
#     CRASHED at 985s with rc=3221225477 (STATUS_ACCESS_VIOLATION on Windows).
#     Native-code segfault under entity_topology cascade load.
#     → Entity_topology is not only useless on these workloads — it's actively unstable.
#
# Decision: global flip safe AND beneficial. Mode 7 harness override
# (research/mode7/run_mode7.py) is now redundant — the global default propagates.
#
# Override: set TPVRG_USR_STRATEGIES=all (re-enables entity_topology cascade)
#           for the rare workload that genuinely needs it OR for diagnostic A/B work
#           OR for the future post-hoc Janitor analytic that runs entity_topology
#           selectively on completed renders for algorithm-improvement signal
#           (per founder direction 2026-05-14 morning; future research direction).
#
# Source artifacts:
#   research/results/2026-05-14-night-late/SUMMARY.md (EXP-074 vs EXP-075)
#   research/results/2026-05-14-morning-audit/SUMMARY.md (EXP-077 crash + EXP-078)
#   backlog-completed.md [ENTITY-TOPOLOGY-PIPELINE-LATENCY-WEDGE] (RESOLVED-BY-CULL)
#   docs/diagnostics/2026-04-28-tier2-entity-render-failure-trace-synthesis.md
#     §"Empirical validation + post-hoc reframe (2026-05-14 morning)"
USR_STRATEGIES: str = os.environ.get("TPVRG_USR_STRATEGIES", "tier1-all-no-entity").strip().lower()
if USR_STRATEGIES not in _VALID_USR_STRATEGIES:
    raise ValueError(
        f"TPVRG_USR_STRATEGIES={USR_STRATEGIES!r} not in "
        f"{sorted(_VALID_USR_STRATEGIES)}"
    )

# NER backend: "gliner" (GLiNER v2.1, default) or "gliner2" (GLiNER2).
# GLiNER2 adds: native relation extraction (stacked with spaCy SVO),
# 2048-token context (no sub-chunking), confidence scores per entity.
NER_BACKEND: str = os.environ.get("TPVRG_NER_BACKEND", "gliner2").strip()

# Cross-encoder model for passage reranking after macro retrieval.
# Default: cross-encoder/ms-marco-MiniLM-L6-v2 — current Fire alloy floor.
# Set TPVRG_CROSS_ENCODER="" explicitly to disable reranking for A/B studies.
# Per the Fire/Water Doctrine clarification (2026-04-05): the alloy floor only
# moves up. Silent fallback to no reranker is a broken Fire, not a cheap Fire.
CROSS_ENCODER_MODEL: str = os.environ.get(
    "TPVRG_CROSS_ENCODER", "cross-encoder/ms-marco-MiniLM-L6-v2"
)
CROSS_ENCODER_TOP_K: int = int(os.environ.get("TPVRG_CROSS_ENCODER_TOP_K", "25"))

# SP-7: Entity-bridged passage expansion after SP-6 topology expansion.
# Collects entities from initially retrieved passages, ranks bridge entities by
# mention frequency (+query-name boost), applies an IDF-like commonness filter,
# and adds additional passages connected via the selected entities.
SP7_ENABLED: bool = os.environ.get("TPVRG_SP7_ENABLED", "true").lower() == "true"
SP7_MAX_BRIDGE_ENTITIES: int = int(os.environ.get("TPVRG_SP7_MAX_BRIDGE_ENTITIES", "5"))
SP7_MAX_PASSAGES_PER_ENTITY: int = int(os.environ.get("TPVRG_SP7_MAX_PER_ENTITY", "2"))
SP7_MAX_TOTAL_ADDITIONS: int = int(os.environ.get("TPVRG_SP7_MAX_TOTAL", "10"))
SP7_ASSET_CASCADE: bool = os.environ.get("TPVRG_SP7_ASSET_CASCADE", "false").lower() == "true"
SP7_CASCADE_SIBLINGS_PER_ASSET: int = int(os.environ.get("TPVRG_SP7_CASCADE_SIBLINGS", "2"))

# Query manifold A.1: wh_type → expected entity categories (soft prior only).
WH_TYPE_CATEGORY_PRIOR: dict[str, set[str]] = {
    "who": {"person", "people", "character"},
    "where": {"location", "gpe", "loc", "fac", "place", "city", "country"},
    "when": {"event", "date", "time", "temporal_anchor", "period"},
    "how_many": {"number", "quantity", "cardinal"},
    "which": set(),
    "what": set(),
    "how": set(),
    "why": set(),
}
WH_TYPE_PRIOR_BOOST: float = 0.08

# Render confidence (C.1) defaults — diagnostic only.
# Manifold-driven RRF channel weights.
# High specificity → FTS5 dominates (keyword match for exact lookups).
# Low specificity → embedding dominates (semantic match for broad queries).
RRF_SPECIFICITY_FTS5_BOOST: float = float(os.environ.get("TPVRG_RRF_FTS5_BOOST", "2.0"))
RRF_SPECIFICITY_EMB_SUPPRESS: float = float(os.environ.get("TPVRG_RRF_EMB_SUPPRESS", "0.7"))

RENDER_CONFIDENCE_ALPHA: float = 0.7
RENDER_CONFIDENCE_BETA: float = 0.3
RENDER_CONFIDENCE_GAMMA: float = 0.5  # entity_coverage weight — higher than beta, answer presence matters
RENDER_CONFIDENCE_SENTENCE_THRESHOLD: float = 0.1

# C.3 Triple-render selector
C3_ENABLED: bool = os.environ.get("TPVRG_C3_ENABLED", "true").lower() == "true"
C3_THRESHOLD: float = float(os.environ.get("TPVRG_C3_THRESHOLD", "0.80"))


@dataclass
class SelectorEvaluation:
    """Telemetry for one render strategy considered by the selector."""

    strategy: str
    render_time_s: float
    confidence_score: float | None
    was_run: bool


@dataclass
class RenderTrace:
    """Per-question causality trace for rendered context persistence."""

    context_hash: str
    context_token_count: int
    selected_strategy: str | None
    selector_evaluations: list[SelectorEvaluation] = field(default_factory=list)
    pass_1_survivors: dict[str, int | None] = field(default_factory=dict)
    pass_2_realized: dict[str, int | None] = field(default_factory=dict)


def query_budget(intent: object) -> int:
    """Compute token budget from query manifold position.

    High reasoning_depth → larger budget (synthesis needs room).
    High specificity → smaller budget (factual lookup needs precision, not breadth).

    Range: ~2400 (high specificity, low depth) to ~12000 (low specificity, high depth).
    Default (no intent): 4000 (backward-compatible with qa profile).

    Validated by Mode 7 results: 50% → 89% lenient from 4K → 10K budget.
    Unlike reverted F20 (which CUT budget for simple queries), this only
    INCREASES budget for complex queries. Simple queries keep ~4K.
    """
    reasoning_depth = getattr(intent, "reasoning_depth", 0.0) or 0.0
    specificity = getattr(intent, "specificity", 0.5) or 0.5
    reasoning_depth = max(0.0, min(1.0, reasoning_depth))
    specificity = max(0.0, min(1.0, specificity))

    base = QUERY_BUDGET_BASE
    depth_boost = int(reasoning_depth * 5000)  # [0, 5000]
    spec_factor = max(0.8, 1.0 - 0.2 * specificity)  # [0.8, 1.0] — gentle damping only
    # Floor at 10K. The Governor is a METER, not a BOUNCER.
    # "Lost in the middle" doesn't kick in until ~20-30K.
    # Below that, more headroom = better or equal accuracy.
    # The pitch is token UTILIZATION (rendered / available), not restriction.
    # F20 + Mode 7 both proved: starving budget causes regressions.
    return max(base, int((base + depth_boost) * spec_factor))


# SOTA: Level of Detail — adopted from hierarchical geometric models (Clark, 1976)
# The concept of rendering nearby objects at high resolution and distant objects at
# low resolution is standard in 3D graphics; the application to knowledge graph
# rendering under token budgets is novel to TP-VRG.
class LODLevel(IntEnum):
    """Resolution tiers for node content."""

    LOD_0 = 0  # Full raw text
    LOD_1 = 1  # Short summary
    LOD_2 = 2  # Name + category only


class NodeData(BaseModel):
    """
    A single knowledge-graph entity stored at three levels of detail.

    The same entity is kept at all three resolutions simultaneously.
    At query time, the engine selects which resolution to serve based
    on topological proximity.

    For chunk nodes (is_chunk=True), parent_id and chunk_index track the
    parent document and position. The Janitor refines inherited LOD1
    summaries and performs retroactive re-chunking of oversized nodes.
    """

    entity_id: str = Field(..., description="Unique canonical ID for the entity")
    name: str = Field(..., description="Human-readable display name")
    category: str = Field(
        default="concept",
        description="Semantic type: person, org, concept, event, location, ...",
    )
    lod_0: str = Field(..., description="LOD 0 - full raw text (highest resolution)")
    lod_1: str = Field(..., description="LOD 1 - short summary (medium resolution)")
    lod_2: str = Field(..., description="LOD 2 - name + category only (lowest resolution)")
    embedding: list[float] | None = Field(
        default=None, description="Vector embedding of lod_0 text"
    )
    parent_id: str | None = Field(
        default=None, description="Parent node entity_id if this node is a chunk (is_chunk=True)"
    )
    chunk_index: int | None = Field(
        default=None, description="Position within parent document (0-indexed)"
    )
    is_chunk: bool = Field(
        default=False, description="True if this node is a sub-section chunk of a larger document"
    )
    refined: bool = Field(
        default=False, description="True if LOD1 has been Janitor-refined (not inherited from parent)"
    )
    ingested_at: float = Field(
        default_factory=time.time,
        description="Unix timestamp (UTC) when this node was ingested into the graph",
    )
    event_timestamp: float | None = Field(
        default=None,
        description="Unix timestamp of the described event (extracted from source metadata or text)",
    )

    def get_at_lod(self, level: LODLevel) -> str:
        """Return the content string for the requested level of detail."""
        return {
            LODLevel.LOD_0: self.lod_0,
            LODLevel.LOD_1: self.lod_1,
            LODLevel.LOD_2: self.lod_2,
        }[level]


class EdgeData(BaseModel):
    """
    A directional relationship in the knowledge graph.

    Edges are always kept in memory as the "thin skeleton" -
    they carry only a label and optional weight.
    """

    source: str = Field(..., description="Source entity_id")
    target: str = Field(..., description="Target entity_id")
    relation: str = Field(..., description="Relationship label, e.g. 'founded', 'located_in'")
    weight: float = Field(default=1.0, description="Edge weight (lower = closer)")
    ingested_at: float = Field(
        default_factory=time.time,
        description="Unix timestamp (UTC) when this edge was ingested into the graph",
    )


class SourcePassage(BaseModel):
    """A chunk of raw ingested text linked to the entities extracted from it.

    The passage preserves the original raw text that was fed to the LLM
    extraction step, so LOD_0 data is never lost.

    In the Graph-per-Node architecture, passages are first-class macro-graph
    nodes with their own embeddings. Macro search finds relevant passages;
    micro tessellation then scores entities within those passages.
    """

    passage_id: str = Field(..., description="Unique ID for this passage")
    raw_text: str = Field(..., description="The original raw text as ingested")
    source_id: str | None = Field(
        default=None,
        description="Deterministic source ID for provenance-aware source deletion",
    )
    source_label: str = Field(default="", description="Label describing the text source")
    entity_ids: list[str] = Field(default_factory=list, description="Entities extracted from this passage")
    ingested_at: str = Field(default="", description="ISO timestamp of ingestion")
    embedding: list[float] | None = Field(
        default=None,
        description="Vector embedding of raw_text — used for macro-graph passage search",
    )
    temporal_min: int | None = Field(
        default=None,
        description="Earliest year mentioned in this passage (F14 Temporal Reasoning)",
    )
    temporal_max: int | None = Field(
        default=None,
        description="Latest year mentioned in this passage (F14 Temporal Reasoning)",
    )
    asset_id: str | None = Field(
        default=None,
        description="Nullable authorial-unit Asset ID for additive Asset overlay grouping",
    )


class ExtractionResult(BaseModel):
    """The structured output expected from the LLM extraction step."""

    nodes: list[NodeData] = Field(default_factory=list)
    edges: list[EdgeData] = Field(default_factory=list)
    session_passage_id: str | None = Field(
        default=None,
        description="ID of the session-level passage created during ingestion. "
        "Used by callers to track sessions for inter-session stitching (Layer 0).",
    )
    provenance_write_failed: bool = Field(
        default=False,
        description="F16: set True if graph.db committed successfully but "
        "provenance.db commit failed (soft failure, graph is authoritative).",
    )


class TokenProfile(BaseModel):
    """Token budget configuration for a use case.

    Pool ratios partition ``max_tokens`` across three rendering categories:
    - ``node_pool_ratio``: fraction reserved for node content (LOD text)
    - ``edge_pool_ratio``: fraction reserved for the relationship skeleton
    - ``boundary_pool_ratio``: fraction reserved for boundary (stubble) edges

    The three ratios should sum to 1.0. When all default to (1.0, 0.0, 0.0)
    the full budget goes to nodes and edge/boundary rendering falls back to
    the Phase A count-based caps (MAX_RENDERED_EDGES / STUBBLE_CAP).

    The named PROFILES (chat, research, code_simple, code_complex) use
    70 / 25 / 5 percent splits by default.
    """

    name: str
    max_tokens: int
    description: str = ""
    lod_0_bias: float = Field(default=1.0, description="Score multiplier for LOD_0 preference")
    lod_1_bias: float = Field(default=1.0, description="Score multiplier for LOD_1 preference")
    lod_2_bias: float = Field(default=1.0, description="Score multiplier for LOD_2 preference")
    node_pool_ratio: float = Field(
        default=1.0,
        description="Fraction of max_tokens allocated to node content (0.0–1.0)",
    )
    edge_pool_ratio: float = Field(
        default=0.0,
        description="Fraction of max_tokens allocated to the relationship skeleton",
    )
    boundary_pool_ratio: float = Field(
        default=0.0,
        description="Fraction of max_tokens allocated to boundary (stubble) edges",
    )
    max_nodes: int | None = Field(
        default=None,
        description=(
            "Hard ceiling on nodes rendered by the governor, regardless of budget. "
            "None → use MAX_NODES_DEFAULT (50). Separates breadth from depth: more "
            "budget deepens detail on the same node set rather than widening it. "
            "Stopgap until Liquid LOD Phase C (Intent Vector) handles this dynamically."
        ),
    )


class ScoredNode(BaseModel):
    """A node with its computed relevance score and assigned LOD."""

    entity_id: str
    score: float
    semantic_proximity: float = 0.0
    topological_weight: float = 0.0
    graph_distance: int = 0
    parent_signal: float = 0.0
    recency_signal: float = 0.0
    assigned_lod: LODLevel = LODLevel.LOD_2
    estimated_tokens: int = 0
    token_budget: int = 0  # per-node token allocation from governor; 0 = use assigned_lod fallback


class WaterConfig:
    """Configuration for Water mode — LLM augmentation of the Fire pipeline.

    Fire/Water Doctrine (strategy.md §4): Principles 4-5 are the floor, not the
    ceiling. Water mode adds LLM augmentation at high-ROI pipeline stages while
    the deterministic Fire pipeline remains as basis and fallback.

    When ``enabled=False`` (default), the pipeline behaves identically to Fire mode.
    Individual augmentation flags allow selective activation for experimentation.
    """

    __slots__ = (
        "enabled",
        "query_expansion",
        "extraction_enrichment",
        "macro_reranking",
        "expansion_model",
        "enrichment_model",
        "reranking_model",
        "reranking_top_k",
        "expansion_variants",
    )

    def __init__(
        self,
        enabled: bool = False,
        query_expansion: bool = True,
        extraction_enrichment: bool = True,
        macro_reranking: bool = True,
        expansion_model: str = "",
        enrichment_model: str = "",
        reranking_model: str = "",
        reranking_top_k: int = 10,
        expansion_variants: int = 3,
    ) -> None:
        self.enabled = enabled
        self.query_expansion = query_expansion            # expand query via LLM before macro search
        self.extraction_enrichment = extraction_enrichment  # GLiNER + LLM fusion at ingestion
        self.macro_reranking = macro_reranking            # LLM rerank passage candidates after macro search
        self.expansion_model = expansion_model            # Ollama model for query expansion
        self.enrichment_model = enrichment_model          # Ollama model for extraction enrichment
        self.reranking_model = reranking_model            # Model for reranking (gpt-4o-mini or Ollama)
        self.reranking_top_k = reranking_top_k            # How many passages to send to reranker
        self.expansion_variants = expansion_variants      # How many query variants to generate


class SpiralConfig:
    """Configuration for the augmented retrieval pipeline (spiral traversal).

    Controls SP-2 (Backbone Orbit), SP-1 (Neighborhood Expansion), C.2
    (Traversal Modulation), and R1 (LLM Re-ranking).
    All parameters have safe defaults that match current pipeline behaviour
    when left unchanged.
    """

    __slots__ = (
        "backbone_orbit_k",
        "neighborhood_hops",
        "neighborhood_max_new",
        "rerank_enabled",
        "rerank_top_k",
    )

    def __init__(
        self,
        backbone_orbit_k: int = 3,
        neighborhood_hops: int = 1,
        neighborhood_max_new: int = 20,
        rerank_enabled: bool = False,
        rerank_top_k: int = 15,
    ) -> None:
        self.backbone_orbit_k = backbone_orbit_k        # SP-2: top-B backbone nodes to inject
        self.neighborhood_hops = neighborhood_hops      # SP-1: expansion rounds (currently 1)
        self.neighborhood_max_new = neighborhood_max_new  # SP-1: cap on new entities per round
        self.rerank_enabled = rerank_enabled             # R1: LLM re-ranking flag
        self.rerank_top_k = rerank_top_k                 # R1: candidate count to send to LLM


PROFILES: dict[str, TokenProfile] = {
    "chat": TokenProfile(
        name="chat",
        max_tokens=10_000,
        description="Aggressive LOD 2 coarsening for conversational use",
        lod_0_bias=0.8,
        lod_1_bias=0.5,
        lod_2_bias=1.2,
        node_pool_ratio=0.70,
        edge_pool_ratio=0.25,
        boundary_pool_ratio=0.05,
    ),
    "research": TokenProfile(
        name="research",
        max_tokens=25_000,
        description="Favors LOD 1 summaries for factual/research work",
        lod_0_bias=1.0,
        lod_1_bias=1.3,
        lod_2_bias=0.8,
        node_pool_ratio=0.70,
        edge_pool_ratio=0.25,
        boundary_pool_ratio=0.05,
    ),
    "code_simple": TokenProfile(
        name="code_simple",
        max_tokens=40_000,
        description="Local files at LOD 0, distant modules at LOD 2",
        lod_0_bias=1.2,
        lod_1_bias=0.8,
        lod_2_bias=1.0,
        node_pool_ratio=0.70,
        edge_pool_ratio=0.25,
        boundary_pool_ratio=0.05,
    ),
    "code_complex": TokenProfile(
        name="code_complex",
        max_tokens=80_000,
        description="High topological weights for complex systems",
        lod_0_bias=1.0,
        lod_1_bias=1.0,
        lod_2_bias=0.7,
        node_pool_ratio=0.70,
        edge_pool_ratio=0.25,
        boundary_pool_ratio=0.05,
    ),
    "qa": TokenProfile(
        name="qa",
        max_tokens=4_000,
        description="Tight budget for factoid QA -- forces Governor to coarsen",
        lod_0_bias=1.2,
        lod_1_bias=0.9,
        lod_2_bias=1.0,
        node_pool_ratio=0.90,
        edge_pool_ratio=0.05,
        boundary_pool_ratio=0.05,
    ),
}
