"""
SQLite Storage Backend — persistent graph storage using sqlite-vec.

The .db file IS the database. NetworkX is used only as a transient
in-memory analysis tool for graph algorithms (BFS, centrality),
loaded on-demand from SQLite edges and cached with invalidation.
"""

from __future__ import annotations

import json
import logging
import os
import hashlib
import re
import shutil
import time
import sqlite3
from collections.abc import Iterable
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import networkx as nx
import numpy as np
import sqlite_vec

from tp_vrg.centrality import compute_backbone_centrality, get_active_centrality_measure
from tp_vrg.models import EdgeData, NodeData, SourcePassage, STRUCTURAL_RELATIONS
from tp_vrg.storage.connection_isolation import isolated_sqlite_connection
from tp_vrg.storage.health import collect_sqlite_health


@dataclass(frozen=True)
class ClosureResult:
    """Result of resolve_derived_closure — the derived-only-vs-shared node split.

    See [[docs/design/arch-rung-level-subgraph-migration-2026-06-08.md]] §3 Step 0.
    The closure-resolver is the cross-rung migration primitive that backs
    delete_source (Art 17 erasure), extract_source (Art 20 portability), and
    every higher-rung delete/extract (Asset, Island, Continent).

    - ``derived_only``: nodes whose entire node_provenance footprint is inside
      the input passage set; if those passages were removed, these nodes would
      have no remaining provenance and are safe to delete / extractable.
    - ``shared``: nodes that ALSO have node_provenance rows outside the input
      passage set; if those passages were removed, these nodes survive with
      reduced provenance and must be preserved (or ghost-stubbed when extracting).
    - ``boundary_edges``: directed edges ``(source, target, relation)`` with
      EXACTLY one endpoint in ``derived_only`` — the "cut" edges an extract
      must carry as typed stubs (per §4 + §6 of the rung-migration design).
      Edges with BOTH endpoints in ``derived_only`` are *internal* (belong to
      the extracted artifact); edges with neither endpoint in ``derived_only``
      are irrelevant. Defaults to ``frozenset()`` for backward-compat with
      pre-Art-20 construction sites.
    """

    derived_only: frozenset[str]
    shared: frozenset[str]
    boundary_edges: frozenset[tuple[str, str, str]] = frozenset()

logger = logging.getLogger(__name__)

_SQL_VARIABLES_CAP_CHUNK_SIZE = 2000


