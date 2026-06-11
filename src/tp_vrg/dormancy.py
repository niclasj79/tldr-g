"""Dormancy probe — does derived state actually FIRE? (Component Registry Phase-2a)

Sibling to the cardinality keystone: cardinality answers *does it scale?* (running
code under load); dormancy answers *does it fire?* (whether a derived-state writer is
actually invoked, and whether its consumer materially uses the result).

Read-only by construction: it statically scans the production source tree for callers
and opens the graph DB in SQLite read-only URI mode. It NEVER writes the graph.

Credibility = self-test: the probe MUST flag the two known-open dormancies —
  * the Asset-overlay backfill (`backfill_assets_by_source_document`) has no
    production caller (only tests + a retired research harness);
  * `assets.edition_seq` is frozen at 1 (re-ingest never increments it).
A probe that can't find the bugs we already know about isn't a probe.

Origin: the 2026-06-05 wiring-class cluster (4 derived-state writers that ran but
didn't fire / weren't consumed). Design: docs/design/arch-dormancy-detection-2026-06-05.md.
Backlog: [REGISTRY-LIVENESS-PREDICATES] + [DORMANCY-INVARIANT].
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Optional

_SRC_ROOT = Path(__file__).resolve().parent  # src/tp_vrg/


class LivenessKind(str, Enum):
    NO_CALLER = "no_caller"            # writer symbol has no production (non-test) caller
    FROZEN_DEFAULT = "frozen_default"  # a column exists but is never varied from its default
    COLUMN_POPULATED = "column_populated"  # a derived table/column has rows
    CONSUMER_INERT = "consumer_inert"  # a consumer of derived state doesn't materially use it


class Liveness(str, Enum):
    LIVE = "live"
    DORMANT = "dormant"
    OFF_BY_DESIGN = "off_by_design"   # default-off + not enabled → expected, not a defect
    UNKNOWN = "unknown"               # could not evaluate (e.g. table/DB absent)


@dataclass(frozen=True)
class DerivedStateWriter:
    """A piece of derived state + how to tell whether it actually fires."""
    id: str
    name: str
    kind: LivenessKind
    target: str                          # symbol name, or "table.column"
    notes: str = ""
    gated_off_env: Optional[str] = None  # if set and env-var not truthy → OFF_BY_DESIGN
    frozen_value: Any = None             # for FROZEN_DEFAULT: the constant to test against


# The canonical derived-state-writer registry the probe walks. Extend this whenever a
# new derived-state writer ships (the [DORMANCY-INVARIANT] discipline).
DERIVED_STATE_WRITERS: tuple[DerivedStateWriter, ...] = (
    DerivedStateWriter(
        "asset_id_backfill",
        "Asset overlay backfill (passages.asset_id)",
        LivenessKind.NO_CALLER,
        "backfill_assets_by_source_document",
        notes="Populates passages.asset_id from source_label. WIRED 2026-06-06 via "
              "Retriever._ensure_asset_backfill (lazy on-query, single-flight, idempotent) "
              "— that is the production caller, so the probe now reports LIVE (no longer "
              "NO_CALLER-dormant). [ASSET-OVERLAY-BACKFILL-WIRING].",
    ),
    DerivedStateWriter(
        "claim_supersession",
        "Temporal supersession (claim_validity.record_supersession)",
        LivenessKind.NO_CALLER,
        "record_supersession",
        notes="WIRED 2026-06-10 (supersession-unification): defined in "
              "claim_validity.py and driven from the asset-edition transition in "
              "storage_sqlite.advance_asset_edition — the superseded edition's "
              "claims get valid_at/invalid_at bounds in claim_validity. That bare "
              "call is the production caller, so the probe reports LIVE.",
    ),
    DerivedStateWriter(
        "asset_edition_seq",
        "Asset edition_seq (document versioning)",
        LivenessKind.NO_CALLER,
        "advance_asset_edition",
        notes="WIRED 2026-06-10 (supersession-unification): re-kinded from "
              "FROZEN_DEFAULT(assets.edition_seq=1) to the wired-writer check — "
              "backfill_assets_by_source_document advances the edition when a "
              "lineage's content hash changes (same group + new hash => "
              "edition_seq+1, prior marked superseded). The static caller scan is "
              "the INV-5 'writer fires' condition; live-graph VALUE variance "
              "arrives with the first real changed-doc re-ingest (edition 2 on "
              "the founder graph), which the test suite proves on a test DB.",
    ),
    DerivedStateWriter(
        "similarity_edges",
        "Similarity Axis (similarity_edges table)",
        LivenessKind.COLUMN_POPULATED,
        "similarity_edges",
        gated_off_env="TPVRG_SIMILARITY_EDGES",
        notes="Default-OFF (TPVRG_SIMILARITY_EDGES). 0 rows when off = expected, not "
              "dormant; the probe reports OFF_BY_DESIGN unless the flag is enabled.",
    ),
    DerivedStateWriter(
        "render_affinity_edges",
        "Render-Affinity Axis L3/RTWM (render_affinity_edges table)",
        LivenessKind.COLUMN_POPULATED,
        "render_affinity_edges",
        gated_off_env="TPVRG_RENDER_AFFINITY",
        notes="Default-OFF (TPVRG_RENDER_AFFINITY; shipped 2026-06-11 per the "
              "weighting-invariance verdict). Co-render edges from provenance traces "
              "+ HyPE synthetic cold-start; consumed by the Island-partition fold "
              "(TPVRG_PARTITION_USE_RENDER_AFFINITY). 0 rows when off = OFF_BY_DESIGN.",
    ),
    DerivedStateWriter(
        "node_provenance",
        "Node provenance reverse index (node_provenance table)",
        LivenessKind.COLUMN_POPULATED,
        "node_provenance",
        notes="Derived reverse index for source-cascade deletion. Populated during "
              "passage upsert and repairable via the backfill_node_provenance Janitor task.",
    ),
    DerivedStateWriter(
        "asset_overlay_consumer",
        "Asset overlay consumer (_apply_asset_overlay sibling-boost)",
        LivenessKind.CONSUMER_INERT,
        "_apply_asset_overlay",
        notes="Consumer-side liveness: does the overlay materially re-rank when asset_id "
              "is present? Synthetic exclusion-regime check (strong asset + a low-scoring "
              "answer sibling). LIVE = it pulls the sibling in. The §3 canary's 'no effect' "
              "was coverage-saturation, not a weak mechanism (verdict 2026-06-06).",
    ),
)


# --- static caller scan (no DB needed) -------------------------------------------

def _is_truthy_env(name: str, environ: Optional[dict[str, str]] = None) -> bool:
    import os
    env = os.environ if environ is None else environ
    return (env.get(name, "") or "").strip().lower() in {"1", "true", "yes", "on"}


def production_callers(symbol: str, src_root: Optional[Path] = None,
                       exclude_files: Optional[set[str]] = None) -> list[str]:
    """Production (src/tp_vrg/) references to `symbol` that are NOT its definition.

    Counts both direct calls `symbol(` and string references `"symbol"` (getattr-style
    dynamic dispatch). Excludes the `def symbol(` line and comment lines. Tests live
    under tests/ (outside src/tp_vrg/), so they are inherently excluded. The probe's
    own module is excluded by default — its DERIVED_STATE_WRITERS table names the
    symbols as strings, and that registry is not a caller.
    """
    root = src_root or _SRC_ROOT
    excluded = exclude_files if exclude_files is not None else {Path(__file__).name}
    call_pat = re.compile(rf"(?<![\w.]){re.escape(symbol)}\s*\(")
    str_pat = re.compile(rf"""['"]{re.escape(symbol)}['"]""")
    def_pat = re.compile(rf"\bdef\s+{re.escape(symbol)}\s*\(")
    refs: list[str] = []
    for py in sorted(root.rglob("*.py")):
        if py.name in excluded:
            continue
        try:
            lines = py.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for i, line in enumerate(lines, 1):
            stripped = line.lstrip()
            if stripped.startswith("#"):
                continue
            if def_pat.search(line):
                continue  # the definition itself
            if call_pat.search(line) or str_pat.search(line):
                refs.append(f"{py.relative_to(root.parent).as_posix()}:{i}")
    return refs


