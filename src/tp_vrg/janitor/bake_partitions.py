"""Unified Asset -> Island -> Continent community partition bake."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import datetime, timezone
import logging
import time

from tp_vrg.janitor.bake_asset_rung import bake_asset_rung
from tp_vrg.janitor.bake_continent_rung import bake_continent_rung
from tp_vrg.janitor.bake_island_rung import bake_island_rung, get_partition_algorithm
from tp_vrg.storage.per_rung_centroids import assert_vec0_integrity, centroid_counts

logger = logging.getLogger(__name__)

_PHASES = ("asset", "island", "continent", "centroids")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def bake_partitions(
    conn,
    *,
    force_rebake: bool = False,
    recompute_centroids: bool = True,
    on_phase: Callable[[str, int, int], None] | None = None,
) -> dict[str, object]:
    """Bake all community rungs off the event loop and refresh centroids.

    ``force_rebake`` is accepted for the Janitor task contract; Phase 1 always
    performs an idempotent full replacement, so the flag does not alter behavior.

    ``on_phase(name, index, total)`` is invoked (best-effort) immediately before
    each phase begins, so a long-running caller (the async HTTP job surface) can
    report live phase/progress. Phase markers are also logged unconditionally so
    an operator tailing the engine log can distinguish "working" from "wedged" on
    every operator surface — the bake is minute-scale on a real graph, not "<5s".
    """
    del force_rebake
    total = len(_PHASES)

    def _phase(name: str, index: int) -> None:
        logger.info("[bake] phase %d/%d: %s", index + 1, total, name)
        if on_phase is not None:
            try:
                on_phase(name, index, total)
            except Exception:  # progress reporting must never break the bake
                logger.debug("[bake] on_phase callback raised", exc_info=True)

    started = time.perf_counter()

    _phase("asset", 0)
    asset_partition = await asyncio.to_thread(
        bake_asset_rung,
        conn,
        recompute_centroids=recompute_centroids,
    )
    _phase("island", 1)
    island_partition = await asyncio.to_thread(
        bake_island_rung,
        conn,
        recompute_centroids=recompute_centroids,
    )
    _phase("continent", 2)
    continent_partition = await asyncio.to_thread(
        bake_continent_rung,
        conn,
        recompute_centroids=recompute_centroids,
    )
    _phase("centroids", 3)
    integrity = (
        assert_vec0_integrity(conn)
        if recompute_centroids
        else centroid_counts(conn)
    )
    wall_time_s = time.perf_counter() - started
    logger.info(
        "[bake] complete: asset=%d island=%d continent=%d wall_time_s=%.2f",
        len(asset_partition),
        len(island_partition),
        len(continent_partition),
        wall_time_s,
    )
    return {
        "asset_count": len(asset_partition),
        "island_count": len(island_partition),
        "continent_count": len(continent_partition),
        "centroid_counts": integrity,
        "algorithm": get_partition_algorithm(),
        "baked_at": _utc_now(),
        "wall_time_s": wall_time_s,
    }
