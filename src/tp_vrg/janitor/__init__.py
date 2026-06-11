"""Janitor package facade plus focused bake tasks.

The historical ``GraphJanitor`` implementation lives in ``tp_vrg/janitor.py``.
This facade keeps legacy imports working while allowing focused bake modules
under ``tp_vrg.janitor``.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_LEGACY_JANITOR_PATH = Path(__file__).resolve().parent.parent / "janitor.py"
_SPEC = importlib.util.spec_from_file_location(
    "tp_vrg._legacy_janitor",
    _LEGACY_JANITOR_PATH,
)
if _SPEC is None or _SPEC.loader is None:
    raise ImportError(f"Unable to load legacy janitor module at {_LEGACY_JANITOR_PATH}")

_LEGACY_JANITOR = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _LEGACY_JANITOR
_SPEC.loader.exec_module(_LEGACY_JANITOR)

for _name in dir(_LEGACY_JANITOR):
    if not _name.startswith("_"):
        globals()[_name] = getattr(_LEGACY_JANITOR, _name)

__all__ = [name for name in globals() if not name.startswith("_")]
