"""Claim-validity recording — the temporal supersession write path.

The regulated-buyer promise "what was the rule on date X" needs every claim
(today's grain: the passage) to carry validity bounds: ``valid_at`` (when its
edition was declared) and ``invalid_at`` (when a later edition superseded it).
The substrate half (the ``claim_validity`` table) is created by
``SQLiteBackend._migrate_asset_overlay_schema``; this module is the writer.

Wired 2026-06-10 by the supersession-unification sprint: the production caller
is the asset-edition transition inside ``backfill_assets_by_source_document``
(see ``storage_sqlite.advance_asset_edition``) — re-ingesting a changed
document advances the Asset edition and records supersession rows for the
prior edition's claims in the same transaction. Until then this writer was the
``claim_supersession`` dormancy (INV-5, [ASSET-EDITION-SUPERSESSION-WIRING]).

Layer discipline (arch-asset-semantic-unit §2): supersession MARKS, never
rewrites — the superseded edition's Asset row and claims are immutable
Authorial Layer-1 records; ``claim_validity`` is an append-style overlay.
"""

from __future__ import annotations

import logging
import sqlite3
from collections.abc import Iterable

logger = logging.getLogger(__name__)


def record_supersession(
    conn: sqlite3.Connection,
    *,
    lineage_id: str,
    superseded_asset_id: str,
    superseded_edition_seq: int,
    superseding_asset_id: str,
    claim_ids: Iterable[str],
    valid_at: str | None,
    invalid_at: str,
) -> int:
    """Record validity bounds for a superseded edition's claims.

    One row per claim (passage) of the superseded edition: ``valid_at`` = the
    superseded edition's ``declared_at``; ``invalid_at`` = the superseding
    edition's ``declared_at``. Idempotent (INSERT OR REPLACE on the
    ``(claim_id, lineage_id, edition_seq)`` primary key) so a re-run of the
    same transition never duplicates rows.

    Returns the number of claim rows recorded. Zero claims is legitimate (an
    edition whose passages were already re-pointed by an interrupted earlier
    run) and logged rather than raised; empty identifiers are structural
    errors and raise (INV-2 fail-loud).
    """
    if not lineage_id or not superseded_asset_id or not superseding_asset_id:
        raise ValueError(
            "record_supersession requires lineage_id, superseded_asset_id and "
            "superseding_asset_id — got "
            f"lineage_id={lineage_id!r} superseded={superseded_asset_id!r} "
            f"superseding={superseding_asset_id!r}"
        )
    if not invalid_at:
        raise ValueError("record_supersession requires invalid_at (the superseding "
                         "edition's declared_at)")

    rows = [
        (
            claim_id,
            lineage_id,
            int(superseded_edition_seq),
            valid_at,
            invalid_at,
            superseding_asset_id,
        )
        for claim_id in claim_ids
        if claim_id
    ]
    if not rows:
        logger.info(
            "record_supersession: superseded edition %s (lineage %s) had no claims "
            "to bound — recording nothing.",
            superseded_asset_id,
            lineage_id,
        )
        return 0

    conn.executemany(
        """
        INSERT OR REPLACE INTO claim_validity (
            claim_id, lineage_id, edition_seq, valid_at, invalid_at, superseded_by
        )
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    logger.info(
        "record_supersession: %d claims of %s (lineage %s, edition %d) bounded "
        "valid_at=%s invalid_at=%s superseded_by=%s",
        len(rows),
        superseded_asset_id,
        lineage_id,
        superseded_edition_seq,
        valid_at,
        invalid_at,
        superseding_asset_id,
    )
    return len(rows)


__all__ = ("record_supersession",)
