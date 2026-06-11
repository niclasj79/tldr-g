"""Storage package facade plus focused storage helpers.

The historical storage abstraction lives in ``tp_vrg/storage.py``.  This
package facade keeps ``from tp_vrg.storage import StorageBackend`` working
while allowing focused submodules such as ``tp_vrg.storage.community_partitions``.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_LEGACY_STORAGE_PATH = Path(__file__).resolve().parent.parent / "storage.py"
_SPEC = importlib.util.spec_from_file_location(
    "_tp_vrg_legacy_storage",
    _LEGACY_STORAGE_PATH,
)
if _SPEC is None or _SPEC.loader is None:
    raise ImportError(f"Unable to load legacy storage module at {_LEGACY_STORAGE_PATH}")

_LEGACY_STORAGE = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _LEGACY_STORAGE
_SPEC.loader.exec_module(_LEGACY_STORAGE)

for _name in dir(_LEGACY_STORAGE):
    if not _name.startswith("_"):
        globals()[_name] = getattr(_LEGACY_STORAGE, _name)

__all__ = [name for name in globals() if not name.startswith("_")]
