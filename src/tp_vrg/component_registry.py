"""Unified component registry.

Single canonical catalog of the engine's pluggable components, covering both
deterministic mechanisms and optional LLM-augmented injectors.

The registry exposes:
  * ``ComponentDescriptor`` plus the descriptor table and lookup API.
  * ``resolve_mode_profile`` and ``apply_mode_profile`` for lean/standard/full
    mode defaults.
  * ``registry_summary`` for ``/health`` observability.

Safety invariant:
  ``apply_mode_profile`` is a no-op unless a mode is explicitly provided or
  ``TPVRG_MODE`` is set. It uses ``setdefault`` semantics, so individually-set
  environment variables win. With no mode selected, default behavior is
  unchanged. ``TPVRG_MODE=standard`` reproduces canonical defaults, while
  ``lean`` and ``full`` are explicit opt-ins.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping, Optional


class ComponentClass(str, Enum):
    FIRE = "fire"      # deterministic mechanism (no LLM call)
    WATER = "water"    # LLM-augmented injector (water.py); deterministic fallback


class Stage(str, Enum):
    INGEST = "ingest"  # runs during ingestion
    BAKE = "bake"      # runs in an offline janitor bake (needs --force-reingest to re-take effect)
    QUERY = "query"    # runs at query time


class AuditStatus(str, Enum):
    REQUIRED = "required"                          # architectural identity; cannot turn off
    CONFIRMED_LOAD_BEARING = "confirmed_load_bearing"  # mechanism-audit measured a real contribution
    CONFIRMED_FLAT = "confirmed_flat"              # mechanism-audit measured ~zero contribution
    PRIOR = "prior"                                # not yet audited; position is first-principles
    BLOCKED = "blocked"                            # no toggle exists yet (e.g. hardcoded default)


MODES: tuple[str, ...] = ("lean", "standard", "full")


def _serialize_env(value: Any) -> str:
    """Serialize a mode-default to the string form the engine's env reads expect."""
    if isinstance(value, bool):
        return "true" if value else "false"  # engine reads do .lower() == "true"
    return str(value)


@dataclass(frozen=True)
class ComponentDescriptor:
    component_id: str                 # stable id, e.g. "rrf_fusion"
    name: str                         # human-facing, e.g. "RRF Fusion" (never a code)
    klass: ComponentClass
    stage: Stage
    locus: str                        # file:symbol where it lives
    default: Any                      # the canonical default (the ONE source — INV-1)
    mode_defaults: Mapping[str, Any]  # {lean, standard, full} -> value
    audit_status: AuditStatus
    toggle: Optional[str] = None      # env var (TPVRG_*) or WaterConfig.field or None (hardcoded)
    models_attr: Optional[str] = None # the models.py attribute mirroring `default` (for the INV-1 consistency test)
    notes: str = ""

    def __post_init__(self) -> None:
        missing = set(MODES) - set(self.mode_defaults)
        if missing:
            raise ValueError(
                f"ComponentDescriptor {self.component_id!r} mode_defaults missing modes: {sorted(missing)}"
            )
        extra = set(self.mode_defaults) - set(MODES)
        if extra:
            raise ValueError(
                f"ComponentDescriptor {self.component_id!r} mode_defaults has unknown modes: {sorted(extra)}"
            )

    @property
    def env_toggle(self) -> Optional[str]:
        """The env-var toggle, if this component is env-controlled (not WaterConfig / hardcoded)."""
        if self.toggle and self.toggle.startswith("TPVRG_"):
            return self.toggle
        return None


# ---------------------------------------------------------------------------
# The descriptor table.
#
# Defaults below are the canonical defaults lifted into the registry as data
# (the registry is their home going forward; Phase 2 inverts the dependency).
# `standard` mode-default == `default` for every component — the safety property.
# `models_attr` names the models.py symbol the consistency test cross-checks against.
# Line-exact loci verified against models.py 2026-06-05; the full 33-component
# inventory (incl. hardcoded-algorithm + cost/observability fields) is in the
# design doc — this table holds the toggle-able + identity components.
# ---------------------------------------------------------------------------

