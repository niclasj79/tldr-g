"""Pattern 2 speculative pre-render cache storage.
Implements the invalidation-aware bundle cache from the Pattern 2 design doc.
Cache lookup is fast, but never serves without a current invalidation token.
"""
from __future__ import annotations
from dataclasses import dataclass
import os
import time
from collections.abc import Sequence
import numpy as np
DEFAULT_MATCH_THRESHOLD = 0.85
DEFAULT_MAX_CACHE_BYTES = 100 * 1024 * 1024
DEFAULT_TTL_DAYS = 7.0
@dataclass(frozen=True)
class CacheResult:
    hit: bool
    reason: str
    cluster_id: str | None = None
    representative_query_text: str | None = None
    rendered_bundle: bytes | None = None
    bundle_lod_tier: int | None = None
    similarity: float = 0.0
def _now() -> float:
    return time.time()
def configured_ttl_days() -> float:
    raw = os.environ.get("TPVRG_SPECULATIVE_BUNDLE_TTL_DAYS", str(DEFAULT_TTL_DAYS))
    try:
        ttl = float(raw.strip())
    except ValueError as exc:
        raise ValueError("TPVRG_SPECULATIVE_BUNDLE_TTL_DAYS must be numeric") from exc
    if ttl <= 0:
        raise ValueError("TPVRG_SPECULATIVE_BUNDLE_TTL_DAYS must be > 0")
    return ttl
