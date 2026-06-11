"""Tests for src/tp_vrg/provenance_storage.py — F16 provenance backend."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from tp_vrg.provenance_storage import ProvenanceBackend


@pytest.fixture
def backend(tmp_path: Path):
    """Yield a fresh ProvenanceBackend, closed in teardown (Windows file locks)."""
    path = tmp_path / "provenance.db"
    b = ProvenanceBackend(path)
    yield b
    b.close()


# --------------------------------------------------------------- schema


def test_schema_creates_five_tables(backend):
    """All 5 tables (+ provenance_meta) are created on first open."""
    conn = backend._conn
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()
    names = {r[0] for r in rows}
    expected = {
        "sources",
        "source_segments",
        "answers",
        "answer_citations",
        "provenance_meta",
    }
    assert expected.issubset(names), f"missing: {expected - names}"


def test_schema_version_stored(backend):
    conn = backend._conn
    row = conn.execute(
        "SELECT value FROM provenance_meta WHERE key='schema_version'"
    ).fetchone()
    assert row is not None
    assert row[0] == "1"


def test_wal_mode_enabled(backend):
    row = backend._conn.execute("PRAGMA journal_mode").fetchone()
    assert row[0].lower() == "wal"


def test_foreign_keys_enabled(backend):
    row = backend._conn.execute("PRAGMA foreign_keys").fetchone()
    assert row[0] == 1


def test_user_id_column_nullable(backend):
    """answers.user_id must exist and be nullable (for future account backend)."""
    cols = backend._conn.execute("PRAGMA table_info(answers)").fetchall()
    user_id_col = next((c for c in cols if c[1] == "user_id"), None)
    assert user_id_col is not None
    # col[3] = notnull flag; 0 means nullable
    assert user_id_col[3] == 0


# ------------------------------------------------------------ ingestion


def test_upsert_source_roundtrip(backend):
    backend.upsert_source(
        source_id="s_abc123",
        source_label="test.txt",
        content_hash="deadbeef",
        byte_size=42,
    )
    rows = backend._conn.execute("SELECT * FROM sources").fetchall()
    assert len(rows) == 1
    assert rows[0]["source_label"] == "test.txt"
    assert rows[0]["content_hash"] == "deadbeef"
    assert rows[0]["byte_size"] == 42


def test_upsert_source_idempotent(backend):
    """Same source_id written twice updates in place (no duplicates)."""
    backend.upsert_source("s_1", "label1", content_hash="h1")
    backend.upsert_source("s_1", "label2", content_hash="h2")
    rows = backend._conn.execute("SELECT source_label, content_hash FROM sources").fetchall()
    assert len(rows) == 1
    assert rows[0]["source_label"] == "label2"
    assert rows[0]["content_hash"] == "h2"


def test_upsert_segment_requires_source(backend):
    """Foreign key constraint: segment can't exist without parent source."""
    with pytest.raises(sqlite3.IntegrityError):
        backend.upsert_segment(
            segment_id="seg_1",
            source_id="s_nonexistent",
            seq=0,
            text="orphaned",
        )


def test_upsert_segment_roundtrip(backend):
    backend.upsert_source("s_1", "doc.txt", content_hash="h")
    backend.upsert_segment("seg_1", "s_1", seq=0, text="hello world")
    rows = backend._conn.execute("SELECT * FROM source_segments").fetchall()
    assert len(rows) == 1
    assert rows[0]["text"] == "hello world"
    assert rows[0]["seq"] == 0


def test_upsert_segment_idempotent(backend):
    backend.upsert_source("s_1", "doc.txt", content_hash="h")
    backend.upsert_segment("seg_1", "s_1", seq=0, text="v1")
    backend.upsert_segment("seg_1", "s_1", seq=0, text="v2")
    rows = backend._conn.execute("SELECT text FROM source_segments").fetchall()
    assert len(rows) == 1
    assert rows[0]["text"] == "v2"


# ----------------------------------------------------- answer + citations


