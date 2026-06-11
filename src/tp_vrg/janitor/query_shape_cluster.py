"""Pattern 2 query-shape clustering for speculative pre-render prediction.

Implements the core "predict likely next-queries" step from
docs/design/arch-janitor-as-rendering-primitive.md Pattern 2: cluster recent
query shapes by sigma-fingerprint similarity so the Janitor can pre-render
LOW LOD bundles for likely future turns.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import sqlite3
from collections.abc import Callable, Sequence

import numpy as np

from tp_vrg.intent import INTENT_AXES, IntentSignal, classify_intent

DEFAULT_HISTORY_WINDOW_HOURS = 72
DEFAULT_CLUSTER_THRESHOLD = 0.85
DEFAULT_TOP_N_CLUSTERS = 20

_WH_TYPES = ("what", "who", "when", "where", "why", "how")

@dataclass(frozen=True)
class QueryEvent:
    query_text: str
    observed_at: datetime | None = None

@dataclass(frozen=True)
class QueryShapeCluster:
    cluster_id: str
    representative_query_text: str
    member_queries: tuple[str, ...]
    cluster_centroid: tuple[float, ...]
    member_count: int

def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None

def _parse_observed_at(value: object) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)

def _history_rows(conn: sqlite3.Connection, table_name: str, text_column: str, time_column: str) -> list[QueryEvent]:
    rows = conn.execute(
        f"SELECT {text_column}, {time_column} FROM {table_name} ORDER BY {time_column}"
    ).fetchall()
    return [
        QueryEvent(text, _parse_observed_at(observed_at))
        for query_text, observed_at in rows
        if (text := str(query_text or "").strip())
    ]

def read_recent_query_events(
    conn: sqlite3.Connection,
    *,
    window_hours: int = DEFAULT_HISTORY_WINDOW_HOURS,
    now: datetime | None = None,
) -> list[QueryEvent]:
    """Read recent query events from query history or the provenance answers log."""
    if window_hours <= 0:
        raise ValueError("window_hours must be > 0")

    if _table_exists(conn, "query_history"):
        events = _history_rows(conn, "query_history", "query_text", "observed_at")
    elif _table_exists(conn, "answers"):
        events = _history_rows(conn, "answers", "query_text", "answered_at")
    else:
        return []

    cutoff = (now or datetime.now(timezone.utc)) - timedelta(hours=window_hours)
    return [event for event in events if event.observed_at is None or event.observed_at >= cutoff]

def intent_to_sigma_fingerprint(intent: IntentSignal) -> np.ndarray:
    wh = (intent.wh_type or "what").lower()
    values = [float(intent.content_axes.get(axis, 0.0)) for axis in INTENT_AXES]
    values.extend([
        float(intent.exhaustiveness),
        float(intent.reasoning_depth),
        float(intent.specificity),
        1.0 if intent.temporal_reference_date is not None else 0.0,
    ])
    values.extend(1.0 if wh == wh_type else 0.0 for wh_type in _WH_TYPES)
    vector = np.asarray(values, dtype=np.float32)
    if vector.size == 0 or not np.all(np.isfinite(vector)):
        raise ValueError("intent sigma-fingerprint is empty or non-finite")
    norm = float(np.linalg.norm(vector))
    if norm == 0.0:
        raise ValueError("intent sigma-fingerprint is zero")
    return (vector / norm).astype(np.float32)

def query_to_sigma_fingerprint(
    query_text: str,
    *,
    classify: Callable[[str], IntentSignal] = classify_intent,
) -> np.ndarray:
    text = query_text.strip()
    if not text:
        raise ValueError("query_text must be non-empty")
    return intent_to_sigma_fingerprint(classify(text))


def cosine_similarity(left: Sequence[float] | np.ndarray, right: Sequence[float] | np.ndarray) -> float:
    """Return cosine similarity for two non-zero vectors."""
    a = np.asarray(left, dtype=np.float32)
    b = np.asarray(right, dtype=np.float32)
    if a.shape != b.shape:
        raise ValueError(f"dimension mismatch: {a.shape} != {b.shape}")
    a_norm = float(np.linalg.norm(a))
    b_norm = float(np.linalg.norm(b))
    if a_norm == 0.0 or b_norm == 0.0:
        raise ValueError("cosine similarity requires non-zero vectors")
    return float(np.dot(a, b) / (a_norm * b_norm))


def _cluster_id(representative_query_text: str, centroid: np.ndarray) -> str:
    payload = {
        "representative": " ".join(representative_query_text.lower().split()),
        "centroid": [round(float(value), 6) for value in centroid],
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "qshape:" + hashlib.sha256(encoded).hexdigest()[:16]


def cluster_query_shapes(
    events: Sequence[QueryEvent | str],
    *,
    threshold: float = DEFAULT_CLUSTER_THRESHOLD,
    top_n: int | None = DEFAULT_TOP_N_CLUSTERS,
    classify: Callable[[str], IntentSignal] = classify_intent,
) -> list[QueryShapeCluster]:
    """Cluster recent queries by sigma-fingerprint cosine similarity."""
    if not 0.0 < threshold <= 1.0:
        raise ValueError("threshold must be in (0, 1]")
    if top_n is not None and top_n <= 0:
        raise ValueError("top_n must be > 0 when provided")

    buckets: list[dict[str, object]] = []
    for item in events:
        query_text = item.query_text if isinstance(item, QueryEvent) else str(item)
        query_text = query_text.strip()
        if not query_text:
            continue
        vector = query_to_sigma_fingerprint(query_text, classify=classify)
        best_index: int | None = None
        best_score = threshold
        for index, bucket in enumerate(buckets):
            score = cosine_similarity(vector, bucket["centroid"])  # type: ignore[arg-type]
            if score >= best_score:
                best_index = index
                best_score = score
        if best_index is None:
            buckets.append({"queries": [query_text], "vectors": [vector], "centroid": vector})
            continue
        bucket = buckets[best_index]
        queries = bucket["queries"]  # type: ignore[assignment]
        vectors = bucket["vectors"]  # type: ignore[assignment]
        queries.append(query_text); vectors.append(vector)
        centroid = np.mean(np.vstack(vectors), axis=0).astype(np.float32)
        bucket["centroid"] = centroid / float(np.linalg.norm(centroid))

    clusters: list[QueryShapeCluster] = []
    for bucket in buckets:
        queries = tuple(bucket["queries"])  # type: ignore[arg-type]
        centroid = np.asarray(bucket["centroid"], dtype=np.float32)
        clusters.append(
            QueryShapeCluster(
                cluster_id=_cluster_id(queries[0], centroid),
                representative_query_text=queries[0],
                member_queries=queries,
                cluster_centroid=tuple(float(value) for value in centroid),
                member_count=len(queries),
            )
        )
    clusters.sort(key=lambda cluster: (-cluster.member_count, cluster.cluster_id))
    return clusters[:top_n] if top_n is not None else clusters