def init_schema(conn) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS speculative_prerender_cache (
          cluster_id TEXT PRIMARY KEY, representative_query_text TEXT NOT NULL,
          query_embedding BLOB NOT NULL, rendered_bundle BLOB NOT NULL,
          bundle_lod_tier INTEGER NOT NULL, baked_at REAL NOT NULL,
          invalidation_token TEXT NOT NULL, hit_count INTEGER NOT NULL DEFAULT 0,
          miss_count INTEGER NOT NULL DEFAULT 0, last_accessed_at REAL NOT NULL,
          bundle_size_bytes INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_spec_cache_baked_at ON speculative_prerender_cache(baked_at);
        CREATE INDEX IF NOT EXISTS idx_spec_cache_last_accessed ON speculative_prerender_cache(last_accessed_at);
        """
    )
    conn.commit()
def _vector_blob(values: Sequence[float] | np.ndarray) -> bytes:
    vector = np.asarray(values, dtype=np.float32)
    if vector.ndim != 1 or vector.size == 0 or not np.all(np.isfinite(vector)):
        raise ValueError("query_embedding must be a finite one-dimensional vector")
    norm = float(np.linalg.norm(vector))
    if norm == 0.0:
        raise ValueError("query_embedding must be non-zero")
    return (vector / norm).astype(np.float32).tobytes()
def _blob_vector(blob: bytes) -> np.ndarray:
    vector = np.frombuffer(bytes(blob), dtype=np.float32)
    if vector.ndim != 1 or vector.size == 0 or not np.all(np.isfinite(vector)):
        raise ValueError("cached query_embedding is invalid")
    return vector
def _cosine(left: np.ndarray, right: np.ndarray) -> float:
    if left.shape != right.shape:
        raise ValueError(f"cache embedding dimension mismatch: {left.shape} != {right.shape}")
    return float(np.dot(left, right) / (np.linalg.norm(left) * np.linalg.norm(right)))
def _require_token(token: str) -> str:
    if not token or not str(token).strip():
        raise ValueError("current_invalidation_token is required for speculative cache lookup")
    return str(token)
def _cache_size(conn) -> int:
    row = conn.execute(
        "SELECT COALESCE(SUM(bundle_size_bytes + length(query_embedding)), 0) "
        "FROM speculative_prerender_cache"
    ).fetchone()
    return int(row[0] or 0)
def enforce_cache_size_limit(conn, *, max_bytes: int = DEFAULT_MAX_CACHE_BYTES) -> int:
    if max_bytes <= 0:
        raise ValueError("max_bytes must be > 0")
    init_schema(conn)
    evicted = 0
    while _cache_size(conn) > max_bytes:
        row = conn.execute(
            "SELECT cluster_id FROM speculative_prerender_cache "
            "ORDER BY last_accessed_at ASC, baked_at ASC LIMIT 1"
        ).fetchone()
        if row is None:
            break
        conn.execute("DELETE FROM speculative_prerender_cache WHERE cluster_id = ?", (row[0],))
        evicted += 1
    conn.commit()
    return evicted
def upsert_bundle(
    cluster_id: str,
    rep_query: str,
    query_embedding: Sequence[float] | np.ndarray,
    bundle: bytes | str,
    lod_tier: int,
    invalidation_token: str,
    conn,
    *,
    baked_at: float | None = None,
    max_cache_bytes: int = DEFAULT_MAX_CACHE_BYTES,
) -> None:
    init_schema(conn)
    token = _require_token(invalidation_token)
    if lod_tier < 0:
        raise ValueError("lod_tier must be >= 0")
    bundle_bytes = bundle.encode("utf-8") if isinstance(bundle, str) else bytes(bundle)
    if not bundle_bytes:
        raise ValueError("rendered bundle must be non-empty")
    now = _now() if baked_at is None else float(baked_at)
    conn.execute(
        """
        INSERT INTO speculative_prerender_cache (cluster_id, representative_query_text,
          query_embedding, rendered_bundle, bundle_lod_tier, baked_at, invalidation_token,
          last_accessed_at, bundle_size_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cluster_id) DO UPDATE SET
          representative_query_text = excluded.representative_query_text,
          query_embedding = excluded.query_embedding, rendered_bundle = excluded.rendered_bundle,
          bundle_lod_tier = excluded.bundle_lod_tier, baked_at = excluded.baked_at,
          invalidation_token = excluded.invalidation_token, last_accessed_at = excluded.last_accessed_at,
          bundle_size_bytes = excluded.bundle_size_bytes
        """,
        (cluster_id, rep_query, _vector_blob(query_embedding), bundle_bytes, int(lod_tier),
         now, token, now, len(bundle_bytes)),
    )
    conn.commit()
    enforce_cache_size_limit(conn, max_bytes=max_cache_bytes)
def _is_expired(baked_at: float, *, now: float, ttl_days: float) -> bool:
    return now - float(baked_at) > ttl_days * 86400.0
def lookup_bundle(query_text: str, query_embedding: Sequence[float] | np.ndarray, intent: object, conn, *,
                  current_invalidation_token: str, threshold: float = DEFAULT_MATCH_THRESHOLD,
                  now: float | None = None, ttl_days: float | None = None) -> CacheResult:
    del query_text, intent
    init_schema(conn)
    token = _require_token(current_invalidation_token)
    query = _blob_vector(_vector_blob(query_embedding))
    rows = conn.execute(
        "SELECT cluster_id, representative_query_text, query_embedding, rendered_bundle, "
        "bundle_lod_tier, baked_at, invalidation_token FROM speculative_prerender_cache"
    ).fetchall()
    if not rows:
        return CacheResult(False, "empty")
    best = max(rows, key=lambda row: _cosine(query, _blob_vector(row[2])))
    similarity = _cosine(query, _blob_vector(best[2]))
    if similarity < threshold:
        conn.execute("UPDATE speculative_prerender_cache SET miss_count = miss_count + 1 WHERE cluster_id = ?", (best[0],))
        conn.commit()
        return CacheResult(False, "below_threshold", str(best[0]), similarity=similarity)
    if str(best[6]) != token:
        conn.execute("UPDATE speculative_prerender_cache SET miss_count = miss_count + 1 WHERE cluster_id = ?", (best[0],))
        conn.commit()
        return CacheResult(False, "stale_token", str(best[0]), similarity=similarity)
    current_time = _now() if now is None else float(now)
    if _is_expired(float(best[5]), now=current_time, ttl_days=ttl_days or configured_ttl_days()):
        conn.execute("UPDATE speculative_prerender_cache SET miss_count = miss_count + 1 WHERE cluster_id = ?", (best[0],))
        conn.commit()
        return CacheResult(False, "expired", str(best[0]), similarity=similarity)
    conn.execute(
        "UPDATE speculative_prerender_cache SET hit_count = hit_count + 1, "
        "last_accessed_at = ? WHERE cluster_id = ?",
        (current_time, best[0]),
    )
    conn.commit()
    return CacheResult(True, "hit", str(best[0]), str(best[1]), bytes(best[3]), int(best[4]), similarity)
def invalidate_all_stale(conn, current_invalidation_token: str, *, now: float | None = None, ttl_days: float | None = None) -> int:
    init_schema(conn)
    token = _require_token(current_invalidation_token)
    cutoff = (_now() if now is None else float(now)) - (ttl_days or configured_ttl_days()) * 86400.0
    before = conn.execute("SELECT COUNT(*) FROM speculative_prerender_cache").fetchone()[0]
    conn.execute(
        "DELETE FROM speculative_prerender_cache WHERE invalidation_token != ? OR baked_at < ?",
        (token, cutoff),
    )
    conn.commit()
    after = conn.execute("SELECT COUNT(*) FROM speculative_prerender_cache").fetchone()[0]
    return int(before) - int(after)
def cache_stats(conn) -> dict[str, object]:
    init_schema(conn)
    rows = conn.execute(
        "SELECT cluster_id, representative_query_text, baked_at, hit_count, miss_count, "
        "bundle_size_bytes FROM speculative_prerender_cache ORDER BY cluster_id"
    ).fetchall()
    now = _now()
    clusters = []
    hits = misses = size = 0
    for cluster_id, rep, baked_at, hit_count, miss_count, bundle_size in rows:
        h, m, s = int(hit_count), int(miss_count), int(bundle_size)
        hits += h; misses += m; size += s
        clusters.append({"cluster_id": str(cluster_id), "representative_query_text": str(rep),
                         "hit_count": h, "miss_count": m, "hit_rate": h / max(h + m, 1),
                         "bundle_age_seconds": max(0.0, now - float(baked_at)), "bundle_size_bytes": s})
    return {
        "aggregate": {"hit_count": hits, "miss_count": misses, "hit_rate": hits / max(hits + misses, 1)},
        "cache_size_bytes": size,
        "clusters": clusters,
    }
