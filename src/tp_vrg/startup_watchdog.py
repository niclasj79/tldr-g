from __future__ import annotations

import os
import sys
import threading
import time
import traceback
from typing import Any


_START_TIME = time.monotonic()
_CHECKPOINTS: list[dict[str, Any]] = []
_PHASE = "starting"


def mark_startup_checkpoint(phase: str, message: str) -> None:
    global _PHASE
    _PHASE = phase
    _CHECKPOINTS.append({
        "phase": phase,
        "message": message,
        "t": time.monotonic() - _START_TIME,
        "thread": threading.current_thread().name,
    })


def thread_dump_text() -> str:
    frames = sys._current_frames()
    chunks: list[str] = []
    for th in threading.enumerate():
        frame = frames.get(th.ident)
        chunks.append(f"Thread {th.name} (id={th.ident}):")
        if frame is None:
            chunks.append("  <no frame>")
        else:
            chunks.extend(["  " + line.rstrip("\n") for line in traceback.format_stack(frame)])
    return "\n".join(chunks)


class StartupWatchdog:
    def __init__(self, timeout_seconds: int, logger, terminate_on_fire: bool = True) -> None:
        self.timeout_seconds = int(timeout_seconds)
        self.logger = logger
        self.terminate_on_fire = terminate_on_fire
        self._ready = threading.Event()
        self._fired = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, daemon=True, name="startup-watchdog")
        self._thread.start()

    def signal_ready(self) -> None:
        self._ready.set()
        self.logger.info("[startup] WATCHDOG: ready received, watchdog cancelled")

    def _run(self) -> None:
        if self._ready.wait(timeout=self.timeout_seconds):
            return
        self.fire()

    def fire(self) -> None:
        if self._fired.is_set():
            return
        self._fired.set()
        dump = thread_dump_text()
        self.logger.error(
            "[WATCHDOG] startup did not signal ready in %ss. Thread dump follows.\n%s",
            self.timeout_seconds,
            dump,
        )
        if self.terminate_on_fire:
            os._exit(78)


def startup_status() -> dict[str, Any]:
    return {
        "phase": _PHASE,
        "duration_seconds": time.monotonic() - _START_TIME,
        "checkpoints": list(_CHECKPOINTS),
        "thread_dump": thread_dump_text(),
    }
