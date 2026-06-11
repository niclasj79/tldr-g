"""SQLite-backed content-hash embedding cache."""

from __future__ import annotations

import hashlib
import sqlite3
import time
from collections import defaultdict

import numpy as np


class EmbeddingCache:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    @staticmethod
    def hash_text(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]

    def lookup(self, content_hash: str, model_id: str) -> np.ndarray | None:
        row = self._conn.execute(
            "SELECT embedding, dimension FROM embedding_cache WHERE content_hash=? AND model_id=?",
            (content_hash, model_id),
        ).fetchone()
        if row is None:
            return None
        blob, dim = row
        vec = np.frombuffer(blob, dtype=np.float32)
        if vec.size != int(dim):
            raise ValueError(f"Embedding cache corruption for ({content_hash}, {model_id}): dim={dim}, bytes={len(blob)}")
        now = int(time.time())
        self._conn.execute(
            "UPDATE embedding_cache SET last_accessed_at=?, hit_count=hit_count+1 WHERE content_hash=? AND model_id=?",
            (now, content_hash, model_id),
        )
        self._conn.commit()
        return vec

    def write(self, content_hash: str, model_id: str, embedding: np.ndarray, dimension: int) -> None:
        vec = np.asarray(embedding, dtype=np.float32)
        if vec.ndim != 1 or vec.size != int(dimension):
            raise ValueError(f"Dimension mismatch: vec.size={vec.size}, dimension={dimension}")
        now = int(time.time())
        self._conn.execute(
            """
            INSERT INTO embedding_cache(content_hash, model_id, embedding, dimension, created_at, last_accessed_at, hit_count)
            VALUES(?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(content_hash, model_id) DO UPDATE SET
              embedding=excluded.embedding,
              dimension=excluded.dimension,
              last_accessed_at=excluded.last_accessed_at
            """,
            (content_hash, model_id, vec.tobytes(), int(dimension), now, now),
        )
        self._conn.commit()

    def stats(self) -> dict:
        total_entries = int(self._conn.execute("SELECT COUNT(*) FROM embedding_cache").fetchone()[0])
        rows = self._conn.execute("SELECT model_id, COUNT(*) FROM embedding_cache GROUP BY model_id").fetchall()
        by_model = {m: int(c) for m, c in rows}
        bytes_total = int(self._conn.execute("SELECT COALESCE(SUM(length(embedding)),0) FROM embedding_cache").fetchone()[0])
        oldest, newest = self._conn.execute("SELECT MIN(created_at), MAX(created_at) FROM embedding_cache").fetchone()
        return {
            "total_entries": total_entries,
            "by_model": by_model,
            "total_bytes": bytes_total,
            "oldest": oldest,
            "newest": newest,
        }

    def integrity_check(self) -> bool:
        rows = self._conn.execute(
            "SELECT embedding, dimension FROM embedding_cache ORDER BY RANDOM() LIMIT 10"
        ).fetchall()
        for blob, dim in rows:
            vec = np.frombuffer(blob, dtype=np.float32)
            if vec.size != int(dim):
                return False
        return True
