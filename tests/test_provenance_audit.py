"""Tests for the M2.4 provenance audit harness (tools/provenance_audit.py).

The harness is the externally-runnable proof behind "attested knowledge":
citations → segments → graph passages → source corpus, verified mechanically.
These tests run it the way an external party would — as a subprocess with
explicit paths, stdlib-only (no PYTHONPATH injection) — and assert both the
exit-code contract and the JSON report shape.

Fixture shape mirrors the real dual-write: one source whose file text is the
ingested text (content_hash = sha256(file)), two segments that are verbatim
paragraphs of it, matching graph passages (segment_id == passage_id), one
answer citing both segments.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

pytest.importorskip("sqlite_vec")

from tp_vrg.models import SourcePassage
from tp_vrg.provenance_storage import ProvenanceBackend
from tp_vrg.storage_sqlite import SQLiteBackend

TOOL = Path(__file__).resolve().parents[1] / "tools" / "provenance_audit.py"

SEG_1 = (
    "TLDR-G renders knowledge instead of retrieving chunks. "
    "The fractal graph preserves topology across resolution changes."
)
SEG_2 = (
    "Every rendered fact traces back to its source segment. "
    "The provenance layer makes the chain mechanically verifiable."
)
FILE_TEXT = f"{SEG_1}\n\n{SEG_2}\n"


def _build_fixture(
    tmp_path: Path,
    *,
    segment_2_text: str = SEG_2,
    content_hash: str | None = None,
    citation_segment_ids: tuple[str, ...] = ("seg-1", "seg-2"),
    snippet_for_seg_1: str = "",
    graph_passage_2_text: str | None = None,
) -> dict[str, Path]:
    """Build provenance.db + graph.db + a corpus dir; return their paths."""
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    (corpus / "doc.md").write_text(FILE_TEXT, encoding="utf-8")

    prov_path = tmp_path / "provenance.db"
    prov = ProvenanceBackend(prov_path)
    prov.upsert_source(
        source_id="src-1",
        source_label="doc.md",
        content_hash=content_hash or hashlib.sha256(FILE_TEXT.encode()).hexdigest(),
        byte_size=len(FILE_TEXT.encode()),
    )
    prov.upsert_segment("seg-1", "src-1", 1, SEG_1)
    prov.upsert_segment("seg-2", "src-1", 2, segment_2_text)
    prov.record_answer(
        answer_id="ans-1", query_text="what does TLDR-G do?", model_label="test"
    )
    prov.record_citations(
        "ans-1",
        [
            (seg_id, i, snippet_for_seg_1 if seg_id == "seg-1" else "")
            for i, seg_id in enumerate(citation_segment_ids)
        ],
    )
    prov.close()

    graph_path = tmp_path / "graph.db"
    storage = SQLiteBackend(graph_path, embedding_dim=4)
    for pid, text in (
        ("seg-1", SEG_1),
        ("seg-2", graph_passage_2_text if graph_passage_2_text is not None else segment_2_text),
    ):
        storage.upsert_passage(
            SourcePassage(
                passage_id=pid,
                raw_text=text,
                source_id="src-1",
                source_label="doc.md",
                entity_ids=[],
                ingested_at="2026-06-11T00:00:00+00:00",
                embedding=[1.0, 0.0, 0.0, 0.0],
            )
        )
    storage.close()

    return {"prov": prov_path, "graph": graph_path, "corpus": corpus}


def _run_audit(paths: dict[str, Path], *extra: str) -> tuple[int, dict]:
    """Run the harness as an external party would: subprocess, explicit paths."""
    cmd = [
        sys.executable,
        "-X",
        "utf8",
        str(TOOL),
        "--provenance-db",
        str(paths["prov"]),
        "--graph-db",
        str(paths["graph"]),
        "--corpus-dir",
        str(paths["corpus"]),
        *extra,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    assert proc.stdout, f"no stdout; stderr: {proc.stderr}"
    return proc.returncode, json.loads(proc.stdout)


def test_clean_chain_passes_end_to_end(tmp_path: Path) -> None:
    paths = _build_fixture(tmp_path)
    code, report = _run_audit(paths)

    assert code == 0, report
    assert report["summary"]["verdict"] == "PASS"
    tier1 = report["tier1_internal_chain"]["checks"]
    assert tier1["A1_citations_resolve"]["status"] == "PASS"
    assert tier1["A1_citations_resolve"]["citations_total"] == 2
    assert tier1["A3_segments_have_sources"]["status"] == "PASS"
    assert tier1["A4_dual_write_integrity"]["status"] == "PASS"
    assert tier1["A4_dual_write_integrity"]["ids_on_both_sides"] == 2

    [source] = report["tier2_corpus_anchoring"]["sources"]
    assert source["anchoring"] == "ANCHORED_EXACT"
    assert source["status"] == "PASS"
    assert source["segment_classes"].get("VERBATIM_WHOLE") == 2


def test_dangling_citation_fails_then_warns_with_flag(tmp_path: Path) -> None:
    paths = _build_fixture(
        tmp_path, citation_segment_ids=("seg-1", "seg-2", "seg-ERASED")
    )
    code, report = _run_audit(paths)
    assert code == 1
    a1 = report["tier1_internal_chain"]["checks"]["A1_citations_resolve"]
    assert a1["status"] == "FAIL"
    assert {d["segment_id"] for d in a1["dangling"]} == {"seg-ERASED"}

    code, report = _run_audit(paths, "--allow-dangling")
    assert code == 0, report
    assert (
        report["tier1_internal_chain"]["checks"]["A1_citations_resolve"]["status"]
        == "WARN"
    )


def test_graph_provenance_divergence_caught(tmp_path: Path) -> None:
    """A4: provenance segment and graph passage with the same ID must be byte-identical."""
    paths = _build_fixture(
        tmp_path, graph_passage_2_text=SEG_2 + " [TAMPERED IN GRAPH]"
    )
    code, report = _run_audit(paths)
    assert code == 1
    a4 = report["tier1_internal_chain"]["checks"]["A4_dual_write_integrity"]
    assert a4["status"] == "FAIL"
    assert [m["id"] for m in a4["byte_mismatches"]] == ["seg-2"]


def test_tampered_segment_not_in_corpus_caught(tmp_path: Path) -> None:
    """Tier 2: a segment whose text never appeared in the source file is ABSENT.

    The hash still anchors (it was stored at ingest time over the original
    text), which is exactly the attack the corpus check exists for: the
    provenance store says one thing, the source corpus says another.
    """
    paths = _build_fixture(
        tmp_path,
        segment_2_text="This sentence was never present in the ingested document at all.",
        graph_passage_2_text="This sentence was never present in the ingested document at all.",
    )
    code, report = _run_audit(paths)
    assert code == 1
    [source] = report["tier2_corpus_anchoring"]["sources"]
    assert source["status"] == "FAIL"
    assert [f["segment_id"] for f in source["segment_failures"]] == ["seg-2"]
    assert source["segment_failures"][0]["class"] == "ABSENT"


def test_snippet_not_in_segment_caught(tmp_path: Path) -> None:
    paths = _build_fixture(
        tmp_path, snippet_for_seg_1="a fabricated quote that the segment never said"
    )
    code, report = _run_audit(paths)
    assert code == 1
    a2 = report["tier1_internal_chain"]["checks"]["A2_snippets_verbatim"]
    assert a2["status"] == "FAIL"
    assert a2["snippets_checked"] == 1


def test_unanchored_source_fails_then_warns_with_flag(tmp_path: Path) -> None:
    paths = _build_fixture(tmp_path, content_hash="0" * 64)
    code, report = _run_audit(paths)
    assert code == 1
    [source] = report["tier2_corpus_anchoring"]["sources"]
    assert source["anchoring"] == "UNANCHORED"
    assert source["status"] == "FAIL"

    code, report = _run_audit(paths, "--allow-unanchored")
    assert code == 0, report
    [source] = report["tier2_corpus_anchoring"]["sources"]
    assert source["status"] == "WARN"


def test_session_date_header_is_stripped_before_anchoring(tmp_path: Path) -> None:
    """The temporal wiring injects '[Session date: …]' prefixes into chunks;
    those are engine-added, not source text, and must not break anchoring."""
    paths = _build_fixture(
        tmp_path,
        segment_2_text=f"[Session date: 2026-06-11]\n\n{SEG_2}",
        graph_passage_2_text=f"[Session date: 2026-06-11]\n\n{SEG_2}",
    )
    code, report = _run_audit(paths)
    assert code == 0, report
    [source] = report["tier2_corpus_anchoring"]["sources"]
    assert source["segment_classes"].get("VERBATIM_WHOLE") == 2


def test_whitespace_reflow_passes_as_normalized(tmp_path: Path) -> None:
    """The chunker reflows paragraphs; whitespace-only divergence is not tampering."""
    reflowed = SEG_2.replace(". ", ".\n")
    paths = _build_fixture(
        tmp_path, segment_2_text=reflowed, graph_passage_2_text=reflowed
    )
    code, report = _run_audit(paths)
    assert code == 0, report
    [source] = report["tier2_corpus_anchoring"]["sources"]
    classes = source["segment_classes"]
    assert classes.get("VERBATIM_WHOLE", 0) == 1  # seg-1 untouched
    assert classes.get("VERBATIM_NORMALIZED", 0) == 1  # seg-2 reflowed
