"""Append-only JSONL progress writer with lock + size rotation."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from tp_vrg.data_dir import get_data_dir

DEFAULT_PROGRESS_FILE = get_data_dir() / "progress.jsonl"
MAX_BYTES = 50 * 1024 * 1024
MAX_ROTATIONS = 3

# Module-level lock for in-process thread serialization.
# The OS-level file lock (msvcrt/fcntl below) handles cross-process safety,
# but Python's buffered I/O in "a+" mode on Windows doesn't cleanly pair
# with msvcrt.locking for thread contention — the 10-second retry limit
# can bubble exceptions under load and the fail-open except-path then
# permits torn writes. This in-process lock removes the contention for
# the common (single-process, many-thread) case; the OS lock remains for
# the cross-process case. Standard pattern — Python's logging
# RotatingFileHandler uses the same approach.
_WRITE_LOCK = threading.Lock()


def _lock_file(file_obj: Any) -> None:
    """Best-effort exclusive file lock (fail-open).

    Locks a fixed sentinel byte at position 0 so all writers serialize on
    the same region. Previously used seek-to-end, but msvcrt.locking locks
    N bytes starting at the current file position — and each writer has a
    different EOF position, so writers ended up locking different bytes
    and never achieving mutual exclusion (fails ~66% of the time under
    16-thread × 200-event load; ~2 events lost per failure).
    """
    try:
        if os.name == "nt":
            import msvcrt

            # Fix lock region to byte 0 for cross-writer serialization.
            # Locking past EOF is permitted on Windows, so an empty file
            # is also fine.
            file_obj.seek(0)
            msvcrt.locking(file_obj.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            # fcntl.flock locks the whole file regardless of position.
            fcntl.flock(file_obj.fileno(), fcntl.LOCK_EX)
    except Exception:
        # Fail-open by design: append-only writes are still acceptable.
        return


def _unlock_file(file_obj: Any) -> None:
    """Best-effort unlock matching _lock_file (fail-open)."""
    try:
        if os.name == "nt":
            import msvcrt

            # Must unlock the same range that was locked (byte 0, length 1).
            file_obj.seek(0)
            msvcrt.locking(file_obj.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(file_obj.fileno(), fcntl.LOCK_UN)
    except Exception:
        return


def _rotate_if_needed(path: Path) -> None:
    if not path.exists():
        return
    if path.stat().st_size <= MAX_BYTES:
        return

    oldest = path.with_name(f"{path.name}.{MAX_ROTATIONS}")
    if oldest.exists():
        oldest.unlink()
    for idx in range(MAX_ROTATIONS - 1, 0, -1):
        src = path.with_name(f"{path.name}.{idx}")
        if src.exists():
            src.rename(path.with_name(f"{path.name}.{idx + 1}"))
    path.rename(path.with_name(f"{path.name}.1"))


def append_event(event: dict[str, Any], path: Path = DEFAULT_PROGRESS_FILE) -> None:
    """Append one event to the progress JSONL file, with lock + rotation.

    Two-tier locking:
      1. In-process: module-level threading.Lock serializes threads.
      2. Cross-process: fcntl/msvcrt file lock serializes processes.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(event, ensure_ascii=False) + "\n"

    with _WRITE_LOCK:
        _rotate_if_needed(path)
        with path.open("a+", encoding="utf-8") as file_obj:
            _lock_file(file_obj)
            try:
                file_obj.write(line)
                file_obj.flush()
            finally:
                _unlock_file(file_obj)
