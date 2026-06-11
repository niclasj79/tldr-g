"""World-map orientation render — the query-conditioned macro frame.

The cheapest realization of the orientation surface per
[[docs/design/arch-world-map-render-surface-2026-06-09.md]] §9
(`[WORLD-MAP-ORIENTATION-RENDER]`, ledger #90): a flag-gated, token-budgeted
header that tells the model (and the user) WHERE in the knowledge terrain
the render is operating — a filtered table-of-contents for broad queries,
a route spine for multi-hop queries, and NOTHING (0 tokens) for local
lookups.

Flag: ``TPVRG_WORLD_MAP_ORIENTATION`` (default off — byte-identical render
when unset, per the legibility gate in the design §6: the flag stays off
until the partition-quality smoke confirms a legible macro-partition).

Map-mode derivation reuses the EXISTING Intent Vector structural-demand
axes (design §9 step 1 — no new classifier):

- ``path``   — multi-hop signature: ``reasoning_depth > 0.5`` (the same
  threshold the traversal-modulation profile uses for its topology boost).
- ``filter`` — broad-overview signature: ``specificity < 0.4`` or
  ``exhaustiveness > 0.7`` (mention-all / overview demand).
- ``off``    — everything else (local / micro lookups).

``path`` wins over ``filter`` when both fire — a multi-hop query needs the
connective spine more than a table of contents.

This module is the single canonical implementation (INV-7); the engine's
``get_context`` is its one production consumer.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

WORLD_MAP_ENV = "TPVRG_WORLD_MAP_ORIENTATION"

# The orientation frame is itself budget-governed (design §9 step 3): a
# fixed small ceiling so the frame can never crowd out evidence. Lines are
# dropped whole (cheapest-last) when the ceiling would be exceeded.
ORIENTATION_MAX_TOKENS = 120

_PATH_REASONING_DEPTH = 0.5
_FILTER_SPECIFICITY = 0.4
_FILTER_EXHAUSTIVENESS = 0.7


def orientation_enabled() -> bool:
    raw = os.environ.get(WORLD_MAP_ENV, "").strip().lower()
    return raw in {"1", "true", "on", "yes"}


def derive_map_mode(intent: Any) -> str:
    """``path`` / ``filter`` / ``off`` from existing structural-demand axes."""
    if intent is None:
        return "off"
    reasoning_depth = float(getattr(intent, "reasoning_depth", 0.0) or 0.0)
    specificity = float(getattr(intent, "specificity", 0.5) or 0.0)
    exhaustiveness = float(getattr(intent, "exhaustiveness", 0.5) or 0.0)
    if reasoning_depth > _PATH_REASONING_DEPTH:
        return "path"
    if specificity < _FILTER_SPECIFICITY or exhaustiveness > _FILTER_EXHAUSTIVENESS:
        return "filter"
    return "off"


def _terrain_maps(storage: Any) -> tuple[dict[str, str], dict[str, str], dict[str, tuple[str, str]], dict[str, tuple[str, str]]]:
    """Return (asset->island, island->continent, island_labels, continent_labels).

    Small at macro scale (tens of communities); read whole.
    """
    from tp_vrg.storage import community_partitions as cp

    conn = storage.conn
    asset_to_island: dict[str, str] = {}
    for island_id, asset_ids in cp.read_partition("island", conn).items():
        for asset_id in asset_ids:
            asset_to_island[asset_id] = island_id
    island_to_continent: dict[str, str] = {}
    for continent_id, island_ids in cp.read_partition("continent", conn).items():
        for island_id in island_ids:
            island_to_continent[island_id] = continent_id
    return (
        asset_to_island,
        island_to_continent,
        cp.read_labels("island", conn),
        cp.read_labels("continent", conn),
    )


def _label(labels: dict[str, tuple[str, str]], community_id: str) -> str:
    return labels.get(community_id, (community_id, ""))[0]


def build_orientation_frame(
    mode: str,
    storage: Any,
    rendered_passage_ids: list[str] | None,
) -> str:
    """Render the orientation header for ``mode``. Empty string when nothing
    useful can be said (no partition baked, no passages to locate, mode off).
    """
    if mode not in ("path", "filter"):
        return ""

    asset_to_island, island_to_continent, island_labels, continent_labels = (
        _terrain_maps(storage)
    )
    if not asset_to_island:
        return ""  # no macro-partition baked — nothing to orient against

    passage_ids = [pid for pid in (rendered_passage_ids or []) if pid]
    # Locate the render: passage -> asset -> island -> continent, preserving
    # first-appearance order (the route order for `path`).
    island_order: list[str] = []
    island_hits: dict[str, int] = {}
    if passage_ids and hasattr(storage, "get_asset_ids_for_passages"):
        passage_assets = storage.get_asset_ids_for_passages(passage_ids)
        for pid in passage_ids:
            asset_id = passage_assets.get(pid)
            island_id = asset_to_island.get(asset_id or "")
            if island_id is None:
                continue
            if island_id not in island_hits:
                island_order.append(island_id)
            island_hits[island_id] = island_hits.get(island_id, 0) + 1

    lines: list[str] = []
    if mode == "path":
        if not island_order:
            return ""  # a spine needs located passages; entity-mode renders skip
        lines.append("[World map — route]")
        for idx, island_id in enumerate(island_order, 1):
            continent_id = island_to_continent.get(island_id, "")
            lines.append(
                f"{idx}. {_label(continent_labels, continent_id)}"
                f" › {_label(island_labels, island_id)}"
            )
    else:  # filter — the graph table of contents, in-view first
        lines.append("[World map — territories in view]")
        by_continent: dict[str, list[str]] = {}
        for island_id in island_order:
            by_continent.setdefault(
                island_to_continent.get(island_id, ""), []
            ).append(island_id)
        ranked = sorted(
            by_continent.items(),
            key=lambda kv: -sum(island_hits.get(i, 0) for i in kv[1]),
        )
        for continent_id, islands in ranked:
            names = ", ".join(_label(island_labels, i) for i in islands)
            hits = sum(island_hits.get(i, 0) for i in islands)
            lines.append(
                f"- {_label(continent_labels, continent_id)} ({names})"
                f" — {hits} passage{'s' if hits != 1 else ''} in view"
            )
        outside = len(set(island_to_continent.values()) - set(by_continent))
        if not ranked:
            # nothing located (e.g. entity-mode render): give the global TOC
            for continent_id in sorted(set(island_to_continent.values())):
                lines.append(f"- {_label(continent_labels, continent_id)}")
                outside = 0
        if outside:
            lines.append(f"(+{outside} continent{'s' if outside != 1 else ''} outside this view)")

    # Budget governance: drop tail lines whole until under the ceiling.
    # Canonical estimator first (INV-1); offline chars/4 heuristic as the
    # annotated fallback — the orientation budget must never depend on a
    # tokenizer download succeeding at render time.
    try:
        from tp_vrg.tokens import estimate_tokens as _est
    except Exception:  # pragma: no cover
        _est = None

    def _tokens(text: str) -> int:
        if _est is not None:
            try:
                return _est(text)
            except Exception:
                pass
        return max(1, len(text) // 4)

    while len(lines) > 1 and _tokens("\n".join(lines)) > ORIENTATION_MAX_TOKENS:
        lines.pop()
    if len(lines) <= 1:
        return ""
    return "\n".join(lines) + "\n\n"


def maybe_prepend_orientation(
    ctx: str,
    intent: Any,
    storage: Any,
    rendered_passage_ids: list[str] | None,
) -> str:
    """The engine's one call site. Flag off ⇒ returns ``ctx`` UNCHANGED
    (byte-identical, the acceptance invariant). Orientation is a render
    decoration: a failure here must never break a render — it logs loudly
    and returns the undecorated context (fail-soft by design, NOT silent).
    """
    if not orientation_enabled():
        return ctx
    if not ctx or not isinstance(ctx, str):
        return ctx
    try:
        mode = derive_map_mode(intent)
        frame = build_orientation_frame(mode, storage, rendered_passage_ids)
        if not frame:
            return ctx
        return frame + ctx
    except Exception:
        logger.exception(
            "[world-map] orientation frame failed; returning undecorated render"
        )
        return ctx