_DESCRIPTORS: list[ComponentDescriptor] = [
    # --- FIRE: retrieval / fusion ------------------------------------------
    ComponentDescriptor(
        "rrf_fusion", "RRF Fusion", ComponentClass.FIRE, Stage.QUERY,
        "retrieval.py:macro_search", True,
        {"lean": True, "standard": True, "full": True},
        AuditStatus.CONFIRMED_LOAD_BEARING, "TPVRG_RRF_FUSION", "RRF_FUSION",
        "−0.10 lenient when off (2026-06-02 audit); cheap fusion, kept on all modes.",
    ),
    ComponentDescriptor(
        "render_selector", "Unified Render Selector", ComponentClass.FIRE, Stage.QUERY,
        "engine.py:_maybe_c3_select", True,
        {"lean": False, "standard": True, "full": True},
        AuditStatus.CONFIRMED_LOAD_BEARING, "TPVRG_C3_ENABLED", "C3_ENABLED",
        "−0.067 off but +2.6s/q (2026-06-02 audit). Lean drops it for latency.",
    ),
    ComponentDescriptor(
        "render_selector_strategies", "Render Selector strategy set", ComponentClass.FIRE, Stage.QUERY,
        "engine.py:_maybe_c3_select / models.py:USR_STRATEGIES", "tier1-all-no-entity",
        {"lean": "passage-only", "standard": "tier1-all-no-entity", "full": "all"},
        AuditStatus.PRIOR, "TPVRG_USR_STRATEGIES", "USR_STRATEGIES",
    ),
    ComponentDescriptor(
        "macro_top_k", "Macro Search top-K", ComponentClass.FIRE, Stage.QUERY,
        "retrieval.py:macro_search", 25,
        {"lean": 15, "standard": 25, "full": 25},
        AuditStatus.REQUIRED, "TPVRG_MACRO_TOP_K", "MACRO_TOP_K",
    ),
    ComponentDescriptor(
        "passage_topology", "Passage Topology Expansion (SP-6)", ComponentClass.FIRE, Stage.QUERY,
        "retrieval.py:_expand_by_passage_topology", "both",
        {"lean": "none", "standard": "both", "full": "both"},
        AuditStatus.PRIOR, "TPVRG_MACRO_TOPOLOGY", "MACRO_TOPOLOGY",
    ),
    ComponentDescriptor(
        "entity_bridge", "Entity Bridge (SP-7)", ComponentClass.FIRE, Stage.QUERY,
        "retrieval.py:_expand_by_entity_bridge", True,
        {"lean": False, "standard": True, "full": True},
        AuditStatus.PRIOR, "TPVRG_SP7_ENABLED", "SP7_ENABLED",
        "FRAMES/multi-hop-sensitive; not flipped on LoCoMo-only evidence.",
    ),
    ComponentDescriptor(
        "cross_encoder", "Cross-Encoder Reranking", ComponentClass.FIRE, Stage.QUERY,
        "reranker.py:CrossEncoderReranker", "cross-encoder/ms-marco-MiniLM-L6-v2",
        {"lean": "", "standard": "cross-encoder/ms-marco-MiniLM-L6-v2", "full": "cross-encoder/ms-marco-MiniLM-L6-v2"},
        AuditStatus.PRIOR, "TPVRG_CROSS_ENCODER", "CROSS_ENCODER_MODEL",
        'Empty string disables. Lean drops it.',
    ),
    # --- FIRE: embeddings / ingest -----------------------------------------
    ComponentDescriptor(
        "sentence_embeddings", "Sentence-Level Embeddings", ComponentClass.FIRE, Stage.INGEST,
        "models.py:SENTENCE_EMBEDDINGS_ENABLED", True,
        {"lean": False, "standard": True, "full": True},
        AuditStatus.PRIOR, "TPVRG_SENTENCE_EMBEDDINGS", "SENTENCE_EMBEDDINGS_ENABLED",
    ),
    ComponentDescriptor(
        "contextual_embedding", "Contextual Embedding (metadata prefix)", ComponentClass.FIRE, Stage.INGEST,
        "models.py:CONTEXTUAL_EMBEDDING", True,
        {"lean": True, "standard": True, "full": True},
        AuditStatus.PRIOR, "TPVRG_CONTEXTUAL_EMBEDDING", "CONTEXTUAL_EMBEDDING",
    ),
    ComponentDescriptor(
        "ner_backend", "NER Backend", ComponentClass.FIRE, Stage.INGEST,
        "models.py:NER_BACKEND", "gliner2",
        {"lean": "gliner2", "standard": "gliner2", "full": "gliner2"},
        AuditStatus.REQUIRED, "TPVRG_NER_BACKEND", "NER_BACKEND",
    ),
    ComponentDescriptor(
        "coref_mode", "Coref Resolver", ComponentClass.FIRE, Stage.INGEST,
        "coref.py:resolve_pronouns", "sieve",
        {"lean": "rules", "standard": "sieve", "full": "sieve"},
        AuditStatus.PRIOR, "TPVRG_COREF_MODE", None,
        "Default 'sieve' read in coref.py (not a models.py constant).",
    ),
    ComponentDescriptor(
        "fuzzy_dedup", "Entity Normalization / Fuzzy Dedup", ComponentClass.FIRE, Stage.INGEST,
        "normalizer.py:EntityNormalizer", 0.85,
        {"lean": 0.85, "standard": 0.85, "full": 0.85},
        AuditStatus.REQUIRED, "TPVRG_FUZZY_THRESHOLD", "FUZZY_THRESHOLD",
    ),
    ComponentDescriptor(
        "chunk_target_tokens", "Deterministic Chunker target", ComponentClass.FIRE, Stage.INGEST,
        "chunker.py:DeterministicChunker", 384,
        {"lean": 384, "standard": 384, "full": 384},
        AuditStatus.REQUIRED, "TPVRG_CHUNK_TARGET_TOKENS", None,
        "Default 384 read in chunker.py (not a models.py constant).",
    ),
    # --- FIRE: bake-time ----------------------------------------------------
    ComponentDescriptor(
        "centrality_measure", "Centrality Dispatcher", ComponentClass.FIRE, Stage.BAKE,
        "centrality.py:get_active_centrality_measure", "pagerank",
        {"lean": "degree", "standard": "pagerank", "full": "pagerank"},
        AuditStatus.PRIOR, "TPVRG_CENTRALITY_MEASURE", "DEFAULT_CENTRALITY_MEASURE",
        "The M5-invisibility incident origin: the flag-check missed the env toggle.",
    ),
    ComponentDescriptor(
        "partition_algorithm", "Partition Bake algorithm", ComponentClass.FIRE, Stage.BAKE,
        "janitor/bake_partitions.py", "leiden",
        {"lean": "leiden", "standard": "leiden", "full": "leiden"},
        AuditStatus.PRIOR, "TPVRG_PARTITION_ALGORITHM", "DEFAULT_PARTITION_ALGORITHM",
    ),
    ComponentDescriptor(
        "similarity_axis", "Similarity Axis (similarity_edges)", ComponentClass.FIRE, Stage.BAKE,
        "janitor/bake_similarity_edges.py", False,
        {"lean": False, "standard": False, "full": True},
        AuditStatus.PRIOR, "TPVRG_SIMILARITY_EDGES", None,
        "Shipped 56313fd, DEFAULT-OFF; the 4th structural axis. Full mode opts in.",
    ),
    # --- FIRE: governor / render (required identity) -----------------------
    ComponentDescriptor(
        "token_governor", "Token Governor (LOD_Z Phase B)", ComponentClass.FIRE, Stage.QUERY,
        "governor.py:TokenGovernor", True,
        {"lean": True, "standard": True, "full": True},
        AuditStatus.REQUIRED, None, None,
        "Hard token budget is the engine's defining property.",
    ),
    ComponentDescriptor(
        "lod_z_compression", "LOD_Z Extractive Compression", ComponentClass.FIRE, Stage.QUERY,
        "compression.py:compress", True,
        {"lean": True, "standard": True, "full": True},
        AuditStatus.REQUIRED, None, None,
        "The render primitive; hardcoded algorithm.",
    ),
    ComponentDescriptor(
        "lod0_steal", "LOD_0 Steal (Governor Pass 3)", ComponentClass.FIRE, Stage.QUERY,
        "governor.py:apply_budget", "off",
        {"lean": "off", "standard": "off", "full": "on"},
        AuditStatus.PRIOR, "TPVRG_LOD0_INVARIANT", None,
        "Env convention is 'on'/'off' strings; models.LOD0_INVARIANT_ENABLED is the "
        "resolved bool (False), so no direct value cross-check.",
    ),
    ComponentDescriptor(
        "reading_order_fiber", "Reading-Order Fiber (SP-8)", ComponentClass.FIRE, Stage.QUERY,
        "retrieval.py:_expand_by_reading_order", True,
        {"lean": True, "standard": True, "full": True},
        AuditStatus.REQUIRED, None, None,
        "Provenance-gated keystone axis (shipped 2026-04-15).",
    ),
    ComponentDescriptor(
        "intent_vector", "Intent Vector Classifier", ComponentClass.FIRE, Stage.QUERY,
        "intent.py:classify_intent", True,
        {"lean": True, "standard": True, "full": True},
        AuditStatus.REQUIRED, None, None,
    ),
    ComponentDescriptor(
        "multi_res_descent", "Multi-Resolution Descent", ComponentClass.FIRE, Stage.QUERY,
        "multi_res/descent_algorithm.py:descend_to_children", True,
        {"lean": False, "standard": True, "full": True},
        AuditStatus.PRIOR, None, None,
        "Lean profile already skips it (should_skip_multires).",
    ),
    # --- FIRE: scoring / admission / rendering (mostly hardcoded identity) -
    ComponentDescriptor(
        "composite_scorer", "Composite Relevance Scorer (6-signal)", ComponentClass.FIRE, Stage.QUERY,
        "scoring.py:RelevanceScorer", True,
        {"lean": True, "standard": True, "full": True},
        AuditStatus.REQUIRED, None, None,
        "Semantic + topological + graph-distance + parent + recency + temporal signals; intent-modulated weights.",
    ),
    ComponentDescriptor(
        "mad_admission", "Iterative Re-scoring (MAD admission)", ComponentClass.FIRE, Stage.QUERY,
        "governor.py:apply_budget (Pass 0a)", True,
        {"lean": True, "standard": True, "full": True},
        AuditStatus.PRIOR, None, None,
        "MAD-adaptive candidate cap when the score distribution is non-degenerate.",
    ),
    ComponentDescriptor(
        "dress_code_governor", "Dress-Code Governor (hierarchical relations)", ComponentClass.FIRE, Stage.QUERY,
        "renderer.py (CHILD/PARENT/HIERARCHICAL_RELATIONS)", True,
        {"lean": True, "standard": True, "full": True},
        AuditStatus.PRIOR, None, None,
        "Renders structural relations as implicit markdown nesting (zero explicit edge tokens).",
    ),
    ComponentDescriptor(
        "motif_compression", "Motif Compression (hub/fan/chain)", ComponentClass.FIRE, Stage.QUERY,
        "renderer.py:_analyze_motifs", 3,
        {"lean": 3, "standard": 3, "full": 3},
        AuditStatus.PRIOR, None, "MOTIF_THRESHOLD",
        "Groups hub-spoke / fan-out / chain edge motifs; default is the min group size (MOTIF_THRESHOLD).",
    ),
    ComponentDescriptor(
        "query_decomposition", "Query Decomposition (3-strategy)", ComponentClass.FIRE, Stage.QUERY,
        "decomposition.py:decompose_query", True,
        {"lean": False, "standard": True, "full": True},
        AuditStatus.PRIOR, None, None,
        "Gated by should_decompose (reasoning_depth>0.5 or chain keywords); spaCy/GLiNER/regex cascade.",
    ),
    ComponentDescriptor(
        "hype_lite", "HyPE-Lite Question Generation", ComponentClass.FIRE, Stage.INGEST,
        "hype_templates.py:generate_topology_questions", True,
        {"lean": False, "standard": True, "full": True},
        AuditStatus.PRIOR, None, None,
        "Deterministic topology-template anticipatory questions (no LLM); RRF channel 2.",
    ),
    ComponentDescriptor(
        "backbone_orbit", "Backbone Orbit (SP-2)", ComponentClass.FIRE, Stage.QUERY,
        "retrieval.py:_inject_backbone_nodes", True,
        {"lean": False, "standard": True, "full": True},
        AuditStatus.PRIOR, None, None,
        "Injects top-centrality bridge nodes (SpiralConfig.backbone_orbit_k, config-slot not env).",
    ),
    ComponentDescriptor(
        "neighborhood_expansion", "Neighborhood Expansion (SP-1)", ComponentClass.FIRE, Stage.QUERY,
        "retrieval.py:_expand_by_neighborhood", True,
        {"lean": False, "standard": True, "full": True},
        AuditStatus.PRIOR, None, None,
        "Entity->passage reverse lookup (SpiralConfig.neighborhood_hops/max_new, config-slot not env).",
    ),
    ComponentDescriptor(
        "temporal_extraction", "Temporal Extraction / Filter (F14)", ComponentClass.FIRE, Stage.INGEST,
        "temporal.py:extract_temporal", True,
        {"lean": False, "standard": True, "full": True},
        AuditStatus.PRIOR, None, None,
        "Year-range extraction + passage temporal_min/max; intent-gated at query time.",
    ),
    ComponentDescriptor(
        "defined_terms", "Defined-Terms Canonicalization", ComponentClass.FIRE, Stage.INGEST,
        "defined_terms.py", True,
        {"lean": True, "standard": True, "full": True},
        AuditStatus.REQUIRED, None, None,
        "Entity-name canonicalization (variant -> canonical entity_id).",
    ),
    # --- WATER: LLM injectors (all default-off, opt-in; WaterConfig-gated) --
    ComponentDescriptor(
        "water_query_expander", "Query Expander (LLM)", ComponentClass.WATER, Stage.QUERY,
        "water.py:QueryExpander", False,
        {"lean": False, "standard": False, "full": True},
        AuditStatus.PRIOR, "WaterConfig.query_expansion", None,
        "WaterConfig-gated (not env); full mode opts in. Deterministic fallback on LLM failure.",
    ),
    ComponentDescriptor(
        "water_passage_reranker", "Passage Reranker (LLM)", ComponentClass.WATER, Stage.QUERY,
        "water.py:PassageReranker", False,
        {"lean": False, "standard": False, "full": True},
        AuditStatus.PRIOR, "WaterConfig.macro_reranking", None,
    ),
    ComponentDescriptor(
        "water_extraction_enricher", "Extraction Enricher (GLiNER+LLM)", ComponentClass.WATER, Stage.INGEST,
        "water.py:ExtractionEnricher", False,
        {"lean": False, "standard": False, "full": True},
        AuditStatus.PRIOR, "WaterConfig.extraction_enrichment", None,
    ),
]

