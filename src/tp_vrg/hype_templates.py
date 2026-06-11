"""
Topology-aware HyPE question template library (I4 MVP).

SOTA: Hypothetical Document Embeddings — adopted from HyDE (Gao et al., 2022)
Our variant (HyPE-lite) generates questions at ingestion time rather than
hypothetical documents at query time, enabling question-to-question matching.

Generates anticipatory questions from extracted graph structure at ingestion time.
These questions are embedded and stored alongside passage embeddings, enabling
question-to-question matching at query time (HyPE-lite principle).

Unlike the basic HyPE templates ("What is X?", "Tell me about X."), topology-aware
templates read the edge types, entity categories, and multi-hop paths to generate
questions that target the retrieval scenarios where TP-VRG's topology matters most:
contradiction detection, temporal reasoning, causal chains, and multi-hop bridging.

Deterministic — no LLM calls. Fire-safe. Templates are selected by matching
(source_category, relation_pattern, target_category) against a template library.

Usage:
    questions = generate_topology_questions(nodes, edges, entity_name_map, max_questions=15)
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tp_vrg.models import EdgeData, NodeData

# ---------------------------------------------------------------------------
# Template library
# ---------------------------------------------------------------------------

# Edge templates: keyed by (source_category_pattern, relation_pattern, target_category_pattern)
# Patterns use "*" as wildcard. Relation patterns can use "|" for alternatives.
# Templates use {source}, {target}, {relation} placeholders.
_EDGE_TEMPLATES: list[tuple[str, str, str, list[str]]] = [
    # Temporal edges (entity → temporal anchor)
    ("*", "occurred_at", "temporal_anchor", [
        "What happened involving {source} in {target}?",
        "What events occurred during {target}?",
    ]),

    # Person-organization relationships
    ("person", "works_at|founded|leads|employed_by|member_of", "organization", [
        "What role does {source} have at {target}?",
        "Who is affiliated with {target}?",
    ]),

    # Awards and recognition
    ("person", "won|received|awarded|nominated", "*", [
        "When did {source} receive {target}?",
        "Who else received {target}?",
    ]),

    # Creation and authorship
    ("person", "created|wrote|developed|invented|discovered|designed", "*", [
        "What did {source} create or discover?",
        "Who developed {target}?",
    ]),

    # Organization-organization (Mode 7: contractual)
    ("organization", "*", "organization", [
        "What are the terms between {source} and {target}?",
        "What obligations exist between {source} and {target}?",
    ]),

    # Location relationships
    ("*", "located_in|based_in|born_in|died_in|moved_to", "location", [
        "What entities are associated with {target}?",
        "What happened in {target}?",
    ]),

    # Causal and sequential
    ("*", "caused|led_to|resulted_in|preceded|followed", "*", [
        "What were the consequences of {source}?",
        "What led to {target}?",
    ]),

    # Part-of / contains (hierarchical)
    ("*", "part_of|contains|has_attribute|belongs_to", "*", [
        "What are the components of {target}?",
        "What does {source} contain or consist of?",
    ]),

    # Generic fallback (any edge not matched above)
    ("*", "*", "*", [
        "How is {source} related to {target}?",
    ]),
]

# Entity templates: keyed by category. Applied per-entity based on category.
_ENTITY_TEMPLATES: dict[str, list[str]] = {
    "person": [
        "What dates are associated with {name}?",
        "What organizations is {name} affiliated with?",
    ],
    "organization": [
        "What people are associated with {name}?",
        "What agreements or terms involve {name}?",
    ],
    "temporal_anchor": [
        "What happened in {name}?",
        "What events occurred during {name}?",
    ],
    "event": [
        "Who was involved in {name}?",
        "When did {name} take place?",
    ],
    "location": [
        "What happened in {name}?",
        "Who is associated with {name}?",
    ],
}

# Hub templates: for high-degree nodes (many connections)
_HUB_TEMPLATES: list[str] = [
    "What is the significance of {name}?",
    "What connects to {name}?",
]

# Bridge templates: for 2-hop paths A→B→C where no direct A→C edge exists
_BRIDGE_TEMPLATES: list[str] = [
    "What connects {entity_a} to {entity_c}?",
    "How is {entity_a} related to {entity_c}?",
]

# ---------------------------------------------------------------------------
# Template matching
# ---------------------------------------------------------------------------


def _matches_pattern(value: str, pattern: str) -> bool:
    """Check if a value matches a pattern (wildcard or pipe-separated alternatives)."""
    if pattern == "*":
        return True
    alternatives = pattern.split("|")
    return value.lower() in [a.lower() for a in alternatives]


def _questions_from_edge(
    edge: EdgeData,
    entity_name_map: dict[str, str],
    entity_category_map: dict[str, str],
) -> list[str]:
    """Generate questions from a single edge using the template library."""
    src_name = entity_name_map.get(edge.source, edge.source)
    tgt_name = entity_name_map.get(edge.target, edge.target)
    src_cat = entity_category_map.get(edge.source, "")
    tgt_cat = entity_category_map.get(edge.target, "")
    relation = edge.relation or ""

    questions: list[str] = []
    matched = False
    for src_pat, rel_pat, tgt_pat, templates in _EDGE_TEMPLATES:
        if src_pat == "*" and rel_pat == "*" and tgt_pat == "*":
            continue  # Skip generic fallback on first pass
        if (_matches_pattern(src_cat, src_pat)
                and _matches_pattern(relation, rel_pat)
                and _matches_pattern(tgt_cat, tgt_pat)):
            for tmpl in templates:
                q = tmpl.format(source=src_name, target=tgt_name, relation=relation)
                questions.append(q)
            matched = True
            break  # First match wins (most specific)

    if not matched:
        # Generic fallback
        q = f"How is {src_name} related to {tgt_name}?"
        questions.append(q)

    return questions


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def generate_topology_questions(
    nodes: list[NodeData],
    edges: list[EdgeData],
    entity_name_map: dict[str, str],
    max_questions: int = 15,
    hub_degree_threshold: int = 5,
    max_bridge_paths: int = 5,
) -> list[str]:
    """Generate topology-aware HyPE questions from extracted graph structure.

    Args:
        nodes: Extracted entity nodes.
        edges: Extracted relationship edges.
        entity_name_map: Mapping from entity_id to display name.
        max_questions: Maximum questions to return (prevents storage explosion).
        hub_degree_threshold: Minimum edge degree for hub templates.
        max_bridge_paths: Maximum 2-hop bridging questions to generate.

    Returns:
        List of question strings, deduplicated and capped at max_questions.
    """
    from tp_vrg.models import STRUCTURAL_RELATIONS

    questions: list[str] = []
    seen: set[str] = set()

    def _add(q: str) -> None:
        q_lower = q.lower().strip()
        if q_lower not in seen and len(q_lower) > 10:
            seen.add(q_lower)
            questions.append(q)

    # Build category map
    entity_category_map: dict[str, str] = {
        n.entity_id: n.category for n in nodes
    }

    # Filter out structural edges (stitching, follows, etc.)
    semantic_edges = [
        e for e in edges
        if e.relation not in STRUCTURAL_RELATIONS
    ]

    # 1. Edge-based templates
    for edge in semantic_edges:
        for q in _questions_from_edge(edge, entity_name_map, entity_category_map):
            _add(q)
            if len(questions) >= max_questions:
                return questions

    # 2. Entity-based templates (category-specific)
    for node in nodes:
        cat = node.category.lower() if node.category else ""
        name = entity_name_map.get(node.entity_id, node.name)
        templates = _ENTITY_TEMPLATES.get(cat, [])
        for tmpl in templates:
            _add(tmpl.format(name=name))
            if len(questions) >= max_questions:
                return questions

    # 3. Hub templates (high-degree nodes)
    degree_count: dict[str, int] = {}
    for edge in semantic_edges:
        degree_count[edge.source] = degree_count.get(edge.source, 0) + 1
        degree_count[edge.target] = degree_count.get(edge.target, 0) + 1

    hub_nodes = [
        eid for eid, deg in sorted(degree_count.items(), key=lambda x: -x[1])
        if deg >= hub_degree_threshold
    ]
    for eid in hub_nodes[:3]:  # Top 3 hubs only
        name = entity_name_map.get(eid, eid)
        for tmpl in _HUB_TEMPLATES:
            _add(tmpl.format(name=name))
            if len(questions) >= max_questions:
                return questions

    # 4. Bridging templates (2-hop paths without direct edge)
    # Build adjacency for 2-hop detection
    adj: dict[str, set[str]] = {}
    for edge in semantic_edges:
        adj.setdefault(edge.source, set()).add(edge.target)
        adj.setdefault(edge.target, set()).add(edge.source)

    direct_edges: set[tuple[str, str]] = {
        (e.source, e.target) for e in semantic_edges
    } | {
        (e.target, e.source) for e in semantic_edges
    }

    bridge_count = 0
    for entity_a in adj:
        if bridge_count >= max_bridge_paths:
            break
        for entity_b in adj[entity_a]:
            if bridge_count >= max_bridge_paths:
                break
            for entity_c in adj.get(entity_b, set()):
                if entity_c == entity_a:
                    continue
                if (entity_a, entity_c) in direct_edges:
                    continue  # Direct edge exists — not a bridge
                name_a = entity_name_map.get(entity_a, entity_a)
                name_c = entity_name_map.get(entity_c, entity_c)
                for tmpl in _BRIDGE_TEMPLATES:
                    _add(tmpl.format(entity_a=name_a, entity_c=name_c))
                bridge_count += 1
                if len(questions) >= max_questions:
                    return questions
                break  # One bridge per A→B→C path

    return questions