# --- DB checks (read-only) -------------------------------------------------------

def _ro_connect(db_path: Path) -> Optional[sqlite3.Connection]:
    if not Path(db_path).exists():
        return None
    try:
        return sqlite3.connect(f"file:{Path(db_path).as_posix()}?mode=ro", uri=True)
    except sqlite3.Error:
        return None


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


def _default_graph_db_path() -> Optional[Path]:
    try:
        from tp_vrg.data_dir import get_graph_db_path
        return Path(get_graph_db_path())
    except Exception:
        return None


def _eval_no_caller(w: DerivedStateWriter, src_root: Optional[Path]) -> dict[str, Any]:
    callers = production_callers(w.target, src_root)
    status = Liveness.LIVE if callers else Liveness.DORMANT
    return {"status": status, "evidence": {"production_callers": callers[:8],
                                           "production_caller_count": len(callers)}}


def _eval_frozen(w: DerivedStateWriter, conn: Optional[sqlite3.Connection]) -> dict[str, Any]:
    table, _, col = w.target.partition(".")
    if conn is None or not _table_exists(conn, table):
        return {"status": Liveness.UNKNOWN, "evidence": {"reason": "db_or_table_absent",
                                                         "target": w.target}}
    try:
        total = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        varied = conn.execute(
            f"SELECT COUNT(*) FROM {table} WHERE {col} IS NOT ?", (w.frozen_value,)
        ).fetchone()[0]
    except sqlite3.Error as exc:
        return {"status": Liveness.UNKNOWN, "evidence": {"reason": f"query_error: {exc}"}}
    if total == 0:
        return {"status": Liveness.UNKNOWN, "evidence": {"reason": "empty_table", "rows": 0}}
    status = Liveness.LIVE if varied > 0 else Liveness.DORMANT
    return {"status": status, "evidence": {"rows": total, "varied_from_default": varied,
                                           "frozen_value": w.frozen_value}}


