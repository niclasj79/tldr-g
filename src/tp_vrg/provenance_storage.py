"""ProvenanceBackend — user-facing audit trail (F16).

Stores a narrow, read-friendly record of:
  - sources          — what was ingested (source_id, label, content hash, size)
  - source_segments  — the individual text segments from each source
  - answers          — every rendered query response (query text + timestamp)
  - answer_citations — which segments contributed to each answer

The schema is deliberately disjoint from graph.db's internal schema. A user
or customer running `sqlite3 provenance.db ".schema"` sees only these five
tables (plus provenance_meta for versioning). No LOD columns, no backbone,
no embeddings, no stitching edges, no FTS indices.

The `segment_id` column in `source_segments` uses the same ID as the
corresponding `passage_id` in graph.db — they are deterministic content
hashes, so the IDs match by construction and no mapping table is needed.

`answer_citations.segment_id` deliberately has NO foreign key constraint
(see plan decision D9). Pre-F16 citations or re-ingestion edge cases may
leave orphaned references; explain queries LEFT JOIN and surface them as
`source_label=None` for graceful degradation.

The `answers` table has a nullable `user_id` column provisioned for a
future multi-user account backend. Current single-user installs leave it
NULL.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

__all__ = ["ProvenanceBackend"]


_SCHEMA_VERSION = "1"


class ProvenanceBackend:
    """SQLite-backed provenance store (F16)."""

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)
        self._conn: sqlite3.Connection | None = None
        self._in_batch = False
        self._open_or_create()

    # ------------------------------------------------------------------ open

    def _open_or_create(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self._path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        # WAL mode so concurrent readers don't block writers (see plan G8)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._init_schema()
        self._migrate_schema()

    def _init_schema(self) -> None:
        assert self._conn is not None
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sources (
                source_id    TEXT PRIMARY KEY,
                source_label TEXT NOT NULL,
                source_uri   TEXT DEFAULT '',
                source_type  TEXT DEFAULT '',
                imported_at  TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                byte_size    INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_sources_label ON sources(source_label);

            CREATE TABLE IF NOT EXISTS source_segments (
                segment_id TEXT PRIMARY KEY,
                source_id  TEXT NOT NULL REFERENCES sources(source_id),
                seq        INTEGER NOT NULL,
                text       TEXT NOT NULL,
                char_start INTEGER,
                char_end   INTEGER,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_segments_source ON source_segments(source_id);

            CREATE TABLE IF NOT EXISTS answers (
                answer_id   TEXT PRIMARY KEY,
                query_text  TEXT NOT NULL,
                answered_at TEXT NOT NULL,
                model_label TEXT DEFAULT '',
                user_id     TEXT DEFAULT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_answers_user ON answers(user_id);

            CREATE TABLE IF NOT EXISTS answer_citations (
                answer_id        TEXT NOT NULL REFERENCES answers(answer_id),
                segment_id       TEXT NOT NULL,  -- intentional: no FK (plan D9)
                cite_order       INTEGER NOT NULL,
                evidence_snippet TEXT DEFAULT '',
                PRIMARY KEY (answer_id, segment_id, cite_order)
            );
            CREATE INDEX IF NOT EXISTS idx_citations_segment ON answer_citations(segment_id);

            CREATE TABLE IF NOT EXISTS provenance_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        self._conn.execute(
            "INSERT OR IGNORE INTO provenance_meta (key, value) VALUES (?, ?)",
            ("schema_version", _SCHEMA_VERSION),
        )
        if not self._in_batch:
            self._conn.commit()

    def _migrate_schema(self) -> None:
        """Future schema migrations go here. Currently a no-op (version 1)."""
        # Reserved for F16.x follow-ups. Pattern: read current version, apply
        # ALTER TABLE migrations in order, bump the version in provenance_meta.
        pass

    # ------------------------------------------------------------ ingestion

    def upsert_source(
        self,
        source_id: str,
        source_label: str,
        content_hash: str,
        source_uri: str = "",
        source_type: str = "",
        byte_size: int = 0,
    ) -> None:
        """Insert or update a source row. Idempotent on `source_id`."""
        assert self._conn is not None
        now = datetime.now(timezone.utc).isoformat()
        self._conn.execute(
            """
            INSERT INTO sources
                (source_id, source_label, source_uri, source_type, imported_at,
                 content_hash, byte_size)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id) DO UPDATE SET
                source_label = excluded.source_label,
                source_uri   = excluded.source_uri,
                source_type  = excluded.source_type,
                content_hash = excluded.content_hash,
                byte_size    = excluded.byte_size
            """,
            (source_id, source_label, source_uri, source_type, now, content_hash, byte_size),
        )
        if not self._in_batch:
            self._conn.commit()

    def upsert_segment(
        self,
        segment_id: str,
        source_id: str,
        seq: int,
        text: str,
        char_start: int | None = None,
        char_end: int | None = None,
    ) -> None:
        """Insert or update a source segment. Idempotent on `segment_id`."""
        assert self._conn is not None
        now = datetime.now(timezone.utc).isoformat()
        self._conn.execute(
            """
            INSERT INTO source_segments
                (segment_id, source_id, seq, text, char_start, char_end, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(segment_id) DO UPDATE SET
                source_id  = excluded.source_id,
                seq        = excluded.seq,
                text       = excluded.text,
                char_start = excluded.char_start,
                char_end   = excluded.char_end
            """,
            (segment_id, source_id, seq, text, char_start, char_end, now),
        )
        if not self._in_batch:
            self._conn.commit()

    # ----------------------------------------------------------------- query

    def record_answer(
        self,
        answer_id: str,
        query_text: str,
        model_label: str = "tp-vrg",
        user_id: str | None = None,
    ) -> None:
        """Record a single answer event. Call once per query rendered."""
        assert self._conn is not None
        now = datetime.now(timezone.utc).isoformat()
        self._conn.execute(
            """
            INSERT INTO answers
                (answer_id, query_text, answered_at, model_label, user_id)
            VALUES (?, ?, ?, ?, ?)
            """,
            (answer_id, query_text, now, model_label, user_id),
        )
        if not self._in_batch:
            self._conn.commit()

    def record_citations(
        self,
        answer_id: str,
        citations: list[tuple[str, int, str]],
    ) -> None:
        """Record citations for a previously-recorded answer.

        `citations` is a list of (segment_id, cite_order, evidence_snippet)
        tuples. `evidence_snippet` may be empty in F16.
        """
        assert self._conn is not None
        if not citations:
            return
        self._conn.executemany(
            """
            INSERT INTO answer_citations
                (answer_id, segment_id, cite_order, evidence_snippet)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(answer_id, segment_id, cite_order) DO UPDATE SET
                evidence_snippet = excluded.evidence_snippet
            """,
            [(answer_id, seg_id, order, snippet) for seg_id, order, snippet in citations],
        )
        if not self._in_batch:
            self._conn.commit()

    # ----------------------------------------------------------------- read

    def get_answer(self, answer_id: str) -> dict[str, Any] | None:
        """Return the raw answer row, or None if missing."""
        assert self._conn is not None
        row = self._conn.execute(
            "SELECT answer_id, query_text, answered_at, model_label, user_id "
            "FROM answers WHERE answer_id = ?",
            (answer_id,),
        ).fetchone()
        if row is None:
            return None
        return dict(row)

    def get_citations_for_answer(self, answer_id: str) -> list[dict[str, Any]]:
        """Return the citation rows joined with segment + source data.

        LEFT JOIN on source_segments so that orphaned citations (segment_id
        that was never written to source_segments) still appear, with
        `source_label=None` and `text=None`. This handles pre-F16 content
        gracefully.
        """
        assert self._conn is not None
        rows = self._conn.execute(
            """
            SELECT
                ac.cite_order         AS cite_order,
                ac.segment_id         AS segment_id,
                ac.evidence_snippet   AS evidence_snippet,
                s.text                AS text,
                s.seq                 AS seq,
                src.source_label      AS source_label,
                src.source_uri        AS source_uri
            FROM answer_citations ac
            LEFT JOIN source_segments s ON s.segment_id = ac.segment_id
            LEFT JOIN sources src       ON src.source_id = s.source_id
            WHERE ac.answer_id = ?
            ORDER BY ac.cite_order
            """,
            (answer_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    # ----------------------------------------- reading-order fiber (F16+)

    def get_segment_context(
        self,
        passage_id: str,
        window: int = 1,
    ) -> list[dict[str, Any]]:
        """Return the passage's segment and its seq-neighbors from the same source.

        Uses passage_id == segment_id convention (F16 plan D9).
        One query finds the source_id + seq, a second fetches the window.
        Returns list of dicts with keys: segment_id, source_id, seq, text.
        Ordered by seq ascending. Empty list if passage_id has no segment.
        """
        assert self._conn is not None
        # Step 1: find this segment's source_id and seq
        anchor = self._conn.execute(
            "SELECT source_id, seq FROM source_segments WHERE segment_id = ?",
            (passage_id,),
        ).fetchone()
        if anchor is None:
            return []
        source_id, seq = anchor["source_id"], anchor["seq"]

        # Step 2: fetch the window
        rows = self._conn.execute(
            """
            SELECT segment_id, source_id, seq, text
            FROM source_segments
            WHERE source_id = ? AND seq BETWEEN ? AND ?
            ORDER BY seq
            """,
            (source_id, seq - window, seq + window),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_segments_for_source(
        self,
        source_id: str,
    ) -> list[dict[str, Any]]:
        """Return all segments for a source, ordered by seq.

        Used for document-scope queries ("summarize this entire document").
        """
        assert self._conn is not None
        rows = self._conn.execute(
            """
            SELECT segment_id, source_id, seq, text
            FROM source_segments
            WHERE source_id = ?
            ORDER BY seq
            """,
            (source_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def find_segment_by_heading(
        self,
        source_id: str,
        heading_text: str,
    ) -> dict[str, Any] | None:
        """Find the segment that contains a section heading matching heading_text.

        Used for section-reference resolution: when the rendered context
        mentions "Schedule A" or "Exhibit B", find the segment that IS
        that section heading within the same source document.

        Prioritizes bold headings (**Schedule A**) and standalone headings
        (# Schedule A) over inline mentions. Falls back to the LAST match
        by seq (section headings tend to appear after inline references).
        """
        assert self._conn is not None
        # Skip session-level passages (seq=0) — they contain the full document
        # text and will match any heading. We want the CHUNK that contains
        # the heading, not the full-text passage.
        seq_filter = "AND seq > 0"

        # First try: bold heading (**heading_text**)
        rows = self._conn.execute(
            f"""
            SELECT segment_id, source_id, seq, text
            FROM source_segments
            WHERE source_id = ? AND text LIKE ? {seq_filter}
            ORDER BY seq DESC
            LIMIT 1
            """,
            (source_id, f"%**{heading_text}**%"),
        ).fetchall()
        if rows:
            return dict(rows[0])

        # Second try: markdown heading (# heading_text)
        rows = self._conn.execute(
            f"""
            SELECT segment_id, source_id, seq, text
            FROM source_segments
            WHERE source_id = ? AND text LIKE ? {seq_filter}
            ORDER BY seq DESC
            LIMIT 1
            """,
            (source_id, f"%# {heading_text}%"),
        ).fetchall()
        if rows:
            return dict(rows[0])

        # Fallback: last mention by seq (section headings come after references)
        rows = self._conn.execute(
            f"""
            SELECT segment_id, source_id, seq, text
            FROM source_segments
            WHERE source_id = ? AND text LIKE ? {seq_filter}
            ORDER BY seq DESC
            LIMIT 1
            """,
            (source_id, f"%{heading_text}%"),
        ).fetchall()
        if not rows:
            return None
        return dict(rows[0])

    def get_source_id_for_segment(
        self,
        segment_id: str,
    ) -> str | None:
        """Return the source_id for a given segment_id, or None."""
        assert self._conn is not None
        row = self._conn.execute(
            "SELECT source_id FROM source_segments WHERE segment_id = ?",
            (segment_id,),
        ).fetchone()
        return row["source_id"] if row else None

    def source_exists(self, source_id: str) -> bool:
        """Return True if the provenance store has a source row."""
        assert self._conn is not None
        row = self._conn.execute(
            "SELECT 1 FROM sources WHERE source_id = ?",
            (source_id,),
        ).fetchone()
        return row is not None

    def delete_source_cascade(self, source_id: str) -> dict[str, int]:
        """Delete a source, its segments, and citations to those segments.

        If the caller already opened a provenance batch, this method leaves
        commit/rollback to that caller. Otherwise it wraps itself in a batch.
        """
        assert self._conn is not None
        owns_batch = not self._in_batch
        if owns_batch:
            self.begin_batch()
        try:
            segment_rows = self._conn.execute(
                "SELECT segment_id FROM source_segments WHERE source_id = ?",
                (source_id,),
            ).fetchall()
            segment_ids = [row["segment_id"] for row in segment_rows]

            citations_removed = 0
            if segment_ids:
                for segment_id in segment_ids:
                    before = self._conn.total_changes
                    self._conn.execute(
                        "DELETE FROM answer_citations WHERE segment_id = ?",
                        (segment_id,),
                    )
                    citations_removed += self._conn.total_changes - before

            before = self._conn.total_changes
            self._conn.execute(
                "DELETE FROM source_segments WHERE source_id = ?",
                (source_id,),
            )
            segments_removed = self._conn.total_changes - before

            before = self._conn.total_changes
            self._conn.execute(
                "DELETE FROM sources WHERE source_id = ?",
                (source_id,),
            )
            sources_removed = self._conn.total_changes - before

            if owns_batch:
                self.commit_batch()
            return {
                "sources_removed": int(sources_removed),
                "segments_removed": int(segments_removed),
                "citations_removed": int(citations_removed),
            }
        except Exception:
            if owns_batch:
                self.rollback_batch()
            raise

    # ------------------------------------------------------- transactions

    def begin_batch(self) -> None:
        """Enter batch mode. All subsequent writes are deferred until commit_batch."""
        assert self._conn is not None
        self._in_batch = True
        self._conn.execute("BEGIN")

    def commit_batch(self) -> None:
        """Commit the current batch. Safe to call outside batch mode (no-op)."""
        assert self._conn is not None
        if self._in_batch:
            self._conn.commit()
            self._in_batch = False

    def rollback_batch(self) -> None:
        """Roll back the current batch. Safe to call outside batch mode (no-op)."""
        assert self._conn is not None
        if self._in_batch:
            self._conn.rollback()
            self._in_batch = False

    # ---------------------------------------------------------- management

    def clear_all(self) -> None:
        """Delete all rows from all tables. Used by tp_vrg_clear.

        Preserves the schema and the schema_version. Not transactional —
        call outside batch mode.
        """
        assert self._conn is not None
        was_in_batch = self._in_batch
        if was_in_batch:
            self.commit_batch()
        self._conn.executescript(
            """
            DELETE FROM answer_citations;
            DELETE FROM answers;
            DELETE FROM source_segments;
            DELETE FROM sources;
            """
        )
        self._conn.commit()

    def close(self) -> None:
        """Close the underlying SQLite connection. Idempotent."""
        if self._conn is not None:
            try:
                if self._in_batch:
                    self._conn.rollback()
            except sqlite3.Error:
                pass
            self._conn.close()
            self._conn = None
            self._in_batch = False

    def health_check(self) -> dict[str, Any]:
        """Return a small diagnostic summary for tp_vrg_health."""
        assert self._conn is not None
        counts: dict[str, int] = {}
        for table in ("sources", "source_segments", "answers", "answer_citations"):
            row = self._conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
            counts[table] = row[0] if row else 0
        version_row = self._conn.execute(
            "SELECT value FROM provenance_meta WHERE key = 'schema_version'"
        ).fetchone()
        integrity_row = self._conn.execute("PRAGMA integrity_check").fetchone()
        return {
            "sources": counts["sources"],
            "segments": counts["source_segments"],
            "answers": counts["answers"],
            "citations": counts["answer_citations"],
            "schema_version": version_row[0] if version_row else None,
            "integrity": integrity_row[0] if integrity_row else "unknown",
            "path": str(self._path),
        }