def test_record_answer_roundtrip(backend):
    backend.record_answer("a_1", "What is X?", model_label="tp-vrg", user_id=None)
    row = backend.get_answer("a_1")
    assert row is not None
    assert row["query_text"] == "What is X?"
    assert row["model_label"] == "tp-vrg"
    assert row["user_id"] is None
    # answered_at populated automatically
    assert row["answered_at"]


def test_record_answer_with_user_id(backend):
    backend.record_answer("a_1", "q", user_id="alice@example.com")
    row = backend.get_answer("a_1")
    assert row["user_id"] == "alice@example.com"


def test_get_answer_nonexistent_returns_none(backend):
    assert backend.get_answer("nonexistent") is None


def test_record_citations_batch_ordered(backend):
    """Citations are retrievable in cite_order."""
    # Set up source + segments
    backend.upsert_source("s_1", "doc.txt", content_hash="h")
    backend.upsert_segment("seg_a", "s_1", seq=0, text="alpha")
    backend.upsert_segment("seg_b", "s_1", seq=1, text="beta")
    backend.upsert_segment("seg_c", "s_1", seq=2, text="gamma")

    # Answer + citations out of order
    backend.record_answer("a_1", "q")
    backend.record_citations(
        "a_1",
        [("seg_b", 1, "evidence b"), ("seg_a", 0, "evidence a"), ("seg_c", 2, "")],
    )

    cites = backend.get_citations_for_answer("a_1")
    assert [c["cite_order"] for c in cites] == [0, 1, 2]
    assert [c["segment_id"] for c in cites] == ["seg_a", "seg_b", "seg_c"]
    assert cites[0]["source_label"] == "doc.txt"
    assert cites[0]["text"] == "alpha"
    assert cites[1]["evidence_snippet"] == "evidence b"


def test_record_citations_empty_list_is_noop(backend):
    backend.record_answer("a_1", "q")
    backend.record_citations("a_1", [])
    cites = backend.get_citations_for_answer("a_1")
    assert cites == []


def test_get_citations_left_join_handles_orphans(backend):
    """Citations pointing to non-existent segments are returned with NULL fields.

    This is the graceful-degradation path for pre-F16 content (see plan D9/G5).
    """
    backend.record_answer("a_1", "q")
    # Citation with a fabricated segment_id that was never upserted
    backend.record_citations("a_1", [("seg_ghost", 0, "")])

    cites = backend.get_citations_for_answer("a_1")
    assert len(cites) == 1
    assert cites[0]["segment_id"] == "seg_ghost"
    assert cites[0]["source_label"] is None
    assert cites[0]["text"] is None


# ------------------------------------------------------- transactions


def test_batch_commit(backend):
    backend.begin_batch()
    backend.upsert_source("s_1", "label", content_hash="h")
    backend.upsert_source("s_2", "label", content_hash="h")
    backend.commit_batch()
    rows = backend._conn.execute("SELECT COUNT(*) FROM sources").fetchone()
    assert rows[0] == 2


def test_batch_rollback(backend):
    backend.begin_batch()
    backend.upsert_source("s_1", "label", content_hash="h")
    backend.upsert_source("s_2", "label", content_hash="h")
    backend.rollback_batch()
    rows = backend._conn.execute("SELECT COUNT(*) FROM sources").fetchone()
    assert rows[0] == 0


def test_commit_outside_batch_is_noop(backend):
    # No crash
    backend.commit_batch()
    backend.rollback_batch()


# ---------------------------------------------------- management + health


def test_clear_all_resets_tables(backend):
    backend.upsert_source("s_1", "label", content_hash="h")
    backend.upsert_segment("seg_1", "s_1", seq=0, text="hi")
    backend.record_answer("a_1", "q")
    backend.record_citations("a_1", [("seg_1", 0, "")])

    backend.clear_all()

    for table in ("sources", "source_segments", "answers", "answer_citations"):
        count = backend._conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        assert count == 0

    # Schema version preserved
    version = backend._conn.execute(
        "SELECT value FROM provenance_meta WHERE key='schema_version'"
    ).fetchone()
    assert version[0] == "1"


