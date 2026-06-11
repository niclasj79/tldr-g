"""Per-rung community centroid storage and vec0 search helpers."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
import re
from collections.abc import Iterable, Mapping, Sequence

import numpy as np

from tp_vrg.storage.community_partitions import Rung, read_partition

VALID_CENTROID_RUNGS: tuple[Rung, ...] = ("asset", "island", "continent")
CENTROID_INDEX_TABLES: Mapping[Rung, str] = {
    "asset": "community_centroids_asset_embeddings",
    "island": "community_centroids_island_embeddings",
    "continent": "community_centroids_continent_embeddings",
}

_SOURCE_RUNG: Mapping[Rung, Rung | None] = {
    "asset": None,
    "island": "asset",
    "continent": "island",
}
_FLOAT_DIM_RE = re.compile(r"FLOAT\[(\d+)\]", re.IGNORECASE)


@dataclass(frozen=True)
class CentroidSearchResult:
    """One cosine-ranked per-rung community centroid match."""

    community_id: str
    similarity: float
    member_count: int


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _validate_rung(rung: str) -> Rung:
    if rung not in VALID_CENTROID_RUNGS:
        raise ValueError(
            f"Unknown centroid rung {rung!r}; expected {list(VALID_CENTROID_RUNGS)}"
        )
    return rung  # type: ignore[return-value]


def _index_table(rung: Rung) -> str:
    return CENTROID_INDEX_TABLES[rung]


def _table_exists(conn, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _detect_vec0_sql(conn, table_name: str) -> str | None:
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?",
        (table_name,),
    ).fetchone()
    if row is None or row[0] is None:
        return None
    return str(row[0])


def _detect_vec0_dim(conn, table_name: str) -> int | None:
    sql = _detect_vec0_sql(conn, table_name)
    if sql is None:
        return None
    match = _FLOAT_DIM_RE.search(sql)
    return int(match.group(1)) if match else None


def _vec0_uses_cosine_metric(conn, table_name: str) -> bool:
    sql = (_detect_vec0_sql(conn, table_name) or "").lower()
    return "distance_metric=cosine" in sql or "distance=cosine" in sql


def _detect_blob_dim(conn, table_name: str, *, where: str = "") -> int | None:
    if not _table_exists(conn, table_name):
        return None
    sql = f"SELECT embedding FROM {table_name} {where} LIMIT 1"
    try:
        row = conn.execute(sql).fetchone()
    except Exception:
        return None
    if row is None:
        return None
    return len(bytes(row[0])) // np.dtype(np.float32).itemsize


def resolve_embedding_dim(conn, requested_dim: int | None = None) -> int:
    """Resolve the active embedding dimension and enforce C2 alignment."""
    detected: list[tuple[str, int]] = []
    for table_name in (
        "passage_embeddings",
        "node_embeddings",
        *CENTROID_INDEX_TABLES.values(),
    ):
        dim = _detect_vec0_dim(conn, table_name)
        if dim is not None:
            detected.append((table_name, dim))

    if requested_dim is not None:
        requested = int(requested_dim)
        if requested <= 0:
            raise ValueError("embedding_dim must be > 0")
        mismatches = [
            (table_name, dim)
            for table_name, dim in detected
            if dim != requested
        ]
        if mismatches:
            details = ", ".join(
                f"{table_name}=FLOAT[{dim}]" for table_name, dim in mismatches
            )
            raise ValueError(
                f"C2 violated for community centroids: requested embedding_dim={requested} "
                f"but existing vec0 schema reports {details}"
            )
        return requested

    unique_dims = sorted({dim for _table_name, dim in detected})
    if len(unique_dims) == 1:
        return unique_dims[0]
    if len(unique_dims) > 1:
        details = ", ".join(f"{table_name}=FLOAT[{dim}]" for table_name, dim in detected)
        raise ValueError(f"C2 violated for community centroids: mixed vec0 dims ({details})")

    inferred = _detect_blob_dim(conn, "passage_embedding_store")
    if inferred is not None and inferred > 0:
        return inferred
    if _table_exists(conn, "community_centroids"):
        row = conn.execute(
            "SELECT centroid_blob FROM community_centroids LIMIT 1"
        ).fetchone()
        if row is not None:
            return len(bytes(row[0])) // np.dtype(np.float32).itemsize
    raise ValueError(
        "Cannot resolve community centroid embedding dimension: no vec0 schema "
        "or canonical embedding rows found"
    )


def init_schema(conn, embedding_dim: int) -> None:
    """Create the centroid store plus one vec0 table per community rung."""
    dim = resolve_embedding_dim(conn, embedding_dim)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS community_centroids (
          rung TEXT NOT NULL,
          community_id TEXT NOT NULL,
          centroid_blob BLOB NOT NULL,
          member_count INTEGER NOT NULL CHECK (member_count > 0),
          computed_at TEXT NOT NULL,
          PRIMARY KEY (rung, community_id)
        );

        CREATE INDEX IF NOT EXISTS idx_community_centroids_rung
          ON community_centroids (rung);
        """
    )
    for table_name in CENTROID_INDEX_TABLES.values():
        existing_dim = _detect_vec0_dim(conn, table_name)
        if existing_dim is not None and existing_dim != dim:
            raise ValueError(
                f"C2 violated for {table_name}: existing FLOAT[{existing_dim}] "
                f"!= requested FLOAT[{dim}]"
            )
        conn.execute(
            f"""
            CREATE VIRTUAL TABLE IF NOT EXISTS {table_name} USING vec0(
                id TEXT PRIMARY KEY,
                embedding FLOAT[{dim}] distance_metric=cosine
            )
            """
        )
    conn.commit()


