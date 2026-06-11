"""Lightweight progress event hub for real-time UI updates.

Provides a module-level singleton that any component can import and call
to broadcast progress events to all connected WebSocket clients (Cockpit,
CLI monitors, etc.).

Usage from any component::

    from tp_vrg.progress import progress

    progress.emit("ingest", current=5, total=20,
                  message="Extracting entities...")

The API server subscribes Cockpit clients via ``/ws/progress``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from collections import deque
from dataclasses import asdict, dataclass
from threading import Lock
from typing import Any

from tp_vrg.data_dir import get_data_dir
from tp_vrg.progress_file_writer import append_event

logger = logging.getLogger(__name__)


@dataclass
class ProgressEvent:
    """A single progress update from an engine component."""

    stage: str  # "ingest", "embed", "extract", "backbone", "query", "janitor"
    current: int = 0
    total: int | None = None
    eta_seconds: float | None = None
    message: str = ""
    timestamp: float = 0.0

    def __post_init__(self) -> None:
        if not self.timestamp:
            self.timestamp = time.time()


class ProgressHub:
    """Broadcast progress events to all connected WebSocket clients.

    Thread-safe: ``emit()`` can be called from any thread.  Subscribers
    are ``asyncio.Queue`` instances consumed by the WebSocket handler
    running in the uvicorn event loop.
    """

    def __init__(self, *, history_limit: int = 500) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()
        self._history: deque[dict[str, Any]] = deque(maxlen=max(1, int(history_limit)))
        self._history_lock = Lock()
        self._last_emit_ts: float = 0.0

    def subscribe(self) -> asyncio.Queue[str]:
        """Register a new subscriber queue. Returns the queue to read from."""
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=256)
        self._subscribers.add(q)
        logger.debug("Progress subscriber added (%d total)", len(self._subscribers))
        return q

    def unsubscribe(self, q: asyncio.Queue[str]) -> None:
        """Remove a subscriber queue (e.g. on WebSocket disconnect)."""
        self._subscribers.discard(q)
        logger.debug("Progress subscriber removed (%d remaining)", len(self._subscribers))

    def emit(
        self,
        stage: str,
        *,
        current: int = 0,
        total: int | None = None,
        eta_seconds: float | None = None,
        message: str = "",
    ) -> None:
        """Broadcast a progress event to all subscribers (fire-and-forget).

        Safe to call from sync or async code, from any thread.
        Slow consumers are silently dropped to prevent backpressure.
        """
        event = ProgressEvent(
            stage=stage,
            current=current,
            total=total,
            eta_seconds=eta_seconds,
            message=message,
        )
        payload_dict = asdict(event)
        # On coarse clocks (Windows time.time() ~15ms resolution) successive
        # emits can collide; the `since` history filter relies on strict
        # monotonic ordering so bump by 1µs when a tie is detected.
        with self._history_lock:
            if payload_dict["timestamp"] <= self._last_emit_ts:
                payload_dict["timestamp"] = self._last_emit_ts + 1e-6
            self._last_emit_ts = payload_dict["timestamp"]
        payload_dict["ts"] = payload_dict["timestamp"]
        self._append_history(payload_dict)
        payload = json.dumps(payload_dict)
        self._emit_progress_file(payload_dict)

        if not self._subscribers:
            return  # fast path — no live websocket listeners

        dead: list[asyncio.Queue[str]] = []
        for q in self._subscribers:
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self._subscribers.discard(q)
            logger.warning("Dropped slow progress subscriber")

    def history(self, *, since: float = 0.0, limit: int = 100) -> list[dict[str, Any]]:
        """Return recent in-process events, newest-bounded and oldest-first."""
        limit = max(1, min(int(limit), self._history.maxlen or 500))
        with self._history_lock:
            events = [
                dict(event)
                for event in self._history
                if _event_timestamp(event) > since
            ]
        return events[-limit:]

    def clear_history(self) -> None:
        """Clear in-process history. Intended for tests and controlled resets."""
        with self._history_lock:
            self._history.clear()

    def _append_history(self, event: dict[str, Any]) -> None:
        with self._history_lock:
            self._history.append(dict(event))

    def _emit_progress_file(self, event: dict[str, object]) -> None:
        mode = os.environ.get("TP_VRG_PROGRESS_FILE", "").strip().lower()
        data_dir_exists = get_data_dir().exists()
        enabled = mode in {"1", "true", "on", "yes"} or (mode == "" and data_dir_exists)
        if not enabled:
            return
        source = os.environ.get("TPVRG_PROGRESS_SOURCE", "api")
        try:
            append_event(
                {
                    "ts": event.get("timestamp", time.time()),
                    "pid": os.getpid(),
                    "source": source,
                    "stage": event.get("stage", ""),
                    "current": int(event.get("current", 0) or 0),
                    "total": int(event.get("total", 0) or 0),
                    # eta_seconds matches the in-process WS schema so Cockpit
                    # shows ETA labels for tail events too (None → no label).
                    "eta_seconds": event.get("eta_seconds"),
                    "message": str(event.get("message", "")),
                    "sprint_id": os.environ.get("TPVRG_SPRINT_ID", ""),
                }
            )
        except Exception:
            logger.debug("progress file append failed", exc_info=sys.exc_info())


# Module-level singleton — importable from anywhere in the codebase.
def _event_timestamp(event: dict[str, Any]) -> float:
    try:
        return float(event.get("timestamp", event.get("ts", 0.0)) or 0.0)
    except (TypeError, ValueError):
        return 0.0


progress = ProgressHub()
