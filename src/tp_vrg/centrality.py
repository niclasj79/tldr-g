"""Centrality dispatcher for backbone scoring.

Two compute entry points:
- ``compute_backbone_centrality(graph)`` — synchronous. For janitor tasks,
  CLI tooling, and tests. Blocks the caller's thread until complete.
- ``compute_backbone_centrality_async(graph)`` — event-loop-safe variant.
  Offloads the underlying networkx computation to a thread so async
  handlers (FastAPI endpoints, MCP tool coroutines) remain responsive.

Convention: any ``async def`` function that needs centrality MUST call
the async variant. Calling the sync variant from an async handler blocks
the entire uvicorn event loop during O(V+E)-class compute on large
graphs — see pipeline-contracts.md §C8 and the 2026-04-21 Cockpit
startup-hang incident for the incident record that motivated this split.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import logging
import os

import networkx as nx

from tp_vrg.models import DEFAULT_CENTRALITY_MEASURE

logger = logging.getLogger(__name__)

_CENTRALITY_DISPATCH: dict[str, Callable[[nx.Graph | nx.DiGraph], dict[str, float]]] = {
    "pagerank": lambda graph: nx.pagerank(graph, alpha=0.85),
    "betweenness": nx.betweenness_centrality,
    "degree": nx.degree_centrality,
}


def get_active_centrality_measure(raw_value: str | None = None) -> str:
    """Resolve the active backbone centrality measure from env or canonical default."""
    default_measure = DEFAULT_CENTRALITY_MEASURE.strip().lower()
    configured = os.environ.get("TPVRG_CENTRALITY_MEASURE") if raw_value is None else raw_value
    if configured is None:
        return default_measure

    candidate = configured.strip().lower()
    if not candidate:
        return default_measure
    if candidate not in _CENTRALITY_DISPATCH:
        logger.warning(
            "Unknown TPVRG_CENTRALITY_MEASURE=%r; falling back to %s",
            configured,
            default_measure,
        )
        return default_measure
    return candidate


def compute_backbone_centrality(
    graph: nx.Graph | nx.DiGraph,
) -> tuple[str, dict[str, float]]:
    """Compute backbone centrality using the active measure dispatcher.

    Synchronous. Callers run on whatever thread invoked them; on large
    graphs (~100K nodes, ~1M edges) this can be seconds to minutes of
    GIL-held compute. Do NOT call from any ``async def`` context — use
    ``compute_backbone_centrality_async`` instead.
    """
    measure = get_active_centrality_measure()
    centralities = _CENTRALITY_DISPATCH[measure](graph)
    return measure, centralities


async def compute_backbone_centrality_async(
    graph: nx.Graph | nx.DiGraph,
) -> tuple[str, dict[str, float]]:
    """Event-loop-safe variant of compute_backbone_centrality.

    Offloads the networkx computation to a thread via ``asyncio.to_thread``
    so the asyncio event loop remains responsive during large-graph
    centrality compute. Use this from any ``async def`` handler or
    coroutine. The synchronous variant remains for janitor tasks, CLI
    commands, and unit tests that don't need event-loop cooperation.
    """
    return await asyncio.to_thread(compute_backbone_centrality, graph)
