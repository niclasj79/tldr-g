"""B2 registration wrappers for storage providers."""

from __future__ import annotations

from ..contracts import CostEstimate
from ..registry import get_registry


class SQLiteVecStorageAdapter:
    """Adapter wrapper for the existing SQLite vec0 storage backend."""

    component_id = "sqlite_vec0"
    component_family = "storage"

    def availability_check(self) -> bool:
        try:
            from tp_vrg.storage_sqlite import SQLiteBackend

            return SQLiteBackend is not None
        except Exception:
            return False

    def cost_estimate(self, work_item) -> CostEstimate:
        return CostEstimate(
            compute_ms=None,
            tokens_in=None,
            tokens_out=None,
            cryptographic_ops=0,
            confidence=0.0,
        )


def register_defaults() -> None:
    registry = get_registry()
    registry.register("B2", "sqlite_vec0", SQLiteVecStorageAdapter())