def test_close_idempotent(backend):
    backend.close()
    backend.close()  # no crash


def test_health_check_shape(backend):
    backend.upsert_source("s_1", "label", content_hash="h")
    backend.upsert_segment("seg_1", "s_1", seq=0, text="hi")
    backend.record_answer("a_1", "q")
    backend.record_citations("a_1", [("seg_1", 0, "")])

    health = backend.health_check()
    assert health["sources"] == 1
    assert health["segments"] == 1
    assert health["answers"] == 1
    assert health["citations"] == 1
    assert health["schema_version"] == "1"
    assert health["integrity"] == "ok"
    assert "path" in health


def test_reopen_preserves_data(tmp_path):
    path = tmp_path / "p.db"

    b1 = ProvenanceBackend(path)
    b1.upsert_source("s_1", "label", content_hash="h")
    b1.record_answer("a_1", "q")
    b1.close()

    b2 = ProvenanceBackend(path)
    try:
        assert b2.get_answer("a_1") is not None
        rows = b2._conn.execute("SELECT COUNT(*) FROM sources").fetchone()
        assert rows[0] == 1
    finally:
        b2.close()


# ================================================================
# Dual-write integration tests (ingestion pipeline + ProvenanceBackend)
# ================================================================


@pytest.fixture
def memory_with_provenance(tmp_path):
    """LODGraphMemory wired with both graph + provenance backends (mock providers)."""
    from tp_vrg.engine import LODGraphMemory
    from tp_vrg.storage import InMemoryBackend
    from tp_vrg.llm_service import MockLLMProvider
    from tp_vrg.embeddings import MockEmbeddingProvider

    prov_path = tmp_path / "provenance.db"
    provenance = ProvenanceBackend(prov_path)

    memory = LODGraphMemory(
        llm_provider=MockLLMProvider(),
        embedding_provider=MockEmbeddingProvider(),
        storage=InMemoryBackend(),
        use_semantic_scoring=False,  # skip scorer init (embedding dim quirks in mocks)
        coref_mode="none",
        provenance=provenance,
    )
    yield memory, provenance
    provenance.close()


@pytest.mark.asyncio
async def test_dual_write_single_path(memory_with_provenance):
    """Short text → 1 source + 1 segment in provenance."""
    memory, prov = memory_with_provenance
    await memory.add_memory("A short document about Alice.", source="alice.txt")

    conn = prov._conn
    source_count = conn.execute("SELECT COUNT(*) FROM sources").fetchone()[0]
    segment_count = conn.execute("SELECT COUNT(*) FROM source_segments").fetchone()[0]
    assert source_count == 1
    assert segment_count == 1

    row = conn.execute("SELECT source_label, byte_size FROM sources").fetchone()
    assert row[0] == "alice.txt"
    assert row[1] == len("A short document about Alice.".encode())

    seg = conn.execute("SELECT seq, text FROM source_segments").fetchone()
    assert seg[0] == 0  # session seq
    assert seg[1] == "A short document about Alice."


@pytest.mark.asyncio
async def test_dual_write_chunked_path(memory_with_provenance):
    """Long multi-chunk document → 1 source + N chunks + 1 session segment."""
    memory, prov = memory_with_provenance

    # Force chunking by making a long document with markdown headers
    long_text = "\n\n".join([
        "# Chapter 1\n" + ("Paragraph about X. " * 50),
        "# Chapter 2\n" + ("Paragraph about Y. " * 50),
        "# Chapter 3\n" + ("Paragraph about Z. " * 50),
    ])
    await memory.add_memory(long_text, source="book.md")

    conn = prov._conn
    source_count = conn.execute("SELECT COUNT(*) FROM sources").fetchone()[0]
    assert source_count == 1

    # Must have at least 2 segments (1 session + 1+ chunks)
    segs = conn.execute(
        "SELECT seq FROM source_segments ORDER BY seq"
    ).fetchall()
    seq_values = [s[0] for s in segs]
    assert 0 in seq_values  # session segment
    assert len(segs) >= 2  # session + at least one chunk


