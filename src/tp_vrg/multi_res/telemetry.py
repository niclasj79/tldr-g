"""In-process telemetry for multi-resolution descent traces."""

from __future__ import annotations

from collections import Counter
from typing import Any

from tp_vrg.multi_res.descent_algorithm import PassageScope

_last_scope: PassageScope | None = None
_counters: Counter[str] = Counter()


def record_descent_scope(scope: PassageScope) -> None:
    """Record the latest descent scope and update per-rung counters."""
    global _last_scope
    _last_scope = scope
    if scope.skipped:
        _counters["descent_skipped"] += 1
        return
    for trace in scope.descent_trace:
        _counters[f"descent_{trace.level}_visited"] += trace.candidate_count
        if trace.bottomed_out:
            _counters[f"descent_bottomed_out_at_{trace.level}"] += 1


def descent_scope_to_json(scope: PassageScope | None) -> dict[str, Any]:
    if scope is None:
        return {"hit": False, "trace": [], "counters": dict(_counters)}
    return {
        "hit": True,
        "skipped": scope.skipped,
        "skip_reason": scope.skip_reason,
        "passage_ids": list(scope.passage_ids),
        "final_beam": [
            {"community_id": c.community_id, "level": c.level, "score": c.score}
            for c in scope.final_beam
        ],
        "trace": [
            {
                "level": t.level,
                "candidate_ids": list(t.candidate_ids),
                "candidate_count": t.candidate_count,
                "pruned_to": t.pruned_to,
                "bottomed_out": t.bottomed_out,
                "bottom_out_reason": t.bottom_out_reason,
            }
            for t in scope.descent_trace
        ],
        "counters": dict(_counters),
    }


def get_last_descent_trace(query_id: str | None = None) -> dict[str, Any]:
    """Return the latest trace; query_id is reserved for persisted traces."""
    return descent_scope_to_json(_last_scope)


def reset_descent_telemetry() -> None:
    global _last_scope
    _last_scope = None
    _counters.clear()