def _as_vector(value: Sequence[float] | np.ndarray, *, dim: int, label: str) -> np.ndarray:
    vector = np.asarray(value, dtype=np.float32)
    if vector.shape != (dim,):
        raise ValueError(f"{label} has dimension {vector.size}; expected {dim}")
    if not np.all(np.isfinite(vector)):
        raise ValueError(f"{label} contains non-finite values")
    return vector


def _blob_to_vector(blob: bytes, *, dim: int, label: str) -> np.ndarray:
    vector = np.frombuffer(bytes(blob), dtype=np.float32)
    if vector.shape != (dim,):
        raise ValueError(f"{label} has dimension {vector.size}; expected {dim}")
    if not np.all(np.isfinite(vector)):
        raise ValueError(f"{label} contains non-finite values")
    return vector


def _unit_centroid(vector: np.ndarray, *, label: str) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    if norm == 0.0:
        raise ValueError(f"{label} produced a zero centroid")
    return (vector / norm).astype(np.float32)


def write_centroid(
    rung: str,
    community_id: str,
    centroid: Sequence[float] | np.ndarray,
    member_count: int,
    conn,
    *,
    embedding_dim: int | None = None,
) -> None:
    """Upsert one community centroid into the canonical table and rung vec0 index."""
    resolved_rung = _validate_rung(rung)
    dim = resolve_embedding_dim(conn, embedding_dim)
    init_schema(conn, dim)
    if member_count <= 0:
        raise ValueError("member_count must be > 0")
    vector = _unit_centroid(
        _as_vector(centroid, dim=dim, label=f"{resolved_rung}/{community_id}"),
        label=f"{resolved_rung}/{community_id}",
    )
    blob = vector.tobytes()
    computed_at = _utc_now()
    conn.execute(
        """
        INSERT INTO community_centroids
          (rung, community_id, centroid_blob, member_count, computed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(rung, community_id) DO UPDATE SET
          centroid_blob = excluded.centroid_blob,
          member_count = excluded.member_count,
          computed_at = excluded.computed_at
        """,
        (resolved_rung, community_id, blob, int(member_count), computed_at),
    )
    table_name = _index_table(resolved_rung)
    conn.execute(f"DELETE FROM {table_name} WHERE id = ?", (community_id,))
    conn.execute(
        f"INSERT INTO {table_name}(id, embedding) VALUES (?, ?)",
        (community_id, blob),
    )
    conn.commit()


