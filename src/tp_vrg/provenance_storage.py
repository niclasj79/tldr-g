"""ProvenanceBackend — user-facing audit trail (F16).

Stores a narrow, read-friendly record of:
  - sources          — what was ingested (source_id, label, content hash, size)
  - source_segments  — the individual text segments from each source
  - answers          — every rendered query response (query text, timestamp,
                       and the model's generated response text when one exists)
  - answer_citations — which segments contributed to each answer
  - answer_claims / answer_claim_evidence
                     — the Response Graph sidecar: each answer decomposed into
                       claims, each claim carrying a grounding verdict and the
                       candidate evidence set that verdict was scoped to

The schema is deliberately disjoint from graph.db's internal schema. A user
or customer running `sqlite3 provenance.db ".schema"` sees only these tables
(plus provenance_meta for versioning). No LOD columns, no backbone, no
embeddings, no stitching edges, no FTS indices.

The Response Graph is a SIDECAR and stays one: claims and verdicts are keyed
by answer_id and never enter the knowledge graph. Merge-back is triple-gated
(maturation mechanism + a model-derived provenance class + GDPR lineage), and
none of those exist — see docs/design/arch-last-mile-provenance-2026-07-05.md
A7. Verdicts do, however, die with the evidence they name: both deletion
cascades drop the verdicts scoped to any segment they remove.

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

import json
import sqlite3
from collections.abc import Sequence
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

            CREATE TABLE IF NOT EXISTS segment_sources (
                segment_id TEXT NOT NULL,
                source_id  TEXT NOT NULL,
                PRIMARY KEY (segment_id, source_id)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS idx_segment_sources_source
            ON segment_sources(source_id);

            -- Resolution overlay: coref / defined-term resolution recorded as a
            -- REVERSIBLE layer over the verbatim source, one row per source. The
            -- seq=0 segment holds the verbatim document; applying this map to it
            -- reproduces the resolved text the engine extracts/embeds from (see
            -- src/tp_vrg/resolution_overlay.py). Additive + default-safe: absent
            -- for engine-unmutated sources; a citation stays honest by pointing
            -- at the verbatim seq=0 segment + disclosing this overlay.
            CREATE TABLE IF NOT EXISTS source_resolution_overlay (
                source_id      TEXT PRIMARY KEY REFERENCES sources(source_id),
                resolution_map TEXT NOT NULL,
                created_at     TEXT NOT NULL
            );

            -- THE MENTION LEDGER, first increment ([ASSET-MENTION-LEDGER],
            -- 2026-07-28). Coreference already computes full mention clusters
            -- with character spans on every ingest -- `get_clusters(as_strings=
            -- False)` in coref_lingmess -- uses them to build string edits, and
            -- then DISCARDS them, returning only resolved text. This table stops
            -- discarding them. It is a persistence change, not a model change:
            -- the expensive part was already paid for.
            --
            -- WHY provenance.db AND NOT graph.db: `compute_logical_roots` hashes
            -- every table in graph.db, so a new table there would move
            -- `logical_root_all` and change the identity of every snapshot. But
            -- mentions are not graph topology -- they are provenance about a
            -- source, and they can only be interpreted against the resolution
            -- overlay stored directly above. Co-locating them keeps graph
            -- identity untouched and puts the two artifacts that must be read
            -- together in one place.
            --
            -- `coord_space` is load-bearing and must never be dropped. Coref runs
            -- AFTER `preprocess_defined_terms` has already rewritten the text, so
            -- these offsets index the coref INPUT, not the verbatim original.
            -- Mapping them back to the immutable source requires
            -- `resolution_overlay.OffsetIndex` over the row above. Recording
            -- which coordinate space an offset lives in is the difference
            -- between a usable ledger and a silently-misaligned one -- the exact
            -- class of error this project has repeatedly paid for.
            CREATE TABLE IF NOT EXISTS source_mention_clusters (
                source_id      TEXT NOT NULL REFERENCES sources(source_id),
                cluster_id     INTEGER NOT NULL,
                mention_idx    INTEGER NOT NULL,
                span_start     INTEGER NOT NULL,
                span_end       INTEGER NOT NULL,
                surface_form   TEXT NOT NULL,
                representative TEXT NOT NULL,
                coord_space    TEXT NOT NULL,
                created_at     TEXT NOT NULL,
                PRIMARY KEY (source_id, cluster_id, mention_idx)
            );
            CREATE INDEX IF NOT EXISTS idx_mention_clusters_source
                ON source_mention_clusters(source_id);
            CREATE INDEX IF NOT EXISTS idx_mention_clusters_surface
                ON source_mention_clusters(surface_form);

            -- `response_text` closes the last-mile gap (A9 of
            -- docs/design/arch-last-mile-provenance-2026-07-05.md): before it,
            -- the row stored the QUERY and the model's output evaporated after
            -- display, so nothing downstream could verify what was actually
            -- said. It is written at render time when the answer already
            -- exists, or filled in afterwards via `record_response_text` on
            -- the streaming path where the tokens arrive later.
            -- `response_recorded_at` distinguishes "no answer generated"
            -- (context-only /query) from "answer generated, empty string".
            -- `render_strategy` exists to make grounding telemetry
            -- STRATIFIABLE. Grounding rate compared across render strategies
            -- is a laundered metric (A5): edge-primary rendering
            -- pre-positions claims, the model parrots them, verification
            -- trivially confirms, and the number stops measuring faithfulness
            -- and starts measuring render composition. You cannot stratify by
            -- something you never recorded, so it is recorded here.
            CREATE TABLE IF NOT EXISTS answers (
                answer_id            TEXT PRIMARY KEY,
                query_text           TEXT NOT NULL,
                answered_at          TEXT NOT NULL,
                model_label          TEXT DEFAULT '',
                user_id              TEXT DEFAULT NULL,
                response_text        TEXT DEFAULT NULL,
                response_recorded_at TEXT DEFAULT NULL,
                render_strategy      TEXT DEFAULT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_answers_user ON answers(user_id);

            -- The Response Graph sidecar (last-mile provenance §3.4): one row
            -- per answer-claim, carrying its verdict and the stage that
            -- produced it. A SIDECAR, keyed by answer_id — these rows are
            -- NEVER written into the knowledge graph. Merge-back stays
            -- triple-gated (A7: maturation mechanism + model-derived
            -- provenance class + GDPR lineage), none of which exists yet.
            -- Lives beside the citations because a verdict is provenance about
            -- one answer, and so inherits the export + cascade machinery that
            -- already governs answers.
            CREATE TABLE IF NOT EXISTS answer_claims (
                answer_id      TEXT NOT NULL,
                claim_index    INTEGER NOT NULL,
                claim_text     TEXT NOT NULL,
                sentence_index INTEGER NOT NULL DEFAULT 0,
                markers        TEXT NOT NULL DEFAULT '',
                verdict        TEXT NOT NULL,
                tier           TEXT NOT NULL DEFAULT '',
                confidence     REAL,
                decomposer_id  TEXT NOT NULL DEFAULT '',
                verifier_id    TEXT NOT NULL DEFAULT '',
                verified_at    TEXT NOT NULL,
                PRIMARY KEY (answer_id, claim_index)
            ) WITHOUT ROWID;

            -- The candidate set each verdict was scoped to (A10): embedding
            -- retrieval is negation-blind, so "no contradiction found" only
            -- ever means "none among THESE candidates". Recording them is what
            -- makes that scoping explicit instead of implied.
            CREATE TABLE IF NOT EXISTS answer_claim_evidence (
                answer_id    TEXT NOT NULL,
                claim_index  INTEGER NOT NULL,
                segment_id   TEXT NOT NULL,
                rank         INTEGER NOT NULL,
                score        REAL,
                role         TEXT NOT NULL DEFAULT 'candidate',
                PRIMARY KEY (answer_id, claim_index, rank)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS idx_claim_evidence_segment
            ON answer_claim_evidence(segment_id);

            -- One row per verification RUN. The receipt is only re-derivable
            -- against the rule that actually produced it, and every field here
            -- was previously reconstructed from the AMBIENT ENVIRONMENT at
            -- receipt-build time -- so a verdict decided at quote floor 0.75
            -- could be signed as 0.80, and an env-enabled NLI could be named
            -- in a receipt where it never ran. The execution is recorded, not
            -- inferred. ``verified_text`` is the text actually decomposed
            -- (which may be a caller override), so claims can never be signed
            -- beside an answer body they were not produced from.
            CREATE TABLE IF NOT EXISTS answer_verification_runs (
                answer_id     TEXT NOT NULL PRIMARY KEY,
                verified_text TEXT,
                thresholds    TEXT NOT NULL DEFAULT '{}',
                nli_model_id  TEXT,
                nli_available INTEGER NOT NULL DEFAULT 1,
                tiers_offered TEXT NOT NULL DEFAULT '[]',
                verified_at   TEXT NOT NULL
            ) WITHOUT ROWID;

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
        """Install additive ownership for content-derived shared segments."""
        assert self._conn is not None
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS segment_sources (
                segment_id TEXT NOT NULL,
                source_id  TEXT NOT NULL,
                PRIMARY KEY (segment_id, source_id)
            ) WITHOUT ROWID
        """)
        self._conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_segment_sources_source
            ON segment_sources(source_id)
        """)
        self._conn.execute("""
            INSERT OR IGNORE INTO segment_sources (segment_id, source_id)
            SELECT segment_id, source_id FROM source_segments
        """)
        # Additive: the answer's own text (last-mile provenance step 1).
        # Pre-existing stores keep every row; the new columns arrive NULL,
        # which reads as "this answer predates response storage" — distinct
        # from an empty generated answer (recorded_at set, text '').
        existing = {
            r[1] for r in self._conn.execute("PRAGMA table_info(answers)").fetchall()
        }
        for column in ("response_text", "response_recorded_at", "render_strategy"):
            if column not in existing:
                self._conn.execute(
                    f"ALTER TABLE answers ADD COLUMN {column} TEXT DEFAULT NULL"
                )
        self._conn.commit()

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
        self._conn.execute(
            "INSERT OR IGNORE INTO segment_sources (segment_id, source_id) "
            "VALUES (?, ?)",
            (segment_id, source_id),
        )
        if not self._in_batch:
            self._conn.commit()

    def replace_mention_clusters(
        self,
        source_id: str,
        clusters: list[dict],
        coord_space: str = "coref_input",
    ) -> int:
        """Persist the coreference mention clusters for one source. Idempotent.

        [ASSET-MENTION-LEDGER] first increment. Replaces the whole set for the
        source so a re-ingest cannot leave a half-updated ledger interleaving two
        editions' offsets — the offsets are only meaningful against one text.

        ``clusters`` is a list of ``{cluster_id, mention_idx, span_start,
        span_end, surface_form, representative}``. ``coord_space`` names the text
        the offsets index and is stored verbatim; see the table comment for why
        dropping it would make the ledger unusable rather than merely untidy.

        Returns the number of mentions written.
        """
        assert self._conn is not None
        if not source_id:
            raise ValueError("mention clusters require a source_id")
        now = datetime.now(timezone.utc).isoformat()
        # Whole-set replace: a partial update would silently mix coordinate
        # spaces across editions, which is the failure the coord_space column
        # exists to prevent.
        self._conn.execute(
            "DELETE FROM source_mention_clusters WHERE source_id = ?", (source_id,)
        )
        rows = [
            (
                source_id,
                int(m["cluster_id"]),
                int(m["mention_idx"]),
                int(m["span_start"]),
                int(m["span_end"]),
                str(m["surface_form"]),
                str(m["representative"]),
                coord_space,
                now,
            )
            for m in clusters
        ]
        if rows:
            self._conn.executemany(
                "INSERT INTO source_mention_clusters (source_id, cluster_id, "
                "mention_idx, span_start, span_end, surface_form, representative, "
                "coord_space, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                rows,
            )
        self._conn.commit()
        return len(rows)

    def get_mention_clusters(self, source_id: str) -> list[dict]:
        """Read back one source's mention ledger, cluster-ordered."""
        assert self._conn is not None
        cur = self._conn.execute(
            "SELECT cluster_id, mention_idx, span_start, span_end, surface_form, "
            "representative, coord_space FROM source_mention_clusters "
            "WHERE source_id = ? ORDER BY cluster_id, mention_idx",
            (source_id,),
        )
        return [
            {
                "cluster_id": r[0], "mention_idx": r[1], "span_start": r[2],
                "span_end": r[3], "surface_form": r[4], "representative": r[5],
                "coord_space": r[6],
            }
            for r in cur.fetchall()
        ]

    def upsert_resolution_overlay(self, source_id: str, resolution_map: str) -> None:
        """Store the reversible resolution overlay for a source. Idempotent on
        `source_id`. `resolution_map` is the JSON produced by
        resolution_overlay.edits_to_json (raw-offset substitutions)."""
        assert self._conn is not None
        now = datetime.now(timezone.utc).isoformat()
        self._conn.execute(
            """
            INSERT INTO source_resolution_overlay (source_id, resolution_map, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT(source_id) DO UPDATE SET
                resolution_map = excluded.resolution_map,
                created_at     = excluded.created_at
            """,
            (source_id, resolution_map, now),
        )
        if not self._in_batch:
            self._conn.commit()

    def get_resolution_overlay(self, source_id: str) -> str | None:
        """Return the stored resolution-map JSON for a source, or None if the
        source's stored text is already verbatim (no resolution applied)."""
        assert self._conn is not None
        row = self._conn.execute(
            "SELECT resolution_map FROM source_resolution_overlay WHERE source_id = ?",
            (source_id,),
        ).fetchone()
        return row["resolution_map"] if row else None

    # ----------------------------------------------------------------- query

    def record_answer(
        self,
        answer_id: str,
        query_text: str,
        model_label: str = "tp-vrg",
        user_id: str | None = None,
        response_text: str | None = None,
        render_strategy: str | None = None,
    ) -> None:
        """Record a single answer event. Call once per query rendered.

        ``response_text`` is the model's generated answer when it already
        exists at record time (the non-streaming answer path). Leave it None
        for a context-only render or when the tokens arrive later — the
        streaming path fills it in with :meth:`record_response_text`.

        ``render_strategy`` is the strategy the selector actually took for
        this render; it is what makes grounding telemetry stratifiable.
        """
        assert self._conn is not None
        now = datetime.now(timezone.utc).isoformat()
        self._conn.execute(
            """
            INSERT INTO answers
                (answer_id, query_text, answered_at, model_label, user_id,
                 response_text, response_recorded_at, render_strategy)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                answer_id,
                query_text,
                now,
                model_label,
                user_id,
                response_text,
                now if response_text is not None else None,
                render_strategy,
            ),
        )
        if not self._in_batch:
            self._conn.commit()

    def record_response_text(self, answer_id: str, response_text: str) -> bool:
        """Attach the model's generated answer to an already-recorded answer.

        The streaming path records the render receipt when the context is
        assembled and only learns the response when the stream completes, so
        the write is a second step. Returns False when ``answer_id`` is
        unknown (the caller degrades to "no response stored" — never raises,
        matching the best-effort posture of the rest of the receipt path).
        """
        assert self._conn is not None
        cur = self._conn.execute(
            "UPDATE answers SET response_text = ?, response_recorded_at = ? "
            "WHERE answer_id = ?",
            (response_text, datetime.now(timezone.utc).isoformat(), answer_id),
        )
        if not self._in_batch:
            self._conn.commit()
        return cur.rowcount > 0

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

    # ------------------------------------------------- response-graph sidecar

    def record_verification_sidecar(
        self,
        answer_id: str,
        claims: list[dict[str, Any]],
        *,
        verified_text: str | None,
        thresholds: dict[str, float],
        nli_model_id: str | None,
        nli_available: bool,
        tiers_offered: Sequence[str],
        verified_at: str,
    ) -> None:
        """Replace one verification's claims and run as one transaction.

        Claims and their run record are one execution, not two independently
        useful writes. A savepoint gives this operation atomicity both when
        called on its own and inside a caller-owned provenance batch: either
        every row becomes visible together, or the previous coherent sidecar
        remains untouched.

        The public component writers are deliberately reused under the
        savepoint. Besides keeping one implementation of each row shape, this
        means an injected storage failure at either boundary exercises the same
        rollback path as a real SQLite failure.
        """
        assert self._conn is not None
        savepoint = "answer_verification_sidecar"
        was_in_batch = self._in_batch
        self._conn.execute(f"SAVEPOINT {savepoint}")
        self._in_batch = True
        try:
            self.record_claim_verdicts(answer_id, claims)
            self.record_verification_run(
                answer_id,
                verified_text=verified_text,
                thresholds=thresholds,
                nli_model_id=nli_model_id,
                nli_available=nli_available,
                tiers_offered=tiers_offered,
                verified_at=verified_at,
            )
        except BaseException:
            try:
                try:
                    self._conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                finally:
                    self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            finally:
                self._in_batch = was_in_batch
            raise
        else:
            try:
                self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            finally:
                self._in_batch = was_in_batch

    def record_verification_run(
        self,
        answer_id: str,
        *,
        verified_text: str | None,
        thresholds: dict[str, float],
        nli_model_id: str | None,
        nli_available: bool,
        tiers_offered: Sequence[str],
        verified_at: str,
    ) -> None:
        """Record WHAT ACTUALLY RAN for one verification.

        The receipt reads this instead of re-deriving the decision rule from
        the ambient environment at build time. Replace-not-append, for the same
        reason the verdicts are: one (answer, verifier) pair has one execution.
        """
        assert self._conn is not None
        self._conn.execute(
            """
            INSERT INTO answer_verification_runs
                (answer_id, verified_text, thresholds, nli_model_id,
                 nli_available, tiers_offered, verified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(answer_id) DO UPDATE SET
                verified_text = excluded.verified_text,
                thresholds    = excluded.thresholds,
                nli_model_id  = excluded.nli_model_id,
                nli_available = excluded.nli_available,
                tiers_offered = excluded.tiers_offered,
                verified_at   = excluded.verified_at
            """,
            (
                answer_id,
                verified_text,
                json.dumps(thresholds, sort_keys=True),
                nli_model_id,
                1 if nli_available else 0,
                json.dumps(list(tiers_offered)),
                verified_at,
            ),
        )
        if not self._in_batch:
            self._conn.commit()

    def get_verification_run(self, answer_id: str) -> dict[str, Any] | None:
        """The recorded execution for one answer, or None if never verified."""
        assert self._conn is not None
        row = self._conn.execute(
            "SELECT answer_id, verified_text, thresholds, nli_model_id, "
            "nli_available, tiers_offered, verified_at "
            "FROM answer_verification_runs WHERE answer_id = ?",
            (answer_id,),
        ).fetchone()
        if row is None:
            return None
        return {
            "answer_id": row[0],
            "verified_text": row[1],
            "thresholds": json.loads(row[2] or "{}"),
            "nli_model_id": row[3],
            "nli_available": bool(row[4]),
            "tiers_offered": json.loads(row[5] or "[]"),
            "verified_at": row[6],
        }

    def record_claim_verdicts(
        self,
        answer_id: str,
        claims: list[dict[str, Any]],
    ) -> None:
        """Replace the Response Graph sidecar for one answer.

        Each entry: ``claim_index``, ``claim_text``, ``sentence_index``,
        ``markers`` (list), ``verdict``, ``tier``, ``confidence``,
        ``decomposer_id``, ``verifier_id``, and ``evidence`` — a list of
        ``(segment_id, rank, score, role)`` recording the candidate set the
        verdict was scoped to (A10).

        Replace-not-append: re-verifying an answer supersedes its verdicts
        rather than accumulating contradictory ones. The claim list is the
        deterministic function of one (answer, verifier) pair; two versions of
        it in the store would make "the verdict" ambiguous.
        """
        assert self._conn is not None
        now = datetime.now(timezone.utc).isoformat()
        self._conn.execute("DELETE FROM answer_claims WHERE answer_id = ?", (answer_id,))
        self._conn.execute(
            "DELETE FROM answer_claim_evidence WHERE answer_id = ?", (answer_id,)
        )
        self._conn.executemany(
            """
            INSERT INTO answer_claims
                (answer_id, claim_index, claim_text, sentence_index, markers,
                 verdict, tier, confidence, decomposer_id, verifier_id, verified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    answer_id,
                    int(c["claim_index"]),
                    str(c["claim_text"]),
                    int(c.get("sentence_index", 0)),
                    ",".join(c.get("markers") or []),
                    str(c["verdict"]),
                    str(c.get("tier", "")),
                    c.get("confidence"),
                    str(c.get("decomposer_id", "")),
                    str(c.get("verifier_id", "")),
                    now,
                )
                for c in claims
            ],
        )
        evidence_rows = [
            (answer_id, int(c["claim_index"]), str(seg), int(rank), score, str(role))
            for c in claims
            for seg, rank, score, role in (c.get("evidence") or [])
        ]
        if evidence_rows:
            self._conn.executemany(
                """
                INSERT INTO answer_claim_evidence
                    (answer_id, claim_index, segment_id, rank, score, role)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                evidence_rows,
            )
        if not self._in_batch:
            self._conn.commit()

    def get_claim_verdicts(self, answer_id: str) -> list[dict[str, Any]]:
        """Return the Response Graph sidecar for one answer, with its evidence.

        Empty list when the answer has not been verified — deliberately not an
        error: an unverified answer is the normal state while verification is
        still running (verdicts arrive asynchronously, A8).
        """
        assert self._conn is not None
        claims = [
            dict(r)
            for r in self._conn.execute(
                "SELECT answer_id, claim_index, claim_text, sentence_index, markers, "
                "verdict, tier, confidence, decomposer_id, verifier_id, verified_at "
                "FROM answer_claims WHERE answer_id = ? ORDER BY claim_index",
                (answer_id,),
            ).fetchall()
        ]
        if not claims:
            return []
        by_index: dict[int, list[dict[str, Any]]] = {}
        for r in self._conn.execute(
            "SELECT claim_index, segment_id, rank, score, role "
            "FROM answer_claim_evidence WHERE answer_id = ? ORDER BY claim_index, rank",
            (answer_id,),
        ).fetchall():
            by_index.setdefault(int(r["claim_index"]), []).append(dict(r))
        for c in claims:
            c["markers"] = [m for m in (c["markers"] or "").split(",") if m]
            c["evidence"] = by_index.get(int(c["claim_index"]), [])
        return claims

    def claim_verdict_counts_by_strategy(self) -> dict[str, dict[str, int]]:
        """Verdict counts grouped by the render strategy that produced them.

        Returns ``{strategy: {verdict: count}}``. The grouping is done in SQL
        rather than by the caller on purpose: the only aggregate this store
        will produce is a stratified one, so a pooled cross-strategy rate is
        not merely discouraged, it is not available here (A5 — see
        :func:`tp_vrg.output_verifier.grounding_telemetry`).

        Answers recorded before the strategy column, or by a path that does
        not know its strategy, group under ``"unattributed"`` — visible as a
        stratum rather than silently folded into another one.
        """
        assert self._conn is not None
        out: dict[str, dict[str, int]] = {}
        for row in self._conn.execute(
            """
            SELECT COALESCE(NULLIF(a.render_strategy, ''), 'unattributed') AS strategy,
                   c.verdict AS verdict,
                   COUNT(*)  AS n
            FROM answer_claims c
            JOIN answers a ON a.answer_id = c.answer_id
            GROUP BY strategy, verdict
            ORDER BY strategy, verdict
            """
        ).fetchall():
            out.setdefault(row["strategy"], {})[row["verdict"]] = int(row["n"])
        return out

    def delete_claim_verdicts(self, answer_id: str) -> int:
        """Drop one answer's sidecar. Returns the number of claim rows removed."""
        assert self._conn is not None
        cur = self._conn.execute(
            "DELETE FROM answer_claims WHERE answer_id = ?", (answer_id,)
        )
        removed = cur.rowcount
        self._conn.execute(
            "DELETE FROM answer_claim_evidence WHERE answer_id = ?", (answer_id,)
        )
        # The run record describes the execution that produced those verdicts;
        # leaving it behind would let a later receipt cite a decision rule for
        # claims that no longer exist.
        self._conn.execute(
            "DELETE FROM answer_verification_runs WHERE answer_id = ?", (answer_id,)
        )
        if not self._in_batch:
            self._conn.commit()
        return max(0, removed)

    def _invalidate_verdicts_for_segments(self, segment_ids: list[str]) -> int:
        """Drop every verification run that depended on any deleted segment.

        A run is the receipt unit: it binds one decomposed response, one complete
        claim list, and one rule provenance record. Deleting only the affected
        claim used to leave a signable run that presented a two-claim response
        as if only the surviving positive claim had ever existed. Once any
        candidate evidence disappears, purge the whole execution and let a
        later verification rebuild it from the remaining citations.
        """
        assert self._conn is not None
        if not segment_ids:
            return 0
        placeholders = ",".join("?" for _ in segment_ids)
        affected_answers = [
            str(row["answer_id"])
            for row in self._conn.execute(
                f"SELECT DISTINCT answer_id FROM answer_claim_evidence "
                f"WHERE segment_id IN ({placeholders})",
                segment_ids,
            ).fetchall()
        ]
        removed = 0
        for answer_id in affected_answers:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM answer_claims WHERE answer_id = ?",
                (answer_id,),
            ).fetchone()
            removed += int(row["n"] if row is not None else 0)
            self._conn.execute(
                "DELETE FROM answer_claims WHERE answer_id = ?",
                (answer_id,),
            )
            self._conn.execute(
                "DELETE FROM answer_claim_evidence WHERE answer_id = ?",
                (answer_id,),
            )
            self._conn.execute(
                "DELETE FROM answer_verification_runs WHERE answer_id = ?",
                (answer_id,),
            )
        return removed

    # ----------------------------------------------------------------- read

    def get_answer(self, answer_id: str) -> dict[str, Any] | None:
        """Return the raw answer row, or None if missing."""
        assert self._conn is not None
        row = self._conn.execute(
            "SELECT answer_id, query_text, answered_at, model_label, user_id, "
            "response_text, response_recorded_at, render_strategy "
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
                s.source_id           AS source_id,
                src.source_label      AS source_label,
                src.source_uri        AS source_uri,
                src.content_hash      AS content_hash,
                (ovl.source_id IS NOT NULL) AS has_overlay
            FROM answer_citations ac
            LEFT JOIN source_segments s ON s.segment_id = ac.segment_id
            LEFT JOIN sources src       ON src.source_id = s.source_id
            LEFT JOIN source_resolution_overlay ovl ON ovl.source_id = s.source_id
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

    def get_segment_context_batch(
        self,
        passage_ids: list[str],
        window: int = 1,
    ) -> dict[str, list[dict[str, Any]]]:
        """Batched get_segment_context (perf audit A4).

        One anchor-resolve query for all *passage_ids*, then one window query
        per DISTINCT source document (a seq range spanning that source's
        anchors, sliced per anchor in Python) — instead of 2 queries per
        passage. Per-anchor output is identical to get_segment_context: same
        rows, seq-ascending; ids without a segment map to [].
        """
        assert self._conn is not None
        ids = [str(pid) for pid in passage_ids if pid]
        out: dict[str, list[dict[str, Any]]] = {pid: [] for pid in ids}
        if not ids:
            return out

        anchors: dict[str, tuple[str, int]] = {}
        uniq = list(dict.fromkeys(ids))
        chunk_size = 500
        for i in range(0, len(uniq), chunk_size):
            chunk = uniq[i : i + chunk_size]
            rows = self._conn.execute(
                "SELECT segment_id, source_id, seq FROM source_segments "
                f"WHERE segment_id IN ({','.join('?' * len(chunk))})",
                chunk,
            ).fetchall()
            for r in rows:
                anchors[r["segment_id"]] = (r["source_id"], int(r["seq"]))

        by_source: dict[str, list[int]] = {}
        for sid, seq in anchors.values():
            by_source.setdefault(sid, []).append(seq)

        source_rows: dict[str, list[dict[str, Any]]] = {}
        for sid, seqs in by_source.items():
            rows = self._conn.execute(
                """
                SELECT segment_id, source_id, seq, text
                FROM source_segments
                WHERE source_id = ? AND seq BETWEEN ? AND ?
                ORDER BY seq
                """,
                (sid, min(seqs) - window, max(seqs) + window),
            ).fetchall()
            source_rows[sid] = [dict(r) for r in rows]

        for pid in ids:
            anchor = anchors.get(pid)
            if anchor is None:
                continue
            sid, seq = anchor
            lo, hi = seq - window, seq + window
            out[pid] = [r for r in source_rows.get(sid, []) if lo <= r["seq"] <= hi]
        return out

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
            SELECT s.segment_id, o.source_id, s.seq, s.text
            FROM source_segments s
            JOIN segment_sources o ON o.segment_id = s.segment_id
            WHERE o.source_id = ?
            ORDER BY s.seq
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
            SELECT s.segment_id, o.source_id, s.seq, s.text
            FROM source_segments s
            JOIN segment_sources o ON o.segment_id = s.segment_id
            WHERE o.source_id = ? AND s.text LIKE ? {seq_filter}
            ORDER BY s.seq DESC
            LIMIT 1
            """,
            (source_id, f"%**{heading_text}**%"),
        ).fetchall()
        if rows:
            return dict(rows[0])

        # Second try: markdown heading (# heading_text)
        rows = self._conn.execute(
            f"""
            SELECT s.segment_id, o.source_id, s.seq, s.text
            FROM source_segments s
            JOIN segment_sources o ON o.segment_id = s.segment_id
            WHERE o.source_id = ? AND s.text LIKE ? {seq_filter}
            ORDER BY s.seq DESC
            LIMIT 1
            """,
            (source_id, f"%# {heading_text}%"),
        ).fetchall()
        if rows:
            return dict(rows[0])

        # Fallback: last mention by seq (section headings come after references)
        rows = self._conn.execute(
            f"""
            SELECT s.segment_id, o.source_id, s.seq, s.text
            FROM source_segments s
            JOIN segment_sources o ON o.segment_id = s.segment_id
            WHERE o.source_id = ? AND s.text LIKE ? {seq_filter}
            ORDER BY s.seq DESC
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
        """Delete a source and only the final-owner segments it owns.

        If the caller already opened a provenance batch, this method leaves
        commit/rollback to that caller. Otherwise it wraps itself in a batch.
        """
        assert self._conn is not None
        owns_batch = not self._in_batch
        if owns_batch:
            self.begin_batch()
        try:
            segment_rows = self._conn.execute(
                "SELECT segment_id FROM segment_sources WHERE source_id = ? "
                "UNION SELECT segment_id FROM source_segments WHERE source_id = ?",
                (source_id, source_id),
            ).fetchall()
            segment_ids = [row["segment_id"] for row in segment_rows]
            owner_counts = {
                segment_id: int(count)
                for segment_id, count in self._conn.execute(
                    "SELECT segment_id, COUNT(*) FROM segment_sources "
                    f"WHERE segment_id IN ({','.join('?' for _ in segment_ids)}) "
                    "GROUP BY segment_id",
                    segment_ids,
                ).fetchall()
            } if segment_ids else {}
            exclusive_segment_ids = [
                segment_id
                for segment_id in segment_ids
                if owner_counts.get(segment_id, 0) <= 1
            ]
            shared_segment_ids = [
                segment_id
                for segment_id in segment_ids
                if owner_counts.get(segment_id, 0) > 1
            ]

            self._conn.execute(
                "DELETE FROM segment_sources WHERE source_id = ?",
                (source_id,),
            )
            for segment_id in shared_segment_ids:
                remaining = self._conn.execute(
                    "SELECT source_id FROM segment_sources "
                    "WHERE segment_id = ? ORDER BY source_id LIMIT 1",
                    (segment_id,),
                ).fetchone()
                if remaining is None:
                    raise RuntimeError(
                        "segment ownership inconsistency: shared segment has no remaining owner"
                    )
                self._conn.execute(
                    "UPDATE source_segments SET source_id = ? WHERE segment_id = ?",
                    (remaining["source_id"], segment_id),
                )

            citations_removed = 0
            verdicts_removed = 0
            if exclusive_segment_ids:
                # Verdicts first: they name the segments as their candidate
                # set, so they must die with the evidence, not after it.
                verdicts_removed = self._invalidate_verdicts_for_segments(
                    exclusive_segment_ids
                )
                for segment_id in exclusive_segment_ids:
                    before = self._conn.total_changes
                    self._conn.execute(
                        "DELETE FROM answer_citations WHERE segment_id = ?",
                        (segment_id,),
                    )
                    citations_removed += self._conn.total_changes - before

            before = self._conn.total_changes
            for segment_id in exclusive_segment_ids:
                self._conn.execute(
                    "DELETE FROM source_segments WHERE segment_id = ?",
                    (segment_id,),
                )
            segments_removed = self._conn.total_changes - before

            before = self._conn.total_changes
            self._conn.execute(
                "DELETE FROM source_resolution_overlay WHERE source_id = ?",
                (source_id,),
            )
            overlays_removed = self._conn.total_changes - before

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
                "overlays_removed": int(overlays_removed),
                "claim_verdicts_removed": int(verdicts_removed),
            }
        except Exception:
            if owns_batch:
                self.rollback_batch()
            raise

    def delete_asset_cascade(
        self,
        source_id: str,
        segment_ids: list[str],
    ) -> dict[str, int]:
        """Delete one asset's provenance footprint without erasing siblings.

        Asset identity lives in graph.db; provenance.db is source/segment
        keyed. The graph owner therefore supplies the exact member segment
        IDs plus the asset row's ``provenance_source_id``. Citations and those
        segments are always removed. The source-level resolution overlay and
        source row are removed only when no segments remain for that source,
        preserving another asset that shares it.

        If the caller already opened a provenance batch, commit/rollback stays
        with that caller so the graph and provenance deletes can be staged
        together.
        """
        assert self._conn is not None
        source_id = (source_id or "").strip()
        if not source_id:
            raise ValueError("source_id is required for asset provenance deletion")
        unique_segment_ids = list(dict.fromkeys(segment_ids))
        owns_batch = not self._in_batch
        if owns_batch:
            self.begin_batch()
        try:
            citations_removed = 0
            segments_removed = 0
            verdicts_removed = 0
            for segment_id in unique_segment_ids:
                owned = self._conn.execute(
                    "SELECT 1 FROM segment_sources "
                    "WHERE source_id = ? AND segment_id = ?",
                    (source_id, segment_id),
                ).fetchone()
                if owned is None:
                    continue
                self._conn.execute(
                    "DELETE FROM segment_sources WHERE source_id = ? AND segment_id = ?",
                    (source_id, segment_id),
                )
                remaining_owner = self._conn.execute(
                    "SELECT source_id FROM segment_sources "
                    "WHERE segment_id = ? ORDER BY source_id LIMIT 1",
                    (segment_id,),
                ).fetchone()
                if remaining_owner is not None:
                    self._conn.execute(
                        "UPDATE source_segments SET source_id = ? WHERE segment_id = ?",
                        (remaining_owner["source_id"], segment_id),
                    )
                    continue
                # Verdicts scoped to this segment go with it (see
                # _invalidate_verdicts_for_segments — a verdict about deleted
                # evidence asserts a grounding nobody can re-derive).
                verdicts_removed += self._invalidate_verdicts_for_segments([segment_id])
                before = self._conn.total_changes
                self._conn.execute(
                    "DELETE FROM answer_citations WHERE segment_id = ?",
                    (segment_id,),
                )
                citations_removed += self._conn.total_changes - before

                before = self._conn.total_changes
                self._conn.execute(
                    "DELETE FROM source_segments WHERE segment_id = ?",
                    (segment_id,),
                )
                segments_removed += self._conn.total_changes - before

            remaining = int(
                self._conn.execute(
                    "SELECT COUNT(*) FROM segment_sources WHERE source_id = ?",
                    (source_id,),
                ).fetchone()[0]
            )
            overlays_removed = 0
            sources_removed = 0
            if remaining == 0:
                before = self._conn.total_changes
                self._conn.execute(
                    "DELETE FROM source_resolution_overlay WHERE source_id = ?",
                    (source_id,),
                )
                overlays_removed = self._conn.total_changes - before

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
                "overlays_removed": int(overlays_removed),
                "claim_verdicts_removed": int(verdicts_removed),
                "segments_remaining": remaining,
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
            DELETE FROM answer_claim_evidence;
            DELETE FROM answer_claims;
            DELETE FROM answer_verification_runs;
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
