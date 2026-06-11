"""Provenance audit harness (M2.4) — external verification that cited knowledge is real.

The externally-runnable script behind the claim that TLDR-G renders **attested**
knowledge: it verifies, mechanically, that the provenance chain holds —

    answer citations  →  source segments  →  graph passages  →  source corpus

**Tier 1 — internal-chain integrity** (always; needs only the two DBs):
  A1  every ``answer_citations.segment_id`` resolves to a real source segment
      (the column deliberately has NO foreign key — plan D9 — so dangling
      citations are *possible*; this is the hallucinated-citation-shaped check.
      NOTE: GDPR ``delete_source`` erasure legitimately orphans citations of
      erased sources — pass ``--allow-dangling`` to downgrade those to warnings
      on graphs where erasure has run).
  A2  every non-empty ``evidence_snippet`` is verbatim-present in its segment's
      text (the product writes empty snippets today; non-empty ones must match).
  A3  every segment's ``source_id`` resolves to a ``sources`` row.
  A4  graph↔provenance dual-write integrity: for every ID present on BOTH
      sides, ``passages.raw_text`` (graph.db) is byte-identical to
      ``source_segments.text`` (provenance.db). The two files are written in
      one ingest transaction; any divergence means post-hoc tampering or drift.
  A5  answers with zero citations (WARN only — an un-cited answer is not a
      hallucinated citation).

**Tier 2 — source-corpus anchoring** (``--corpus-dir``): matches sources to
original files and verifies segment text is present in them.

  Honesty note (read before interpreting results): the ingestion pipeline
  applies two REFERENCE-RESOLUTION rewrites before chunking — defined-term
  expansion ("the Company" → the defined name; deterministic) and coreference
  resolution (model-based). ``sources.content_hash`` anchors the sha256 of the
  *ingested* text (post-rewrite), and segments are chunks of that text (with
  paragraph reflow, sentence-overlap windows, and an optional injected
  ``[Session date: …]`` header). Therefore:

  B1  source↔file matching: ANCHORED_EXACT when sha256(file) == content_hash;
      ANCHORED_DEFINED_TERMS when the deterministic defined-terms replay of the
      file hashes to content_hash (requires tp_vrg importable; skipped
      gracefully otherwise); else UNANCHORED with the reason recorded
      (coref rewriting at ingest, or the file changed since ingest).
  B2  per-segment verbatim presence in the matched file, in descending
      strictness: VERBATIM_WHOLE (exact substring after stripping the injected
      session-date header) → VERBATIM_NORMALIZED (whitespace-normalized
      substring) → VERBATIM_UNITS (every sentence/paragraph unit of the
      segment present normalized — the chunker reflows paragraphs and overlaps
      sentences, so unit-level is the exact contract chunking preserves) →
      PARTIAL(x%) / ABSENT (failures).

Exit code 0 = no failures. Failures: any A1 dangling (unless --allow-dangling),
any A2/A3/A4 violation, any Tier-2 PARTIAL/ABSENT segment on an anchored
source, any UNANCHORED source (unless --allow-unanchored).

Stdlib-only by default (an external party needs no ML deps). Read-only on both
DBs (SQLite ``mode=ro``).

Usage (from anywhere; defaults resolve the canonical ~/.tp_vrg paths):
    python tools/provenance_audit.py
    python tools/provenance_audit.py --provenance-db path/to/provenance.db \
        --graph-db path/to/graph.db --corpus-dir path/to/sources --out report.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

# Mirrors the injected prefix from tp_vrg.ingestion._carry_session_date_to_chunks
_SESSION_DATE_PREFIX_RE = re.compile(r"^\[Session date: [^\]]+\]\s*")
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
_MIN_UNIT_CHARS = 20  # units shorter than this are too generic to anchor on


def _connect_ro(db_path: Path) -> sqlite3.Connection:
    uri = f"file:{db_path.as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _normalize_ws(text: str) -> str:
    return " ".join(text.split())


def _strip_session_header(text: str) -> str:
    return _SESSION_DATE_PREFIX_RE.sub("", text, count=1)


def _split_units(segment_text: str) -> list[str]:
    """Sentence/paragraph units — the granularity chunking preserves verbatim."""
    units: list[str] = []
    for para in segment_text.split("\n\n"):
        para = para.strip()
        if not para:
            continue
        sentences = [s.strip() for s in _SENTENCE_SPLIT_RE.split(para) if s.strip()]
        units.extend(sentences if sentences else [para])
    return units


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _try_defined_terms_replay(text: str) -> str | None:
    """Deterministic defined-terms replay, if tp_vrg is importable (optional)."""
    try:
        from tp_vrg.defined_terms import preprocess_defined_terms
    except Exception:
        return None
    try:
        replayed, _stats = preprocess_defined_terms(text)
        return replayed
    except Exception:
        return None


# --------------------------------------------------------------------- Tier 1


def audit_internal_chain(
    prov: sqlite3.Connection,
    graph: sqlite3.Connection | None,
    *,
    allow_dangling: bool,
) -> dict:
    report: dict = {"checks": {}, "failures": 0, "warnings": 0}

    segment_ids = {
        row["segment_id"]
        for row in prov.execute("SELECT segment_id FROM source_segments")
    }
    source_ids = {row["source_id"] for row in prov.execute("SELECT source_id FROM sources")}

    # A1 — citations resolve to segments
    citations = prov.execute(
        "SELECT answer_id, segment_id, cite_order, evidence_snippet FROM answer_citations"
    ).fetchall()
    dangling = [
        {"answer_id": c["answer_id"], "segment_id": c["segment_id"]}
        for c in citations
        if c["segment_id"] not in segment_ids
    ]
    a1_failed = bool(dangling) and not allow_dangling
    report["checks"]["A1_citations_resolve"] = {
        "citations_total": len(citations),
        "dangling": dangling,
        "status": "PASS" if not dangling else ("WARN" if allow_dangling else "FAIL"),
        "note": (
            "dangling citations can be legitimate on graphs where GDPR "
            "delete_source erasure has run (answer history survives, content "
            "is gone); --allow-dangling downgrades them to warnings"
            if dangling
            else ""
        ),
    }
    if a1_failed:
        report["failures"] += len(dangling)
    elif dangling:
        report["warnings"] += len(dangling)

    # A2 — non-empty evidence snippets are verbatim in their segment
    seg_text: dict[str, str] = {
        row["segment_id"]: row["text"]
        for row in prov.execute("SELECT segment_id, text FROM source_segments")
    }
    snippet_failures: list[dict] = []
    snippets_checked = 0
    for c in citations:
        snippet = (c["evidence_snippet"] or "").strip()
        if not snippet or c["segment_id"] not in seg_text:
            continue
        snippets_checked += 1
        segment = seg_text[c["segment_id"]]
        if snippet in segment:
            continue
        if _normalize_ws(snippet) in _normalize_ws(segment):
            continue
        snippet_failures.append(
            {"answer_id": c["answer_id"], "segment_id": c["segment_id"],
             "snippet_prefix": snippet[:80]}
        )
    report["checks"]["A2_snippets_verbatim"] = {
        "snippets_checked": snippets_checked,
        "failures": snippet_failures,
        "status": "PASS" if not snippet_failures else "FAIL",
    }
    report["failures"] += len(snippet_failures)

    # A3 — segments link to real sources
    orphan_segments = [
        row["segment_id"]
        for row in prov.execute("SELECT segment_id, source_id FROM source_segments")
        if row["source_id"] not in source_ids
    ]
    report["checks"]["A3_segments_have_sources"] = {
        "segments_total": len(segment_ids),
        "orphan_segments": orphan_segments,
        "status": "PASS" if not orphan_segments else "FAIL",
    }
    report["failures"] += len(orphan_segments)

    # A4 — graph↔provenance dual-write byte-identity (intersection of IDs)
    if graph is not None:
        passages = {
            row["passage_id"]: row["raw_text"]
            for row in graph.execute("SELECT passage_id, raw_text FROM passages")
        }
        both = set(passages) & set(seg_text)
        mismatches = [
            {"id": pid,
             "graph_prefix": (passages[pid] or "")[:60],
             "provenance_prefix": (seg_text[pid] or "")[:60]}
            for pid in sorted(both)
            if (passages[pid] or "") != (seg_text[pid] or "")
        ]
        report["checks"]["A4_dual_write_integrity"] = {
            "ids_on_both_sides": len(both),
            "graph_only_passages": len(set(passages) - set(seg_text)),
            "provenance_only_segments": len(set(seg_text) - set(passages)),
            "byte_mismatches": mismatches,
            "status": "PASS" if not mismatches else "FAIL",
        }
        report["failures"] += len(mismatches)
    else:
        report["checks"]["A4_dual_write_integrity"] = {
            "status": "SKIPPED", "note": "no --graph-db provided"
        }

    # A5 — answers with zero citations (WARN)
    zero_cite = prov.execute(
        """
        SELECT a.answer_id FROM answers a
        LEFT JOIN answer_citations c ON a.answer_id = c.answer_id
        GROUP BY a.answer_id HAVING COUNT(c.segment_id) = 0
        """
    ).fetchall()
    report["checks"]["A5_zero_citation_answers"] = {
        "count": len(zero_cite),
        "status": "PASS" if not zero_cite else "WARN",
    }
    report["warnings"] += len(zero_cite)

    return report


# --------------------------------------------------------------------- Tier 2


def _classify_segment(segment_text: str, file_text: str, file_norm: str) -> dict:
    body = _strip_session_header(segment_text)
    if body in file_text:
        return {"class": "VERBATIM_WHOLE", "fail": False}
    if _normalize_ws(body) in file_norm:
        return {"class": "VERBATIM_NORMALIZED", "fail": False}
    units = [u for u in _split_units(body) if len(u) >= _MIN_UNIT_CHARS]
    if not units:
        # Too short to unit-split meaningfully; the whole-segment checks above
        # already failed → treat as absent rather than vacuously passing.
        return {"class": "ABSENT", "fail": True, "units_total": 0, "units_present": 0}
    present = sum(1 for u in units if _normalize_ws(u) in file_norm)
    if present == len(units):
        return {"class": "VERBATIM_UNITS", "fail": False,
                "units_total": len(units), "units_present": present}
    return {
        "class": "PARTIAL" if present else "ABSENT",
        "fail": True,
        "units_total": len(units),
        "units_present": present,
    }


def audit_corpus_anchoring(
    prov: sqlite3.Connection,
    corpus_dir: Path,
    *,
    glob: str,
    allow_unanchored: bool,
) -> dict:
    report: dict = {"sources": [], "failures": 0, "warnings": 0}

    files: list[Path] = sorted(p for p in corpus_dir.rglob(glob) if p.is_file())
    file_texts: dict[Path, str] = {}
    hash_index: dict[str, Path] = {}
    replay_index: dict[str, Path] = {}
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        file_texts[path] = text
        hash_index[_sha256_text(text)] = path
        replayed = _try_defined_terms_replay(text)
        if replayed is not None and replayed != text:
            replay_index[_sha256_text(replayed)] = path

    sources = prov.execute(
        "SELECT source_id, source_label, content_hash FROM sources"
    ).fetchall()

    for src in sources:
        entry: dict = {
            "source_id": src["source_id"],
            "source_label": src["source_label"],
        }
        matched: Path | None = None
        matched_text: str | None = None
        if src["content_hash"] in hash_index:
            matched = hash_index[src["content_hash"]]
            matched_text = file_texts[matched]
            entry["anchoring"] = "ANCHORED_EXACT"
        elif src["content_hash"] in replay_index:
            matched = replay_index[src["content_hash"]]
            # Segments are chunks of the REPLAYED (defined-terms-expanded)
            # text, so verify against the replay, not the raw file.
            matched_text = _try_defined_terms_replay(file_texts[matched]) or ""
            entry["anchoring"] = "ANCHORED_DEFINED_TERMS"
        else:
            entry["anchoring"] = "UNANCHORED"
            entry["note"] = (
                "no corpus file hashes to this source's content_hash — either "
                "coref rewriting fired at ingest (not replayable externally), "
                "or the file changed since ingest, or it isn't in --corpus-dir"
            )
            entry["status"] = "WARN" if allow_unanchored else "FAIL"
            if allow_unanchored:
                report["warnings"] += 1
            else:
                report["failures"] += 1
            report["sources"].append(entry)
            continue

        entry["matched_file"] = str(matched)
        file_norm = _normalize_ws(matched_text or "")
        segs = prov.execute(
            "SELECT segment_id, text FROM source_segments WHERE source_id = ? ORDER BY seq",
            (src["source_id"],),
        ).fetchall()
        seg_results: dict[str, int] = {}
        seg_failures: list[dict] = []
        for seg in segs:
            verdict = _classify_segment(seg["text"] or "", matched_text or "", file_norm)
            seg_results[verdict["class"]] = seg_results.get(verdict["class"], 0) + 1
            if verdict["fail"]:
                seg_failures.append({"segment_id": seg["segment_id"], **verdict})
        entry["segments_total"] = len(segs)
        entry["segment_classes"] = seg_results
        entry["segment_failures"] = seg_failures
        entry["status"] = "PASS" if not seg_failures else "FAIL"
        report["failures"] += len(seg_failures)
        report["sources"].append(entry)

    return report


# ----------------------------------------------------------------------- main


def run_audit(
    provenance_db: Path,
    graph_db: Path | None,
    corpus_dir: Path | None,
    *,
    glob: str = "*",
    allow_dangling: bool = False,
    allow_unanchored: bool = False,
) -> dict:
    if not provenance_db.exists():
        raise FileNotFoundError(f"provenance DB not found: {provenance_db}")
    prov = _connect_ro(provenance_db)
    graph = None
    if graph_db is not None:
        if not graph_db.exists():
            raise FileNotFoundError(f"graph DB not found: {graph_db}")
        graph = _connect_ro(graph_db)

    try:
        report: dict = {
            "harness": "provenance_audit (M2.4)",
            "audited_at": datetime.now(timezone.utc).isoformat(),
            "provenance_db": str(provenance_db),
            "graph_db": str(graph_db) if graph_db else None,
            "corpus_dir": str(corpus_dir) if corpus_dir else None,
        }
        report["tier1_internal_chain"] = audit_internal_chain(
            prov, graph, allow_dangling=allow_dangling
        )
        if corpus_dir is not None:
            report["tier2_corpus_anchoring"] = audit_corpus_anchoring(
                prov, corpus_dir, glob=glob, allow_unanchored=allow_unanchored
            )
        else:
            report["tier2_corpus_anchoring"] = {
                "status": "SKIPPED", "note": "no --corpus-dir provided",
                "failures": 0, "warnings": 0,
            }

        failures = (
            report["tier1_internal_chain"]["failures"]
            + report["tier2_corpus_anchoring"].get("failures", 0)
        )
        warnings = (
            report["tier1_internal_chain"]["warnings"]
            + report["tier2_corpus_anchoring"].get("warnings", 0)
        )
        report["summary"] = {
            "failures": failures,
            "warnings": warnings,
            "verdict": "PASS" if failures == 0 else "FAIL",
        }
        return report
    finally:
        prov.close()
        if graph is not None:
            graph.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--provenance-db", type=Path, default=None,
                        help="path to provenance.db (default: canonical ~/.tp_vrg location)")
    parser.add_argument("--graph-db", type=Path, default=None,
                        help="path to graph.db for the dual-write check "
                             "(default: canonical location if it exists; pass "
                             "--no-graph to skip)")
    parser.add_argument("--no-graph", action="store_true",
                        help="skip the graph-side dual-write check")
    parser.add_argument("--corpus-dir", type=Path, default=None,
                        help="directory of original source files for Tier-2 anchoring")
    parser.add_argument("--glob", default="*", help="corpus file glob (default: *)")
    parser.add_argument("--allow-dangling", action="store_true",
                        help="downgrade dangling citations to warnings "
                             "(legitimate after GDPR erasure)")
    parser.add_argument("--allow-unanchored", action="store_true",
                        help="downgrade unanchored sources to warnings")
    parser.add_argument("--out", type=Path, default=None,
                        help="write the JSON report here (default: stdout only)")
    args = parser.parse_args(argv)

    provenance_db = args.provenance_db
    graph_db = args.graph_db
    if provenance_db is None or (graph_db is None and not args.no_graph):
        # Canonical defaults from the engine (INV-1) — guarded so the script
        # stays runnable by an external party without tp_vrg installed when
        # they pass explicit paths.
        try:
            from tp_vrg.data_dir import get_graph_db_path, get_provenance_db_path
            if provenance_db is None:
                provenance_db = get_provenance_db_path()
            if graph_db is None and not args.no_graph:
                candidate = get_graph_db_path()
                graph_db = candidate if candidate.exists() else None
        except Exception:
            if provenance_db is None:
                print(
                    "ERROR: --provenance-db required (tp_vrg not importable, "
                    "so the canonical default path cannot be resolved)",
                    file=sys.stderr,
                )
                return 2
    if args.no_graph:
        graph_db = None

    report = run_audit(
        provenance_db,
        graph_db,
        args.corpus_dir,
        glob=args.glob,
        allow_dangling=args.allow_dangling,
        allow_unanchored=args.allow_unanchored,
    )

    payload = json.dumps(report, indent=2)
    print(payload)
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(payload, encoding="utf-8")
        print(f"\nReport written: {args.out}", file=sys.stderr)
    return 0 if report["summary"]["verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