def _member_to_community(partition: Mapping[str, Sequence[str]], rung: Rung) -> dict[str, str]:
    mapping: dict[str, str] = {}
    duplicates: set[str] = set()
    for community_id, member_ids in partition.items():
        if not member_ids:
            raise ValueError(f"Cannot compute {rung} centroid for empty community {community_id!r}")
        for member_id in member_ids:
            member_key = str(member_id)
            if member_key in mapping:
                duplicates.add(member_key)
            mapping[member_key] = str(community_id)
    if duplicates:
        raise ValueError(
            f"{rung} partition assigns members to multiple communities: "
            f"{sorted(duplicates)[:10]}"
        )
    if not mapping:
        raise ValueError(f"Cannot compute {rung} centroids from an empty partition")
    return mapping


def _source_embedding_rows(rung: Rung, conn) -> Iterable[tuple[str, bytes]]:
    source_rung = _SOURCE_RUNG[rung]
    if source_rung is None:
        if not _table_exists(conn, "passage_embedding_store"):
            raise ValueError("Cannot compute Asset centroids: passage_embedding_store is missing")
        return conn.execute(
            "SELECT id, embedding FROM passage_embedding_store ORDER BY id"
        ).fetchall()
    if not _table_exists(conn, "community_centroids"):
        raise ValueError(
            f"Cannot compute {rung} centroids: {source_rung} centroids are missing"
        )
    return conn.execute(
        """
        SELECT community_id, centroid_blob
        FROM community_centroids
        WHERE rung = ?
        ORDER BY community_id
        """,
        (source_rung,),
    ).fetchall()


def compute_centroids_for_partition(
    rung: str,
    partition: Mapping[str, Sequence[str]],
    conn,
    *,
    embedding_dim: int | None = None,
) -> dict[str, tuple[np.ndarray, int]]:
    """Compute normalized centroids for one rung without writing them."""
    resolved_rung = _validate_rung(rung)
    dim = resolve_embedding_dim(conn, embedding_dim)
    member_to_community = _member_to_community(partition, resolved_rung)
    sums: dict[str, np.ndarray] = {}
    counts: dict[str, int] = {}
    seen_members: set[str] = set()

    for member_id, blob in _source_embedding_rows(resolved_rung, conn):
        member_key = str(member_id)
        community_id = member_to_community.get(member_key)
        if community_id is None:
            continue
        vector = _blob_to_vector(
            blob,
            dim=dim,
            label=f"{resolved_rung} source embedding {member_key!r}",
        )
        if community_id not in sums:
            sums[community_id] = np.zeros(dim, dtype=np.float64)
            counts[community_id] = 0
        sums[community_id] += vector.astype(np.float64)
        counts[community_id] += 1
        seen_members.add(member_key)

    missing = sorted(set(member_to_community) - seen_members)
    if missing:
        raise ValueError(
            f"Cannot compute {resolved_rung} centroids: {len(missing)} member "
            f"embeddings missing; examples={missing[:10]}"
        )

    centroids: dict[str, tuple[np.ndarray, int]] = {}
    for community_id, vector_sum in sorted(sums.items()):
        member_count = counts[community_id]
        mean = (vector_sum / member_count).astype(np.float32)
        centroids[community_id] = (
            _unit_centroid(mean, label=f"{resolved_rung}/{community_id}"),
            member_count,
        )
    return centroids


