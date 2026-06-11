"""SQLite persistence for hierarchical edge bundles.

This module owns the bundle cache schema. It intentionally does not modify the
existing graph storage backend.
"""

from __future__ import annotations

import io
import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

import numpy as np

from .bundle import Bundle


def migrate(conn: sqlite3.Connection) -> None:
    """Create the bundle table if needed. Idempotent."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS bundles (
            community_a_id TEXT NOT NULL,
            community_b_id TEXT NOT NULL,
            level INTEGER NOT NULL,
            w REAL NOT NULL,
            sigma_blob BLOB NOT NULL,
            entity_set_blob BLOB NOT NULL,
            tau_blob BLOB NOT NULL,
            rho_blob BLOB NOT NULL,
            evidence_blob BLOB NOT NULL,
            computed_at TEXT NOT NULL,
            stale BOOLEAN NOT NULL DEFAULT 0,
            PRIMARY KEY (community_a_id, community_b_id, level)
        )
        """
    )
    _ensure_stale_column(conn)
    conn.commit()


def _ensure_stale_column(conn: sqlite3.Connection) -> None:
    columns = {
        str(row[1]) for row in conn.execute("PRAGMA table_info(bundles)").fetchall()
    }
    if "stale" not in columns:
        conn.execute("ALTER TABLE bundles ADD COLUMN stale BOOLEAN NOT NULL DEFAULT 0")


def _array_to_blob(value: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    np.save(buffer, np.asarray(value, dtype=np.float64), allow_pickle=False)
    return buffer.getvalue()


def _array_from_blob(blob: bytes) -> np.ndarray:
    buffer = io.BytesIO(blob)
    return np.load(buffer, allow_pickle=False)


def _json_to_blob(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _json_from_blob(blob: bytes) -> Any:
    return json.loads(blob.decode("utf-8"))


def _parse_computed_at(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def save_bundle(
    conn: sqlite3.Connection, bundle: Bundle, *, stale: bool = False
) -> None:
    """Insert or replace a bundle row."""
    migrate(conn)
    conn.execute(
        """
        INSERT OR REPLACE INTO bundles (
            community_a_id,
            community_b_id,
            level,
            w,
            sigma_blob,
            entity_set_blob,
            tau_blob,
            rho_blob,
            evidence_blob,
            computed_at,
            stale
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            bundle.community_a_id,
            bundle.community_b_id,
            bundle.level,
            bundle.w,
            _array_to_blob(bundle.sigma),
            _json_to_blob(sorted(bundle.entity_set)),
            _array_to_blob(bundle.tau),
            _json_to_blob(bundle.rho),
            _json_to_blob(list(bundle.evidence)),
            bundle.computed_at.isoformat(),
            int(bool(stale)),
        ),
    )
    conn.commit()


def _bundle_from_row(row: sqlite3.Row | tuple[Any, ...]) -> Bundle:
    return Bundle(
        community_a_id=row[0],
        community_b_id=row[1],
        level=int(row[2]),
        w=float(row[3]),
        sigma=_array_from_blob(row[4]),
        entity_set=frozenset(_json_from_blob(row[5])),
        tau=_array_from_blob(row[6]),
        rho={str(k): float(v) for k, v in _json_from_blob(row[7]).items()},
        evidence=tuple(str(edge_id) for edge_id in _json_from_blob(row[8])),
        computed_at=_parse_computed_at(row[9]),
    )


def load_bundle(
    conn: sqlite3.Connection,
    community_a_id: str,
    community_b_id: str,
    level: int,
) -> Bundle | None:
    """Load one bundle by primary key."""
    migrate(conn)
    row = conn.execute(
        """
        SELECT community_a_id, community_b_id, level, w, sigma_blob,
               entity_set_blob, tau_blob, rho_blob, evidence_blob, computed_at
        FROM bundles
        WHERE community_a_id = ? AND community_b_id = ? AND level = ?
        """,
        (community_a_id, community_b_id, int(level)),
    ).fetchone()
    if row is None:
        return None
    return _bundle_from_row(row)


def list_bundles(conn: sqlite3.Connection, *, level: int | None = None) -> list[Bundle]:
    """Load bundle rows, optionally restricted to one level."""
    migrate(conn)
    if level is None:
        rows = conn.execute(
            """
            SELECT community_a_id, community_b_id, level, w, sigma_blob,
                   entity_set_blob, tau_blob, rho_blob, evidence_blob, computed_at
            FROM bundles
            ORDER BY level, community_a_id, community_b_id
            """
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT community_a_id, community_b_id, level, w, sigma_blob,
                   entity_set_blob, tau_blob, rho_blob, evidence_blob, computed_at
            FROM bundles
            WHERE level = ?
            ORDER BY community_a_id, community_b_id
            """,
            (int(level),),
        ).fetchall()
    return [_bundle_from_row(row) for row in rows]