def _eval_column_populated(w: DerivedStateWriter, conn: Optional[sqlite3.Connection],
                           environ: Optional[dict[str, str]]) -> dict[str, Any]:
    if w.gated_off_env and not _is_truthy_env(w.gated_off_env, environ):
        return {"status": Liveness.OFF_BY_DESIGN,
                "evidence": {"gated_off_env": w.gated_off_env, "enabled": False}}
    table = w.target.split(".")[0]
    if conn is None or not _table_exists(conn, table):
        return {"status": Liveness.UNKNOWN, "evidence": {"reason": "db_or_table_absent",
                                                         "target": w.target}}
    try:
        rows = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    except sqlite3.Error as exc:
        return {"status": Liveness.UNKNOWN, "evidence": {"reason": f"query_error: {exc}"}}
    status = Liveness.LIVE if rows > 0 else Liveness.DORMANT
    return {"status": status, "evidence": {"rows": rows}}


def _eval_consumer_inert(w: DerivedStateWriter) -> dict[str, Any]:
    """Consumer-side liveness: run the consumer with a synthetic input where it SHOULD
    act (a strong asset + a low-scoring answer-bearing sibling) and check it materially
    changes the result. LIVE = the consumer uses the derived state; DORMANT = inert.

    This is the sharper liveness class the §3 re-canary surfaced: a writer can fire while
    its consumer barely uses the result. Mirrors tests/test_asset_overlay_consumer_liveness.py.
    """
    try:
        from types import SimpleNamespace
        from tp_vrg.retrieval import Retriever
    except Exception as exc:  # pragma: no cover - import guard
        return {"status": Liveness.UNKNOWN, "evidence": {"reason": f"import_failed: {exc}"}}

    class _SyntheticStorage:
        def get_asset_ids_for_passages(self, pids):
            m = {"p1": "A", "p2": "A"}
            return {p: m[p] for p in pids if p in m}

        def get_passage_ids_for_assets(self, asset_ids, limit_per_asset=3):
            return {"A": ["p1", "p2", "p_ans"]} if "A" in asset_ids else {}

    stub = SimpleNamespace(
        _storage=_SyntheticStorage(),
        _asset_overlay_mode=lambda: "active",
        _last_sentence_peer_entry_points=[],
        _last_asset_overlay_trace=None,
        _ensure_asset_backfill=lambda: None,  # synthetic storage pre-populated; no lazy backfill
    )
    try:
        out = Retriever._apply_asset_overlay(stub, {"p1": 0.9, "p2": 0.85}, top_k=10)
    except Exception as exc:
        return {"status": Liveness.UNKNOWN, "evidence": {"reason": f"call_failed: {exc}"}}
    pulled_in = "p_ans" in out and out.get("p_ans", 0.0) > 0.8
    return {
        "status": Liveness.LIVE if pulled_in else Liveness.DORMANT,
        "evidence": {
            "synthetic": "strong-asset + low-scoring answer-sibling",
            "pulled_in_sibling": pulled_in,
            "boosted_score": round(out.get("p_ans", 0.0), 4),
            "note": "within-asset densification; cross-asset bridging is NOT done here.",
        },
    }