class SQLiteBackend:
    """
    Persistent graph storage backed by a SQLite file.

    Schema:
        nodes              — entity data with full metadata (incl. is_chunk, parent_id, etc.)
        node_embeddings    — vec0 virtual table for sqlite-vec cosine search
        edges              — unique (source, target, relation) triplets; dedup via PRIMARY KEY
        nodes_fts          — FTS5 full-text index over name, lod_0, lod_1
        passages           — raw text passages linked to extracted entities
        backbone           — pre-computed backbone centrality cache (for Janitor)
    """

    def __init__(self, path: str | Path, embedding_dim: int | None = None) -> None:
        """
        Open or create a SQLite-backed TP-VRG graph.

        Args:
            path: filesystem path to the .db file. Created if missing.
            embedding_dim: expected embedding dimensionality. If None, the
                dim is auto-detected from an existing graph's vec0 schema,
                or falls back to 384 for a fresh graph. If an int is
                passed AND an existing graph's vec0 schema reports a
                different dim, a WARNING is logged and the existing
                on-disk schema wins — the caller's value is NOT used.
                This prevents the SQL-I1-class silent dim mismatch where
                a caller passes the wrong dim and the resulting vec0
                INSERT fails at runtime with an opaque error.
        """
        self._path = Path(path)
        self._known_ids: set[str] = set()
        self._edge_count: int = 0
        self._graph_cache: nx.Graph | None = None
        self._graph_cache_semantic: nx.DiGraph | None = None  # structural edges excluded
        self._neighborhood_cache: dict[str, dict[str, float]] | None = None
        self._centrality_cache: dict[str, float] | None = None
        self._centrality_cache_measure: str | None = None
        self._drift_warning_emitted: bool = False  # once-per-process drift log flag
        self._conn: sqlite3.Connection | None = None
        self._in_batch: bool = False  # True while a batch transaction is open
        self._bulk_mode: bool = False
        self._bulk_mode_depth: int = 0
        self._bulk_warning_emitted: set[str] = set()

        # SQL-I1 guard: detect existing graph's vec0 dim before touching schema
        existing_dim = self._detect_existing_embedding_dim()
        if existing_dim is not None:
            if embedding_dim is not None and embedding_dim != existing_dim:
                logger.warning(
                    "SQLiteBackend dim mismatch for %s: caller requested "
                    "embedding_dim=%d but existing vec0 schema is FLOAT[%d]. "
                    "Using existing schema dim (%d). Caller's value is IGNORED. "
                    "If this is unintentional, the graph needs to be re-embedded "
                    "at %d dims (see backlog SQL-I1 option C re-embedding janitor task).",
                    self._path, embedding_dim, existing_dim, existing_dim, embedding_dim,
                )
            self._embedding_dim = existing_dim
        else:
            # Fresh graph: honor the caller's requested dim, fall back to 384
            self._embedding_dim = embedding_dim if embedding_dim is not None else 384

        self._open_or_create()

    def _batch_in_query(
        self,
        sql_template: str,
        ids: list[str] | tuple[str, ...] | set[str],
        *,
        chunk_size: int = _SQL_VARIABLES_CAP_CHUNK_SIZE,
        repeat_bindings: int = 1,
    ) -> list[tuple]:
        """Execute an IN-clause query in bounded chunks.

        ``sql_template`` must contain ``{placeholders}``, which is replaced
        with the comma-separated ``?`` placeholders for each chunk.  The
        default chunk size stays well under SQLite's 32K variable cap even
        for doubled-binding queries such as ``source IN (...) OR target IN
        (...)`` where the same ID batch is bound twice.
        """
        if not ids:
            return []
        if chunk_size < 1:
            raise ValueError("chunk_size must be >= 1")
        if repeat_bindings < 1:
            raise ValueError("repeat_bindings must be >= 1")

        deduped_ids = list(dict.fromkeys(ids))
        rows: list[tuple] = []
        for start in range(0, len(deduped_ids), chunk_size):
            batch = deduped_ids[start:start + chunk_size]
            placeholders = ",".join("?" * len(batch))
            params = tuple(batch) * repeat_bindings
            rows.extend(
                self._conn.execute(
                    sql_template.format(placeholders=placeholders),
                    params,
                ).fetchall()
            )
        return rows

    def _visible_node_ids(self, ids: set[str]) -> set[str]:
        """Return node IDs visible to SQLite on this connection.

        `_known_ids` is a hot-path cache, but concurrent ingest can briefly
        make it optimistic. Edge FK gating must consult SQLite's actual view
        before insert so a stale cache entry cannot pass the Python filter and
        then fail at the database constraint.
        """
        if not ids:
            return set()
        rows = self._batch_in_query(
            "SELECT entity_id FROM nodes WHERE entity_id IN ({placeholders})",
            ids,
        )
        return {row[0] for row in rows}

    def _detect_existing_embedding_dim(self) -> int | None:
        """
        Read the vec0 declared dim from an existing graph's schema without
        initializing anything else. Returns None for fresh/missing graphs.

        This runs BEFORE _open_or_create, so it uses a throwaway connection
        that doesn't pollute the main one. Specifically queries the
        `node_embeddings` vec0 table's CREATE DDL from sqlite_master and
        regex-extracts the FLOAT[N] declaration.
        """
        if not self._path.exists():
            return None
        try:
            tmp = sqlite3.connect(str(self._path))
            try:
                row = tmp.execute(
                    "SELECT sql FROM sqlite_master "
                    "WHERE type='table' AND name='node_embeddings'"
                ).fetchone()
            finally:
                tmp.close()
        except sqlite3.Error:
            return None
        if row is None or row[0] is None:
            return None
        # sql looks like: "CREATE VIRTUAL TABLE node_embeddings USING vec0(
        #                     id TEXT PRIMARY KEY,
        #                     embedding FLOAT[1024]
        #                 )"
        import re
        m = re.search(r"FLOAT\[(\d+)\]", row[0])
        return int(m.group(1)) if m else None

    def _open_or_create(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self._path), check_same_thread=False)
        self._conn.enable_load_extension(True)
        sqlite_vec.load(self._conn)  # SOTA: Vector similarity in SQLite — adopted from sqlite-vec (Alex Garcia, 2024)
        self._conn.enable_load_extension(False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        # SQL-C1: safe PRAGMA tuning (benchmark-validated as safe with WAL)
        self._conn.execute("PRAGMA synchronous=NORMAL")    # safe with WAL; ~2x write speed
        self._conn.execute("PRAGMA temp_store=MEMORY")     # temp tables in RAM
        self._conn.execute("PRAGMA cache_size=-20000")     # 20MB page cache (default 2MB)
        # Migration-ordering guard (2026-06-08): graphs created before the GDPR
        # node_provenance schema have a `passages` table without `source_id`, yet
        # _init_schema creates idx_passages_source_id on it — and CREATE TABLE IF
        # NOT EXISTS will NOT add the column to a pre-existing table, so the index
        # creation throws "no such column: source_id" on every legacy graph. Add the
        # column up front so _init_schema's index succeeds. Idempotent: "no such
        # table" (fresh graph) and "duplicate column" (already migrated) are both
        # expected and ignored. Fixes the 2026-06-08 GDPR-merge regression that made
        # every pre-GDPR graph unopenable (StorageInitError, INV-2 fail-loud).
        try:
            self._conn.execute("ALTER TABLE passages ADD COLUMN source_id TEXT DEFAULT ''")
        except sqlite3.OperationalError:
            pass
        self._init_schema()
        self._migrate_schema()
        self._rebuild_index()

        # SQL-I1: proactive dim mismatch detection at startup
        if self._embedding_dim:
            actual = self._detect_existing_embedding_dim()
            if actual is not None and actual != self._embedding_dim:
                import warnings
                warnings.warn(
                    f"Embedding dimension mismatch: graph has {actual}-dim vectors, "
                    f"but engine configured for {self._embedding_dim}-dim. "
                    f"Queries will fail silently. Re-ingest or use matching model.",
                    UserWarning,
                    stacklevel=2,
                )

    def _init_schema(self) -> None:
        """Create all tables if they do not exist."""
        dim = self._embedding_dim
        self._conn.executescript(f"""
            CREATE TABLE IF NOT EXISTS nodes (
                entity_id       TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                category        TEXT NOT NULL DEFAULT 'concept',
                lod_0           TEXT NOT NULL,
                lod_1           TEXT NOT NULL,
                lod_2           TEXT NOT NULL,
                parent_id       TEXT,
                chunk_index     INTEGER,
                is_chunk        INTEGER NOT NULL DEFAULT 0,
                refined         INTEGER NOT NULL DEFAULT 0,
                created_at      TEXT DEFAULT (datetime('now')),
                updated_at      TEXT DEFAULT (datetime('now')),
                ingested_at     REAL,
                event_timestamp REAL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS node_embeddings USING vec0(
                id TEXT PRIMARY KEY,
                embedding FLOAT[{dim}]
            );

            CREATE TABLE IF NOT EXISTS node_embedding_store (
                id        TEXT PRIMARY KEY,
                embedding BLOB NOT NULL
            );

            CREATE TABLE IF NOT EXISTS edges (
                source      TEXT NOT NULL REFERENCES nodes(entity_id),
                target      TEXT NOT NULL REFERENCES nodes(entity_id),
                relation    TEXT NOT NULL,
                weight      REAL DEFAULT 1.0,
                ingested_at REAL,
                PRIMARY KEY (source, target, relation)
            );
            -- SQL-A2: indexes for reverse traversal and relation filtering
            CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
            CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);

            CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
                entity_id UNINDEXED, name, lod_0, lod_1
            );

            CREATE TABLE IF NOT EXISTS passages (
                passage_id   TEXT PRIMARY KEY,
                raw_text     TEXT NOT NULL,
                source_id    TEXT DEFAULT '',
                source_label TEXT DEFAULT '',
                entity_ids   TEXT NOT NULL,
                ingested_at  TEXT DEFAULT (datetime('now')),
                temporal_min INTEGER,
                temporal_max INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_passages_source_id
            ON passages(source_id);

            CREATE TABLE IF NOT EXISTS passage_entities (
                passage_id TEXT NOT NULL,
                entity_id  TEXT NOT NULL,
                PRIMARY KEY (passage_id, entity_id)
            );
            CREATE INDEX IF NOT EXISTS idx_pe_entity
            ON passage_entities(entity_id);

            CREATE TABLE IF NOT EXISTS node_provenance (
                node_id    TEXT NOT NULL,
                source_id  TEXT NOT NULL,
                passage_id TEXT NOT NULL,
                PRIMARY KEY (node_id, passage_id)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS idx_node_provenance_source
            ON node_provenance(source_id);
            CREATE INDEX IF NOT EXISTS idx_node_provenance_passage
            ON node_provenance(passage_id);

            -- SOTA: BM25 full-text search — adopted from Robertson et al. (Okapi BM25), 1994
            CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(
                passage_id UNINDEXED, raw_text, source_label
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS passage_embeddings USING vec0(
                id TEXT PRIMARY KEY,
                embedding FLOAT[{dim}]
            );

            CREATE TABLE IF NOT EXISTS passage_embedding_store (
                id        TEXT PRIMARY KEY,
                embedding BLOB NOT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS question_embeddings USING vec0(
                id TEXT PRIMARY KEY,
                embedding FLOAT[{dim}]
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS sentence_embeddings USING vec0(
                id TEXT PRIMARY KEY,
                embedding FLOAT[{dim}]
            );

            CREATE TABLE IF NOT EXISTS sentence_embedding_store (
                id        TEXT PRIMARY KEY,
                embedding BLOB NOT NULL
            );

            CREATE TABLE IF NOT EXISTS backbone (
                source        TEXT NOT NULL,
                target        TEXT NOT NULL,
                centrality    REAL NOT NULL,
                measure_name  TEXT NOT NULL DEFAULT 'betweenness',
                calculated_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (source, target)
            );

            CREATE TABLE IF NOT EXISTS entity_neighborhoods (
                source_entity_id   TEXT NOT NULL,
                neighbor_entity_id TEXT NOT NULL,
                hop_distance       INTEGER NOT NULL CHECK (hop_distance IN (1, 2)),
                score              REAL NOT NULL,
                calculated_at      TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (source_entity_id, neighbor_entity_id)
            );

            CREATE INDEX IF NOT EXISTS idx_entity_neighborhoods_source
            ON entity_neighborhoods(source_entity_id);

            CREATE INDEX IF NOT EXISTS idx_entity_neighborhoods_source_hop
            ON entity_neighborhoods(source_entity_id, hop_distance);

            CREATE TABLE IF NOT EXISTS sentence_profiles (
                sentence_hash TEXT PRIMARY KEY,
                passage_id    TEXT NOT NULL,
                sentence_idx  INTEGER NOT NULL,
                ent_labels    TEXT NOT NULL,
                pos_tags      TEXT NOT NULL,
                lemmas        TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sp_passage
            ON sentence_profiles(passage_id);

            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS embedding_cache (
                content_hash TEXT NOT NULL,
                model_id TEXT NOT NULL,
                embedding BLOB NOT NULL,
                dimension INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                last_accessed_at INTEGER NOT NULL,
                hit_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (content_hash, model_id)
            );
            CREATE INDEX IF NOT EXISTS idx_embedding_cache_accessed
            ON embedding_cache(last_accessed_at);
            CREATE INDEX IF NOT EXISTS idx_embedding_cache_model
            ON embedding_cache(model_id);
        """)
        # Set schema version for new graphs (INSERT OR IGNORE keeps existing value)
        self._conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '2')"
        )
        self._conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('neighborhood_cache_dirty', '1')"
        )
        self._conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('neighborhood_cache_built_at', '')"
        )
        from tp_vrg.storage.cockpit_stats import init_stats_snapshot_schema
        from tp_vrg.storage.similarity_edges import init_schema as init_similarity_edges_schema

        init_stats_snapshot_schema(self._conn)
        init_similarity_edges_schema(self._conn)
        self._migrate_asset_overlay_schema()
        self._conn.commit()

    def _migrate_schema(self) -> None:
        """Add new columns to existing tables — safe to run on any schema version.

        ALTER TABLE ADD COLUMN raises OperationalError with 'duplicate column name'
        if the column already exists. We catch and ignore those silently.
        """
        migrations = [
            "ALTER TABLE nodes ADD COLUMN ingested_at REAL",
            "ALTER TABLE nodes ADD COLUMN event_timestamp REAL",
            "ALTER TABLE edges ADD COLUMN ingested_at REAL",
            "ALTER TABLE passages ADD COLUMN source_id TEXT DEFAULT ''",
            "ALTER TABLE passages ADD COLUMN temporal_min INTEGER",
            "ALTER TABLE passages ADD COLUMN temporal_max INTEGER",
            "ALTER TABLE backbone ADD COLUMN measure_name TEXT NOT NULL DEFAULT 'betweenness'",
        ]
        for stmt in migrations:
            try:
                self._conn.execute(stmt)
            except Exception as exc:
                if "duplicate column" not in str(exc).lower():
                    raise

        # Virtual table migration — CREATE IF NOT EXISTS is idempotent
        dim = self._embedding_dim
        try:
            self._conn.execute(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS question_embeddings USING vec0("
                f"id TEXT PRIMARY KEY, embedding FLOAT[{dim}])"
            )
        except Exception:
            pass  # sqlite-vec not available or already exists
        try:
            self._conn.execute(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS sentence_embeddings USING vec0("
                f"id TEXT PRIMARY KEY, embedding FLOAT[{dim}])"
            )
        except Exception:
            pass  # sqlite-vec not available or already exists

        # Canonical embedding stores (vec0 indexes can be rebuilt from these)
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS node_embedding_store (
                id        TEXT PRIMARY KEY,
                embedding BLOB NOT NULL
            )
        """)
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS passage_embedding_store (
                id        TEXT PRIMARY KEY,
                embedding BLOB NOT NULL
            )
        """)
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS sentence_embedding_store (
                id        TEXT PRIMARY KEY,
                embedding BLOB NOT NULL
            )
        """)
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS ingestion_progress (
                source_id TEXT PRIMARY KEY,
                source_path TEXT NOT NULL,
                source_type TEXT NOT NULL,
                total_units INTEGER,
                completed_units INTEGER DEFAULT 0,
                last_completed_unit_id TEXT,
                started_at INTEGER NOT NULL,
                last_updated_at INTEGER NOT NULL,
                completed_at INTEGER,
                status TEXT NOT NULL,
                error_detail TEXT
            )
        """)
        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_ingestion_progress_status
            ON ingestion_progress(status)
        """)
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS embedding_cache (
                content_hash TEXT NOT NULL,
                model_id TEXT NOT NULL,
                embedding BLOB NOT NULL,
                dimension INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                last_accessed_at INTEGER NOT NULL,
                hit_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (content_hash, model_id)
            )
        """)
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_embedding_cache_accessed ON embedding_cache(last_accessed_at)"
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_embedding_cache_model ON embedding_cache(model_id)"
        )
        from tp_vrg.storage.cockpit_stats import init_stats_snapshot_schema

        init_stats_snapshot_schema(self._conn)
        self._migrate_asset_overlay_schema()
        # Best-effort one-time backfill from existing vec0 tables.
        # On fresh DBs this is a no-op.
        self._conn.execute("""
            INSERT OR IGNORE INTO node_embedding_store (id, embedding)
            SELECT id, embedding FROM node_embeddings
        """)
        self._conn.execute("""
            INSERT OR IGNORE INTO passage_embedding_store (id, embedding)
            SELECT id, embedding FROM passage_embeddings
        """)

        # Sentence profiles table (fiber-basis precomputation)
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS sentence_profiles (
                sentence_hash TEXT PRIMARY KEY,
                passage_id    TEXT NOT NULL,
                sentence_idx  INTEGER NOT NULL,
                ent_labels    TEXT NOT NULL,
                pos_tags      TEXT NOT NULL,
                lemmas        TEXT NOT NULL
            )
        """)
        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_sp_passage
            ON sentence_profiles(passage_id)
        """)

        # Junction table migration — backfill from JSON entity_ids column
        self._migrate_passage_entities()
        self._ensure_node_provenance_schema()

        self._conn.commit()

    def _ensure_node_provenance_schema(self) -> None:
        """Install the derived node->source-passage reverse index."""
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS node_provenance (
                node_id    TEXT NOT NULL,
                source_id  TEXT NOT NULL,
                passage_id TEXT NOT NULL,
                PRIMARY KEY (node_id, passage_id)
            ) WITHOUT ROWID
        """)
        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_node_provenance_source
            ON node_provenance(source_id)
        """)
        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_node_provenance_passage
            ON node_provenance(passage_id)
        """)
        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_passages_source_id
            ON passages(source_id)
        """)

    def _migrate_passage_entities(self) -> None:
        """One-time backfill of passage_entities junction table from JSON column.

        Skips silently if the table already has rows (idempotent).  For new
        graphs the table is created empty by _init_schema and populated
        incrementally by upsert_passage().
        """
        c = self._conn
        # Create table + index if not present (handles pre-migration graphs)
        c.execute("""
            CREATE TABLE IF NOT EXISTS passage_entities (
                passage_id TEXT NOT NULL,
                entity_id  TEXT NOT NULL,
                PRIMARY KEY (passage_id, entity_id)
            )
        """)
        c.execute("""
            CREATE INDEX IF NOT EXISTS idx_pe_entity
            ON passage_entities(entity_id)
        """)

        # Skip if already populated
        (count,) = c.execute("SELECT COUNT(*) FROM passage_entities").fetchone()
        if count > 0:
            return

        # Backfill from JSON entity_ids column in passages table
        rows = c.execute(
            "SELECT passage_id, entity_ids FROM passages"
        ).fetchall()
        if not rows:
            return

        batch: list[tuple[str, str]] = []
        for passage_id, entity_ids_json in rows:
            try:
                eids = json.loads(entity_ids_json)
            except (json.JSONDecodeError, TypeError):
                continue
            for eid in eids:
                if eid:  # skip empty strings
                    batch.append((passage_id, eid))

        if batch:
            c.executemany(
                "INSERT OR IGNORE INTO passage_entities (passage_id, entity_id) "
                "VALUES (?, ?)",
                batch,
            )

    def backfill_node_provenance(
        self,
        *,
        source_lookup=None,
        dry_run: bool = False,
    ) -> dict[str, object]:
        """Rebuild the derived node->source-passage reverse index.

        ``source_lookup`` is an optional callable that maps passage_id to
        source_id, typically ``ProvenanceBackend.get_source_id_for_segment``.
        It lets pre-source_id graph rows recover their source from the
        separate provenance database without making graph.db the source of
        truth.
        """
        rows = self._conn.execute(
            "SELECT passage_id, source_id, entity_ids FROM passages"
        ).fetchall()
        unresolved: list[str] = []
        payload: list[tuple[str, str, str]] = []
        source_updates: list[tuple[str, str]] = []

        for passage_id, source_id, entity_ids_json in rows:
            resolved_source_id = (source_id or "").strip()
            if not resolved_source_id and source_lookup is not None:
                resolved_source_id = (source_lookup(passage_id) or "").strip()
                if resolved_source_id:
                    source_updates.append((resolved_source_id, passage_id))

            try:
                entity_ids = json.loads(entity_ids_json) if entity_ids_json else []
            except (TypeError, json.JSONDecodeError):
                entity_ids = []

            if not resolved_source_id:
                unresolved.append(passage_id)
                continue

            for entity_id in entity_ids:
                if entity_id:
                    payload.append((entity_id, resolved_source_id, passage_id))

        report: dict[str, object] = {
            "status": "dry_run" if dry_run else "ok",
            "passages_scanned": len(rows),
            "passages_with_source_id_backfilled": len(source_updates),
            "node_provenance_rows_written": len(payload),
            "unresolved_passages": len(unresolved),
            "unresolved_sample": unresolved[:10],
        }

        if unresolved and not dry_run:
            raise ValueError(
                "Cannot backfill node_provenance: "
                f"{len(unresolved)} passage(s) have no source_id and no provenance segment "
                f"mapping. Sample: {unresolved[:5]}"
            )
        if dry_run:
            return report

        c = self._conn
        if source_updates:
            c.executemany(
                "UPDATE passages SET source_id = ? WHERE passage_id = ?",
                source_updates,
            )
        c.execute("DELETE FROM node_provenance")
        if payload:
            c.executemany(
                "INSERT OR IGNORE INTO node_provenance "
                "(node_id, source_id, passage_id) VALUES (?, ?, ?)",
                payload,
            )
        if not self._in_batch:
            c.commit()
        return report

    def node_provenance_summary(self, sample_limit: int = 5) -> dict[str, object]:
        """Return a lightweight diagnostic summary for the reverse index."""
        row_count = self._conn.execute(
            "SELECT COUNT(*) FROM node_provenance"
        ).fetchone()[0]
        node_count = self._conn.execute(
            "SELECT COUNT(DISTINCT node_id) FROM node_provenance"
        ).fetchone()[0]
        source_count = self._conn.execute(
            "SELECT COUNT(DISTINCT source_id) FROM node_provenance"
        ).fetchone()[0]
        sample = self._conn.execute(
            """
            SELECT node_id, source_id, passage_id
            FROM node_provenance
            ORDER BY source_id, passage_id, node_id
            LIMIT ?
            """,
            (max(0, sample_limit),),
        ).fetchall()
        return {
            "status": "ok",
            "rows": int(row_count),
            "nodes": int(node_count),
            "sources": int(source_count),
            "sample": [
                {"node_id": row[0], "source_id": row[1], "passage_id": row[2]}
                for row in sample
            ],
        }

    def _has_column(self, table: str, column: str) -> bool:
        rows = self._conn.execute(f"PRAGMA table_info({table})").fetchall()
        return any(row[1] == column for row in rows)

    def _table_exists(self, table: str) -> bool:
        row = self._conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?",
            (table,),
        ).fetchone()
        return row is not None

    def _asset_schema_enabled(self) -> bool:
        raw = os.environ.get("TPVRG_ASSET_SCHEMA", "on").strip().lower()
        return raw not in {"0", "false", "off", "no", "baseline-no-overlay"}

    def _asset_schema_present(self) -> bool:
        table = self._conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assets'"
        ).fetchone()
        return bool(table) and self._has_column("passages", "asset_id")

    def _require_asset_schema(self) -> None:
        if not self._asset_schema_present():
            raise RuntimeError(
                "Asset overlay schema is not present. Reopen with TPVRG_ASSET_SCHEMA=on "
                "or run against a migrated graph."
            )

    def _migrate_asset_overlay_schema(self) -> None:
        """Install the additive Asset overlay schema.

        This migration only adds nullable/table-level structures:
        - assets
        - passages.asset_id
        - asset_entities
        - edge_provenance.asset_id scoped rows

        It intentionally leaves the edges primary key untouched.
        """
        if not self._asset_schema_enabled():
            return

        c = self._conn
        c.execute("""
            CREATE TABLE IF NOT EXISTS assets (
                asset_id              TEXT PRIMARY KEY,
                lineage_id            TEXT NOT NULL,
                edition_seq           INTEGER NOT NULL DEFAULT 1,
                source_label          TEXT NOT NULL DEFAULT '',
                source_hash           TEXT NOT NULL,
                provenance_source_id  TEXT,
                title                 TEXT NOT NULL DEFAULT '',
                byte_size             INTEGER NOT NULL DEFAULT 0,
                declared_by           TEXT NOT NULL DEFAULT 'human',
                declared_at           TEXT DEFAULT (datetime('now')),
                created_at            TEXT DEFAULT (datetime('now')),
                updated_at            TEXT DEFAULT (datetime('now'))
            )
        """)
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_hash ON assets(source_hash)")
        c.execute(
            "CREATE INDEX IF NOT EXISTS idx_assets_lineage ON assets(lineage_id, edition_seq)"
        )

        # Supersession marks (additive, supersession-unification 2026-06-10).
        # A superseded edition keeps its row immutable except these two marks —
        # Layer-1 discipline: supersession marks, never rewrites.
        if not self._has_column("assets", "superseded_by"):
            c.execute("ALTER TABLE assets ADD COLUMN superseded_by TEXT")
        if not self._has_column("assets", "superseded_at"):
            c.execute("ALTER TABLE assets ADD COLUMN superseded_at TEXT")

        # Claim-validity overlay: valid_at/invalid_at bounds per claim (passage
        # grain), written at edition transitions by claim_validity.record_supersession.
        c.execute("""
            CREATE TABLE IF NOT EXISTS claim_validity (
                claim_id      TEXT NOT NULL,
                lineage_id    TEXT NOT NULL,
                edition_seq   INTEGER NOT NULL,
                valid_at      TEXT,
                invalid_at    TEXT,
                superseded_by TEXT,
                recorded_at   TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (claim_id, lineage_id, edition_seq)
            )
        """)
        c.execute(
            "CREATE INDEX IF NOT EXISTS idx_claim_validity_lineage "
            "ON claim_validity(lineage_id, edition_seq)"
        )

        if not self._has_column("passages", "asset_id"):
            c.execute("ALTER TABLE passages ADD COLUMN asset_id TEXT REFERENCES assets(asset_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_passages_asset ON passages(asset_id)")

        c.execute("""
            CREATE TABLE IF NOT EXISTS asset_entities (
                asset_id         TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
                entity_id        TEXT NOT NULL REFERENCES nodes(entity_id) ON DELETE CASCADE,
                mention_count    INTEGER NOT NULL DEFAULT 1,
                section_position REAL,
                PRIMARY KEY (asset_id, entity_id)
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_ae_entity ON asset_entities(entity_id)")

        c.execute("""
            CREATE TABLE IF NOT EXISTS edge_provenance (
                source              TEXT NOT NULL,
                target              TEXT NOT NULL,
                relation            TEXT NOT NULL,
                asset_id            TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
                evidence_passage_id TEXT,
                confidence          REAL NOT NULL DEFAULT 1.0,
                PRIMARY KEY (source, target, relation, asset_id),
                FOREIGN KEY (source, target, relation)
                    REFERENCES edges(source, target, relation) ON DELETE CASCADE
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_edgeprov_asset ON edge_provenance(asset_id)")

    @staticmethod
    def _asset_group_from_source_label(source_label: str | None) -> str:
        label = (source_label or "").strip()
        if not label:
            return "__missing_source_label__"
        return re.sub(r"\s*\[chunk-\d+\]\s*$", "", label).strip() or label

    @staticmethod
    def _asset_id_for_group(group: str) -> str:
        digest = hashlib.sha256(group.encode("utf-8")).hexdigest()[:16]
        return f"asset:{digest}"

    def _rebuild_index(self) -> None:
        """Rebuild in-memory index from DB state."""
        self._known_ids.clear()
        for (eid,) in self._conn.execute("SELECT entity_id FROM nodes"):
            self._known_ids.add(eid)
        (self._edge_count,) = self._conn.execute(
            "SELECT COUNT(*) FROM edges"
        ).fetchone()
        self._graph_cache = None
        self._centrality_cache = None
        self._centrality_cache_measure = None

    @property
    def conn(self) -> sqlite3.Connection:
        assert self._conn is not None
        return self._conn

    # -- Batch transaction control --------------------------------------------

    def begin_batch(self) -> None:
        """Start a batch operation — suppress per-operation commits.

        Call before a bulk ingestion loop. All upsert_node / upsert_edge /
        upsert_passage calls inside the batch are NOT individually committed;
        they accumulate in a single SQLite transaction that is flushed by
        commit_batch() or rolled back atomically by rollback_batch().
        """
        self._in_batch = True

    def commit_batch(self) -> None:
        """Flush all operations since begin_batch() and resume auto-commit."""
        self._in_batch = False
        self._conn.commit()

    def rollback_batch(self) -> None:
        """Roll back all operations since begin_batch() atomically.

        Also re-syncs the in-memory state (_known_ids, _edge_count) from the
        DB to ensure they reflect the rolled-back state exactly.
        """
        self._in_batch = False
        self._conn.rollback()
        self._rebuild_index()  # re-sync in-memory state from DB

    @contextmanager
    def bulk_mode(self):
        """Defer FTS5/vec0 maintenance until the outer context exits."""
        self._bulk_mode_depth += 1
        self._bulk_mode = True
        try:
            yield
        finally:
            self._bulk_mode_depth -= 1
            if self._bulk_mode_depth <= 0:
                self._bulk_mode_depth = 0
                self._bulk_mode = False
                self._rebuild_fts_index()
                self._rebuild_vec_index()
                self._bulk_warning_emitted.clear()

    def _rebuild_fts_index(self) -> None:
        """Rebuild node/passage FTS5 tables from canonical row tables."""
        c = self._conn
        c.execute("DELETE FROM nodes_fts")
        c.execute(
            """
            INSERT INTO nodes_fts(entity_id, name, lod_0, lod_1)
            SELECT entity_id, name, lod_0, lod_1 FROM nodes
            """
        )
        c.execute("DELETE FROM passages_fts")
        c.execute(
            """
            INSERT INTO passages_fts(passage_id, raw_text, source_label)
            SELECT passage_id, raw_text, source_label FROM passages
            """
        )
        if not self._in_batch:
            c.commit()

    def _get_meta_value(self, key: str) -> str | None:
        try:
            row = self._conn.execute(
                "SELECT value FROM meta WHERE key = ?",
                (key,),
            ).fetchone()
        except sqlite3.Error:
            return None
        return row[0] if row else None

    def _set_meta_value(self, key: str, value: str) -> None:
        self._conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
            (key, value),
        )

    def integrity_verify_due(self, interval_hours: float) -> bool:
        """Return whether the janitor integrity verification cache is stale."""
        if interval_hours < 0:
            raise ValueError("interval_hours must be >= 0")

        checked_at = self._get_meta_value("integrity_last_check_at")
        if not checked_at:
            return True

        row = self._conn.execute(
            """
            SELECT (julianday('now') - julianday(?)) * 24.0
            """,
            (checked_at,),
        ).fetchone()
        if row is None or row[0] is None:
            return True
        return float(row[0]) >= interval_hours

    def run_integrity_verify(self) -> dict[str, object]:
        """Run full SQLite integrity verification on an isolated connection.

        The ``PRAGMA integrity_check`` scan can take minutes on multi-GB
        databases. Routing it through ``isolated_sqlite_connection`` keeps
        the engine connection (used by query/ingest paths and by the cached
        ``/health`` snapshot) free during the scan, matching the same
        connection-isolation pattern applied to ``/graph/glance`` (commit
        ``f68d5d8``) and to the cached ``/health`` snapshot (commit
        ``a675a1a``). The small meta-cache write that records the result
        happens on the main connection because it is fast and must remain
        consistent with the rest of the engine's transactional view.
        """
        with isolated_sqlite_connection(self._path, read_only=True) as iso:
            rows = iso.execute(
                "PRAGMA integrity_check"  # janitor-owned full scan
            ).fetchall()
        messages = [str(row[0]) for row in rows if row and row[0] is not None]
        if not messages:
            messages = ["unknown"]
        result = "ok" if messages == ["ok"] else "\n".join(messages)

        self._set_meta_value("integrity_last_check_result", result)
        self._conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) "
            "VALUES ('integrity_last_check_at', datetime('now'))"
        )
        if not self._in_batch:
            self._conn.commit()

        return {
            "result": result,
            "ok": result == "ok",
            "message_count": len(messages),
        }

    def _read_integrity_cache(self, stale_days: float = 7.0) -> dict[str, str | None]:
        result = self._get_meta_value("integrity_last_check_result")
        checked_at = self._get_meta_value("integrity_last_check_at")
        if not result or not checked_at:
            status = "unknown"
        elif result != "ok":
            status = "degraded"
        else:
            row = self._conn.execute(
                """
                SELECT (julianday('now') - julianday(?))
                """,
                (checked_at,),
            ).fetchone()
            if row is None or row[0] is None:
                status = "unknown"
            else:
                status = "stale" if float(row[0]) >= stale_days else "ok"

        return {
            "integrity": status,
            "integrity_last_checked_at": checked_at,
            "integrity_check_result": result,
        }

    def _record_fts5_sync_cache(
        self,
        *,
        status: str,
        node_fts_rows: int,
        passage_fts_rows: int,
        node_count: int,
        passage_count: int,
    ) -> None:
        self._set_meta_value("fts5_sync_status", status)
        self._conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) "
            "VALUES ('fts5_sync_last_check_at', datetime('now'))"
        )
        self._set_meta_value("fts5_sync_node_rows", str(node_fts_rows))
        self._set_meta_value("fts5_sync_passage_rows", str(passage_fts_rows))
        self._set_meta_value("fts5_sync_node_count", str(node_count))
        self._set_meta_value("fts5_sync_passage_count", str(passage_count))

    def _read_fts5_sync_cache(self, stale_days: float = 7.0) -> dict[str, object]:
        status = self._get_meta_value("fts5_sync_status")
        checked_at = self._get_meta_value("fts5_sync_last_check_at")
        if not status or not checked_at:
            status = "unknown"
        elif status == "ok":
            row = self._conn.execute(
                """
                SELECT (julianday('now') - julianday(?))
                """,
                (checked_at,),
            ).fetchone()
            if row is None or row[0] is None:
                status = "unknown"
            elif float(row[0]) >= stale_days:
                status = "stale"

        fts5_in_sync: bool | None
        if status == "ok":
            fts5_in_sync = True
        elif status == "desynced":
            fts5_in_sync = False
        else:
            fts5_in_sync = None

        node_rows = self._get_meta_value("fts5_sync_node_rows")
        passage_rows = self._get_meta_value("fts5_sync_passage_rows")
        return {
            "fts5_sync_status": status,
            "fts5_sync_last_checked_at": checked_at,
            "fts5_in_sync": fts5_in_sync,
            "fts5_rows": int(node_rows) if node_rows is not None else None,
            "passage_fts_rows": (
                int(passage_rows) if passage_rows is not None else None
            ),
        }

    def fts5_sync_repair(self, dry_run: bool = True) -> dict[str, object]:
        """Delete FTS5 rows whose canonical node/passage row no longer exists.

        The orphan + missing-row scans and the DELETE/INSERT writeback run on
        an isolated short-lived SQLite connection (the same connection-isolation
        pattern applied to ``/graph/glance``, the cached ``/health`` snapshot,
        and ``run_integrity_verify``). This keeps the engine connection free
        for query/ingest traffic and for the cached ``/health`` snapshot's
        backing reads during what can be a long-running janitor task on
        multi-million-row FTS5 indexes.

        When the engine is mid-batch (``_in_batch``) the operation falls back
        to the engine connection: a separate writer connection cannot land
        inside an active engine transaction without deadlock risk, and bulk
        ingest is the documented context where ``fts5_sync_repair`` is
        replayed after the batch closes (see ``SQLiteBackend.bulk_mode``).
        Outside of batch mode (the standard janitor run) every write happens
        on the isolated connection and the engine connection is untouched
        for the duration of the scan.
        """
        if self._in_batch:
            return self._fts5_sync_repair_on_connection(
                self._conn,
                dry_run=dry_run,
                writer_owns_commit=False,
            )

        with isolated_sqlite_connection(self._path, read_only=False) as iso:
            payload = self._fts5_sync_repair_on_connection(
                iso,
                dry_run=dry_run,
                writer_owns_commit=True,
            )
            iso.commit()

        node_count = self.node_count()
        passage_count = self.passage_count()
        node_fts_in_sync_after = payload["_node_fts_rows_after"] == node_count
        passage_fts_in_sync_after = payload["_passage_fts_rows_after"] == passage_count
        fts5_in_sync_after = node_fts_in_sync_after and passage_fts_in_sync_after
        self._record_fts5_sync_cache(
            status="ok" if fts5_in_sync_after else "desynced",
            node_fts_rows=payload["_node_fts_rows_after"],
            passage_fts_rows=payload["_passage_fts_rows_after"],
            node_count=node_count,
            passage_count=passage_count,
        )
        if not self._in_batch:
            self._conn.commit()

        # Strip private "_node_fts_rows_after" / "_passage_fts_rows_after" before
        # returning; they are intermediate values for the meta-cache update only.
        return {
            "orphan_rows_found": payload["orphan_rows_found"],
            "missing_rows_found": payload["missing_rows_found"],
            "rows_deleted": payload["rows_deleted"],
            "rows_inserted": payload["rows_inserted"],
            "dry_run": dry_run,
            "fts5_in_sync_after": fts5_in_sync_after,
            "node_orphan_rows_found": payload["node_orphan_rows_found"],
            "passage_orphan_rows_found": payload["passage_orphan_rows_found"],
            "node_missing_rows_found": payload["node_missing_rows_found"],
            "passage_missing_rows_found": payload["passage_missing_rows_found"],
        }

    def _fts5_sync_repair_on_connection(
        self,
        c: sqlite3.Connection,
        *,
        dry_run: bool,
        writer_owns_commit: bool,
    ) -> dict[str, object]:
        """Run the FTS5 repair scan + writeback against a given connection.

        When called via the isolated connection path (``writer_owns_commit=True``)
        the canonical node/passage counts are NOT computed here — the caller
        reads them from the engine connection after the isolated writer commits
        and uses them to update the meta cache. When called from inside an
        engine batch (``writer_owns_commit=False``) the legacy in-place behaviour
        is preserved: counts + meta cache update + commit happen against ``c``.
        """
        node_orphan_rowids = [
            row[0]
            for row in c.execute(
                """
                SELECT f.rowid
                FROM nodes_fts AS f
                WHERE NOT EXISTS (
                    SELECT 1 FROM nodes AS n
                    WHERE n.entity_id = f.entity_id
                )
                """
            ).fetchall()
        ]
        passage_orphan_rowids = [
            row[0]
            for row in c.execute(
                """
                SELECT f.rowid
                FROM passages_fts AS f
                WHERE NOT EXISTS (
                    SELECT 1 FROM passages AS p
                    WHERE p.passage_id = f.passage_id
                )
                """
            ).fetchall()
        ]
        node_missing_rows = c.execute(
            """
            SELECT n.entity_id, n.name, n.lod_0, n.lod_1
            FROM nodes AS n
            WHERE NOT EXISTS (
                SELECT 1 FROM nodes_fts AS f
                WHERE f.entity_id = n.entity_id
            )
            """
        ).fetchall()
        passage_missing_rows = c.execute(
            """
            SELECT p.passage_id, p.raw_text, p.source_label
            FROM passages AS p
            WHERE NOT EXISTS (
                SELECT 1 FROM passages_fts AS f
                WHERE f.passage_id = p.passage_id
            )
            """
        ).fetchall()

        orphan_rows_found = len(node_orphan_rowids) + len(passage_orphan_rowids)
        missing_rows_found = len(node_missing_rows) + len(passage_missing_rows)
        rows_deleted = 0
        rows_inserted = 0
        if not dry_run and orphan_rows_found:
            c.executemany(
                "DELETE FROM nodes_fts WHERE rowid = ?",
                [(rowid,) for rowid in node_orphan_rowids],
            )
            c.executemany(
                "DELETE FROM passages_fts WHERE rowid = ?",
                [(rowid,) for rowid in passage_orphan_rowids],
            )
            rows_deleted = orphan_rows_found
        if not dry_run and missing_rows_found:
            c.executemany(
                "INSERT INTO nodes_fts(entity_id, name, lod_0, lod_1) "
                "VALUES (?, ?, ?, ?)",
                node_missing_rows,
            )
            c.executemany(
                "INSERT INTO passages_fts(passage_id, raw_text, source_label) "
                "VALUES (?, ?, ?)",
                passage_missing_rows,
            )
            rows_inserted = missing_rows_found

        (node_fts_rows_after,) = c.execute("SELECT COUNT(*) FROM nodes_fts").fetchone()
        (passage_fts_rows_after,) = c.execute(
            "SELECT COUNT(*) FROM passages_fts"
        ).fetchone()

        if writer_owns_commit:
            # Caller (isolated-connection branch) will compute canonical counts
            # against the engine connection and update the meta cache from there.
            return {
                "orphan_rows_found": orphan_rows_found,
                "missing_rows_found": missing_rows_found,
                "rows_deleted": rows_deleted,
                "rows_inserted": rows_inserted,
                "node_orphan_rows_found": len(node_orphan_rowids),
                "passage_orphan_rows_found": len(passage_orphan_rowids),
                "node_missing_rows_found": len(node_missing_rows),
                "passage_missing_rows_found": len(passage_missing_rows),
                "_node_fts_rows_after": node_fts_rows_after,
                "_passage_fts_rows_after": passage_fts_rows_after,
            }

        # Legacy in-batch path: counts, meta cache, commit on the same connection.
        node_count = self.node_count()
        passage_count = self.passage_count()
        node_fts_in_sync_after = node_fts_rows_after == node_count
        passage_fts_in_sync_after = passage_fts_rows_after == passage_count
        fts5_in_sync_after = node_fts_in_sync_after and passage_fts_in_sync_after
        self._record_fts5_sync_cache(
            status="ok" if fts5_in_sync_after else "desynced",
            node_fts_rows=node_fts_rows_after,
            passage_fts_rows=passage_fts_rows_after,
            node_count=node_count,
            passage_count=passage_count,
        )
        if not self._in_batch:
            c.commit()

        return {
            "orphan_rows_found": orphan_rows_found,
            "missing_rows_found": missing_rows_found,
            "rows_deleted": rows_deleted,
            "rows_inserted": rows_inserted,
            "dry_run": dry_run,
            "fts5_in_sync_after": fts5_in_sync_after,
            "node_orphan_rows_found": len(node_orphan_rowids),
            "passage_orphan_rows_found": len(passage_orphan_rowids),
            "node_missing_rows_found": len(node_missing_rows),
            "passage_missing_rows_found": len(passage_missing_rows),
        }

    def _rebuild_vec_index(self) -> None:
        """Rebuild vec0 tables from canonical embedding stores."""
        c = self._conn
        c.execute("DELETE FROM node_embeddings")
        c.execute(
            """
            INSERT INTO node_embeddings(id, embedding)
            SELECT id, embedding FROM node_embedding_store
            """
        )
        c.execute("DELETE FROM passage_embeddings")
        c.execute(
            """
            INSERT INTO passage_embeddings(id, embedding)
            SELECT id, embedding FROM passage_embedding_store
            """
        )
        if not self._in_batch:
            c.commit()

    def _warn_bulk_query_once(self, operation: str) -> None:
        if not self._bulk_mode:
            return
        if operation in self._bulk_warning_emitted:
            return
        self._bulk_warning_emitted.add(operation)
        logger.warning(
            "%s called during SQLiteBackend.bulk_mode(); FTS5/vec0 results may be stale "
            "until bulk_mode exits and indexes are rebuilt.",
            operation,
        )

    # -- CRUD -----------------------------------------------------------------

    def upsert_node(self, node: NodeData) -> None:
        c = self._conn
        already_exists = node.entity_id in self._known_ids

        # Upsert node row
        c.execute(
            """
            INSERT INTO nodes
                (entity_id, name, category, lod_0, lod_1, lod_2,
                 parent_id, chunk_index, is_chunk, refined, updated_at,
                 ingested_at, event_timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
            ON CONFLICT(entity_id) DO UPDATE SET
                name            = excluded.name,
                category        = excluded.category,
                lod_0           = excluded.lod_0,
                lod_1           = excluded.lod_1,
                lod_2           = excluded.lod_2,
                parent_id       = excluded.parent_id,
                chunk_index     = excluded.chunk_index,
                is_chunk        = excluded.is_chunk,
                refined         = excluded.refined,
                updated_at      = excluded.updated_at,
                event_timestamp = excluded.event_timestamp
            """,
            (
                node.entity_id, node.name, node.category,
                node.lod_0, node.lod_1, node.lod_2,
                node.parent_id, node.chunk_index,
                int(node.is_chunk), int(node.refined),
                node.ingested_at, node.event_timestamp,
            ),
        )

        # Persist embedding in canonical store (source of truth for vec0 rebuilds).
        # INSERT OR REPLACE handles both serial upsert and concurrent-session races
        # where two coroutines extract the same entity before either updates _known_ids.
        if node.embedding is not None:
            emb_bytes = np.asarray(node.embedding, dtype=np.float32).tobytes()
            c.execute(
                "INSERT OR REPLACE INTO node_embedding_store(id, embedding) VALUES (?, ?)",
                (node.entity_id, emb_bytes),
            )
        # Non-bulk mode keeps vec0 synchronized inline.
        # DELETE-then-INSERT (not OR REPLACE) because vec0 virtual tables
        # don't support ON CONFLICT. Delete unconditionally to handle races.
        if not self._bulk_mode and node.embedding is not None:
            c.execute("DELETE FROM node_embeddings WHERE id = ?", (node.entity_id,))
            c.execute(
                "INSERT INTO node_embeddings(id, embedding) VALUES (?, ?)",
                (node.entity_id, emb_bytes),
            )

        # Non-bulk mode keeps FTS5 synchronized inline.
        if not self._bulk_mode:
            fts_row = c.execute(
                "SELECT rowid FROM nodes_fts WHERE entity_id = ?", (node.entity_id,)
            ).fetchone()
            if fts_row:
                c.execute("DELETE FROM nodes_fts WHERE rowid = ?", (fts_row[0],))
            c.execute(
                "INSERT INTO nodes_fts(entity_id, name, lod_0, lod_1) VALUES (?, ?, ?, ?)",
                (node.entity_id, node.name, node.lod_0, node.lod_1),
            )

        self._known_ids.add(node.entity_id)
        self._graph_cache = None
        self._graph_cache_semantic = None
        self._neighborhood_cache = None
        self.mark_neighborhood_dirty()
        if not self._in_batch:
            c.commit()

    def upsert_edge(self, edge: EdgeData) -> None:
        if edge.source not in self._known_ids or edge.target not in self._known_ids:
            return
        visible_ids = self._visible_node_ids({edge.source, edge.target})
        if edge.source not in visible_ids or edge.target not in visible_ids:
            return

        cur = self._conn.execute(
            "INSERT OR IGNORE INTO edges (source, target, relation, weight, ingested_at) VALUES (?, ?, ?, ?, ?)",
            (edge.source, edge.target, edge.relation, edge.weight, edge.ingested_at),
        )
        if cur.rowcount > 0:
            self._edge_count += 1
            self._graph_cache = None
            self._graph_cache_semantic = None
            self._neighborhood_cache = None
            self._centrality_cache = None
            self._centrality_cache_measure = None
            self.mark_neighborhood_dirty()
        if not self._in_batch:
            self._conn.commit()

    def upsert_edges_bulk(self, edges: list[EdgeData]) -> None:
        """Bulk edge insert using executemany (INSERT OR IGNORE)."""
        if not edges:
            return
        candidate_edges = [
            e
            for e in edges
            if e.source in self._known_ids and e.target in self._known_ids
        ]
        if not candidate_edges:
            return
        visible_ids = self._visible_node_ids(
            {eid for edge in candidate_edges for eid in (edge.source, edge.target)}
        )
        valid_rows = [
            (e.source, e.target, e.relation, e.weight, e.ingested_at)
            for e in candidate_edges
            if e.source in visible_ids and e.target in visible_ids
        ]
        if not valid_rows:
            return
        before = self._conn.total_changes
        self._conn.executemany(
            "INSERT OR IGNORE INTO edges (source, target, relation, weight, ingested_at) VALUES (?, ?, ?, ?, ?)",
            valid_rows,
        )
        inserted = self._conn.total_changes - before
        if inserted > 0:
            self._edge_count += inserted
            self._graph_cache = None
            self._graph_cache_semantic = None
            self._neighborhood_cache = None
            self._centrality_cache = None
            self._centrality_cache_measure = None
            self.mark_neighborhood_dirty()
        if not self._in_batch:
            self._conn.commit()

    def redirect_edges(self, old_id: str, new_id: str) -> int:
        """Redirect all edges from/to old_id so they point to new_id.

        Uses SQL-native UPDATEs to avoid Python-side full edge scans.
        Returns the number of rows changed/deleted.
        """
        if old_id == new_id:
            return 0
        c = self._conn
        before = c.total_changes
        c.execute("UPDATE OR IGNORE edges SET source = ? WHERE source = ?", (new_id, old_id))
        c.execute("UPDATE OR IGNORE edges SET target = ? WHERE target = ?", (new_id, old_id))
        # Cleanup self-loops introduced by merge redirects.
        c.execute("DELETE FROM edges WHERE source = target")
        changed = c.total_changes - before
        if changed > 0:
            (self._edge_count,) = c.execute("SELECT COUNT(*) FROM edges").fetchone()
            self._graph_cache = None
            self._graph_cache_semantic = None
            self._neighborhood_cache = None
            self._centrality_cache = None
            self._centrality_cache_measure = None
            self.mark_neighborhood_dirty()
        if not self._in_batch:
            c.commit()
        return changed

    def redirect_node_provenance(self, old_id: str, new_id: str) -> int:
        """Move source-passage provenance rows from one node ID to another."""
        if old_id == new_id:
            return 0
        self._ensure_node_provenance_schema()
        c = self._conn
        before = c.total_changes
        c.execute(
            """
            INSERT OR IGNORE INTO node_provenance (node_id, source_id, passage_id)
            SELECT ?, source_id, passage_id
            FROM node_provenance
            WHERE node_id = ?
            """,
            (new_id, old_id),
        )
        c.execute("DELETE FROM node_provenance WHERE node_id = ?", (old_id,))
        changed = c.total_changes - before
        if not self._in_batch:
            c.commit()
        return changed

    def delete_node(self, entity_id: str) -> bool:
        """Delete a node and all its edges, embeddings, and FTS entries.

        Returns True if node existed and was deleted, False otherwise.
        """
        if entity_id not in self._known_ids:
            return False
        c = self._conn
        if c.execute(
            "SELECT 1 FROM nodes WHERE entity_id = ?", (entity_id,)
        ).fetchone() is None:
            return False
        fts_row = c.execute(
            "SELECT rowid FROM nodes_fts WHERE entity_id = ?", (entity_id,)
        ).fetchone()
        # Delete embedding (vec0 requires explicit DELETE)
        c.execute("DELETE FROM node_embeddings WHERE id = ?", (entity_id,))
        c.execute("DELETE FROM node_embedding_store WHERE id = ?", (entity_id,))
        # Delete FTS entry
        if fts_row is not None:
            c.execute("DELETE FROM nodes_fts WHERE rowid = ?", (fts_row[0],))
        if self._asset_schema_present():
            c.execute(
                "DELETE FROM edge_provenance WHERE source = ? OR target = ?",
                (entity_id, entity_id),
            )
            c.execute("DELETE FROM asset_entities WHERE entity_id = ?", (entity_id,))
        # Delete edges (both directions) and track count
        edge_del = c.execute(
            "DELETE FROM edges WHERE source = ? OR target = ?",
            (entity_id, entity_id),
        )
        self._edge_count -= edge_del.rowcount
        # Delete passage_entities references (prevent orphaned junction rows)
        c.execute("DELETE FROM passage_entities WHERE entity_id = ?", (entity_id,))
        c.execute("DELETE FROM node_provenance WHERE node_id = ?", (entity_id,))
        # Delete node
        c.execute("DELETE FROM nodes WHERE entity_id = ?", (entity_id,))
        # Invalidate caches
        self._known_ids.discard(entity_id)
        self._graph_cache = None
        self._graph_cache_semantic = None
        self._neighborhood_cache = None
        self._centrality_cache = None
        self._centrality_cache_measure = None
        self.mark_neighborhood_dirty()
        if not self._in_batch:
            c.commit()
        return True

    def _delete_fts_rows_by_ids(
        self,
        table: str,
        id_column: str,
        ids: list[str],
    ) -> int:
        if not ids:
            return 0
        rows = self._batch_in_query(
            f"SELECT rowid FROM {table} WHERE {id_column} IN ({{placeholders}})",
            ids,
        )
        rowids = [(row[0],) for row in rows]
        if not rowids:
            return 0
        self._conn.executemany(f"DELETE FROM {table} WHERE rowid = ?", rowids)
        return len(rowids)

    def _delete_exact_id_rows(self, table: str, ids: list[str]) -> int:
        if not ids:
            return 0
        deleted = 0
        for row_id in ids:
            if self._conn.execute(
                f"SELECT 1 FROM {table} WHERE id = ?",
                (row_id,),
            ).fetchone():
                deleted += 1
            self._conn.execute(f"DELETE FROM {table} WHERE id = ?", (row_id,))
        return deleted

    def _ids_with_any_prefix(self, table: str, prefixes: list[str]) -> list[str]:
        if not prefixes:
            return []
        rows = self._conn.execute(f"SELECT id FROM {table}").fetchall()
        result: list[str] = []
        for (row_id,) in rows:
            if any(str(row_id).startswith(prefix) for prefix in prefixes):
                result.append(str(row_id))
        return result

    def _populate_node_provenance_for_passages(
        self,
        source_id: str,
        passage_ids: list[str],
    ) -> int:
        if not passage_ids:
            return 0
        rows = self._batch_in_query(
            "SELECT passage_id, entity_ids FROM passages "
            "WHERE passage_id IN ({placeholders})",
            passage_ids,
        )
        payload: list[tuple[str, str, str]] = []
        for passage_id, entity_ids_json in rows:
            try:
                entity_ids = json.loads(entity_ids_json) if entity_ids_json else []
            except (TypeError, json.JSONDecodeError):
                entity_ids = []
            for entity_id in entity_ids:
                if entity_id:
                    payload.append((entity_id, source_id, passage_id))
        if not payload:
            return 0
        before = self._conn.total_changes
        self._conn.executemany(
            "INSERT OR IGNORE INTO node_provenance "
            "(node_id, source_id, passage_id) VALUES (?, ?, ?)",
            payload,
        )
        return self._conn.total_changes - before

    def _source_passage_ids(
        self,
        source_id: str,
        provenance=None,
    ) -> tuple[list[str], bool]:
        rows = self._conn.execute(
            """
            SELECT passage_id
            FROM passages
            WHERE source_id = ?
            ORDER BY passage_id
            """,
            (source_id,),
        ).fetchall()
        passage_ids = [row[0] for row in rows]

        provenance_source_exists = False
        if provenance is not None and hasattr(provenance, "source_exists"):
            provenance_source_exists = bool(provenance.source_exists(source_id))

        if not passage_ids and provenance is not None and hasattr(provenance, "get_segments_for_source"):
            segment_ids = [
                str(row["segment_id"])
                for row in provenance.get_segments_for_source(source_id)
                if row.get("segment_id")
            ]
            if segment_ids:
                graph_rows = self._batch_in_query(
                    "SELECT passage_id FROM passages "
                    "WHERE passage_id IN ({placeholders}) "
                    "ORDER BY passage_id",
                    segment_ids,
                )
                passage_ids = [row[0] for row in graph_rows]

        return list(dict.fromkeys(passage_ids)), provenance_source_exists

    def resolve_derived_closure(
        self, passage_ids: Iterable[str]
    ) -> ClosureResult:
        """Compute the derived-only-vs-shared node split for ``passage_ids``.

        For each node with at least one ``node_provenance`` row whose
        ``passage_id`` is in the input set, classify the node as:

        - ``derived_only`` if EVERY provenance row for that node has a
          ``passage_id`` inside the input set (the node exists ONLY because
          of the input passages and would be left without provenance).
        - ``shared`` if AT LEAST ONE provenance row for that node has a
          ``passage_id`` outside the input set (the node has other sources
          of evidence and would survive if the input passages were removed).

        Pure-read: this method does NOT mutate ``node_provenance`` or any
        other table. The result is the same whether called before or after
        any DELETE on ``node_provenance`` for the input passages; the logic
        reasons about "would this node survive if the input passages were
        not contributing provenance", evaluated against the current row set.

        The first consumer is :meth:`delete_source` (Art 17 GDPR erasure).
        Future consumers (per arch-rung-level-subgraph-migration-2026-06-08.md
        §3 Step 0): ``extract_source`` (Art 20 portability), ``delete_asset``
        / ``extract_asset`` (Asset rung), and the Island/Continent rungs.

        Args:
            passage_ids: An iterable of passage IDs defining the input set.
                Empty input returns an empty ClosureResult immediately.

        Returns:
            ClosureResult with frozenset ``derived_only`` and ``shared``.
        """
        self._ensure_node_provenance_schema()

        passage_id_set: set[str] = set()
        for pid in passage_ids:
            if pid:
                passage_id_set.add(pid)
        if not passage_id_set:
            return ClosureResult(derived_only=frozenset(), shared=frozenset())

        # Candidate nodes: any node with at least one provenance row in the
        # input passage set. Anything outside this set cannot be in the
        # closure by definition.
        candidate_rows = self._batch_in_query(
            "SELECT DISTINCT node_id FROM node_provenance "
            "WHERE passage_id IN ({placeholders})",
            passage_id_set,
        )
        candidate_node_ids = [row[0] for row in candidate_rows]
        if not candidate_node_ids:
            return ClosureResult(derived_only=frozenset(), shared=frozenset())

        # For each candidate, count provenance rows OUTSIDE the input passage
        # set. A count of zero ⇒ derived_only; ≥1 ⇒ shared. Selecting the
        # (node_id, passage_id) pairs and counting in Python avoids a second
        # batched query with negation against a potentially large set.
        rows = self._batch_in_query(
            "SELECT node_id, passage_id FROM node_provenance "
            "WHERE node_id IN ({placeholders})",
            candidate_node_ids,
        )
        external_counts: dict[str, int] = {nid: 0 for nid in candidate_node_ids}
        for node_id, passage_id in rows:
            if passage_id not in passage_id_set:
                external_counts[node_id] = external_counts.get(node_id, 0) + 1

        derived_only = frozenset(
            nid for nid, count in external_counts.items() if count == 0
        )
        shared = frozenset(
            nid for nid, count in external_counts.items() if count > 0
        )

        # Boundary edges: directed (source, target, relation) tuples where
        # EXACTLY one endpoint is in derived_only — the cut edges that an
        # extract must carry as typed stubs. Both-in-derived_only edges are
        # internal (belong to the extracted artifact). Edges with neither
        # endpoint in derived_only are filtered out by the IN-clause.
        boundary_edges: frozenset[tuple[str, str, str]] = frozenset()
        if derived_only:
            edge_rows = self._batch_in_query(
                "SELECT source, target, relation FROM edges "
                "WHERE source IN ({placeholders}) OR target IN ({placeholders})",
                list(derived_only),
                repeat_bindings=2,
            )
            boundary_edges = frozenset(
                (str(source), str(target), str(relation))
                for source, target, relation in edge_rows
                if (source in derived_only) != (target in derived_only)
            )

        return ClosureResult(
            derived_only=derived_only,
            shared=shared,
            boundary_edges=boundary_edges,
        )

    def delete_source(self, source_id: str, provenance=None) -> dict[str, object]:
        """Delete one source and cascade only its derived-only graph nodes.

        Multi-source nodes survive: the source's node_provenance rows are
        removed first, and a candidate node is deleted only if no provenance
        from another source remains.
        """
        source_id = (source_id or "").strip()
        if not source_id:
            raise ValueError("source_id is required")
        if self._in_batch:
            raise RuntimeError("delete_source cannot run inside an existing storage batch")

        self._ensure_node_provenance_schema()
        c = self._conn
        passage_ids, provenance_source_exists = self._source_passage_ids(
            source_id,
            provenance=provenance,
        )
        if not passage_ids and not provenance_source_exists:
            raise KeyError(f"source_id not found: {source_id}")

        provenance_batch_started = False
        report: dict[str, object] = {
            "status": "deleted",
            "source_id": source_id,
            "passages_removed": 0,
            "derived_only_nodes_removed": 0,
            "shared_nodes_preserved": 0,
            "edges_removed": 0,
            "embeddings_removed": 0,
            "node_embeddings_removed": 0,
            "passage_embeddings_removed": 0,
            "question_embeddings_removed": 0,
            "sentence_embeddings_removed": 0,
            "fts5_rows_removed": 0,
            "node_fts_rows_removed": 0,
            "passage_fts_rows_removed": 0,
            "node_provenance_rows_removed": 0,
            "passage_entity_rows_removed": 0,
            "sentence_profile_rows_removed": 0,
            "asset_entities_removed": 0,
            "edge_provenance_removed": 0,
            "assets_removed": 0,
            "provenance_sources_removed": 0,
            "provenance_segments_removed": 0,
            "provenance_citations_removed": 0,
        }

        try:
            c.execute("BEGIN")
            if passage_ids:
                c.executemany(
                    "UPDATE passages SET source_id = ? WHERE passage_id = ?",
                    [(source_id, passage_id) for passage_id in passage_ids],
                )
                self._populate_node_provenance_for_passages(source_id, passage_ids)
                # Resolve the derived-only-vs-shared closure BEFORE deleting the
                # source's node_provenance rows. The resolver is pure-read; it
                # classifies candidate nodes by counting provenance rows OUTSIDE
                # the input passage set — but the candidate query "any node with
                # provenance IN passage_ids" needs the source's rows still
                # present. Calling after the DELETE would return an empty set.
                # See `resolve_derived_closure` docstring + arch-rung-level-
                # subgraph-migration-2026-06-08.md §3 Step 0.
                closure = self.resolve_derived_closure(passage_ids)
            else:
                closure = ClosureResult(derived_only=frozenset(), shared=frozenset())

            node_prov_before = c.total_changes
            if passage_ids:
                for passage_id in passage_ids:
                    c.execute(
                        "DELETE FROM node_provenance WHERE passage_id = ?",
                        (passage_id,),
                    )
            report["node_provenance_rows_removed"] = c.total_changes - node_prov_before

            derived_only = list(closure.derived_only)
            shared = list(closure.shared)
            report["derived_only_nodes_removed"] = len(derived_only)
            report["shared_nodes_preserved"] = len(shared)

            if derived_only:
                node_fts = self._delete_fts_rows_by_ids(
                    "nodes_fts",
                    "entity_id",
                    derived_only,
                )
                node_vec0 = self._delete_exact_id_rows("node_embeddings", derived_only)
                node_store = self._delete_exact_id_rows("node_embedding_store", derived_only)
                report["node_fts_rows_removed"] = node_fts
                report["node_embeddings_removed"] = node_vec0 + node_store

                if self._asset_schema_present():
                    before = c.total_changes
                    for node_id in derived_only:
                        c.execute(
                            "DELETE FROM edge_provenance WHERE source = ? OR target = ?",
                            (node_id, node_id),
                        )
                    report["edge_provenance_removed"] = (
                        int(report["edge_provenance_removed"]) + c.total_changes - before
                    )
                    before = c.total_changes
                    for node_id in derived_only:
                        c.execute("DELETE FROM asset_entities WHERE entity_id = ?", (node_id,))
                    report["asset_entities_removed"] = c.total_changes - before

                before = c.total_changes
                for node_id in derived_only:
                    c.execute(
                        "DELETE FROM edges WHERE source = ? OR target = ?",
                        (node_id, node_id),
                    )
                report["edges_removed"] = c.total_changes - before

                before = c.total_changes
                for node_id in derived_only:
                    c.execute("DELETE FROM passage_entities WHERE entity_id = ?", (node_id,))
                report["passage_entity_rows_removed"] = (
                    int(report["passage_entity_rows_removed"]) + c.total_changes - before
                )

                before = c.total_changes
                for node_id in derived_only:
                    c.execute("DELETE FROM nodes WHERE entity_id = ?", (node_id,))
                nodes_deleted = c.total_changes - before
                if nodes_deleted != len(derived_only):
                    raise RuntimeError(
                        "delete_source structural inconsistency: "
                        f"expected to delete {len(derived_only)} nodes, deleted {nodes_deleted}"
                    )

            if passage_ids:
                if self._asset_schema_present():
                    before = c.total_changes
                    for passage_id in passage_ids:
                        c.execute(
                            "DELETE FROM edge_provenance WHERE evidence_passage_id = ?",
                            (passage_id,),
                        )
                    report["edge_provenance_removed"] = (
                        int(report["edge_provenance_removed"]) + c.total_changes - before
                    )

                question_ids = self._ids_with_any_prefix(
                    "question_embeddings",
                    [f"{passage_id}__q" for passage_id in passage_ids],
                )
                sentence_vec_ids = self._ids_with_any_prefix(
                    "sentence_embeddings",
                    [f"{passage_id}__s" for passage_id in passage_ids],
                )
                sentence_store_ids = self._ids_with_any_prefix(
                    "sentence_embedding_store",
                    [f"{passage_id}__s" for passage_id in passage_ids],
                )

                report["question_embeddings_removed"] = self._delete_exact_id_rows(
                    "question_embeddings",
                    question_ids,
                )
                sentence_vec0 = self._delete_exact_id_rows(
                    "sentence_embeddings",
                    sentence_vec_ids,
                )
                sentence_store = self._delete_exact_id_rows(
                    "sentence_embedding_store",
                    sentence_store_ids,
                )
                report["sentence_embeddings_removed"] = sentence_vec0 + sentence_store

                passage_fts = self._delete_fts_rows_by_ids(
                    "passages_fts",
                    "passage_id",
                    passage_ids,
                )
                passage_vec0 = self._delete_exact_id_rows("passage_embeddings", passage_ids)
                passage_store = self._delete_exact_id_rows(
                    "passage_embedding_store",
                    passage_ids,
                )
                report["passage_fts_rows_removed"] = passage_fts
                report["passage_embeddings_removed"] = passage_vec0 + passage_store

                before = c.total_changes
                for passage_id in passage_ids:
                    c.execute("DELETE FROM sentence_profiles WHERE passage_id = ?", (passage_id,))
                report["sentence_profile_rows_removed"] = c.total_changes - before

                before = c.total_changes
                for passage_id in passage_ids:
                    c.execute("DELETE FROM passage_entities WHERE passage_id = ?", (passage_id,))
                report["passage_entity_rows_removed"] = (
                    int(report["passage_entity_rows_removed"]) + c.total_changes - before
                )

                before = c.total_changes
                for passage_id in passage_ids:
                    c.execute("DELETE FROM passages WHERE passage_id = ?", (passage_id,))
                report["passages_removed"] = c.total_changes - before

                if self._asset_schema_present():
                    before = c.total_changes
                    c.execute("DELETE FROM assets WHERE provenance_source_id = ?", (source_id,))
                    report["assets_removed"] = c.total_changes - before

            if provenance is not None and hasattr(provenance, "delete_source_cascade"):
                provenance.begin_batch()
                provenance_batch_started = True
                provenance_report = provenance.delete_source_cascade(source_id)
                provenance.commit_batch()
                provenance_batch_started = False
                report["provenance_sources_removed"] = int(
                    provenance_report.get("sources_removed", 0)
                )
                report["provenance_segments_removed"] = int(
                    provenance_report.get("segments_removed", 0)
                )
                report["provenance_citations_removed"] = int(
                    provenance_report.get("citations_removed", 0)
                )

            report["fts5_rows_removed"] = (
                int(report["node_fts_rows_removed"]) + int(report["passage_fts_rows_removed"])
            )
            report["embeddings_removed"] = (
                int(report["node_embeddings_removed"])
                + int(report["passage_embeddings_removed"])
                + int(report["question_embeddings_removed"])
                + int(report["sentence_embeddings_removed"])
            )

            # Write the neighborhood dirty flag INSIDE the transaction —
            # marking it after commit leaves an implicit write transaction
            # open, which breaks the next explicit BEGIN (e.g. a follow-up
            # delete_asset / delete_source on the same connection).
            self.mark_neighborhood_dirty()
            c.commit()
            for node_id in derived_only:
                self._known_ids.discard(node_id)
            (self._edge_count,) = c.execute("SELECT COUNT(*) FROM edges").fetchone()
            self._graph_cache = None
            self._graph_cache_semantic = None
            self._neighborhood_cache = None
            self._centrality_cache = None
            self._centrality_cache_measure = None
            logger.info("[gdpr] delete_source %s -> %s", source_id, report)
            return report
        except Exception:
            c.rollback()
            if provenance_batch_started:
                try:
                    provenance.rollback_batch()
                except Exception:
                    pass
            self._rebuild_index()
            raise

    def extract_source(
        self,
        source_id: str,
        provenance=None,
        *,
        include_embeddings: bool = False,
    ) -> dict[str, object]:
        """Serialize one source's derived-only closure as a PortableArtifact.

        The non-destructive dual of :meth:`delete_source`: the SAME closure
        computation, copy instead of drop. Shared/boundary nodes are emitted
        as typed stubs (``lod_2`` label + ``points_to`` reference; never
        ``lod_0`` / ``lod_1`` content of shared knowledge), so the artifact
        carries the extract's full content without leaking provenance from
        outside the source. See
        [[docs/design/arch-rung-level-subgraph-migration-2026-06-08.md]] §4 +
        §6 + GDPR Art 20 portability.

        PURE-READ: zero mutation of the live graph; a caller-side row-count
        before/after assertion holds. The artifact's ``exported_at`` field
        is set by the caller (the operator surface stamps it), not in this
        pure-read core.

        Legacy graphs whose ``passages.source_id`` is empty have the same
        prerequisite as ``delete_source``: run the Janitor
        ``backfill_node_provenance`` task once before extracting at scale
        (see ``[GDPR-LIVE-GRAPH-BACKFILL-PREREQ]``).

        Args:
            source_id: The source to extract.
            provenance: Optional provenance store, used to recover passage
                IDs on legacy graphs missing ``passages.source_id``
                (matches :meth:`delete_source` behaviour).
            include_embeddings: When True, includes the float32 embedding
                arrays for derived-only nodes + passages. Default False
                keeps the artifact light + text-portable.

        Returns:
            A JSON-serializable PortableArtifact v1 dict with
            ``artifact_version``, ``rung``, ``source_id``,
            ``derived_only_nodes`` (full content), ``passages``,
            ``internal_edges`` (both endpoints in derived_only),
            ``boundary_stubs`` (shared/outside nodes as ``lod_2``-only
            references), and ``boundary_edges`` (cut edges with a
            ``crosses_to_stub`` annotation).

        Raises:
            ValueError: empty ``source_id``.
            KeyError: ``source_id`` is unknown (matches ``delete_source``).
        """
        source_id = (source_id or "").strip()
        if not source_id:
            raise ValueError("source_id is required")
        self._ensure_node_provenance_schema()

        passage_ids, provenance_source_exists = self._source_passage_ids(
            source_id,
            provenance=provenance,
        )
        if not passage_ids and not provenance_source_exists:
            raise KeyError(f"source_id not found: {source_id}")

        closure = self.resolve_derived_closure(passage_ids)

        # --- derived-only nodes (full content) ----------------------------------
        derived_only_payload: list[dict[str, object]] = []
        if closure.derived_only:
            node_map = self.get_nodes(list(closure.derived_only))
            for entity_id in sorted(closure.derived_only):
                node = node_map.get(entity_id)
                if node is None:
                    continue
                row: dict[str, object] = {
                    "entity_id": node.entity_id,
                    "name": node.name,
                    "category": node.category,
                    "lod_0": node.lod_0,
                    "lod_1": node.lod_1,
                    "lod_2": node.lod_2,
                }
                if include_embeddings and node.embedding:
                    row["embedding"] = list(node.embedding)
                derived_only_payload.append(row)

        # --- passages of the source --------------------------------------------
        passages_payload: list[dict[str, object]] = []
        if passage_ids:
            passage_map = self.get_passages_batch(passage_ids)
            embedding_map: dict[str, list[float]] = {}
            if include_embeddings:
                emb_rows = self._batch_in_query(
                    "SELECT id, embedding FROM passage_embedding_store "
                    "WHERE id IN ({placeholders})",
                    passage_ids,
                )
                for pid, blob in emb_rows:
                    if blob is None:
                        continue
                    arr = np.frombuffer(blob, dtype=np.float32)
                    if arr.size and bool(np.any(arr != 0)):
                        embedding_map[str(pid)] = arr.tolist()
            for passage_id in sorted(passage_map):
                passage = passage_map[passage_id]
                payload: dict[str, object] = {
                    "passage_id": passage.passage_id,
                    "raw_text": passage.raw_text,
                    "source_id": passage.source_id or source_id,
                    "source_label": passage.source_label,
                    "entity_ids": sorted(passage.entity_ids),
                    "ingested_at": passage.ingested_at,
                }
                if include_embeddings and passage_id in embedding_map:
                    payload["embedding"] = embedding_map[passage_id]
                passages_payload.append(payload)

        # --- internal edges (both endpoints in derived_only) -------------------
        internal_edges_payload: list[dict[str, object]] = []
        if closure.derived_only:
            edge_rows = self._batch_in_query(
                "SELECT source, target, relation FROM edges "
                "WHERE source IN ({placeholders}) AND target IN ({placeholders})",
                list(closure.derived_only),
                repeat_bindings=2,
            )
            internal_edges_payload = [
                {"source": str(s), "target": str(t), "relation": str(r)}
                for s, t, r in edge_rows
            ]

        # --- boundary stubs (lod_2 label only; no lod_0/lod_1 leakage) ---------
        stub_node_ids: set[str] = set()
        for source_node, target_node, _relation in closure.boundary_edges:
            if source_node not in closure.derived_only:
                stub_node_ids.add(source_node)
            if target_node not in closure.derived_only:
                stub_node_ids.add(target_node)

        boundary_stubs_payload: list[dict[str, object]] = []
        if stub_node_ids:
            stub_rows = self._batch_in_query(
                "SELECT entity_id, lod_2 FROM nodes "
                "WHERE entity_id IN ({placeholders})",
                sorted(stub_node_ids),
            )
            stub_label: dict[str, str] = {
                str(entity_id): (str(label) if label else "")
                for entity_id, label in stub_rows
            }
            for entity_id in sorted(stub_node_ids):
                boundary_stubs_payload.append(
                    {
                        "entity_id": entity_id,
                        "stub": True,
                        "lod_2": stub_label.get(entity_id, ""),
                        "points_to": {"shard": "residual", "node_id": entity_id},
                    }
                )

        boundary_edges_payload: list[dict[str, object]] = []
        for source_node, target_node, relation in sorted(closure.boundary_edges):
            crosses_to_stub = (
                source_node
                if source_node not in closure.derived_only
                else target_node
            )
            boundary_edges_payload.append(
                {
                    "source": source_node,
                    "target": target_node,
                    "relation": relation,
                    "crosses_to_stub": crosses_to_stub,
                }
            )

        artifact: dict[str, object] = {
            "artifact_version": 1,
            "rung": "source",
            "source_id": source_id,
            "derived_only_nodes": derived_only_payload,
            "passages": passages_payload,
            "internal_edges": internal_edges_payload,
            "boundary_stubs": boundary_stubs_payload,
            "boundary_edges": boundary_edges_payload,
        }
        logger.info(
            "[gdpr] extract_source %s -> {derived_only=%d stubs=%d internal_edges=%d boundary_edges=%d passages=%d embeddings=%s}",
            source_id,
            len(derived_only_payload),
            len(boundary_stubs_payload),
            len(internal_edges_payload),
            len(boundary_edges_payload),
            len(passages_payload),
            "yes" if include_embeddings else "no",
        )
        return artifact

    def import_portable_artifact(self, artifact: dict) -> dict[str, object]:
        """Reconstruct a PortableArtifact v1 into this graph.

        The reverse path of :meth:`extract_source` / :meth:`extract_asset`
        (``rung`` dispatches): re-creates derived-only nodes (full content)
        + passages + internal edges + boundary edges, and materializes
        boundary-stub references as extraction-stub nodes
        (``category="extraction_stub"`` with empty ``lod_0``/``lod_1`` —
        the privacy property persists across the round-trip). Asset-rung
        artifacts additionally reconstruct the Authorial asset record +
        asset-scoped evidence (see :meth:`_import_asset_artifact`).

        Idempotent — uses UPSERT semantics throughout (``upsert_node`` /
        ``upsert_passage`` / ``upsert_edge``). Re-importing the same
        artifact does NOT create duplicates. A stub does NOT overwrite an
        existing full node (this matters when grafting an extract onto a
        graph that already has the shared knowledge).

        Args:
            artifact: A dict produced by ``extract_source`` (or hand-built
                following the v1 envelope).

        Returns:
            A report counting how many rows of each kind were imported.

        Raises:
            ValueError: unsupported artifact version or rung.
        """
        version = artifact.get("artifact_version")
        if version != 1:
            raise ValueError(
                f"unsupported PortableArtifact version: {version!r}"
            )
        rung = artifact.get("rung")
        if rung == "asset":
            return self._import_asset_artifact(artifact)
        if rung in ("island", "continent"):
            return self._import_community_artifact(artifact)
        if rung != "source":
            raise ValueError(
                f"PortableArtifact rung must be 'source', 'asset', 'island', "
                f"or 'continent' in v1; got {rung!r}"
            )

        report: dict[str, object] = {
            "source_id": artifact.get("source_id"),
            "derived_only_nodes_imported": 0,
            "stub_nodes_imported": 0,
            "stub_nodes_skipped_full_node_present": 0,
            "passages_imported": 0,
            "internal_edges_imported": 0,
            "boundary_edges_imported": 0,
        }

        for node_row in artifact.get("derived_only_nodes") or []:
            entity_id = str(node_row.get("entity_id") or "").strip()
            if not entity_id:
                continue
            embedding = node_row.get("embedding")
            self.upsert_node(
                NodeData(
                    entity_id=entity_id,
                    name=str(node_row.get("name") or entity_id),
                    category=str(node_row.get("category") or "concept"),
                    lod_0=str(node_row.get("lod_0") or ""),
                    lod_1=str(node_row.get("lod_1") or ""),
                    lod_2=str(node_row.get("lod_2") or entity_id),
                    embedding=list(embedding) if embedding else None,
                )
            )
            report["derived_only_nodes_imported"] += 1  # type: ignore[operator]

        for stub in artifact.get("boundary_stubs") or []:
            entity_id = str(stub.get("entity_id") or "").strip()
            if not entity_id:
                continue
            # Idempotency + privacy: if a full node with this ID already
            # exists, do NOT overwrite it with the label-only stub. Stubs
            # only fill in MISSING shared nodes.
            if self.get_node(entity_id) is not None:
                report["stub_nodes_skipped_full_node_present"] += 1  # type: ignore[operator]
                continue
            label = str(stub.get("lod_2") or entity_id)
            self.upsert_node(
                NodeData(
                    entity_id=entity_id,
                    name=label,
                    category="extraction_stub",
                    lod_0="",  # no shared-content leakage
                    lod_1="",
                    lod_2=label,
                )
            )
            report["stub_nodes_imported"] += 1  # type: ignore[operator]

        for passage_row in artifact.get("passages") or []:
            passage_id = str(passage_row.get("passage_id") or "").strip()
            if not passage_id:
                continue
            embedding = passage_row.get("embedding")
            self.upsert_passage(
                SourcePassage(
                    passage_id=passage_id,
                    raw_text=str(passage_row.get("raw_text") or ""),
                    source_id=passage_row.get("source_id") or None,
                    source_label=str(passage_row.get("source_label") or ""),
                    entity_ids=list(passage_row.get("entity_ids") or []),
                    ingested_at=str(passage_row.get("ingested_at") or ""),
                    embedding=list(embedding) if embedding else None,
                )
            )
            report["passages_imported"] += 1  # type: ignore[operator]

        for edge_row in artifact.get("internal_edges") or []:
            self.upsert_edge(
                EdgeData(
                    source=str(edge_row["source"]),
                    target=str(edge_row["target"]),
                    relation=str(edge_row["relation"]),
                )
            )
            report["internal_edges_imported"] += 1  # type: ignore[operator]

        for edge_row in artifact.get("boundary_edges") or []:
            self.upsert_edge(
                EdgeData(
                    source=str(edge_row["source"]),
                    target=str(edge_row["target"]),
                    relation=str(edge_row["relation"]),
                )
            )
            report["boundary_edges_imported"] += 1  # type: ignore[operator]

        logger.info(
            "[gdpr] import_portable_artifact source=%s -> %s",
            artifact.get("source_id"),
            report,
        )
        return report

    def _import_asset_artifact(self, artifact: dict) -> dict[str, object]:
        """Reconstruct an asset-rung PortableArtifact v1 into this graph.

        FK-correct ordering under ``PRAGMA foreign_keys=ON``: the asset row
        lands first (``passages.asset_id`` / ``asset_entities.asset_id`` /
        ``edge_provenance.asset_id`` all reference it), then nodes + stubs
        (``asset_entities.entity_id`` references nodes), then passages,
        then edges — internal + boundary + ``evidenced_shared_edges`` —
        (``edge_provenance`` references edges), then the asset-scoped
        evidence rows. Idempotent: UPSERT semantics throughout; a stub
        never overwrites an existing full node.

        Raises:
            RuntimeError: the Asset overlay schema is not present.
            ValueError: missing/inconsistent ``asset`` record.
        """
        self._require_asset_schema()

        asset_record = artifact.get("asset")
        if not isinstance(asset_record, dict) or not str(
            asset_record.get("asset_id") or ""
        ).strip():
            raise ValueError(
                "asset-rung PortableArtifact requires an 'asset' record "
                "with an asset_id (the Authorial Layer-1 row)"
            )
        asset_id = str(asset_record["asset_id"]).strip()
        envelope_asset_id = str(artifact.get("asset_id") or "").strip()
        if envelope_asset_id and envelope_asset_id != asset_id:
            raise ValueError(
                "asset-rung PortableArtifact is inconsistent: envelope asset_id "
                f"{envelope_asset_id!r} != asset record asset_id {asset_id!r}"
            )

        report: dict[str, object] = {
            "asset_id": asset_id,
            "asset_rows_imported": 0,
            "derived_only_nodes_imported": 0,
            "stub_nodes_imported": 0,
            "stub_nodes_skipped_full_node_present": 0,
            "passages_imported": 0,
            "internal_edges_imported": 0,
            "boundary_edges_imported": 0,
            "evidenced_shared_edges_imported": 0,
            "asset_entity_rows_imported": 0,
            "asset_entity_rows_skipped_missing_node": 0,
            "edge_provenance_rows_imported": 0,
        }

        self._upsert_asset_record(asset_record)
        report["asset_rows_imported"] = 1
        self._import_artifact_graph_sections(artifact, report, default_asset_id=asset_id)
        self._import_artifact_evidence(artifact, report, fixed_asset_id=asset_id)

        self._conn.commit()
        logger.info(
            "[asset-rung] import_portable_artifact asset=%s -> %s",
            asset_id,
            report,
        )
        return report

    def _upsert_asset_record(self, asset_record: dict) -> str:
        """UPSERT one Authorial Layer-1 asset row from an artifact record."""
        asset_id = str(asset_record.get("asset_id") or "").strip()
        if not asset_id:
            raise ValueError("asset record requires an asset_id")
        self._conn.execute(
            """
            INSERT INTO assets (
                asset_id, lineage_id, edition_seq, source_label, source_hash,
                provenance_source_id, title, byte_size, declared_by,
                declared_at, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(asset_id) DO UPDATE SET
                lineage_id = excluded.lineage_id,
                edition_seq = excluded.edition_seq,
                source_label = excluded.source_label,
                source_hash = excluded.source_hash,
                provenance_source_id = excluded.provenance_source_id,
                title = excluded.title,
                byte_size = excluded.byte_size,
                declared_by = excluded.declared_by,
                declared_at = excluded.declared_at,
                updated_at = datetime('now')
            """,
            (
                asset_id,
                str(asset_record.get("lineage_id") or asset_id),
                int(asset_record.get("edition_seq") or 1),
                str(asset_record.get("source_label") or ""),
                str(asset_record.get("source_hash") or f"import-{asset_id}"),
                asset_record.get("provenance_source_id"),
                str(asset_record.get("title") or ""),
                int(asset_record.get("byte_size") or 0),
                str(asset_record.get("declared_by") or "portable_artifact_import"),
                asset_record.get("declared_at"),
            ),
        )
        return asset_id

    def _import_artifact_graph_sections(
        self,
        artifact: dict,
        report: dict[str, object],
        *,
        default_asset_id: str | None,
    ) -> None:
        """Import nodes + stubs + passages + the three edge classes.

        Shared by the asset-rung and community-rung import paths. FK order
        is the caller's responsibility (asset rows must already exist when
        passages carry asset_ids).
        """
        for node_row in artifact.get("derived_only_nodes") or []:
            entity_id = str(node_row.get("entity_id") or "").strip()
            if not entity_id:
                continue
            embedding = node_row.get("embedding")
            self.upsert_node(
                NodeData(
                    entity_id=entity_id,
                    name=str(node_row.get("name") or entity_id),
                    category=str(node_row.get("category") or "concept"),
                    lod_0=str(node_row.get("lod_0") or ""),
                    lod_1=str(node_row.get("lod_1") or ""),
                    lod_2=str(node_row.get("lod_2") or entity_id),
                    embedding=list(embedding) if embedding else None,
                )
            )
            report["derived_only_nodes_imported"] += 1  # type: ignore[operator]

        for stub in artifact.get("boundary_stubs") or []:
            entity_id = str(stub.get("entity_id") or "").strip()
            if not entity_id:
                continue
            # Idempotency + privacy: a label-only stub never overwrites a
            # full node already present in the destination graph.
            if self.get_node(entity_id) is not None:
                report["stub_nodes_skipped_full_node_present"] += 1  # type: ignore[operator]
                continue
            label = str(stub.get("lod_2") or entity_id)
            self.upsert_node(
                NodeData(
                    entity_id=entity_id,
                    name=label,
                    category="extraction_stub",
                    lod_0="",  # no shared-content leakage
                    lod_1="",
                    lod_2=label,
                )
            )
            report["stub_nodes_imported"] += 1  # type: ignore[operator]

        for passage_row in artifact.get("passages") or []:
            passage_id = str(passage_row.get("passage_id") or "").strip()
            if not passage_id:
                continue
            embedding = passage_row.get("embedding")
            self.upsert_passage(
                SourcePassage(
                    passage_id=passage_id,
                    raw_text=str(passage_row.get("raw_text") or ""),
                    source_id=passage_row.get("source_id") or None,
                    source_label=str(passage_row.get("source_label") or ""),
                    entity_ids=list(passage_row.get("entity_ids") or []),
                    ingested_at=str(passage_row.get("ingested_at") or ""),
                    embedding=list(embedding) if embedding else None,
                    temporal_min=passage_row.get("temporal_min"),
                    temporal_max=passage_row.get("temporal_max"),
                    asset_id=str(passage_row.get("asset_id") or default_asset_id or "")
                    or None,
                )
            )
            report["passages_imported"] += 1  # type: ignore[operator]

        for section, counter in (
            ("internal_edges", "internal_edges_imported"),
            ("boundary_edges", "boundary_edges_imported"),
            ("evidenced_shared_edges", "evidenced_shared_edges_imported"),
        ):
            for edge_row in artifact.get(section) or []:
                self.upsert_edge(
                    EdgeData(
                        source=str(edge_row["source"]),
                        target=str(edge_row["target"]),
                        relation=str(edge_row["relation"]),
                    )
                )
                report[counter] += 1  # type: ignore[operator]

    def _import_artifact_evidence(
        self,
        artifact: dict,
        report: dict[str, object],
        *,
        fixed_asset_id: str | None,
    ) -> None:
        """Import asset_entities + edge_provenance rows.

        ``fixed_asset_id`` (asset-rung artifacts) scopes every row to the
        envelope's asset; community-rung artifacts carry asset_id per row.
        Rows without a resolvable asset are skipped + counted (fail-soft on
        evidence, never on content — evidence is recomputable Layer 2).
        """
        for ae_row in artifact.get("asset_entities") or []:
            entity_id = str(ae_row.get("entity_id") or "").strip()
            asset_id = fixed_asset_id or str(ae_row.get("asset_id") or "").strip()
            if not entity_id or not asset_id:
                continue
            if self.get_node(entity_id) is None:
                # FK to nodes — a well-formed artifact never hits this
                # (extract filters to the artifact node set), but a
                # hand-built one might.
                report["asset_entity_rows_skipped_missing_node"] += 1  # type: ignore[operator]
                continue
            self._conn.execute(
                "INSERT OR REPLACE INTO asset_entities "
                "(asset_id, entity_id, mention_count, section_position) "
                "VALUES (?, ?, ?, ?)",
                (
                    asset_id,
                    entity_id,
                    int(ae_row.get("mention_count") or 1),
                    ae_row.get("section_position"),
                ),
            )
            report["asset_entity_rows_imported"] += 1  # type: ignore[operator]

        for ep_row in artifact.get("edge_provenance") or []:
            asset_id = fixed_asset_id or str(ep_row.get("asset_id") or "").strip()
            if not asset_id:
                continue
            self._conn.execute(
                "INSERT OR REPLACE INTO edge_provenance "
                "(source, target, relation, asset_id, evidence_passage_id, confidence) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    str(ep_row["source"]),
                    str(ep_row["target"]),
                    str(ep_row["relation"]),
                    asset_id,
                    ep_row.get("evidence_passage_id"),
                    float(ep_row.get("confidence") or 1.0),
                ),
            )
            report["edge_provenance_rows_imported"] += 1  # type: ignore[operator]

    def _import_community_artifact(self, artifact: dict) -> dict[str, object]:
        """Reconstruct an island/continent-rung PortableArtifact v1.

        Rung-migration step 4's import half: every member asset's Authorial
        record lands first, then the union closure's graph sections, then
        the per-asset evidence, then the community membership + labels are
        re-registered in ``community_partitions`` with
        ``algorithm="portable_artifact_import"`` — explicitly Systemic
        Layer-2 state the destination may re-bake over at any time.

        Raises:
            RuntimeError: Asset overlay schema absent.
            ValueError: missing ``communities``/``assets`` sections or
                rung/envelope inconsistency.
        """
        from tp_vrg.storage import community_partitions as cp

        self._require_asset_schema()
        rung = str(artifact.get("rung") or "")
        communities = artifact.get("communities")
        assets = artifact.get("assets")
        if not isinstance(communities, dict) or not str(
            communities.get("community_id") or ""
        ).strip():
            raise ValueError(
                f"{rung}-rung PortableArtifact requires a 'communities' section "
                "with a community_id"
            )
        if not isinstance(assets, list) or not assets:
            raise ValueError(
                f"{rung}-rung PortableArtifact requires a non-empty 'assets' list "
                "(the member Authorial records)"
            )
        community_id = str(communities["community_id"]).strip()
        envelope_id = str(artifact.get("community_id") or "").strip()
        if envelope_id and envelope_id != community_id:
            raise ValueError(
                f"{rung}-rung PortableArtifact is inconsistent: envelope "
                f"community_id {envelope_id!r} != communities section {community_id!r}"
            )

        report: dict[str, object] = {
            "rung": rung,
            "community_id": community_id,
            "asset_rows_imported": 0,
            "derived_only_nodes_imported": 0,
            "stub_nodes_imported": 0,
            "stub_nodes_skipped_full_node_present": 0,
            "passages_imported": 0,
            "internal_edges_imported": 0,
            "boundary_edges_imported": 0,
            "evidenced_shared_edges_imported": 0,
            "asset_entity_rows_imported": 0,
            "asset_entity_rows_skipped_missing_node": 0,
            "edge_provenance_rows_imported": 0,
            "island_partitions_imported": 0,
            "continent_partitions_imported": 0,
            "community_labels_imported": 0,
        }

        for asset_record in assets:
            if isinstance(asset_record, dict):
                self._upsert_asset_record(asset_record)
                report["asset_rows_imported"] += 1  # type: ignore[operator]

        self._import_artifact_graph_sections(artifact, report, default_asset_id=None)
        self._import_artifact_evidence(artifact, report, fixed_asset_id=None)

        # --- membership + labels (Systemic Layer 2; re-bakeable) ---------------
        conn = self._conn
        if rung == "island":
            cp.write_partition(
                "island",
                community_id,
                list(communities.get("member_asset_ids") or []),
                "portable_artifact_import",
                conn,
            )
            report["island_partitions_imported"] = 1
            cp.write_label(
                "island",
                community_id,
                str(communities.get("label") or community_id),
                "portable_artifact_import",
                conn,
            )
            report["community_labels_imported"] = 1
        else:  # continent
            island_ids: list[str] = []
            for island in communities.get("islands") or []:
                island_id = str(island.get("island_id") or "").strip()
                if not island_id:
                    continue
                island_ids.append(island_id)
                cp.write_partition(
                    "island",
                    island_id,
                    list(island.get("member_asset_ids") or []),
                    "portable_artifact_import",
                    conn,
                )
                report["island_partitions_imported"] += 1  # type: ignore[operator]
                cp.write_label(
                    "island",
                    island_id,
                    str(island.get("label") or island_id),
                    "portable_artifact_import",
                    conn,
                )
                report["community_labels_imported"] += 1  # type: ignore[operator]
            cp.write_partition(
                "continent",
                community_id,
                island_ids,
                "portable_artifact_import",
                conn,
            )
            report["continent_partitions_imported"] = 1
            cp.write_label(
                "continent",
                community_id,
                str(communities.get("label") or community_id),
                "portable_artifact_import",
                conn,
            )
            report["community_labels_imported"] += 1  # type: ignore[operator]

        conn.commit()
        logger.info(
            "[community-rung] import_portable_artifact %s=%s -> %s",
            rung,
            community_id,
            report,
        )
        return report

    # ------------------------------------------------------------------
    # Asset-rung migration (delete_asset / extract_asset)
    # ------------------------------------------------------------------
    # The Asset-rung instance of the closure-resolver primitive, per
    # [[docs/design/arch-rung-level-subgraph-migration-2026-06-08.md]] §5:
    # membership = passages WHERE asset_id = ?, then the SAME
    # derived-only-vs-shared computation as the source rung. This is what
    # makes the resolver a proven CROSS-RUNG primitive rather than a
    # source-only feature; the Island/Continent rungs are unions of member
    # assets' closures over the same machinery.

    _ASSET_ROW_COLUMNS = (
        "asset_id",
        "lineage_id",
        "edition_seq",
        "source_label",
        "source_hash",
        "provenance_source_id",
        "title",
        "byte_size",
        "declared_by",
        "declared_at",
        "created_at",
        "updated_at",
    )

    def _asset_row_dict(self, asset_id: str) -> dict[str, object] | None:
        """Return the full Authorial Layer-1 asset record, or None."""
        row = self._conn.execute(
            "SELECT " + ", ".join(self._ASSET_ROW_COLUMNS) + " FROM assets WHERE asset_id = ?",
            (asset_id,),
        ).fetchone()
        if row is None:
            return None
        return dict(zip(self._ASSET_ROW_COLUMNS, row))

    def _assert_asset_membership_resolvable(
        self,
        asset_id: str,
        passage_rows: list[tuple[str, str | None, str | None]],
    ) -> None:
        """Fail loud when the asset's closure would silently under-resolve.

        INV-2 guard (the asset-rung analogue of the live-97K
        ``[GDPR-LIVE-GRAPH-BACKFILL-PREREQ]`` finding): a member passage
        that HAS extracted entities but NO ``node_provenance`` rows would
        make ``resolve_derived_closure`` classify nothing for it — a
        delete would orphan derived nodes and an extract would emit an
        incomplete artifact, both silently. Raise instead.

        ``passage_rows`` is ``(passage_id, source_id, entity_ids_json)``.
        """
        with_entities: list[str] = []
        for passage_id, _source_id, entity_ids_json in passage_rows:
            try:
                entity_ids = json.loads(entity_ids_json) if entity_ids_json else []
            except (TypeError, json.JSONDecodeError):
                entity_ids = []
            if any(eid for eid in entity_ids):
                with_entities.append(passage_id)
        if not with_entities:
            return
        covered = {
            row[0]
            for row in self._batch_in_query(
                "SELECT DISTINCT passage_id FROM node_provenance "
                "WHERE passage_id IN ({placeholders})",
                with_entities,
            )
        }
        missing = [pid for pid in with_entities if pid not in covered]
        if missing:
            raise ValueError(
                f"Asset {asset_id} membership is unresolvable: {len(missing)} member "
                "passage(s) have extracted entities but no node_provenance rows — "
                "the derived-only closure would silently under-resolve. Run the "
                "Janitor backfill_node_provenance task first (same prerequisite as "
                "delete_source; see [GDPR-LIVE-GRAPH-BACKFILL-PREREQ]). "
                f"Sample: {missing[:5]}"
            )

    def _asset_passage_rows(
        self, asset_id: str
    ) -> list[tuple[str, str | None, str | None]]:
        """Return ``(passage_id, source_id, entity_ids_json)`` member rows."""
        return self._conn.execute(
            "SELECT passage_id, source_id, entity_ids FROM passages "
            "WHERE asset_id = ? ORDER BY passage_id",
            (asset_id,),
        ).fetchall()

    def delete_asset(self, asset_id: str) -> dict[str, object]:
        """Delete one Asset and cascade only its derived-only graph nodes.

        Art-17 erasure at the Asset rung: membership is ``passages WHERE
        asset_id = ?``, then the same closure cascade as
        :meth:`delete_source`. Nodes shared with OTHER assets — including
        other assets of the SAME source — survive with reduced provenance.
        The Asset overlay rows (the asset row + its ``asset_entities`` +
        ``edge_provenance``) are removed explicitly; the ``ON DELETE
        CASCADE`` Asset FKs are the safety net, not the mechanism. Order
        matters: ``passages.asset_id REFERENCES assets`` is NO-ACTION under
        ``PRAGMA foreign_keys=ON``, so passages are removed before the
        asset row.

        v1 boundary: the separate provenance.db is NOT cascaded at the
        Asset rung — an Asset is a sub-source grouping in general, and
        segment-level provenance erasure is out of scope here. Full Art-17
        erasure of a whole source remains :meth:`delete_source`.

        Raises:
            ValueError: empty ``asset_id``, or membership unmaterialized /
                unresolvable (fail-loud per INV-2 — run
                ``backfill_assets_by_source_document`` /
                ``backfill_node_provenance`` first).
            KeyError: unknown ``asset_id``.
            RuntimeError: called inside an existing storage batch.
        """
        asset_id = (asset_id or "").strip()
        if not asset_id:
            raise ValueError("asset_id is required")
        if self._in_batch:
            raise RuntimeError("delete_asset cannot run inside an existing storage batch")
        self._require_asset_schema()
        self._ensure_node_provenance_schema()
        c = self._conn

        if self._asset_row_dict(asset_id) is None:
            raise KeyError(f"asset_id not found: {asset_id}")
        passage_rows = self._asset_passage_rows(asset_id)
        passage_ids = [row[0] for row in passage_rows]
        if not passage_ids and self.asset_backfill_pending():
            raise ValueError(
                f"Asset {asset_id} has no member passages while the Asset overlay "
                "backfill is pending — membership is unmaterialized. Run "
                "backfill_assets_by_source_document first."
            )

        report: dict[str, object] = {
            "status": "deleted",
            "asset_id": asset_id,
            "passages_removed": 0,
            "derived_only_nodes_removed": 0,
            "shared_nodes_preserved": 0,
            "edges_removed": 0,
            "embeddings_removed": 0,
            "node_embeddings_removed": 0,
            "passage_embeddings_removed": 0,
            "question_embeddings_removed": 0,
            "sentence_embeddings_removed": 0,
            "fts5_rows_removed": 0,
            "node_fts_rows_removed": 0,
            "passage_fts_rows_removed": 0,
            "node_provenance_rows_removed": 0,
            "passage_entity_rows_removed": 0,
            "sentence_profile_rows_removed": 0,
            "asset_entities_removed": 0,
            "edge_provenance_removed": 0,
            "assets_removed": 0,
        }

        derived_only: list[str] = []
        try:
            c.execute("BEGIN")
            # Self-heal node_provenance for member passages whose source_id
            # is known (mirrors delete_source's defensive populate), then
            # fail loud on anything still unresolvable. The heal is allowed
            # here because delete mutates anyway; extract_asset must stay
            # pure-read and only asserts.
            by_source: dict[str, list[str]] = {}
            for passage_id, source_id, _entity_ids_json in passage_rows:
                sid = (source_id or "").strip()
                if sid:
                    by_source.setdefault(sid, []).append(passage_id)
            for sid, pids in by_source.items():
                self._populate_node_provenance_for_passages(sid, pids)
            self._assert_asset_membership_resolvable(asset_id, passage_rows)

            if passage_ids:
                closure = self.resolve_derived_closure(passage_ids)
            else:
                closure = ClosureResult(derived_only=frozenset(), shared=frozenset())

            node_prov_before = c.total_changes
            for passage_id in passage_ids:
                c.execute(
                    "DELETE FROM node_provenance WHERE passage_id = ?",
                    (passage_id,),
                )
            report["node_provenance_rows_removed"] = c.total_changes - node_prov_before

            derived_only = list(closure.derived_only)
            report["derived_only_nodes_removed"] = len(derived_only)
            report["shared_nodes_preserved"] = len(closure.shared)

            if derived_only:
                node_fts = self._delete_fts_rows_by_ids(
                    "nodes_fts",
                    "entity_id",
                    derived_only,
                )
                node_vec0 = self._delete_exact_id_rows("node_embeddings", derived_only)
                node_store = self._delete_exact_id_rows("node_embedding_store", derived_only)
                report["node_fts_rows_removed"] = node_fts
                report["node_embeddings_removed"] = node_vec0 + node_store

                before = c.total_changes
                for node_id in derived_only:
                    c.execute(
                        "DELETE FROM edge_provenance WHERE source = ? OR target = ?",
                        (node_id, node_id),
                    )
                report["edge_provenance_removed"] = (
                    int(report["edge_provenance_removed"]) + c.total_changes - before
                )
                before = c.total_changes
                for node_id in derived_only:
                    c.execute("DELETE FROM asset_entities WHERE entity_id = ?", (node_id,))
                report["asset_entities_removed"] = c.total_changes - before

                before = c.total_changes
                for node_id in derived_only:
                    c.execute(
                        "DELETE FROM edges WHERE source = ? OR target = ?",
                        (node_id, node_id),
                    )
                report["edges_removed"] = c.total_changes - before

                before = c.total_changes
                for node_id in derived_only:
                    c.execute("DELETE FROM passage_entities WHERE entity_id = ?", (node_id,))
                report["passage_entity_rows_removed"] = (
                    int(report["passage_entity_rows_removed"]) + c.total_changes - before
                )

                before = c.total_changes
                for node_id in derived_only:
                    c.execute("DELETE FROM nodes WHERE entity_id = ?", (node_id,))
                nodes_deleted = c.total_changes - before
                if nodes_deleted != len(derived_only):
                    raise RuntimeError(
                        "delete_asset structural inconsistency: "
                        f"expected to delete {len(derived_only)} nodes, deleted {nodes_deleted}"
                    )

            if passage_ids:
                before = c.total_changes
                for passage_id in passage_ids:
                    c.execute(
                        "DELETE FROM edge_provenance WHERE evidence_passage_id = ?",
                        (passage_id,),
                    )
                report["edge_provenance_removed"] = (
                    int(report["edge_provenance_removed"]) + c.total_changes - before
                )

                question_ids = self._ids_with_any_prefix(
                    "question_embeddings",
                    [f"{passage_id}__q" for passage_id in passage_ids],
                )
                sentence_vec_ids = self._ids_with_any_prefix(
                    "sentence_embeddings",
                    [f"{passage_id}__s" for passage_id in passage_ids],
                )
                sentence_store_ids = self._ids_with_any_prefix(
                    "sentence_embedding_store",
                    [f"{passage_id}__s" for passage_id in passage_ids],
                )

                report["question_embeddings_removed"] = self._delete_exact_id_rows(
                    "question_embeddings",
                    question_ids,
                )
                sentence_vec0 = self._delete_exact_id_rows(
                    "sentence_embeddings",
                    sentence_vec_ids,
                )
                sentence_store = self._delete_exact_id_rows(
                    "sentence_embedding_store",
                    sentence_store_ids,
                )
                report["sentence_embeddings_removed"] = sentence_vec0 + sentence_store

                passage_fts = self._delete_fts_rows_by_ids(
                    "passages_fts",
                    "passage_id",
                    passage_ids,
                )
                passage_vec0 = self._delete_exact_id_rows("passage_embeddings", passage_ids)
                passage_store = self._delete_exact_id_rows(
                    "passage_embedding_store",
                    passage_ids,
                )
                report["passage_fts_rows_removed"] = passage_fts
                report["passage_embeddings_removed"] = passage_vec0 + passage_store

                before = c.total_changes
                for passage_id in passage_ids:
                    c.execute("DELETE FROM sentence_profiles WHERE passage_id = ?", (passage_id,))
                report["sentence_profile_rows_removed"] = c.total_changes - before

                before = c.total_changes
                for passage_id in passage_ids:
                    c.execute("DELETE FROM passage_entities WHERE passage_id = ?", (passage_id,))
                report["passage_entity_rows_removed"] = (
                    int(report["passage_entity_rows_removed"]) + c.total_changes - before
                )

                before = c.total_changes
                for passage_id in passage_ids:
                    c.execute("DELETE FROM passages WHERE passage_id = ?", (passage_id,))
                report["passages_removed"] = c.total_changes - before

            # Asset-scoped overlay rows + the asset row itself (passages are
            # already gone, so the NO-ACTION passages.asset_id FK is satisfied).
            before = c.total_changes
            c.execute("DELETE FROM edge_provenance WHERE asset_id = ?", (asset_id,))
            report["edge_provenance_removed"] = (
                int(report["edge_provenance_removed"]) + c.total_changes - before
            )
            before = c.total_changes
            c.execute("DELETE FROM asset_entities WHERE asset_id = ?", (asset_id,))
            report["asset_entities_removed"] = (
                int(report["asset_entities_removed"]) + c.total_changes - before
            )
            before = c.total_changes
            c.execute("DELETE FROM assets WHERE asset_id = ?", (asset_id,))
            report["assets_removed"] = c.total_changes - before

            report["fts5_rows_removed"] = (
                int(report["node_fts_rows_removed"]) + int(report["passage_fts_rows_removed"])
            )
            report["embeddings_removed"] = (
                int(report["node_embeddings_removed"])
                + int(report["passage_embeddings_removed"])
                + int(report["question_embeddings_removed"])
                + int(report["sentence_embeddings_removed"])
            )

            # Inside the transaction for the same reason as delete_source:
            # a post-commit dirty-flag INSERT leaves an implicit transaction
            # open and breaks the next explicit BEGIN.
            self.mark_neighborhood_dirty()
            c.commit()
            for node_id in derived_only:
                self._known_ids.discard(node_id)
            (self._edge_count,) = c.execute("SELECT COUNT(*) FROM edges").fetchone()
            self._graph_cache = None
            self._graph_cache_semantic = None
            self._neighborhood_cache = None
            self._centrality_cache = None
            self._centrality_cache_measure = None
            logger.info("[asset-rung] delete_asset %s -> %s", asset_id, report)
            return report
        except Exception:
            c.rollback()
            self._rebuild_index()
            raise

    def extract_asset(
        self,
        asset_id: str,
        *,
        include_embeddings: bool = False,
    ) -> dict[str, object]:
        """Serialize one Asset's derived-only closure as a PortableArtifact.

        The non-destructive dual of :meth:`delete_asset` (Art-20
        portability at the Asset rung) and the Asset-rung sibling of
        :meth:`extract_source`. Three additions over the source rung:

        1. The artifact carries the full **Authorial Layer-1 asset record**
           (lineage_id, edition_seq, source_hash, title, declared_by, …)
           per the Authorial/Systemic split in
           [[docs/design/arch-asset-semantic-unit.md]] — the asset travels
           as a first-class authorial unit, not a bag of passages.
        2. **Every shared entity the asset mentions is stubbed** (not only
           boundary-edge endpoints): ``closure.shared`` ∪ external
           boundary endpoints. The imported asset's entity map is complete
           — each ``asset_entities`` row resolves to a full node or a stub.
        3. Asset-scoped evidence travels: ``asset_entities`` rows and
           ``edge_provenance`` rows for this asset. Provenance rows on
           stub↔stub edges carry their edge in ``evidenced_shared_edges``
           so they stay importable; rows on edges with an endpoint outside
           the artifact are dropped and counted honestly in
           ``edge_provenance_rows_dropped``.

        Stubs remain ``lod_2``-label-only (never ``lod_0``/``lod_1``
        content of shared knowledge) — the same privacy property as the
        source rung. PURE-READ: zero mutation; unlike :meth:`delete_asset`
        there is NO node_provenance self-heal here — an unresolvable
        membership raises instead (run ``backfill_node_provenance`` first).

        Raises:
            ValueError: empty ``asset_id``, or membership unmaterialized /
                unresolvable (fail-loud per INV-2).
            KeyError: unknown ``asset_id``.
        """
        asset_id = (asset_id or "").strip()
        if not asset_id:
            raise ValueError("asset_id is required")
        self._require_asset_schema()
        self._ensure_node_provenance_schema()
        c = self._conn

        asset_row = self._asset_row_dict(asset_id)
        if asset_row is None:
            raise KeyError(f"asset_id not found: {asset_id}")
        passage_rows = self._asset_passage_rows(asset_id)
        passage_ids = [row[0] for row in passage_rows]
        if not passage_ids and self.asset_backfill_pending():
            raise ValueError(
                f"Asset {asset_id} has no member passages while the Asset overlay "
                "backfill is pending — membership is unmaterialized. Run "
                "backfill_assets_by_source_document first."
            )
        self._assert_asset_membership_resolvable(asset_id, passage_rows)

        closure = self.resolve_derived_closure(passage_ids)

        # --- derived-only nodes (full content) ----------------------------------
        derived_only_payload: list[dict[str, object]] = []
        if closure.derived_only:
            node_map = self.get_nodes(list(closure.derived_only))
            for entity_id in sorted(closure.derived_only):
                node = node_map.get(entity_id)
                if node is None:
                    continue
                row: dict[str, object] = {
                    "entity_id": node.entity_id,
                    "name": node.name,
                    "category": node.category,
                    "lod_0": node.lod_0,
                    "lod_1": node.lod_1,
                    "lod_2": node.lod_2,
                }
                if include_embeddings and node.embedding:
                    row["embedding"] = list(node.embedding)
                derived_only_payload.append(row)

        # --- passages of the asset (carry asset_id + temporal bounds) ----------
        passages_payload: list[dict[str, object]] = []
        if passage_ids:
            passage_map = self.get_passages_batch(passage_ids)
            embedding_map: dict[str, list[float]] = {}
            if include_embeddings:
                emb_rows = self._batch_in_query(
                    "SELECT id, embedding FROM passage_embedding_store "
                    "WHERE id IN ({placeholders})",
                    passage_ids,
                )
                for pid, blob in emb_rows:
                    if blob is None:
                        continue
                    arr = np.frombuffer(blob, dtype=np.float32)
                    if arr.size and bool(np.any(arr != 0)):
                        embedding_map[str(pid)] = arr.tolist()
            for passage_id in sorted(passage_map):
                passage = passage_map[passage_id]
                payload: dict[str, object] = {
                    "passage_id": passage.passage_id,
                    "raw_text": passage.raw_text,
                    "source_id": passage.source_id,
                    "source_label": passage.source_label,
                    "entity_ids": sorted(passage.entity_ids),
                    "ingested_at": passage.ingested_at,
                    "temporal_min": passage.temporal_min,
                    "temporal_max": passage.temporal_max,
                    "asset_id": passage.asset_id or asset_id,
                }
                if include_embeddings and passage_id in embedding_map:
                    payload["embedding"] = embedding_map[passage_id]
                passages_payload.append(payload)

        # --- internal edges (both endpoints in derived_only) -------------------
        internal_edges_payload: list[dict[str, object]] = []
        internal_edge_keys: set[tuple[str, str, str]] = set()
        if closure.derived_only:
            edge_rows = self._batch_in_query(
                "SELECT source, target, relation FROM edges "
                "WHERE source IN ({placeholders}) AND target IN ({placeholders})",
                list(closure.derived_only),
                repeat_bindings=2,
            )
            for s, t, r in edge_rows:
                key = (str(s), str(t), str(r))
                internal_edge_keys.add(key)
                internal_edges_payload.append(
                    {"source": key[0], "target": key[1], "relation": key[2]}
                )

        # --- stubs: ALL shared entities the asset mentions + boundary endpoints
        stub_node_ids: set[str] = set(closure.shared)
        for source_node, target_node, _relation in closure.boundary_edges:
            if source_node not in closure.derived_only:
                stub_node_ids.add(source_node)
            if target_node not in closure.derived_only:
                stub_node_ids.add(target_node)

        boundary_stubs_payload: list[dict[str, object]] = []
        if stub_node_ids:
            stub_rows = self._batch_in_query(
                "SELECT entity_id, lod_2 FROM nodes "
                "WHERE entity_id IN ({placeholders})",
                sorted(stub_node_ids),
            )
            stub_label: dict[str, str] = {
                str(entity_id): (str(label) if label else "")
                for entity_id, label in stub_rows
            }
            for entity_id in sorted(stub_node_ids):
                boundary_stubs_payload.append(
                    {
                        "entity_id": entity_id,
                        "stub": True,
                        "lod_2": stub_label.get(entity_id, ""),
                        "points_to": {"shard": "residual", "node_id": entity_id},
                    }
                )

        boundary_edges_payload: list[dict[str, object]] = []
        for source_node, target_node, relation in sorted(closure.boundary_edges):
            crosses_to_stub = (
                source_node
                if source_node not in closure.derived_only
                else target_node
            )
            boundary_edges_payload.append(
                {
                    "source": source_node,
                    "target": target_node,
                    "relation": relation,
                    "crosses_to_stub": crosses_to_stub,
                }
            )

        artifact_node_ids = set(closure.derived_only) | stub_node_ids
        importable_edge_keys = internal_edge_keys | set(closure.boundary_edges)

        # --- asset_entities (the asset's entity map; asset-local stats) --------
        asset_entities_payload: list[dict[str, object]] = []
        asset_entity_rows_dropped = 0
        ae_rows = c.execute(
            "SELECT entity_id, mention_count, section_position "
            "FROM asset_entities WHERE asset_id = ? ORDER BY entity_id",
            (asset_id,),
        ).fetchall()
        for entity_id, mention_count, section_position in ae_rows:
            if str(entity_id) in artifact_node_ids:
                asset_entities_payload.append(
                    {
                        "entity_id": str(entity_id),
                        "mention_count": int(mention_count),
                        "section_position": section_position,
                    }
                )
            else:
                # Stale junction row whose entity has no provenance from this
                # asset's passages — not representable in the artifact.
                asset_entity_rows_dropped += 1

        # --- edge_provenance (asset-scoped edge evidence) -----------------------
        edge_provenance_payload: list[dict[str, object]] = []
        evidenced_shared_edges_payload: list[dict[str, object]] = []
        seen_shared_edge_keys: set[tuple[str, str, str]] = set()
        edge_provenance_rows_dropped = 0
        ep_rows = c.execute(
            "SELECT source, target, relation, evidence_passage_id, confidence "
            "FROM edge_provenance WHERE asset_id = ? "
            "ORDER BY source, target, relation",
            (asset_id,),
        ).fetchall()
        for s, t, r, evidence_passage_id, confidence in ep_rows:
            key = (str(s), str(t), str(r))
            if key in importable_edge_keys:
                pass  # edge already travels as internal or boundary
            elif key[0] in artifact_node_ids and key[1] in artifact_node_ids:
                # stub↔stub edge evidenced by this asset — carry the edge so
                # the provenance row stays importable (FK to edges).
                if key not in seen_shared_edge_keys:
                    seen_shared_edge_keys.add(key)
                    evidenced_shared_edges_payload.append(
                        {"source": key[0], "target": key[1], "relation": key[2]}
                    )
            else:
                edge_provenance_rows_dropped += 1
                continue
            edge_provenance_payload.append(
                {
                    "source": key[0],
                    "target": key[1],
                    "relation": key[2],
                    "evidence_passage_id": evidence_passage_id,
                    "confidence": float(confidence),
                }
            )

        artifact: dict[str, object] = {
            "artifact_version": 1,
            "rung": "asset",
            "asset_id": asset_id,
            "asset": asset_row,
            "derived_only_nodes": derived_only_payload,
            "passages": passages_payload,
            "internal_edges": internal_edges_payload,
            "boundary_stubs": boundary_stubs_payload,
            "boundary_edges": boundary_edges_payload,
            "evidenced_shared_edges": evidenced_shared_edges_payload,
            "asset_entities": asset_entities_payload,
            "edge_provenance": edge_provenance_payload,
            "asset_entity_rows_dropped": asset_entity_rows_dropped,
            "edge_provenance_rows_dropped": edge_provenance_rows_dropped,
        }
        logger.info(
            "[asset-rung] extract_asset %s -> {derived_only=%d stubs=%d internal_edges=%d "
            "boundary_edges=%d evidenced_shared_edges=%d passages=%d asset_entities=%d "
            "edge_provenance=%d dropped=(%d,%d) embeddings=%s}",
            asset_id,
            len(derived_only_payload),
            len(boundary_stubs_payload),
            len(internal_edges_payload),
            len(boundary_edges_payload),
            len(evidenced_shared_edges_payload),
            len(passages_payload),
            len(asset_entities_payload),
            len(edge_provenance_payload),
            asset_entity_rows_dropped,
            edge_provenance_rows_dropped,
            "yes" if include_embeddings else "no",
        )
        return artifact

    def _community_membership(
        self, rung: str, community_id: str
    ) -> tuple[str, str, dict[str, list[str]], list[str]]:
        """Resolve a community's label + member structure from the baked partition.

        Returns ``(label, label_source, islands, member_asset_ids)`` where
        ``islands`` maps island_id -> member asset_ids (a single synthetic
        entry keyed by ``community_id`` itself at the island rung) and
        ``member_asset_ids`` is the deduplicated union.

        Raises:
            KeyError: no partition rows for this community at this rung.
            ValueError: a continent references islands with no baked island
                rows (stale partition — fail loud, re-bake).
        """
        from tp_vrg.storage import community_partitions as cp

        conn = self._conn
        labels = cp.read_labels(rung, conn)
        label, label_source = labels.get(community_id, (community_id, "asset_label_fallback"))

        member_rows = conn.execute(
            "SELECT member_id FROM community_partitions "
            "WHERE rung = ? AND community_id = ? ORDER BY member_id",
            (rung, community_id),
        ).fetchall()
        members = [row[0] for row in member_rows]
        if not members:
            raise KeyError(f"{rung} community not found in baked partition: {community_id}")

        if rung == "island":
            return label, label_source, {community_id: members}, members

        # continent: members are island_ids; resolve each island's assets
        islands: dict[str, list[str]] = {}
        missing_islands: list[str] = []
        for island_id in members:
            island_assets = [
                row[0]
                for row in conn.execute(
                    "SELECT member_id FROM community_partitions "
                    "WHERE rung = 'island' AND community_id = ? ORDER BY member_id",
                    (island_id,),
                ).fetchall()
            ]
            if not island_assets:
                missing_islands.append(island_id)
            islands[island_id] = island_assets
        if missing_islands:
            raise ValueError(
                f"Continent {community_id} references {len(missing_islands)} island(s) "
                f"with no baked island rows (sample: {missing_islands[:5]}) — the "
                "partition is stale; re-bake the island rung before extracting."
            )
        member_asset_ids = sorted({aid for assets in islands.values() for aid in assets})
        return label, label_source, islands, member_asset_ids

    def extract_community(
        self,
        community_id: str,
        *,
        rung: str,
        include_embeddings: bool = False,
    ) -> dict[str, object]:
        """Serialize an Island or Continent as a PortableArtifact.

        Rung-migration ladder step 4 ([[docs/design/arch-rung-level-subgraph-migration-2026-06-08.md]]
        §5): a community-rung extract is the UNION of its member assets'
        closures over the same machinery as :meth:`extract_asset`. The rung
        defines the boundary — knowledge shared between two assets of the
        SAME island is derived-only at the island rung (it travels as full
        content), while knowledge shared with assets outside the community
        becomes lod_2-only stubs. PURE-READ; same fail-loud guards as the
        asset rung, applied per member asset, plus a stale-partition guard
        (community rows referencing assets/islands that no longer exist).

        The artifact carries the community structure (labels + membership),
        every member asset's Authorial Layer-1 record, and the per-asset
        evidence (asset_entities + edge_provenance, each row asset-scoped).
        Membership is Systemic Layer-2 state — the destination may re-bake
        its own partition over the imported rows at any time.

        Raises:
            ValueError: bad rung / empty id / unresolvable membership /
                stale partition.
            KeyError: unknown community at this rung.
        """
        community_id = (community_id or "").strip()
        if not community_id:
            raise ValueError("community_id is required")
        if rung not in ("island", "continent"):
            raise ValueError(
                f"extract_community rung must be 'island' or 'continent'; got {rung!r} "
                "(use extract_asset / extract_source for the lower rungs)"
            )
        self._require_asset_schema()
        self._ensure_node_provenance_schema()
        c = self._conn

        label, label_source, islands, member_asset_ids = self._community_membership(
            rung, community_id
        )

        # --- member asset records (Authorial Layer-1) + per-asset guards -------
        assets_payload: list[dict[str, object]] = []
        missing_assets: list[str] = []
        all_passage_ids: list[str] = []
        for asset_id in member_asset_ids:
            asset_row = self._asset_row_dict(asset_id)
            if asset_row is None:
                missing_assets.append(asset_id)
                continue
            assets_payload.append(asset_row)
            passage_rows = self._asset_passage_rows(asset_id)
            self._assert_asset_membership_resolvable(asset_id, passage_rows)
            all_passage_ids.extend(row[0] for row in passage_rows)
        if missing_assets:
            raise ValueError(
                f"{rung} {community_id} membership references {len(missing_assets)} "
                f"asset(s) with no asset row (sample: {missing_assets[:5]}) — the "
                "partition is stale; re-bake before extracting."
            )
        passage_ids = list(dict.fromkeys(all_passage_ids))

        closure = self.resolve_derived_closure(passage_ids)

        # --- closure sections (same shapes as extract_asset, union-scoped) -----
        derived_only_payload: list[dict[str, object]] = []
        if closure.derived_only:
            node_map = self.get_nodes(list(closure.derived_only))
            for entity_id in sorted(closure.derived_only):
                node = node_map.get(entity_id)
                if node is None:
                    continue
                row: dict[str, object] = {
                    "entity_id": node.entity_id,
                    "name": node.name,
                    "category": node.category,
                    "lod_0": node.lod_0,
                    "lod_1": node.lod_1,
                    "lod_2": node.lod_2,
                }
                if include_embeddings and node.embedding:
                    row["embedding"] = list(node.embedding)
                derived_only_payload.append(row)

        passages_payload: list[dict[str, object]] = []
        if passage_ids:
            passage_map = self.get_passages_batch(passage_ids)
            embedding_map: dict[str, list[float]] = {}
            if include_embeddings:
                emb_rows = self._batch_in_query(
                    "SELECT id, embedding FROM passage_embedding_store "
                    "WHERE id IN ({placeholders})",
                    passage_ids,
                )
                for pid, blob in emb_rows:
                    if blob is None:
                        continue
                    arr = np.frombuffer(blob, dtype=np.float32)
                    if arr.size and bool(np.any(arr != 0)):
                        embedding_map[str(pid)] = arr.tolist()
            for passage_id in sorted(passage_map):
                passage = passage_map[passage_id]
                payload: dict[str, object] = {
                    "passage_id": passage.passage_id,
                    "raw_text": passage.raw_text,
                    "source_id": passage.source_id,
                    "source_label": passage.source_label,
                    "entity_ids": sorted(passage.entity_ids),
                    "ingested_at": passage.ingested_at,
                    "temporal_min": passage.temporal_min,
                    "temporal_max": passage.temporal_max,
                    "asset_id": passage.asset_id,
                }
                if include_embeddings and passage_id in embedding_map:
                    payload["embedding"] = embedding_map[passage_id]
                passages_payload.append(payload)

        internal_edges_payload: list[dict[str, object]] = []
        internal_edge_keys: set[tuple[str, str, str]] = set()
        if closure.derived_only:
            edge_rows = self._batch_in_query(
                "SELECT source, target, relation FROM edges "
                "WHERE source IN ({placeholders}) AND target IN ({placeholders})",
                list(closure.derived_only),
                repeat_bindings=2,
            )
            for s, t, r in edge_rows:
                key = (str(s), str(t), str(r))
                internal_edge_keys.add(key)
                internal_edges_payload.append(
                    {"source": key[0], "target": key[1], "relation": key[2]}
                )

        stub_node_ids: set[str] = set(closure.shared)
        for source_node, target_node, _relation in closure.boundary_edges:
            if source_node not in closure.derived_only:
                stub_node_ids.add(source_node)
            if target_node not in closure.derived_only:
                stub_node_ids.add(target_node)

        boundary_stubs_payload: list[dict[str, object]] = []
        if stub_node_ids:
            stub_rows = self._batch_in_query(
                "SELECT entity_id, lod_2 FROM nodes "
                "WHERE entity_id IN ({placeholders})",
                sorted(stub_node_ids),
            )
            stub_label: dict[str, str] = {
                str(entity_id): (str(value) if value else "")
                for entity_id, value in stub_rows
            }
            for entity_id in sorted(stub_node_ids):
                boundary_stubs_payload.append(
                    {
                        "entity_id": entity_id,
                        "stub": True,
                        "lod_2": stub_label.get(entity_id, ""),
                        "points_to": {"shard": "residual", "node_id": entity_id},
                    }
                )

        boundary_edges_payload: list[dict[str, object]] = []
        for source_node, target_node, relation in sorted(closure.boundary_edges):
            crosses_to_stub = (
                source_node
                if source_node not in closure.derived_only
                else target_node
            )
            boundary_edges_payload.append(
                {
                    "source": source_node,
                    "target": target_node,
                    "relation": relation,
                    "crosses_to_stub": crosses_to_stub,
                }
            )

        artifact_node_ids = set(closure.derived_only) | stub_node_ids
        importable_edge_keys = internal_edge_keys | set(closure.boundary_edges)

        # --- per-asset evidence across ALL member assets ------------------------
        asset_entities_payload: list[dict[str, object]] = []
        asset_entity_rows_dropped = 0
        ae_rows = self._batch_in_query(
            "SELECT asset_id, entity_id, mention_count, section_position "
            "FROM asset_entities WHERE asset_id IN ({placeholders}) "
            "ORDER BY asset_id, entity_id",
            member_asset_ids,
        )
        for asset_id, entity_id, mention_count, section_position in ae_rows:
            if str(entity_id) in artifact_node_ids:
                asset_entities_payload.append(
                    {
                        "asset_id": str(asset_id),
                        "entity_id": str(entity_id),
                        "mention_count": int(mention_count),
                        "section_position": section_position,
                    }
                )
            else:
                asset_entity_rows_dropped += 1

        edge_provenance_payload: list[dict[str, object]] = []
        evidenced_shared_edges_payload: list[dict[str, object]] = []
        seen_shared_edge_keys: set[tuple[str, str, str]] = set()
        edge_provenance_rows_dropped = 0
        ep_rows = self._batch_in_query(
            "SELECT source, target, relation, asset_id, evidence_passage_id, confidence "
            "FROM edge_provenance WHERE asset_id IN ({placeholders}) "
            "ORDER BY asset_id, source, target, relation",
            member_asset_ids,
        )
        for s, t, r, asset_id, evidence_passage_id, confidence in ep_rows:
            key = (str(s), str(t), str(r))
            if key in importable_edge_keys:
                pass
            elif key[0] in artifact_node_ids and key[1] in artifact_node_ids:
                if key not in seen_shared_edge_keys:
                    seen_shared_edge_keys.add(key)
                    evidenced_shared_edges_payload.append(
                        {"source": key[0], "target": key[1], "relation": key[2]}
                    )
            else:
                edge_provenance_rows_dropped += 1
                continue
            edge_provenance_payload.append(
                {
                    "source": key[0],
                    "target": key[1],
                    "relation": key[2],
                    "asset_id": str(asset_id),
                    "evidence_passage_id": evidence_passage_id,
                    "confidence": float(confidence),
                }
            )

        # --- community structure (labels are Systemic; membership travels) -----
        from tp_vrg.storage import community_partitions as cp

        island_labels = (
            {community_id: (label, label_source)}
            if rung == "island"
            else cp.read_labels("island", c)
        )
        communities: dict[str, object] = {
            "community_id": community_id,
            "label": label,
            "label_source": label_source,
        }
        if rung == "island":
            communities["member_asset_ids"] = islands[community_id]
        else:
            communities["islands"] = [
                {
                    "island_id": island_id,
                    "label": island_labels.get(island_id, (island_id, "asset_label_fallback"))[0],
                    "label_source": island_labels.get(
                        island_id, (island_id, "asset_label_fallback")
                    )[1],
                    "member_asset_ids": asset_ids,
                }
                for island_id, asset_ids in sorted(islands.items())
            ]

        artifact: dict[str, object] = {
            "artifact_version": 1,
            "rung": rung,
            "community_id": community_id,
            "communities": communities,
            "assets": assets_payload,
            "derived_only_nodes": derived_only_payload,
            "passages": passages_payload,
            "internal_edges": internal_edges_payload,
            "boundary_stubs": boundary_stubs_payload,
            "boundary_edges": boundary_edges_payload,
            "evidenced_shared_edges": evidenced_shared_edges_payload,
            "asset_entities": asset_entities_payload,
            "edge_provenance": edge_provenance_payload,
            "asset_entity_rows_dropped": asset_entity_rows_dropped,
            "edge_provenance_rows_dropped": edge_provenance_rows_dropped,
        }
        logger.info(
            "[community-rung] extract_community %s %s -> {assets=%d derived_only=%d "
            "stubs=%d passages=%d internal=%d boundary=%d evidenced_shared=%d "
            "asset_entities=%d edge_provenance=%d dropped=(%d,%d) embeddings=%s}",
            rung,
            community_id,
            len(assets_payload),
            len(derived_only_payload),
            len(boundary_stubs_payload),
            len(passages_payload),
            len(internal_edges_payload),
            len(boundary_edges_payload),
            len(evidenced_shared_edges_payload),
            len(asset_entities_payload),
            len(edge_provenance_payload),
            asset_entity_rows_dropped,
            edge_provenance_rows_dropped,
            "yes" if include_embeddings else "no",
        )
        return artifact

    # ------------------------------------------------------------------
    # MOVE — extract + delete + residual stub (rung-migration §4 third op)
    # ------------------------------------------------------------------

    def _ensure_migration_log_schema(self) -> None:
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS migration_log (
                unit_type    TEXT NOT NULL,
                unit_id      TEXT NOT NULL,
                payload_hash TEXT NOT NULL,
                label        TEXT NOT NULL DEFAULT '',
                moved_at     TEXT NOT NULL,
                destination  TEXT,
                PRIMARY KEY (unit_type, unit_id, moved_at)
            )
            """
        )

    def _record_move(
        self,
        unit_type: str,
        unit_id: str,
        payload_hash: str,
        label: str,
        destination: str | None,
    ) -> str:
        """Write the migration-log row + the residual extraction-stub node.

        The §6 reciprocal: the residual graph keeps a typed marker that this
        unit's knowledge departed, plus a provenance commitment (the
        artifact's canonical payload hash) in ``migration_log`` so a future
        return/merge can verify it is the same shard coming home.
        """
        self._ensure_migration_log_schema()
        moved_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self._conn.execute(
            "INSERT INTO migration_log "
            "(unit_type, unit_id, payload_hash, label, moved_at, destination) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (unit_type, unit_id, payload_hash, label, moved_at, destination),
        )
        stub_id = f"extraction_stub:{unit_type}:{unit_id}"
        stub_label = f"{label or unit_id} (moved)"
        self.upsert_node(
            NodeData(
                entity_id=stub_id,
                name=stub_label,
                category="extraction_stub",
                lod_0="",  # never content; the artifact carries the content
                lod_1="",
                lod_2=stub_label,
            )
        )
        return stub_id

    def _move_unit(
        self,
        unit_type: str,
        unit_id: str,
        *,
        include_embeddings: bool,
        destination: str | None,
        extract,
        delete,
        label: str,
        provenance=None,
        persist_artifact=None,
    ) -> dict[str, object]:
        from tp_vrg.attestation import payload_hash_hex  # stdlib-only at module level

        artifact = extract()
        payload_hash = payload_hash_hex(artifact)
        # The only-copy safety beat: when a persist callback is given, it runs
        # BETWEEN the pure-read extract and the destructive delete. If
        # persisting fails (disk full, bad path, signing error), the exception
        # propagates and the delete NEVER runs — the graph is unchanged and
        # nothing was lost. Operator surfaces (HTTP/MCP) REQUIRE this path.
        persisted: dict[str, object] | None = None
        if persist_artifact is not None:
            persisted = persist_artifact(artifact, payload_hash)
        delete_report = delete()
        stub_id = self._record_move(unit_type, unit_id, payload_hash, label, destination)
        report: dict[str, object] = {
            "status": "moved",
            "rung": unit_type,
            "unit_id": unit_id,
            "payload_hash": payload_hash,
            "residual_stub_id": stub_id,
            "destination": destination,
            "artifact": artifact,
            "delete_report": delete_report,
        }
        if persisted is not None:
            report["artifact_persisted"] = persisted
        logger.info(
            "[move] %s %s -> {payload_hash=%s stub=%s destination=%s persisted=%s}",
            unit_type,
            unit_id,
            payload_hash,
            stub_id,
            destination or "(unspecified)",
            (persisted or {}).get("artifact_path", "no"),
        )
        return report

    def move_asset(
        self,
        asset_id: str,
        *,
        include_embeddings: bool = True,
        destination: str | None = None,
        persist_artifact=None,
    ) -> dict[str, object]:
        """MOVE one Asset: extract -> delete -> residual stub + move record.

        The third terminal operation of the closure resolver
        ([[docs/design/arch-rung-level-subgraph-migration-2026-06-08.md]] §4:
        DELETE / EXTRACT / MOVE share one closure computation) — P-6's
        "break off a self-contained sub-graph, leaving a stub behind."

        ⚠️ THE RETURNED ``artifact`` IS THE ONLY COPY of the moved
        knowledge unless ``persist_artifact`` is given (a callable
        ``(artifact, payload_hash) -> info dict`` invoked BETWEEN the
        pure-read extract and the destructive delete — if it raises, the
        delete never runs and the graph is unchanged; the HTTP/MCP move
        surfaces require it). Without it the caller MUST persist the
        report's artifact before discarding it. ``payload_hash`` is the
        canonical sha256 recorded in ``migration_log`` so a future
        merge-back can verify the returning shard.

        ``include_embeddings`` defaults True (unlike extract): a move
        should carry the knowledge whole rather than forcing a re-embed.

        Same fail-loud guards as extract_asset + delete_asset.
        """
        asset_id = (asset_id or "").strip()
        if not asset_id:
            raise ValueError("asset_id is required")
        asset_row = self._asset_row_dict(asset_id)
        label = str(asset_row.get("title") or asset_id) if asset_row else asset_id
        return self._move_unit(
            "asset",
            asset_id,
            include_embeddings=include_embeddings,
            destination=destination,
            extract=lambda: self.extract_asset(
                asset_id, include_embeddings=include_embeddings
            ),
            delete=lambda: self.delete_asset(asset_id),
            label=label,
            persist_artifact=persist_artifact,
        )

    def move_source(
        self,
        source_id: str,
        provenance=None,
        *,
        include_embeddings: bool = True,
        destination: str | None = None,
        persist_artifact=None,
    ) -> dict[str, object]:
        """MOVE one source: extract -> delete -> residual stub + move record.

        Source-rung sibling of :meth:`move_asset`; see its docstring for
        the only-copy warning, the ``persist_artifact`` safety callback,
        and ordering guarantees. ``provenance`` is forwarded to both
        halves (legacy passage recovery + the Art-17 provenance-store
        cascade, matching delete_source).
        """
        source_id = (source_id or "").strip()
        if not source_id:
            raise ValueError("source_id is required")
        return self._move_unit(
            "source",
            source_id,
            include_embeddings=include_embeddings,
            destination=destination,
            extract=lambda: self.extract_source(
                source_id, provenance, include_embeddings=include_embeddings
            ),
            delete=lambda: self.delete_source(source_id, provenance),
            label=source_id,
            persist_artifact=persist_artifact,
        )

    def get_node(self, entity_id: str) -> NodeData | None:
        if entity_id not in self._known_ids:
            return None

        row = self._conn.execute(
            """
            SELECT entity_id, name, category, lod_0, lod_1, lod_2,
                   parent_id, chunk_index, is_chunk, refined,
                   ingested_at, event_timestamp
            FROM nodes WHERE entity_id = ?
            """,
            (entity_id,),
        ).fetchone()
        if row is None:
            return None

        emb_row = self._conn.execute(
            "SELECT embedding FROM node_embeddings WHERE id = ?", (entity_id,)
        ).fetchone()
        embedding = None
        if emb_row:
            arr = np.frombuffer(emb_row[0], dtype=np.float32)
            if np.any(arr != 0):
                embedding = arr.tolist()

        return NodeData(
            entity_id=row[0], name=row[1], category=row[2],
            lod_0=row[3], lod_1=row[4], lod_2=row[5],
            parent_id=row[6], chunk_index=row[7],
            is_chunk=bool(row[8]), refined=bool(row[9]),
            embedding=embedding,
            ingested_at=row[10] if row[10] is not None else time.time(),
            event_timestamp=row[11],
        )

    def get_all_nodes(self) -> dict[str, NodeData]:
        rows = self._conn.execute(
            """
            SELECT n.entity_id, n.name, n.category, n.lod_0, n.lod_1, n.lod_2,
                   n.parent_id, n.chunk_index, n.is_chunk, n.refined,
                   e.embedding, n.ingested_at, n.event_timestamp
            FROM nodes n
            LEFT JOIN node_embeddings e ON n.entity_id = e.id
            """
        ).fetchall()

        result: dict[str, NodeData] = {}
        for row in rows:
            embedding = None
            if row[10] is not None:
                arr = np.frombuffer(row[10], dtype=np.float32)
                if np.any(arr != 0):
                    embedding = arr.tolist()
            result[row[0]] = NodeData(
                entity_id=row[0], name=row[1], category=row[2],
                lod_0=row[3], lod_1=row[4], lod_2=row[5],
                parent_id=row[6], chunk_index=row[7],
                is_chunk=bool(row[8]), refined=bool(row[9]),
                embedding=embedding,
                ingested_at=row[11] if row[11] is not None else time.time(),
                event_timestamp=row[12],
            )
        return result

    def get_node_index(self) -> dict[str, str]:
        """Return lightweight normalization index: {entity_id: category}."""
        rows = self._conn.execute(
            "SELECT entity_id, category FROM nodes"
        ).fetchall()
        return {entity_id: category for entity_id, category in rows}

    def get_nodes(self, ids: list[str]) -> dict[str, NodeData]:
        """Batch fetch nodes by ID list. Missing IDs are silently omitted."""
        if not ids:
            return {}
        rows = self._batch_in_query(
            """
            SELECT n.entity_id, n.name, n.category, n.lod_0, n.lod_1, n.lod_2,
                   n.parent_id, n.chunk_index, n.is_chunk, n.refined,
                   e.embedding, n.ingested_at, n.event_timestamp
            FROM nodes n
            LEFT JOIN node_embeddings e ON n.entity_id = e.id
            WHERE n.entity_id IN ({placeholders})
            """,
            ids,
        )

        result: dict[str, NodeData] = {}
        for row in rows:
            embedding = None
            if row[10] is not None:
                arr = np.frombuffer(row[10], dtype=np.float32)
                if np.any(arr != 0):
                    embedding = arr.tolist()
            result[row[0]] = NodeData(
                entity_id=row[0], name=row[1], category=row[2],
                lod_0=row[3], lod_1=row[4], lod_2=row[5],
                parent_id=row[6], chunk_index=row[7],
                is_chunk=bool(row[8]), refined=bool(row[9]),
                embedding=embedding,
                ingested_at=row[11] if row[11] is not None else time.time(),
                event_timestamp=row[12],
            )
        return result

    def get_node_timestamps(self) -> dict[str, str]:
        """Return {entity_id: created_at_iso} for all nodes."""
        rows = self._conn.execute(
            "SELECT entity_id, created_at FROM nodes"
        ).fetchall()
        return {row[0]: row[1] for row in rows if row[1]}

    def rebuild_neighborhood_cache(self) -> int:
        """Rebuild 2-hop semantic neighborhood cache (structural edges excluded)."""
        c = self._conn
        rels = sorted(STRUCTURAL_RELATIONS)
        in_clause = ",".join("?" * len(rels))

        sql = f"""
            WITH RECURSIVE
              undirected_edges(base, nbr) AS (
                SELECT source, target FROM edges WHERE relation NOT IN ({in_clause})
                UNION ALL
                SELECT target, source FROM edges WHERE relation NOT IN ({in_clause})
              ),
              walk(node, hop, path) AS (
                SELECT ?, 0, ',' || ? || ','
                UNION ALL
                SELECT ue.nbr, walk.hop + 1, walk.path || ue.nbr || ','
                FROM walk
                JOIN undirected_edges ue ON ue.base = walk.node
                WHERE walk.hop < 2
                  AND instr(walk.path, ',' || ue.nbr || ',') = 0
              ),
              shortest AS (
                SELECT node AS neighbor_entity_id, MIN(hop) AS hop_distance
                FROM walk
                WHERE hop BETWEEN 1 AND 2
                  AND node <> ?
                GROUP BY node
              )
            INSERT OR REPLACE INTO entity_neighborhoods (
                source_entity_id, neighbor_entity_id, hop_distance, score, calculated_at
            )
            SELECT
                ?,
                neighbor_entity_id,
                hop_distance,
                CASE hop_distance WHEN 1 THEN 1.0 ELSE 0.6 END,
                datetime('now')
            FROM shortest
        """

        c.execute("BEGIN")
        try:
            c.execute("DELETE FROM entity_neighborhoods")
            for source in self._known_ids:
                params = tuple(rels + rels + [source, source, source, source])
                c.execute(sql, params)
            c.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES ('neighborhood_cache_dirty', '0')"
            )
            c.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES ('neighborhood_cache_built_at', datetime('now'))"
            )
            (rows_written,) = c.execute(
                "SELECT COUNT(*) FROM entity_neighborhoods"
            ).fetchone()
            c.commit()
            self._neighborhood_cache = None
            return int(rows_written)
        except Exception:
            c.rollback()
            raise

    def get_cached_neighborhoods(self, entity_ids: set[str]) -> dict[str, float]:
        """Return merged cached neighborhoods: neighbor_entity_id -> max(score)."""
        if not entity_ids:
            return {}
        rows = self._batch_in_query(
            """
            SELECT neighbor_entity_id, MIN(hop_distance) AS hop_distance, MAX(score) AS score
            FROM entity_neighborhoods
            WHERE source_entity_id IN ({placeholders})
            GROUP BY neighbor_entity_id
            """,
            entity_ids,
        )
        neighborhoods: dict[str, tuple[int, float]] = {}
        for neighbor_id, hop_distance, score in rows:
            current = neighborhoods.get(neighbor_id)
            if current is None:
                neighborhoods[neighbor_id] = (int(hop_distance), float(score))
                continue
            best_hop = min(current[0], int(hop_distance))
            best_score = max(current[1], float(score))
            neighborhoods[neighbor_id] = (best_hop, best_score)
        return {neighbor_id: score for neighbor_id, (_, score) in neighborhoods.items()}

    def is_neighborhood_cache_clean(self) -> bool:
        row = self._conn.execute(
            "SELECT value FROM meta WHERE key = 'neighborhood_cache_dirty'"
        ).fetchone()
        return bool(row and row[0] == "0")

    def mark_neighborhood_dirty(self) -> None:
        self._conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('neighborhood_cache_dirty', '1')"
        )
        self._neighborhood_cache = None

    def get_neighbors(self, entity_id: str) -> list[str]:
        rows = self._conn.execute(
            """
            SELECT target FROM edges WHERE source = ?
            UNION
            SELECT source FROM edges WHERE target = ?
            """,
            (entity_id, entity_id),
        ).fetchall()
        return [r[0] for r in rows]

    def get_neighbors_with_relations(self, entity_id: str) -> list[tuple[str, str]]:
        """Return (neighbor_id, relation) for all edges touching entity_id."""
        rows = self._conn.execute(
            """
            SELECT target, relation FROM edges WHERE source = ?
            UNION ALL
            SELECT source, relation FROM edges WHERE target = ?
            """,
            (entity_id, entity_id),
        ).fetchall()
        return [(r[0], r[1] or "") for r in rows]

    def exact_name_match(self, name: str) -> set[str]:
        """Return entity_ids where node.name matches exactly (case-insensitive)."""
        rows = self._conn.execute(
            "SELECT entity_id FROM nodes WHERE LOWER(name) = LOWER(?)",
            (name,),
        ).fetchall()
        return {r[0] for r in rows}

    def get_all_edges(self) -> list[tuple[str, str, dict]]:
        rows = self._conn.execute(
            "SELECT source, target, relation, weight FROM edges"
        ).fetchall()
        return [
            (r[0], r[1], {"relation": r[2], "weight": float(r[3])})
            for r in rows
        ]

    def get_edges_for_nodes(
        self, entity_ids: set[str]
    ) -> list[tuple[str, str, dict]]:
        """Return edges where EITHER source OR target is in *entity_ids*.

        Includes boundary/stubble edges (one endpoint inside, one outside the
        set).  Same return format as get_all_edges().
        """
        if not entity_ids:
            return []
        rows = self._batch_in_query(
            """
            SELECT source, target, relation, weight FROM edges
            WHERE source IN ({placeholders}) OR target IN ({placeholders})
            """,
            entity_ids,
            repeat_bindings=2,
        )
        result: list[tuple[str, str, dict]] = []
        seen: set[tuple[str, str, str]] = set()
        for source, target, relation, weight in rows:
            key = (source, target, relation)
            if key in seen:
                continue
            seen.add(key)
            result.append(
                (source, target, {"relation": relation, "weight": float(weight)})
            )
        return result

    def node_count(self) -> int:
        return len(self._known_ids)

    def edge_count(self) -> int:
        return self._edge_count

    def passage_count(self) -> int:
        (count,) = self._conn.execute("SELECT COUNT(*) FROM passages").fetchone()
        return int(count)

    # -- Graph analytics (transient NetworkX) ---------------------------------

    def _ensure_graph(self, exclude_structural: bool = False) -> None:
        """Build the transient NetworkX graph from SQLite edges if needed.

        Args:
            exclude_structural: If True, build/use the semantic-only graph that
                excludes STRUCTURAL_RELATIONS edges (used for backbone centrality
                to prevent the PageRank Hijack from long-document edge chains).
                If False (default), build/use the full graph including structural
                edges (used for traversal and distance queries).
        """
        cache_key = "_graph_cache_semantic" if exclude_structural else "_graph_cache"
        if getattr(self, cache_key, None) is not None:
            return

        g: nx.Graph | nx.DiGraph = nx.DiGraph() if exclude_structural else nx.Graph()
        for eid in self._known_ids:
            g.add_node(eid)
        for src, tgt, rel, w in self._conn.execute(
            "SELECT source, target, relation, weight FROM edges"
        ):
            if exclude_structural and rel in STRUCTURAL_RELATIONS:
                continue
            g.add_edge(src, tgt, relation=rel, weight=float(w))
        setattr(self, cache_key, g)

    def shortest_path_lengths(self, source: str) -> dict[str, int]:
        self._ensure_graph()
        if source not in self._graph_cache:
            return {}
        return dict(nx.single_source_shortest_path_length(self._graph_cache, source))

    def bounded_neighborhood(
        self, source_ids: list[str], max_hops: int = 5
    ) -> dict[str, int]:
        """BFS from source_ids up to max_hops, returning minimum hop distances.

        Uses a temp table for seeds to avoid SQLITE_LIMIT_COMPOUND_SELECT (500)
        which the previous UNION ALL approach hit on dense graphs (>500 active entities).
        """
        if not source_ids:
            return {}
        if max_hops < 0:
            return {}

        # Temp table avoids both the VALUES-parens bug and the UNION ALL 500-term limit.
        self._conn.execute(
            "CREATE TEMP TABLE IF NOT EXISTS _bfs_seeds (entity_id TEXT PRIMARY KEY)"
        )
        self._conn.execute("DELETE FROM _bfs_seeds")
        self._conn.executemany(
            "INSERT OR IGNORE INTO _bfs_seeds VALUES (?)",
            [(sid,) for sid in source_ids],
        )
        rows = self._conn.execute(
            """
            WITH RECURSIVE bfs(entity_id, depth) AS (
                SELECT entity_id, 0
                FROM _bfs_seeds
                UNION
                SELECT e.target, bfs.depth + 1
                FROM edges e
                JOIN bfs ON e.source = bfs.entity_id
                WHERE bfs.depth < ?
                UNION
                SELECT e.source, bfs.depth + 1
                FROM edges e
                JOIN bfs ON e.target = bfs.entity_id
                WHERE bfs.depth < ?
            )
            SELECT entity_id, MIN(depth)
            FROM bfs
            GROUP BY entity_id
            """,
            (max_hops, max_hops),
        ).fetchall()
        return {eid: int(depth) for eid, depth in rows}

    def betweenness_centrality(self) -> dict[str, float]:
        """Return persisted backbone centrality without computing on read.

        The historical method name is retained for StorageBackend compatibility,
        but Doctrine A makes this a cache read. Explicit refresh belongs to
        calculate_backbone(), typically via the janitor.
        """
        if self._centrality_cache is not None:
            return self._centrality_cache

        self._ensure_backbone_measure_fresh()
        rows = self._conn.execute(
            """
            SELECT source, centrality, COALESCE(measure_name, 'betweenness')
            FROM backbone
            WHERE source = target
            """
        ).fetchall()
        self._centrality_cache = {row[0]: row[1] for row in rows}
        measures = {row[2] for row in rows if row and row[2]}
        if len(measures) == 1:
            self._centrality_cache_measure = next(iter(measures))
        elif measures:
            self._centrality_cache_measure = None
        else:
            self._centrality_cache_measure = get_active_centrality_measure()
        return self._centrality_cache

    def _ensure_backbone_measure_fresh(self) -> None:
        """Detect backbone cache measure drift without recomputing on read.

        Previously this method called ``calculate_backbone()`` synchronously
        when the stored measure differed from the active TPVRG_CENTRALITY_MEASURE.
        That triggered O(V+E)-class network centrality compute on the caller's
        thread — and when the caller was an ``async def`` HTTP handler, the
        entire asyncio event loop blocked for the duration. On the founder's
        97K-node / 985K-edge graph under 89% RAM paging, this blocked Cockpit
        startup for 30+ minutes (2026-04-21 incident; full timeline in
        ``the Cockpit ready-signal migration note``).

        Current behavior: never recompute on read. Log the first observed
        drift at WARNING level (so operators notice) but serve the existing
        cache. Explicit refresh happens via ``calculate_backbone()`` —
        triggered by the janitor, a CLI command, or an MCP tool — all of
        which run in contexts that tolerate sync compute.

        The `TPVRG_SKIP_BACKBONE_INVALIDATION` env var is retained as a
        documented escape hatch (see Operations Manual) — when set, this
        method is silent even about drift. Default: emit drift warning once.

        Pipeline contract C8 formalizes: HTTP/async handlers must never
        block the event loop on centrality compute.
        """
        if os.environ.get("TPVRG_SKIP_BACKBONE_INVALIDATION", "").strip():
            return  # operator-requested silence; no recompute either way

        if self._drift_warning_emitted:
            return  # once-per-process warning; don't spam logs

        rows = self._conn.execute(
            """
            SELECT DISTINCT COALESCE(measure_name, 'betweenness')
            FROM backbone
            WHERE source = target
            """
        ).fetchall()
        measures = {row[0] for row in rows if row and row[0]}
        if not measures:
            # Empty backbone cache — no drift to detect. Not a warning case.
            return

        active_measure = get_active_centrality_measure()
        if len(measures) > 1:
            logger.warning(
                "Backbone cache contains mixed measures %s; active=%s. "
                "Existing cache served as-is. To refresh, trigger "
                "`tp_vrg_janitor(task='backbone')` or "
                "`SQLiteBackend.calculate_backbone()` explicitly.",
                sorted(measures),
                active_measure,
            )
            self._drift_warning_emitted = True
            return

        stored_measure = next(iter(measures))
        if stored_measure != active_measure:
            logger.warning(
                "Backbone cache measure drift: stored=%s active=%s. "
                "Existing cache served as-is (read path never blocks on "
                "recompute). To refresh, trigger "
                "`tp_vrg_janitor(task='backbone')` or "
                "`SQLiteBackend.calculate_backbone()` explicitly.",
                stored_measure,
                active_measure,
            )
            self._drift_warning_emitted = True

    def get_top_backbone_nodes(self, limit: int = 3) -> list[str]:
        """Return entity_ids of the top-N highest-centrality nodes from the backbone cache.

        Used by SP-2 (Backbone Orbit) to inject structurally important bridge nodes
        into the candidate pool even when they are missed by cosine similarity.

        Self-loops (source == target) store per-node centrality in the backbone table.
        Returns [] gracefully when the backbone table is empty or unpopulated.
        """
        self._ensure_backbone_measure_fresh()
        rows = self._conn.execute(
            "SELECT source FROM backbone WHERE source = target ORDER BY centrality DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [row[0] for row in rows]

    def get_backbone(self) -> dict[str, float]:
        """Return cached backbone centrality from the backbone table.

        Returns an empty dict if the backbone has not been calculated yet
        (query path callers should use uniform fallback in that case).
        Centrality values are stored using source == target == entity_id.
        """
        self._ensure_backbone_measure_fresh()
        sql_started_at = time.monotonic()
        cursor = self._conn.execute(
            "SELECT source, centrality FROM backbone WHERE source = target"
        )
        sql_s = time.monotonic() - sql_started_at
        iteration_started_at = time.monotonic()
        rows = cursor.fetchall()
        iteration_s = time.monotonic() - iteration_started_at
        post_started_at = time.monotonic()
        backbone = {row[0]: row[1] for row in rows}
        post_s = time.monotonic() - post_started_at
        logger.info(
            "[backbone-load] sql_ms=%.3f iteration_ms=%.3f post_ms=%.3f rows=%d",
            sql_s * 1000.0,
            iteration_s * 1000.0,
            post_s * 1000.0,
            len(rows),
        )
        return backbone

    def get_backbone_measure(self) -> str | None:
        """Return the persisted backbone centrality measure, if available."""
        self._ensure_backbone_measure_fresh()
        row = self._conn.execute(
            """
            SELECT COALESCE(measure_name, 'betweenness')
            FROM backbone
            WHERE source = target
            LIMIT 1
            """
        ).fetchone()
        return row[0] if row else None

    def calculate_backbone(self) -> dict[str, float]:
        """Compute backbone centrality and cache results in the backbone table.

        Uses the semantic-only graph (structural edges excluded) to prevent
        the PageRank Hijack: a 15-chunk article would create a 14-edge chain
        that artificially inflates centrality for all nodes along that chain.
        Structural edges remain in the full graph for traversal and distance queries.

        Overwrites any previous backbone entries. After this call, get_backbone()
        returns the fresh values and betweenness_centrality() is also updated
        via the in-memory cache.

        Returns:
            The computed centrality dict (entity_id -> centrality score).
        """
        self._ensure_graph(exclude_structural=True)
        if self._graph_cache_semantic.number_of_nodes() == 0:
            self._conn.execute("DELETE FROM backbone WHERE source = target")
            self._conn.commit()
            self._centrality_cache = {}
            self._centrality_cache_measure = get_active_centrality_measure()
            return {}

        measure, centralities = compute_backbone_centrality(self._graph_cache_semantic)

        # Persist to backbone table — use self-loop (source == target) for per-node storage
        self._conn.execute("DELETE FROM backbone WHERE source = target")
        self._conn.executemany(
            """
            INSERT OR REPLACE INTO backbone (source, target, centrality, measure_name)
            VALUES (?, ?, ?, ?)
            """,
            [(eid, eid, score, measure) for eid, score in centralities.items()],
        )
        self._conn.commit()

        # Warm the in-memory cache so subsequent centrality reads do not re-compute
        # during the same session.
        self._centrality_cache = centralities
        self._centrality_cache_measure = measure
        # Fresh cache with active measure — reset drift-warning flag so any
        # FUTURE drift (e.g., operator changes TPVRG_CENTRALITY_MEASURE mid-
        # process) is once-again loggable instead of suppressed.
        self._drift_warning_emitted = False
        return centralities

    @property
    def graph(self) -> nx.Graph | None:
        """Expose the transient NetworkX graph (built on demand)."""
        self._ensure_graph()
        return self._graph_cache

    # -- Full-text search -----------------------------------------------------

    def search_nodes_fts(self, query: str) -> list[str]:
        """Return entity_ids matching *query* via the FTS5 full-text index.

        Uses the ``nodes_fts`` table (indexed on name, lod_0, lod_1).
        Falls back to an empty list if the query contains FTS5 syntax
        errors (e.g. unmatched quotes or special operators).
        """
        if not query or not query.strip():
            return []
        # FTS5 expects a MATCH expression.  We tokenise the user query into
        # individual words and join with AND so "Marie Curie" matches nodes
        # containing both "Marie" AND "Curie" anywhere in name/lod_0/lod_1.
        words = query.strip().split()
        if not words:
            return []
        self._warn_bulk_query_once("search_nodes_fts")
        # Sanitize: strip FTS5 special chars to prevent syntax errors (UX-14).
        sanitized = [self._sanitize_fts5_token(w) for w in words]
        sanitized = [w for w in sanitized if w]
        if not sanitized:
            return []
        match_expr = " AND ".join(f'"{w}"' for w in sanitized)
        try:
            rows = self._conn.execute(
                "SELECT entity_id FROM nodes_fts WHERE nodes_fts MATCH ?",
                (match_expr,),
            ).fetchall()
            return [r[0] for r in rows]
        except Exception:
            # FTS5 MATCH can raise on unusual input — fall back gracefully.
            return []

    @staticmethod
    def _sanitize_fts5_token(word: str) -> str:
        """Strip FTS5 special characters from a single token."""
        import re
        return re.sub(r'[()":*^{}]', "", word).strip()

    def search_passages_fts(self, query: str, top_k: int = 10) -> list[str]:
        """Return passage_ids matching *query* via the ``passages_fts`` FTS5 index.

        Accepts either a raw query string (tokenised into OR-joined words) or
        a pre-formatted FTS5 expression from ``_expand_query_for_fts()``
        (already contains quoted phrases and OR operators).

        Returns up to *top_k* passage IDs ranked by BM25 relevance.
        Falls back to an empty list on FTS5 errors.
        """
        if not query or not query.strip():
            return []
        self._warn_bulk_query_once("search_passages_fts")

        # Detect pre-formatted FTS5 query (from _expand_query_for_fts)
        if " OR " in query:
            # Already formatted with OR operators and quoted phrases.
            # Validate: strip any stray FTS5 operators that leaked through.
            match_expr = query
        else:
            # Raw query: tokenise and wrap each word for safe FTS5 matching.
            words = query.strip().split()
            if not words:
                return []
            sanitized = [self._sanitize_fts5_token(w) for w in words]
            sanitized = [w for w in sanitized if w]
            if not sanitized:
                return []
            match_expr = " OR ".join(f'"{w}"' for w in sanitized)

        try:
            rows = self._conn.execute(
                "SELECT passage_id FROM passages_fts WHERE passages_fts MATCH ? "
                "ORDER BY rank LIMIT ?",
                (match_expr, top_k),
            ).fetchall()
            return [r[0] for r in rows]
        except Exception:
            return []

    # -- Vector search --------------------------------------------------------

    def vector_search(
        self, query_embedding: np.ndarray, top_k: int = 5
    ) -> list[tuple[str, float]]:
        """Cosine similarity search via sqlite-vec vec_distance_cosine."""
        self._warn_bulk_query_once("vector_search")
        if not self._known_ids:
            return []

        q = np.asarray(query_embedding, dtype=np.float32)
        if np.linalg.norm(q) == 0:
            return []

        rows = self._conn.execute(
            """
            SELECT id, vec_distance_cosine(embedding, ?) AS dist
            FROM node_embeddings
            ORDER BY dist
            LIMIT ?
            """,
            (q.tobytes(), top_k),
        ).fetchall()

        # vec_distance_cosine returns [0, 2]; convert to similarity [1, -1]
        return [(entity_id, 1.0 - dist) for entity_id, dist in rows]

    def passage_vector_search(
        self, query_embedding: np.ndarray, top_k: int = 10
    ) -> list[tuple[str, float]]:
        """Cosine similarity search over passage embeddings (macro-graph search).

        Returns (passage_id, similarity) pairs sorted by similarity descending.
        Returns empty list if no passage embeddings exist (backward-compat).
        """
        self._warn_bulk_query_once("passage_vector_search")
        q = np.asarray(query_embedding, dtype=np.float32)
        if np.linalg.norm(q) == 0:
            return []

        rows = self._conn.execute(
            """
            SELECT id, vec_distance_cosine(embedding, ?) AS dist
            FROM passage_embeddings
            ORDER BY dist
            LIMIT ?
            """,
            (q.tobytes(), top_k),
        ).fetchall()

        # vec_distance_cosine returns [0, 2]; convert to similarity [1, -1]
        return [(passage_id, 1.0 - dist) for passage_id, dist in rows]

    def save_question_embeddings(
        self, passage_id: str, question_vectors: list[np.ndarray]
    ) -> None:
        """Store HyPE-lite anticipatory question embeddings for a passage.

        Each question is stored as ``{passage_id}__q{idx}`` in the
        question_embeddings vec0 table. The passage_id is recoverable by
        splitting on ``__q``.

        Idempotent: deletes any existing question embeddings for the passage
        before inserting new ones.
        """
        if not question_vectors:
            return

        # Delete existing question embeddings for this passage (idempotent).
        # vec0 doesn't support LIKE, so we can't bulk-delete by prefix.
        # Delete up to max(new_count, 20) individual IDs — enough to cover any
        # previously stored set without the magic +50 over-delete.
        c = self._conn
        max_old = max(len(question_vectors), 20)
        for idx in range(max_old):
            qid = f"{passage_id}__q{idx}"
            c.execute("DELETE FROM question_embeddings WHERE id = ?", (qid,))

        for idx, vec in enumerate(question_vectors):
            qid = f"{passage_id}__q{idx}"
            emb_bytes = np.asarray(vec, dtype=np.float32).tobytes()
            c.execute(
                "INSERT INTO question_embeddings(id, embedding) VALUES (?, ?)",
                (qid, emb_bytes),
            )

        if not self._in_batch:
            self._conn.commit()

    def save_question_embeddings_bulk(
        self, passage_id: str, question_vectors: list[np.ndarray]
    ) -> None:
        """Bulk-optimized alias of save_question_embeddings()."""
        if not question_vectors:
            return
        c = self._conn
        max_old = max(len(question_vectors), 20)
        delete_rows = [(f"{passage_id}__q{idx}",) for idx in range(max_old)]
        c.executemany("DELETE FROM question_embeddings WHERE id = ?", delete_rows)

        insert_rows: list[tuple[str, bytes]] = []
        for idx, vec in enumerate(question_vectors):
            qid = f"{passage_id}__q{idx}"
            emb_bytes = np.asarray(vec, dtype=np.float32).tobytes()
            insert_rows.append((qid, emb_bytes))
        c.executemany(
            "INSERT INTO question_embeddings(id, embedding) VALUES (?, ?)",
            insert_rows,
        )

        if not self._in_batch:
            self._conn.commit()

    def question_vector_search(
        self, query_embedding: np.ndarray, top_k: int = 10
    ) -> list[tuple[str, float]]:
        """Find passages via HyPE-lite question-embedding similarity.

        Returns deduplicated (passage_id, max_similarity) pairs, sorted by
        similarity descending. Multiple question embeddings may map to the same
        passage; the highest similarity wins.
        """
        q = np.asarray(query_embedding, dtype=np.float32)
        if np.linalg.norm(q) == 0:
            return []

        # Fetch more candidates than top_k because many may map to the same passage
        rows = self._conn.execute(
            """
            SELECT id, vec_distance_cosine(embedding, ?) AS dist
            FROM question_embeddings
            ORDER BY dist
            LIMIT ?
            """,
            (q.tobytes(), top_k * 5),
        ).fetchall()

        # Aggregate: max similarity per passage_id
        best: dict[str, float] = {}
        for qid, dist in rows:
            passage_id = qid.rsplit("__q", 1)[0]
            sim = 1.0 - dist
            if sim > best.get(passage_id, -999.0):
                best[passage_id] = sim

        # Return sorted by similarity descending, capped at top_k
        return sorted(best.items(), key=lambda x: x[1], reverse=True)[:top_k]

    # -- Sentence embeddings (fine-grained macro retrieval) --------------------

    def save_sentence_embeddings_bulk(
        self, passage_id: str, sentence_vectors: list[np.ndarray]
    ) -> None:
        """Store per-sentence embeddings for a passage.

        ID convention: ``{passage_id}__s{idx}`` — mirrors HyPE question pattern.
        Idempotent: deletes old sentence embeddings before inserting new ones.
        """
        if not sentence_vectors:
            return
        c = self._conn
        max_old = max(len(sentence_vectors), 20)
        delete_rows = [(f"{passage_id}__s{idx}",) for idx in range(max_old)]
        c.executemany("DELETE FROM sentence_embeddings WHERE id = ?", delete_rows)
        c.executemany(
            "DELETE FROM sentence_embedding_store WHERE id = ?", delete_rows
        )

        insert_vec0: list[tuple[str, bytes]] = []
        insert_store: list[tuple[str, bytes]] = []
        for idx, vec in enumerate(sentence_vectors):
            sid = f"{passage_id}__s{idx}"
            emb_bytes = np.asarray(vec, dtype=np.float32).tobytes()
            insert_vec0.append((sid, emb_bytes))
            insert_store.append((sid, emb_bytes))
        c.executemany(
            "INSERT INTO sentence_embeddings(id, embedding) VALUES (?, ?)",
            insert_vec0,
        )
        c.executemany(
            "INSERT INTO sentence_embedding_store(id, embedding) VALUES (?, ?)",
            insert_store,
        )

        if not self._in_batch:
            self._conn.commit()

    def sentence_vector_search(
        self, query_embedding: np.ndarray, top_k: int = 10
    ) -> list[tuple[str, float]]:
        """Find passages via sentence-embedding similarity.

        Returns deduplicated (passage_id, max_similarity) pairs, sorted by
        similarity descending.  Multiple sentence embeddings map to the same
        passage; the highest similarity wins — same aggregation as HyPE
        question_vector_search().
        """
        q = np.asarray(query_embedding, dtype=np.float32)
        if np.linalg.norm(q) == 0:
            return []

        # Fetch more candidates than top_k because many map to the same passage
        rows = self._conn.execute(
            """
            SELECT id, vec_distance_cosine(embedding, ?) AS dist
            FROM sentence_embeddings
            ORDER BY dist
            LIMIT ?
            """,
            (q.tobytes(), top_k * 5),
        ).fetchall()

        # Aggregate: max similarity per passage_id
        best: dict[str, float] = {}
        for sid, dist in rows:
            passage_id = sid.rsplit("__s", 1)[0]
            sim = 1.0 - dist
            if sim > best.get(passage_id, -999.0):
                best[passage_id] = sim

        # Return sorted by similarity descending, capped at top_k
        return sorted(best.items(), key=lambda x: x[1], reverse=True)[:top_k]

    def sentence_vector_search_detailed(
        self, query_embedding: np.ndarray, top_k: int = 10
    ) -> list[tuple[str, int, float]]:
        """Return sentence-level hits as (passage_id, sentence_idx, similarity)."""
        q = np.asarray(query_embedding, dtype=np.float32)
        if np.linalg.norm(q) == 0:
            return []

        rows = self._conn.execute(
            """
            SELECT id, vec_distance_cosine(embedding, ?) AS dist
            FROM sentence_embeddings
            ORDER BY dist
            LIMIT ?
            """,
            (q.tobytes(), top_k * 5),
        ).fetchall()

        detailed: list[tuple[str, int, float]] = []
        for sid, dist in rows:
            passage_id, sep, suffix = sid.rpartition("__s")
            if not sep:
                continue
            try:
                sentence_idx = int(suffix)
            except ValueError:
                continue
            detailed.append((passage_id, sentence_idx, 1.0 - dist))
        return detailed[:top_k]

    # -- Sentence profile cache (fiber-basis precomputation) ------------------

    def save_sentence_profiles_bulk(
        self,
        passage_id: str,
        profiles: list[tuple[str, int, list[str], list[str], list[str]]],
    ) -> None:
        """Store per-sentence NER/POS/lemma profiles for a passage.

        Each profile tuple: (sentence_hash, sentence_idx, ent_labels, pos_tags, lemmas).
        Idempotent: deletes old profiles for the passage before inserting.
        """
        if not profiles:
            return
        c = self._conn
        c.execute(
            "DELETE FROM sentence_profiles WHERE passage_id = ?", (passage_id,)
        )
        c.executemany(
            "INSERT OR REPLACE INTO sentence_profiles "
            "(sentence_hash, passage_id, sentence_idx, ent_labels, pos_tags, lemmas) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            [
                (h, passage_id, idx, json.dumps(ents), json.dumps(pos), json.dumps(lem))
                for h, idx, ents, pos, lem in profiles
            ],
        )
        if not self._in_batch:
            self._conn.commit()

    def get_sentence_profiles_batch(
        self, sentence_hashes: list[str]
    ) -> dict[str, tuple[list[str], list[str], list[str]]]:
        """Batch-lookup cached sentence profiles by hash.

        Returns {sentence_hash: (ent_labels, pos_tags, lemmas)} for each hit.
        """
        if not sentence_hashes:
            return {}
        result: dict[str, tuple[list[str], list[str], list[str]]] = {}
        rows = self._batch_in_query(
            "SELECT sentence_hash, ent_labels, pos_tags, lemmas "
            "FROM sentence_profiles WHERE sentence_hash IN ({placeholders})",
            sentence_hashes,
        )
        for h, ents_json, pos_json, lem_json in rows:
            result[h] = (
                json.loads(ents_json),
                json.loads(pos_json),
                json.loads(lem_json),
            )
        return result

    def get_passages_without_profiles(self) -> list[tuple[str, str]]:
        """Return (passage_id, raw_text) for passages with no cached profiles.

        Used by the janitor backfill task.
        """
        return self._conn.execute(
            "SELECT p.passage_id, p.raw_text FROM passages p "
            "LEFT JOIN sentence_profiles sp ON p.passage_id = sp.passage_id "
            "WHERE sp.passage_id IS NULL"
        ).fetchall()

    # -- Passage storage -------------------------------------------------------

    def upsert_passage(self, passage: SourcePassage) -> None:
        has_source_id = self._has_column("passages", "source_id")
        existing_row = self._conn.execute(
            "SELECT source_id FROM passages WHERE passage_id = ?"
            if has_source_id
            else "SELECT 1 FROM passages WHERE passage_id = ?",
            (passage.passage_id,),
        ).fetchone()
        already_exists = existing_row is not None
        existing_source_id = existing_row[0] if existing_row and has_source_id else ""
        source_id = passage.source_id or ""

        if self._has_column("passages", "asset_id"):
            self._conn.execute(
                """
                INSERT INTO passages (passage_id, raw_text, source_id, source_label,
                                      entity_ids, ingested_at, temporal_min, temporal_max,
                                      asset_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(passage_id) DO UPDATE SET
                    raw_text     = excluded.raw_text,
                    source_id    = COALESCE(NULLIF(excluded.source_id, ''), passages.source_id),
                    source_label = excluded.source_label,
                    entity_ids   = excluded.entity_ids,
                    ingested_at  = excluded.ingested_at,
                    temporal_min = excluded.temporal_min,
                    temporal_max = excluded.temporal_max,
                    asset_id     = COALESCE(excluded.asset_id, passages.asset_id)
                """,
                (
                    passage.passage_id, passage.raw_text, source_id, passage.source_label,
                    json.dumps(passage.entity_ids), passage.ingested_at,
                    passage.temporal_min, passage.temporal_max, passage.asset_id,
                ),
            )
        else:
            self._conn.execute(
                """
                INSERT INTO passages (passage_id, raw_text, source_id, source_label,
                                      entity_ids, ingested_at, temporal_min, temporal_max)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(passage_id) DO UPDATE SET
                    raw_text     = excluded.raw_text,
                    source_id    = COALESCE(NULLIF(excluded.source_id, ''), passages.source_id),
                    source_label = excluded.source_label,
                    entity_ids   = excluded.entity_ids,
                    ingested_at  = excluded.ingested_at,
                    temporal_min = excluded.temporal_min,
                    temporal_max = excluded.temporal_max
                """,
                (
                    passage.passage_id, passage.raw_text, source_id, passage.source_label,
                    json.dumps(passage.entity_ids), passage.ingested_at,
                    passage.temporal_min, passage.temporal_max,
                ),
            )

        # Maintain passage_entities junction table
        if already_exists:
            self._conn.execute(
                "DELETE FROM passage_entities WHERE passage_id = ?",
                (passage.passage_id,),
            )
        if passage.entity_ids:
            self._conn.executemany(
                "INSERT OR IGNORE INTO passage_entities (passage_id, entity_id) "
                "VALUES (?, ?)",
                [(passage.passage_id, eid) for eid in passage.entity_ids if eid],
            )

        effective_source_id = source_id or existing_source_id or ""
        if effective_source_id:
            self._conn.execute(
                "DELETE FROM node_provenance WHERE passage_id = ?",
                (passage.passage_id,),
            )
            rows = [
                (eid, effective_source_id, passage.passage_id)
                for eid in passage.entity_ids
                if eid
            ]
            if rows:
                self._conn.executemany(
                    "INSERT OR IGNORE INTO node_provenance "
                    "(node_id, source_id, passage_id) VALUES (?, ?, ?)",
                    rows,
                )

        # Persist passage embedding in canonical store (source of truth for vec0 rebuilds).
        # INSERT OR REPLACE handles concurrent-session races (asyncio.gather in harness).
        if passage.embedding is not None:
            emb_bytes = np.asarray(passage.embedding, dtype=np.float32).tobytes()
            self._conn.execute(
                "INSERT OR REPLACE INTO passage_embedding_store(id, embedding) VALUES (?, ?)",
                (passage.passage_id, emb_bytes),
            )
        # Non-bulk mode keeps vec0 and FTS5 synchronized inline.
        if not self._bulk_mode:
            fts_row = self._conn.execute(
                "SELECT rowid FROM passages_fts WHERE passage_id = ?",
                (passage.passage_id,),
            ).fetchone()
            if fts_row:
                self._conn.execute("DELETE FROM passages_fts WHERE rowid = ?", (fts_row[0],))
            self._conn.execute(
                "INSERT INTO passages_fts(passage_id, raw_text, source_label) VALUES (?, ?, ?)",
                (passage.passage_id, passage.raw_text, passage.source_label),
            )
        # DELETE-then-INSERT for vec0 (no ON CONFLICT support). Unconditional
        # DELETE handles concurrent-session races from asyncio.gather.
        if not self._bulk_mode and passage.embedding is not None:
            self._conn.execute(
                "DELETE FROM passage_embeddings WHERE id = ?", (passage.passage_id,)
            )
            self._conn.execute(
                "INSERT INTO passage_embeddings(id, embedding) VALUES (?, ?)",
                (passage.passage_id, emb_bytes),
            )

        if not self._in_batch:
            self._conn.commit()

    def get_passage(self, passage_id: str) -> SourcePassage | None:
        asset_select = ", asset_id" if self._has_column("passages", "asset_id") else ""
        row = self._conn.execute(
            f"""
            SELECT passage_id, raw_text, source_id, source_label, entity_ids, ingested_at,
                   temporal_min, temporal_max{asset_select}
            FROM passages WHERE passage_id = ?
            """,
            (passage_id,),
        ).fetchone()
        if row is None:
            return None
        return SourcePassage(
            passage_id=row[0], raw_text=row[1], source_id=row[2] or None,
            source_label=row[3], entity_ids=json.loads(row[4]), ingested_at=row[5],
            temporal_min=row[6], temporal_max=row[7],
            asset_id=row[8] if len(row) > 8 else None,
        )

    def get_passages_raw_text_batch(self, passage_ids: list[str]) -> dict[str, str]:
        """Return {passage_id: raw_text} for a batch of IDs in one SQL query."""
        if not passage_ids:
            return {}
        rows = self._batch_in_query(
            "SELECT passage_id, raw_text FROM passages "
            "WHERE passage_id IN ({placeholders})",
            passage_ids,
        )
        return {r[0]: (r[1] or "") for r in rows}

    def get_passages_batch(self, passage_ids: list[str]) -> dict[str, SourcePassage]:
        """Return {passage_id: SourcePassage} for a batch of IDs in one SQL query.

        Eliminates N+1 queries when resolving multiple passage IDs on the
        query hot path.  Order is NOT preserved — callers that need ordered
        results must re-sort from the returned dict.
        """
        if not passage_ids:
            return {}
        asset_select = ", asset_id" if self._has_column("passages", "asset_id") else ""
        rows = self._batch_in_query(
            "SELECT passage_id, raw_text, source_id, source_label, entity_ids, "
            f"ingested_at, temporal_min, temporal_max{asset_select} "
            "FROM passages WHERE passage_id IN ({placeholders})",
            passage_ids,
        )
        return {
            r[0]: SourcePassage(
                passage_id=r[0], raw_text=r[1], source_id=r[2] or None,
                source_label=r[3], entity_ids=json.loads(r[4]), ingested_at=r[5],
                temporal_min=r[6], temporal_max=r[7],
                asset_id=r[8] if len(r) > 8 else None,
            )
            for r in rows
        }

    def count_passages_for_entity(self, entity_id: str) -> int:
        """Return count of passages containing *entity_id* (lightweight, no data load)."""
        row = self._conn.execute(
            "SELECT COUNT(*) FROM passage_entities WHERE entity_id = ?",
            (entity_id,),
        ).fetchone()
        return row[0] if row else 0

    def get_passage_ids_for_entity(self, entity_id: str) -> list[str]:
        """Return passage_ids containing *entity_id* (lightweight, no raw_text load)."""
        rows = self._conn.execute(
            "SELECT passage_id FROM passage_entities WHERE entity_id = ?",
            (entity_id,),
        ).fetchall()
        return [r[0] for r in rows]

    def get_similarity_passage_neighbors(
        self,
        passage_ids: list[str],
        *,
        limit_per_source: int = 3,
        weight: float = 0.35,
    ) -> dict[str, list[tuple[str, float, int]]]:
        """Read baked passage-level similarity neighbors from the sibling table."""
        if not passage_ids or limit_per_source <= 0:
            return {}
        if not self._table_exists("similarity_edges"):
            return {passage_id: [] for passage_id in passage_ids}
        rows = self._batch_in_query(
            "SELECT src_id, tgt_id, cosine, rank "
            "FROM similarity_edges "
            "WHERE rung = 'passage' AND src_id IN ({placeholders}) "
            "ORDER BY src_id, cosine DESC, rank, tgt_id",
            passage_ids,
            repeat_bindings=1,
        )
        grouped: dict[str, list[tuple[str, float, int]]] = {
            passage_id: [] for passage_id in passage_ids
        }
        for src_id, tgt_id, cosine, rank in rows:
            bucket = grouped.setdefault(str(src_id), [])
            if len(bucket) >= limit_per_source:
                continue
            bucket.append((str(tgt_id), float(cosine) * float(weight), int(rank)))
        return grouped

    def get_passages_for_entity(self, entity_id: str) -> list[SourcePassage]:
        """Return all passages containing *entity_id*.

        Uses the ``passage_entities`` junction table for O(1) indexed lookup
        instead of the old json_each() full-table scan.
        """
        asset_select = ", p.asset_id" if self._has_column("passages", "asset_id") else ""
        rows = self._conn.execute(
            f"""
            SELECT p.passage_id, p.raw_text, p.source_id, p.source_label, p.entity_ids,
                   p.ingested_at, p.temporal_min, p.temporal_max{asset_select}
            FROM passages p
            JOIN passage_entities pe ON p.passage_id = pe.passage_id
            WHERE pe.entity_id = ?
            """,
            (entity_id,),
        ).fetchall()
        return [
            SourcePassage(
                passage_id=r[0], raw_text=r[1], source_id=r[2] or None,
                source_label=r[3], entity_ids=json.loads(r[4]), ingested_at=r[5],
                temporal_min=r[6], temporal_max=r[7],
                asset_id=r[8] if len(r) > 8 else None,
            )
            for r in rows
        ]

    def get_passages_for_entities(
        self, entity_ids: set[str]
    ) -> dict[str, SourcePassage]:
        """Return all passages containing ANY of the given entity_ids.

        Uses the ``passage_entities`` junction table for indexed lookup.
        Returns a dict keyed by passage_id (deduplicated).
        """
        if not entity_ids:
            return {}
        asset_select = ", p.asset_id" if self._has_column("passages", "asset_id") else ""
        rows = self._batch_in_query(
            f"""
            SELECT DISTINCT p.passage_id, p.raw_text, p.source_id, p.source_label,
                   p.entity_ids, p.ingested_at, p.temporal_min, p.temporal_max{asset_select}
            FROM passages p
            JOIN passage_entities pe ON p.passage_id = pe.passage_id
            WHERE pe.entity_id IN ({{placeholders}})
            """,
            entity_ids,
        )
        return {
            r[0]: SourcePassage(
                passage_id=r[0], raw_text=r[1], source_id=r[2] or None,
                source_label=r[3], entity_ids=json.loads(r[4]), ingested_at=r[5],
                temporal_min=r[6], temporal_max=r[7],
                asset_id=r[8] if len(r) > 8 else None,
            )
            for r in rows
        }

    def get_all_passages(self) -> dict[str, SourcePassage]:
        asset_select = ", asset_id" if self._has_column("passages", "asset_id") else ""
        rows = self._conn.execute(
            "SELECT passage_id, raw_text, source_id, source_label, entity_ids, ingested_at,"
            f" temporal_min, temporal_max{asset_select} FROM passages"
        ).fetchall()
        return {
            r[0]: SourcePassage(
                passage_id=r[0], raw_text=r[1], source_id=r[2] or None,
                source_label=r[3], entity_ids=json.loads(r[4]), ingested_at=r[5],
                temporal_min=r[6], temporal_max=r[7],
                asset_id=r[8] if len(r) > 8 else None,
            )
            for r in rows
        }

    def get_passage_entity_map(self) -> dict[str, list[str]]:
        """Return {passage_id: [entity_ids]} — no raw_text loaded."""
        rows = self._conn.execute(
            "SELECT passage_id, entity_ids FROM passages"
        ).fetchall()
        result: dict[str, list[str]] = {}
        for passage_id, entity_ids_json in rows:
            result[passage_id] = json.loads(entity_ids_json) if entity_ids_json else []
        return result

    def get_asset_ids_for_passages(self, passage_ids: list[str]) -> dict[str, str | None]:
        """Return {passage_id: asset_id_or_none} for Asset-aware retrieval."""
        result = {pid: None for pid in passage_ids}
        if not passage_ids or not self._asset_schema_present():
            return result
        rows = self._batch_in_query(
            "SELECT passage_id, asset_id FROM passages "
            "WHERE passage_id IN ({placeholders})",
            passage_ids,
        )
        for passage_id, asset_id in rows:
            result[passage_id] = asset_id
        return result

    def get_passage_ids_for_assets(
        self,
        asset_ids: list[str],
        *,
        limit_per_asset: int = 3,
    ) -> dict[str, list[str]]:
        """Return sibling passage IDs for each Asset, ordered deterministically."""
        if not asset_ids or not self._asset_schema_present():
            return {}
        result: dict[str, list[str]] = {}
        limit = max(1, int(limit_per_asset))
        for asset_id in dict.fromkeys(asset_ids):
            rows = self._conn.execute(
                """
                SELECT passage_id
                FROM passages
                WHERE asset_id = ?
                ORDER BY passage_id
                LIMIT ?
                """,
                (asset_id, limit),
            ).fetchall()
            result[asset_id] = [row[0] for row in rows]
        return result

    def asset_count(self) -> int:
        """Return the number of materialized Asset rows, or zero before migration."""
        if not self._asset_schema_present():
            return 0
        row = self._conn.execute("SELECT COUNT(*) FROM assets").fetchone()
        return int(row[0]) if row else 0

    def asset_backfill_pending(self) -> bool:
        """True if any passage lacks an asset_id — the Asset overlay backfill is stale.

        Cheap staleness probe for the lazy on-query backfill
        (`[ASSET-OVERLAY-BACKFILL-WIRING]`): an `EXISTS`-style `LIMIT 1` scan, not a
        full count. Returns False when the Asset schema is absent (nothing to
        backfill) rather than raising, so the overlay degrades gracefully.
        """
        try:
            self._require_asset_schema()
        except Exception:
            return False
        row = self._conn.execute(
            "SELECT 1 FROM passages WHERE asset_id IS NULL LIMIT 1"
        ).fetchone()
        return row is not None

    def backfill_assets_by_source_document(self) -> dict[str, int]:
        """Materialize Phase 1 Assets by grouping passages on source document."""
        self._require_asset_schema()
        rows = self._conn.execute(
            """
            SELECT passage_id, raw_text, source_label, entity_ids
            FROM passages
            ORDER BY source_label, passage_id
            """
        ).fetchall()

        groups: dict[str, list[tuple[str, str, str, list[str]]]] = {}
        all_entity_ids: set[str] = set()
        for passage_id, raw_text, source_label, entity_ids_json in rows:
            group = self._asset_group_from_source_label(source_label)
            try:
                entity_ids = json.loads(entity_ids_json) if entity_ids_json else []
            except json.JSONDecodeError:
                entity_ids = []
            groups.setdefault(group, []).append(
                (passage_id, raw_text or "", source_label or "", entity_ids)
            )
            all_entity_ids.update(eid for eid in entity_ids if eid)

        valid_entity_ids = self._visible_node_ids(all_entity_ids)
        asset_rows_written = 0
        assets_reused = 0
        editions_advanced = 0
        passage_rows_updated = 0
        asset_entity_rows: list[tuple[str, str, int, float | None]] = []
        # One timestamp per backfill run so a transition's declared_at /
        # superseded_at / invalid_at agree exactly (same SQL datetime format).
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

        for group, passage_rows in groups.items():
            lineage_root = self._asset_id_for_group(group)
            content = "\n\n".join(raw_text for _, raw_text, _, _ in passage_rows)
            source_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
            salted_hash = hashlib.sha256(
                f"{group}\n{content}".encode("utf-8")
            ).hexdigest()
            byte_size = len(content.encode("utf-8"))
            title = group.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]

            # Edition resolution (supersession-unification 2026-06-10). Decision
            # rule: same group + identical source_hash => no-op reuse; same
            # group + different source_hash => NEW edition (edition_seq+1,
            # shared lineage, prior marked superseded); no prior => edition 1.
            prior = self._conn.execute(
                """
                SELECT asset_id, edition_seq, source_hash, declared_at
                FROM assets
                WHERE lineage_id = ?
                ORDER BY edition_seq DESC
                LIMIT 1
                """,
                (lineage_root,),
            ).fetchone()

            if prior is not None and prior[2] in (source_hash, salted_hash):
                # Identical content — reuse the current edition untouched
                # (prior[2] may be the salted form if edition 1 collided with a
                # cross-lineage duplicate at creation; both spellings are "same").
                effective_asset_id = prior[0]
                assets_reused += 1
            elif prior is None:
                effective_asset_id = lineage_root
                conflict = self._conn.execute(
                    "SELECT asset_id FROM assets WHERE source_hash = ?",
                    (source_hash,),
                ).fetchone()
                if conflict and conflict[0] != effective_asset_id:
                    source_hash = salted_hash
                self._conn.execute(
                    """
                    INSERT INTO assets (
                        asset_id, lineage_id, edition_seq, source_label, source_hash,
                        provenance_source_id, title, byte_size, declared_by,
                        declared_at, created_at, updated_at
                    )
                    VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'source_document_backfill',
                            ?, ?, ?)
                    ON CONFLICT(asset_id) DO UPDATE SET
                        lineage_id = excluded.lineage_id,
                        source_label = excluded.source_label,
                        source_hash = excluded.source_hash,
                        provenance_source_id = excluded.provenance_source_id,
                        title = excluded.title,
                        byte_size = excluded.byte_size,
                        updated_at = excluded.updated_at
                    """,
                    (
                        effective_asset_id, lineage_root, group, source_hash,
                        group, title, byte_size, now_iso, now_iso, now_iso,
                    ),
                )
                asset_rows_written += 1
            else:
                # Same lineage, changed content — advance the edition. The
                # claims of the superseded edition get their validity bounds
                # recorded BEFORE passages re-point below.
                effective_asset_id = advance_asset_edition(
                    self._conn,
                    lineage_id=lineage_root,
                    prior_asset_id=prior[0],
                    prior_edition_seq=int(prior[1]),
                    prior_declared_at=prior[3],
                    group=group,
                    source_hash=source_hash,
                    salted_hash=salted_hash,
                    title=title,
                    byte_size=byte_size,
                    declared_at=now_iso,
                )
                asset_rows_written += 1
                editions_advanced += 1

            passage_ids = [passage_id for passage_id, *_ in passage_rows]
            placeholders = ",".join("?" * len(passage_ids))
            cursor = self._conn.execute(
                f"UPDATE passages SET asset_id = ? WHERE passage_id IN ({placeholders})",
                (effective_asset_id, *passage_ids),
            )
            passage_rows_updated += max(cursor.rowcount, 0)

            entity_counts: dict[str, int] = {}
            first_positions: dict[str, float] = {}
            denom = max(len(passage_rows) - 1, 1)
            for idx, (_passage_id, _raw_text, _source_label, entity_ids) in enumerate(
                passage_rows
            ):
                position = idx / denom
                for entity_id in entity_ids:
                    if entity_id not in valid_entity_ids:
                        continue
                    entity_counts[entity_id] = entity_counts.get(entity_id, 0) + 1
                    first_positions.setdefault(entity_id, position)
            for entity_id, mention_count in entity_counts.items():
                asset_entity_rows.append(
                    (effective_asset_id, entity_id, mention_count,
                     first_positions.get(entity_id))
                )

        self._conn.execute("DELETE FROM asset_entities")
        if asset_entity_rows:
            self._conn.executemany(
                """
                INSERT OR REPLACE INTO asset_entities (
                    asset_id, entity_id, mention_count, section_position
                )
                VALUES (?, ?, ?, ?)
                """,
                asset_entity_rows,
            )

        self._conn.execute("DELETE FROM edge_provenance")
        self._conn.execute("""
            INSERT OR IGNORE INTO edge_provenance (
                source, target, relation, asset_id, evidence_passage_id, confidence
            )
            SELECT
                e.source,
                e.target,
                e.relation,
                ae_source.asset_id,
                (
                    SELECT p.passage_id
                    FROM passages p
                    JOIN passage_entities pe ON p.passage_id = pe.passage_id
                    WHERE p.asset_id = ae_source.asset_id
                      AND pe.entity_id IN (e.source, e.target)
                    ORDER BY p.passage_id
                    LIMIT 1
                ) AS evidence_passage_id,
                1.0
            FROM edges e
            JOIN asset_entities ae_source
              ON ae_source.entity_id = e.source
            JOIN asset_entities ae_target
              ON ae_target.entity_id = e.target
             AND ae_target.asset_id = ae_source.asset_id
        """)

        if not self._in_batch:
            self._conn.commit()
        edge_provenance_count = self._conn.execute(
            "SELECT COUNT(*) FROM edge_provenance"
        ).fetchone()[0]

        return {
            "assets": asset_rows_written,
            "assets_reused": assets_reused,
            "editions_advanced": editions_advanced,
            "passages_updated": passage_rows_updated,
            "asset_entities": len(asset_entity_rows),
            "edge_provenance": int(edge_provenance_count),
        }

    # -- Schema versioning ----------------------------------------------------

    def get_schema_version(self) -> str:
        """Return the schema version string.

        Pre-meta-table graphs (created before schema versioning was added)
        return "1" — the meta table simply doesn't exist yet.
        """
        try:
            row = self._conn.execute(
                "SELECT value FROM meta WHERE key = 'schema_version'"
            ).fetchone()
            return row[0] if row else "1"
        except Exception:
            # meta table doesn't exist at all → pre-versioning graph
            return "1"

    # -- Diagnostics ----------------------------------------------------------

    def health_check(self) -> dict:
        """Return a health/integrity report for the graph database."""
        # Health is latency-sensitive and async-reachable. Read it through a
        # short-lived connection so long graph work on the engine connection
        # cannot serialize /health behind it.
        cached_connected_components: int | None = None
        if self._graph_cache and self._graph_cache.number_of_nodes() > 0:
            cached_connected_components = nx.number_connected_components(self._graph_cache)
        return collect_sqlite_health(
            self._path,
            cached_connected_components=cached_connected_components,
        )

    # -- Persistence ----------------------------------------------------------

    def save(self, path: str | Path) -> None:
        """Commit and optionally export to a different path.

        Uses VACUUM INTO so the copy is fully checkpointed — safe with WAL mode.
        """
        self._conn.commit()
        target = Path(path)
        if target.resolve() != self._path.resolve():
            self._conn.execute(f"VACUUM INTO '{target!s}'")

    def load(self, path: str | Path) -> None:
        """Open a different SQLite file, replacing current state."""
        source = Path(path)
        if self._conn is not None:
            self._conn.close()
            self._conn = None
        if source.resolve() != self._path.resolve():
            shutil.copy2(str(source), str(self._path))
        self._open_or_create()

    def close(self) -> None:
        """Commit, optimize, and close the database connection."""
        if self._conn is not None:
            # SQL-H1: PRAGMA optimize analyzes query patterns and updates
            # statistics for the planner. Safe, fast (~1ms), idempotent.
            try:
                self._conn.execute("PRAGMA optimize")
            except Exception:
                pass  # non-critical; don't let it block shutdown
            self._conn.commit()
            self._conn.close()
            self._conn = None

    def __del__(self) -> None:
        self.close()


def advance_asset_edition(
    conn: sqlite3.Connection,
    *,
    lineage_id: str,
    prior_asset_id: str,
    prior_edition_seq: int,
    prior_declared_at: str | None,
    group: str,
    source_hash: str,
    salted_hash: str,
    title: str,
    byte_size: int,
    declared_at: str,
) -> str:
    """Create edition N+1 for a lineage whose content changed; mark N superseded.

    The asset-edition transition writer (supersession-unification 2026-06-10;
    INV-5 ``asset_edition_seq`` dormancy closed here). Module-level — not a
    method — so the dormancy probe's static caller scan sees the bare-call
    production caller in ``backfill_assets_by_source_document``.

    In one transaction-scoped sequence:
    1. INSERT the new edition row (``edition_seq = prior+1``, same
       ``lineage_id``, fresh ``declared_at``); deterministic id
       ``{lineage_id}-e{N}`` so re-runs are idempotent.
    2. Record validity bounds for the superseded edition's claims (its
       passages, looked up BEFORE the caller re-points them): ``valid_at`` =
       prior ``declared_at``, ``invalid_at`` = new ``declared_at``.
    3. Mark the prior row superseded (``superseded_by`` / ``superseded_at``) —
       marks, never rewrites (Layer-1 immutability).

    Returns the new edition's asset_id. Commit/rollback is owned by the caller
    (the backfill), so a persist failure leaves no half-transition behind.
    """
    from tp_vrg.claim_validity import record_supersession

    new_seq = prior_edition_seq + 1
    new_asset_id = f"{lineage_id}-e{new_seq}"

    # Cross-lineage duplicate-content guard (same salt convention as edition 1):
    # idx_assets_hash is UNIQUE, and a revert-to-an-older-edition's-content
    # (A -> B -> A) legitimately collides with this lineage's own earlier row.
    conflict = conn.execute(
        "SELECT asset_id FROM assets WHERE source_hash = ?",
        (source_hash,),
    ).fetchone()
    if conflict and conflict[0] != new_asset_id:
        source_hash = salted_hash

    conn.execute(
        """
        INSERT INTO assets (
            asset_id, lineage_id, edition_seq, source_label, source_hash,
            provenance_source_id, title, byte_size, declared_by,
            declared_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'source_document_backfill', ?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET
            source_hash = excluded.source_hash,
            title = excluded.title,
            byte_size = excluded.byte_size,
            updated_at = excluded.updated_at
        """,
        (
            new_asset_id, lineage_id, new_seq, group, source_hash,
            group, title, byte_size, declared_at, declared_at, declared_at,
        ),
    )

    old_claim_ids = [
        row[0]
        for row in conn.execute(
            "SELECT passage_id FROM passages WHERE asset_id = ? ORDER BY passage_id",
            (prior_asset_id,),
        )
    ]
    record_supersession(
        conn,
        lineage_id=lineage_id,
        superseded_asset_id=prior_asset_id,
        superseded_edition_seq=prior_edition_seq,
        superseding_asset_id=new_asset_id,
        claim_ids=old_claim_ids,
        valid_at=prior_declared_at,
        invalid_at=declared_at,
    )

    conn.execute(
        """
        UPDATE assets
        SET superseded_by = ?, superseded_at = ?, updated_at = ?
        WHERE asset_id = ?
        """,
        (new_asset_id, declared_at, declared_at, prior_asset_id),
    )
    return new_asset_id