_REGISTRY: dict[str, ComponentDescriptor] = {}
for _d in _DESCRIPTORS:
    if _d.component_id in _REGISTRY:
        raise ValueError(f"Duplicate component_id in registry: {_d.component_id!r}")
    _REGISTRY[_d.component_id] = _d


# ---------------------------------------------------------------------------
# L1 — lookup API
# ---------------------------------------------------------------------------

def get(component_id: str) -> ComponentDescriptor:
    try:
        return _REGISTRY[component_id]
    except KeyError:
        raise KeyError(f"Unknown component_id {component_id!r}; known: {sorted(_REGISTRY)}") from None


def all_components() -> tuple[ComponentDescriptor, ...]:
    return tuple(_DESCRIPTORS)


def by_class(klass: ComponentClass) -> tuple[ComponentDescriptor, ...]:
    return tuple(d for d in _DESCRIPTORS if d.klass is klass)


def by_stage(stage: Stage) -> tuple[ComponentDescriptor, ...]:
    return tuple(d for d in _DESCRIPTORS if d.stage is stage)


def fire() -> tuple[ComponentDescriptor, ...]:
    return by_class(ComponentClass.FIRE)


def water() -> tuple[ComponentDescriptor, ...]:
    return by_class(ComponentClass.WATER)


def canonical_default(component_id: str) -> Any:
    return get(component_id).default