def probe_dormancy(
    db_path: Optional[Path | str] = None,
    *,
    src_root: Optional[Path] = None,
    environ: Optional[dict[str, str]] = None,
    writers: tuple[DerivedStateWriter, ...] = DERIVED_STATE_WRITERS,
) -> dict[str, Any]:
    """Evaluate every derived-state writer. Read-only. Returns a structured report.

    db_path: the graph DB to introspect (defaults to the canonical graph path). DB
    checks degrade to UNKNOWN if the DB/table is absent; the NO_CALLER static checks
    never need a DB, so the known-dormancy self-test runs without one.
    """
    resolved_db = Path(db_path) if db_path is not None else _default_graph_db_path()
    conn = _ro_connect(resolved_db) if resolved_db else None
    try:
        results: list[dict[str, Any]] = []
        for w in writers:
            if w.kind is LivenessKind.NO_CALLER:
                ev = _eval_no_caller(w, src_root)
            elif w.kind is LivenessKind.FROZEN_DEFAULT:
                ev = _eval_frozen(w, conn)
            elif w.kind is LivenessKind.COLUMN_POPULATED:
                ev = _eval_column_populated(w, conn, environ)
            elif w.kind is LivenessKind.CONSUMER_INERT:
                ev = _eval_consumer_inert(w)
            else:
                ev = {"status": Liveness.UNKNOWN, "evidence": {"reason": "unknown_kind"}}
            results.append({
                "id": w.id, "name": w.name, "kind": w.kind.value,
                "target": w.target, "status": ev["status"].value,
                "evidence": ev["evidence"], "notes": w.notes,
            })
    finally:
        if conn is not None:
            conn.close()
    dormant = [r for r in results if r["status"] == Liveness.DORMANT.value]
    return {
        "db_path": str(resolved_db) if resolved_db else None,
        "db_available": conn is not None,
        "checked": len(results),
        "dormant_count": len(dormant),
        "dormant_ids": [r["id"] for r in dormant],
        "writers": results,
    }


_HEALTH_CACHE: Optional[dict[str, Any]] = None


def dormancy_health_field(db_path: Optional[Path | str] = None, *, refresh: bool = False) -> dict[str, Any]:
    """Compact, process-memoized summary for the /health endpoint.

    Memoized for the process lifetime so /health (a frequently-polled hot path) never
    re-runs the source scan / DB open. The on-demand /diagnostics/dormancy endpoint
    always runs a fresh full probe.
    """
    global _HEALTH_CACHE
    if _HEALTH_CACHE is not None and not refresh:
        return _HEALTH_CACHE
    report = probe_dormancy(db_path)
    _HEALTH_CACHE = {
        "checked": report["checked"],
        "dormant_count": report["dormant_count"],
        "dormant_ids": report["dormant_ids"],
        "db_available": report["db_available"],
    }
    return _HEALTH_CACHE
