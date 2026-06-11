"""Central file-logging configuration for TP-VRG entry points.

Cockpit runs under ``pythonw`` on Windows, which sends stdout/stderr to NUL
and makes any crash invisible. MCP uses stdout for JSON-RPC and cannot
accept log messages on that channel either. For both, the only sustainable
sink is a file under ``~/.tp_vrg/``.

This module provides ``configure_file_logging(name)`` — idempotent setup
that should be called once at startup of every entry point (cockpit_app,
mcp_server, api_server when standalone, CLI if we want it there too).

The handler is a ``RotatingFileHandler`` (5 MB × 3 backups) so disk usage
is bounded. Formatter includes the thread name because most Cockpit bugs
live in background threads (``gliner-preload``, ``tp-vrg-api``,
``tp-vrg-tray``) and the thread name is the fastest way to pinpoint
which subsystem crashed.

In addition to the handler, this module wires:

- ``sys.excepthook`` — catches uncaught main-thread exceptions
- ``threading.excepthook`` (Python 3.8+) — catches uncaught
  background-thread exceptions. Critical for ``DeferredGLiNERProvider``
  which runs its model load in a daemon thread.

Both hooks route to the same logger so the traceback lands in the log
file even when the exception never reaches user code.

Level defaults to INFO; set ``TPVRG_LOG_LEVEL=DEBUG`` to raise verbosity.
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import sys
import threading
from pathlib import Path

from tp_vrg.data_dir import get_log_path

__all__ = ["configure_file_logging"]


_LOG_FORMAT = (
    "%(asctime)s  %(levelname)-8s  [%(threadName)s]  %(name)s:  %(message)s"
)
_DEFAULT_MAX_BYTES = 5 * 1024 * 1024  # 5 MB
_DEFAULT_BACKUP_COUNT = 3

# Track which log names have already been configured — guard against
# double-wiring if an entry point's main() is re-entered (tests, reloads).
_CONFIGURED: set[str] = set()


def configure_file_logging(
    name: str = "cockpit.log",
    *,
    level: int | str | None = None,
    max_bytes: int = _DEFAULT_MAX_BYTES,
    backup_count: int = _DEFAULT_BACKUP_COUNT,
) -> Path:
    """Wire a rotating file handler on the root logger.

    Idempotent: calling twice with the same *name* is a no-op.

    Returns the path of the log file so callers can surface it in status
    banners, /health responses, or tray tooltips.
    """
    log_path = get_log_path(name)

    if name in _CONFIGURED:
        return log_path

    if level is None:
        env_level = os.environ.get("TPVRG_LOG_LEVEL", "INFO").upper()
        level = getattr(logging, env_level, logging.INFO)

    # Ensure the data dir exists — get_log_path does NOT create it.
    log_path.parent.mkdir(parents=True, exist_ok=True)

    handler = logging.handlers.RotatingFileHandler(
        str(log_path),
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
        delay=True,  # defer file open until first write (Windows-friendly)
    )
    handler.setFormatter(logging.Formatter(_LOG_FORMAT))
    handler.setLevel(level)

    root = logging.getLogger()
    # Root level must be <= handler level, else handler never sees records.
    if root.level == logging.NOTSET or root.level > level:
        root.setLevel(level)

    # If another FileHandler already points at this exact path, replace it
    # rather than appending a second (double-logging is worse than silence).
    for existing in list(root.handlers):
        if isinstance(existing, logging.FileHandler):
            try:
                if Path(existing.baseFilename).resolve() == log_path.resolve():
                    root.removeHandler(existing)
                    existing.close()
            except (OSError, AttributeError):
                pass

    root.addHandler(handler)

    _install_main_thread_excepthook()
    _install_threading_excepthook()

    logging.getLogger(__name__).info(
        "file logging configured: name=%s path=%s level=%s",
        name, log_path, logging.getLevelName(level),
    )
    _CONFIGURED.add(name)
    return log_path


def _install_main_thread_excepthook() -> None:
    """Chain ``sys.excepthook`` to log uncaught main-thread exceptions.

    Preserves the previous hook (default or one set by a debugger) by
    calling it after our logger fires. Idempotent via attribute sentinel.
    """
    if getattr(sys.excepthook, "_tpvrg_installed", False):
        return

    previous = sys.excepthook

    def _hook(exc_type, exc, tb):
        try:
            logging.getLogger("tp_vrg.uncaught").critical(
                "uncaught exception in main thread",
                exc_info=(exc_type, exc, tb),
            )
        except Exception:
            pass  # never let a logging failure mask the original
        previous(exc_type, exc, tb)

    _hook._tpvrg_installed = True  # type: ignore[attr-defined]
    sys.excepthook = _hook


def _install_threading_excepthook() -> None:
    """Chain ``threading.excepthook`` to log uncaught thread exceptions.

    Without this, a crash inside ``DeferredGLiNERProvider._load`` (or any
    other daemon thread) is logged only if the thread's own code catches
    it. This hook is the safety net for everything else.
    """
    if getattr(threading.excepthook, "_tpvrg_installed", False):
        return

    previous = threading.excepthook

    def _hook(args: threading.ExceptHookArgs) -> None:
        try:
            logging.getLogger("tp_vrg.uncaught").critical(
                "uncaught exception in thread %r",
                getattr(args.thread, "name", "<unknown>"),
                exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
            )
        except Exception:
            pass
        previous(args)

    _hook._tpvrg_installed = True  # type: ignore[attr-defined]
    threading.excepthook = _hook