# ---------------------------------------------------------------------------
# L2 — mode-profile loader
# ---------------------------------------------------------------------------

def _validate_mode(mode: str) -> str:
    if mode not in MODES:
        raise ValueError(f"Unknown mode {mode!r}; expected one of {MODES}")  # fail-loud (INV-2)
    return mode


def resolve_mode_profile(mode: str) -> dict[str, Any]:
    """Pure: return {component_id: value} for the given mode. Does NOT touch the env."""
    _validate_mode(mode)
    return {d.component_id: d.mode_defaults[mode] for d in _DESCRIPTORS}


def active_mode(environ: Optional[Mapping[str, str]] = None) -> Optional[str]:
    """The explicitly-set mode (TPVRG_MODE), or None if unset (= current defaults)."""
    import os
    env = os.environ if environ is None else environ
    value = env.get("TPVRG_MODE")
    return value.strip().lower() if value else None


def apply_mode_profile(
    mode: Optional[str] = None,
    environ: Optional[dict[str, str]] = None,
) -> dict[str, str]:
    """Translate a mode into the engine's individual env-var toggles, with setdefault
    semantics so explicit overrides win.

    SAFETY: a no-op when no mode is given AND TPVRG_MODE is unset — default behavior
    is byte-unchanged. Only env-var-toggled components are applied (WaterConfig-gated
    and hardcoded components are skipped; wiring those is Phase 2).

    Returns the dict of env settings it applied (those not already present).
    """
    import os
    env = os.environ if environ is None else environ
    resolved_mode = mode if mode is not None else active_mode(env)
    if resolved_mode is None:
        return {}  # no-op: no mode requested → current behavior
    _validate_mode(resolved_mode)

    applied: dict[str, str] = {}
    for d in _DESCRIPTORS:
        toggle = d.env_toggle
        if toggle is None:
            continue  # WaterConfig-gated or hardcoded — skip (Phase 2)
        if toggle in env:
            continue  # explicit override already set — it wins
        value = _serialize_env(d.mode_defaults[resolved_mode])
        env[toggle] = value
        applied[toggle] = value
    return applied


# ---------------------------------------------------------------------------
# Observability — the /health summary
# ---------------------------------------------------------------------------

def registry_summary(environ: Optional[Mapping[str, str]] = None) -> dict[str, Any]:
    """A compact summary for the /health endpoint: active mode + per-component state."""
    mode = active_mode(environ)
    return {
        "active_mode": mode or "unset (standard defaults)",
        "total": len(_DESCRIPTORS),
        "fire": len(fire()),
        "water": len(water()),
        "by_stage": {s.value: len(by_stage(s)) for s in Stage},
        "audit_status_counts": {
            status.value: sum(1 for d in _DESCRIPTORS if d.audit_status is status)
            for status in AuditStatus
        },
        "components": [
            {
                "id": d.component_id,
                "name": d.name,
                "class": d.klass.value,
                "stage": d.stage.value,
                "toggle": d.toggle,
                "default": d.default,
                "mode_defaults": dict(d.mode_defaults),
                "audit_status": d.audit_status.value,
            }
            for d in _DESCRIPTORS
        ],
    }