@pytest.mark.asyncio
async def test_dual_write_idempotent(memory_with_provenance):
    """Ingesting the same text twice is a no-op (deterministic IDs)."""
    memory, prov = memory_with_provenance
    text = "Bob is a software engineer."
    await memory.add_memory(text, source="bob.txt")
    await memory.add_memory(text, source="bob.txt")

    conn = prov._conn
    source_count = conn.execute("SELECT COUNT(*) FROM sources").fetchone()[0]
    segment_count = conn.execute("SELECT COUNT(*) FROM source_segments").fetchone()[0]
    assert source_count == 1  # upserted
    assert segment_count == 1  # upserted


@pytest.mark.asyncio
async def test_dual_write_rollback_on_graph_failure(tmp_path, monkeypatch):
    """If graph.db write raises, provenance batch is also rolled back."""
    from tp_vrg.engine import LODGraphMemory
    from tp_vrg.storage import InMemoryBackend
    from tp_vrg.llm_service import MockLLMProvider
    from tp_vrg.embeddings import MockEmbeddingProvider

    prov_path = tmp_path / "p.db"
    provenance = ProvenanceBackend(prov_path)

    memory = LODGraphMemory(
        llm_provider=MockLLMProvider(),
        embedding_provider=MockEmbeddingProvider(),
        storage=InMemoryBackend(),
        use_semantic_scoring=False,
        coref_mode="none",
        provenance=provenance,
    )

    # Force graph.db upsert_passage to raise
    original_upsert = memory._storage.upsert_passage

    def failing_upsert(passage):
        raise RuntimeError("simulated graph failure")

    monkeypatch.setattr(memory._storage, "upsert_passage", failing_upsert)

    with pytest.raises(RuntimeError, match="simulated graph failure"):
        await memory.add_memory("Should rollback", source="fail.txt")

    # Provenance should have zero rows (batch was rolled back)
    conn = provenance._conn
    source_count = conn.execute("SELECT COUNT(*) FROM sources").fetchone()[0]
    segment_count = conn.execute("SELECT COUNT(*) FROM source_segments").fetchone()[0]
    assert source_count == 0
    assert segment_count == 0

    provenance.close()


@pytest.mark.asyncio
async def test_dual_write_provenance_commit_failure_logged(tmp_path, caplog):
    """If provenance commit fails AFTER graph commit, warning is logged and
    graph content is preserved (provenance_write_failed flag set)."""
    import logging
    from tp_vrg.engine import LODGraphMemory
    from tp_vrg.storage import InMemoryBackend
    from tp_vrg.llm_service import MockLLMProvider
    from tp_vrg.embeddings import MockEmbeddingProvider

    prov_path = tmp_path / "p.db"
    provenance = ProvenanceBackend(prov_path)

    # Close the underlying connection to force provenance commit to fail
    # (we still need the object to exist so the Ingester can call methods on it)
    original_commit = provenance.commit_batch

    def failing_commit():
        raise RuntimeError("simulated provenance disk full")

    provenance.commit_batch = failing_commit  # type: ignore

    memory = LODGraphMemory(
        llm_provider=MockLLMProvider(),
        embedding_provider=MockEmbeddingProvider(),
        storage=InMemoryBackend(),
        use_semantic_scoring=False,
        coref_mode="none",
        provenance=provenance,
    )

    with caplog.at_level(logging.WARNING):
        result = await memory.add_memory("Short text.", source="flaky.txt")

    # Graph.db should still have content (soft failure)
    assert memory._storage.get_passage(result.session_passage_id) is not None
    # Warning was logged
    assert any("provenance commit failed" in r.message for r in caplog.records)
    # Flag is set on the result
    assert getattr(result, "provenance_write_failed", False) is True

    # Restore and close
    provenance.commit_batch = original_commit  # type: ignore
    provenance.close()