def replace_centroids(
    rung: str,
    centroids: Mapping[str, tuple[np.ndarray, int]],
    conn,
    *,
    embedding_dim: int | None = None,
) -> int:
    """Replace all centroid rows for one rung and keep its vec0 index in sync."""
    resolved_rung = _validate_rung(rung)
    dim = resolve_embedding_dim(conn, embedding_dim)
    init_schema(conn, dim)
    table_name = _index_table(resolved_rung)
    computed_at = _utc_now()
    store_rows: list[tuple[str, str, bytes, int, str]] = []
    index_rows: list[tuple[str, bytes]] = []
    for community_id, (centroid, member_count) in sorted(centroids.items()):
        if member_count <= 0:
            raise ValueError(f"{resolved_rung}/{community_id} member_count must be > 0")
        vector = _unit_centroid(
            _as_vector(
                centroid,
                dim=dim,
                label=f"{resolved_rung}/{community_id}",
            ),
            label=f"{resolved_rung}/{community_id}",
        )
        blob = vector.tobytes()
        store_rows.append((resolved_rung, community_id, blob, int(member_count), computed_at))
        index_rows.append((community_id, blob))

    conn.execute("DELETE FROM community_centroids WHERE rung = ?", (resolved_rung,))
    conn.execute(f"DELETE FROM {table_name}")
    if store_rows:
        conn.executemany(
            """
            INSERT INTO community_centroids
              (rung, community_id, centroid_blob, member_count, computed_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            store_rows,
        )
        conn.executemany(
            f"INSERT INTO {table_name}(id, embedding) VALUES (?, ?)",
            index_rows,
        )
    conn.commit()
    return len(store_rows)


def recompute_centroids_for_rung(
    rung: str,
    conn,
    *,
    embedding_dim: int | None = None,
) -> int:
    """Recompute and replace centroids for one already-baked community rung."""
    resolved_rung = _validate_rung(rung)
    partition = read_partition(resolved_rung, conn)
    if not partition:
        raise ValueError(f"Cannot recompute {resolved_rung} centroids: partition is empty")
    centroids = compute_centroids_for_partition(
        resolved_rung,
        partition,
        conn,
        embedding_dim=embedding_dim,
    )
    return replace_centroids(
        resolved_rung,
        centroids,
        conn,
        embedding_dim=embedding_dim,
    )


async def recompute_centroids_for_rung_async(
    rung: str,
    conn,
    *,
    embedding_dim: int | None = None,
) -> int:
    """Event-loop-safe centroid recompute for async janitor callers."""
    return await asyncio.to_thread(
        recompute_centroids_for_rung,
        rung,
        conn,
        embedding_dim=embedding_dim,
    )


def recompute_all_centroids(
    conn,
    *,
    embedding_dim: int | None = None,
    rungs: Sequence[str] = VALID_CENTROID_RUNGS,
    skip_empty: bool = True,
) -> dict[str, int]:
    """Recompute centroids in dependency order and return per-rung counts."""
    summary: dict[str, int] = {}
    for rung in rungs:
        resolved_rung = _validate_rung(rung)
        if not read_partition(resolved_rung, conn):
            if skip_empty:
                summary[resolved_rung] = 0
                continue
            raise ValueError(f"Cannot recompute {resolved_rung} centroids: partition is empty")
        summary[resolved_rung] = recompute_centroids_for_rung(
            resolved_rung,
            conn,
            embedding_dim=embedding_dim,
        )
    return summary


async def recompute_all_centroids_async(
    conn,
    *,
    embedding_dim: int | None = None,
    rungs: Sequence[str] = VALID_CENTROID_RUNGS,
    skip_empty: bool = True,
) -> dict[str, int]:
    """Event-loop-safe full centroid recompute."""
    return await asyncio.to_thread(
        recompute_all_centroids,
        conn,
        embedding_dim=embedding_dim,
        rungs=rungs,
        skip_empty=skip_empty,
    )


def top_k_centroids(
    rung: str,
    query_embedding: Sequence[float] | np.ndarray,
    top_k: int,
    conn,
    *,
    embedding_dim: int | None = None,
) -> list[CentroidSearchResult]:
    """Return top-K communities in one rung by vec0 cosine similarity."""
    resolved_rung = _validate_rung(rung)
    if top_k <= 0:
        return []
    table_name = _index_table(resolved_rung)
    store_exists = _table_exists(conn, "community_centroids")
    index_exists = _table_exists(conn, table_name)
    if not store_exists and not index_exists:
        return []
    if not store_exists or not index_exists:
        raise ValueError(
            f"Centroid index drift for {resolved_rung}: store_exists={store_exists}, "
            f"index_exists={index_exists}"
        )

    dim = resolve_embedding_dim(conn, embedding_dim)
    query = _as_vector(query_embedding, dim=dim, label="query_embedding")
    if float(np.linalg.norm(query)) == 0.0:
        return []

    query_blob = query.astype(np.float32).tobytes()
    if _vec0_uses_cosine_metric(conn, table_name):
        rows = conn.execute(
            f"""
            SELECT v.id, v.distance AS dist, c.member_count
            FROM {table_name} AS v
            JOIN community_centroids AS c
              ON c.rung = ? AND c.community_id = v.id
            WHERE v.embedding MATCH ? AND k = ?
            ORDER BY v.distance
            """,
            (resolved_rung, query_blob, int(top_k)),
        ).fetchall()
    else:
        rows = conn.execute(
            f"""
            SELECT v.id, vec_distance_cosine(v.embedding, ?) AS dist, c.member_count
            FROM {table_name} AS v
            JOIN community_centroids AS c
              ON c.rung = ? AND c.community_id = v.id
            ORDER BY dist
            LIMIT ?
            """,
            (query_blob, resolved_rung, int(top_k)),
        ).fetchall()
    return [
        CentroidSearchResult(
            community_id=str(community_id),
            similarity=1.0 - float(distance),
            member_count=int(member_count),
        )
        for community_id, distance, member_count in rows
    ]


def centroid_counts(conn) -> dict[str, int]:
    """Return canonical centroid row counts per rung without recomputing."""
    if not _table_exists(conn, "community_centroids"):
        return {rung: 0 for rung in VALID_CENTROID_RUNGS}
    rows = conn.execute(
        """
        SELECT rung, COUNT(*)
        FROM community_centroids
        GROUP BY rung
        """
    ).fetchall()
    counts = {rung: 0 for rung in VALID_CENTROID_RUNGS}
    counts.update({str(rung): int(count) for rung, count in rows})
    return counts


def assert_vec0_integrity(
    conn,
    *,
    embedding_dim: int | None = None,
) -> dict[str, int]:
    """Verify canonical centroid rows and per-rung vec0 indexes match exactly."""
    dim = resolve_embedding_dim(conn, embedding_dim)
    init_schema(conn, dim)
    counts: dict[str, int] = {}
    for rung in VALID_CENTROID_RUNGS:
        table_name = _index_table(rung)
        store_ids = {
            str(row[0])
            for row in conn.execute(
                "SELECT community_id FROM community_centroids WHERE rung = ?",
                (rung,),
            ).fetchall()
        }
        index_ids = {
            str(row[0])
            for row in conn.execute(f"SELECT id FROM {table_name}").fetchall()
        }
        if store_ids != index_ids:
            missing_in_index = sorted(store_ids - index_ids)
            orphan_index = sorted(index_ids - store_ids)
            raise ValueError(
                f"Centroid vec0 integrity failed for {rung}: "
                f"missing_in_index={missing_in_index[:10]}, "
                f"orphan_index={orphan_index[:10]}"
            )
        counts[rung] = len(store_ids)
    return counts


__all__ = [
    "CENTROID_INDEX_TABLES",
    "CentroidSearchResult",
    "VALID_CENTROID_RUNGS",
    "assert_vec0_integrity",
    "centroid_counts",
    "compute_centroids_for_partition",
    "init_schema",
    "recompute_all_centroids",
    "recompute_all_centroids_async",
    "recompute_centroids_for_rung",
    "recompute_centroids_for_rung_async",
    "replace_centroids",
    "resolve_embedding_dim",
    "top_k_centroids",
    "write_centroid",
]
