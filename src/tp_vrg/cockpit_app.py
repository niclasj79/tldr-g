"""
tp_vrg.cockpit_app — PyWebView + pystray desktop shell for TP-VRG.

Architecture (Windows-first, single process):
  Main thread   → PyWebView window (required by webview backend)
  Daemon thread → uvicorn running api_server.py:app on port 8321
  Daemon thread → pystray system tray icon + context menu

On Windows, pystray does NOT require the main thread (unlike macOS).
On macOS, this threading model would need to be inverted (pystray on main,
webview in a secondary thread) — that is a Phase 2 concern.

Usage:
  tp-vrg-cockpit
  # or
  python -m tp_vrg.cockpit_app

Environment variables:
  TPVRG_API_HOST   (default: 127.0.0.1)
  TPVRG_API_PORT   (default: 8321)
"""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path

from tp_vrg.probe import probe_backend

logger = logging.getLogger(__name__)
_START_TS = time.monotonic()


def _startup_log(message: str) -> None:
    dt = time.monotonic() - _START_TS
    logger.info("[startup] %s: %s (t=%.3fs)", threading.current_thread().name, message, dt)


# ---------------------------------------------------------------------------
# Optional-import guard — give a clear message if cockpit extras are missing
# ---------------------------------------------------------------------------
def _require(pkg: str, extra: str = "cockpit") -> None:
    """Raise ImportError with install hint if *pkg* is not importable."""
    try:
        __import__(pkg)
    except ImportError:
        raise ImportError(
            f"Package '{pkg}' is required for the Cockpit desktop app. "
            f"Install it with:  pip install -e '.[{extra}]'"
        ) from None


# ---------------------------------------------------------------------------
# CockpitApp
# ---------------------------------------------------------------------------
class CockpitApp:
    """Desktop wrapper: system tray + PyWebView window + embedded API server."""

    def __init__(self, host: str = "127.0.0.1", port: int = 8321) -> None:
        self.host = host
        self.port = port
        self.api_url = f"http://{host}:{port}"
        self._window = None
        self._tray = None
        # Set by run() based on probe result. True when a separate tp-vrg-api
        # daemon is already running at self.host:self.port and this Cockpit
        # is attaching to it (no embedded engine init).
        self._backend_is_external: bool = False

    # ------------------------------------------------------------------
    # API server (daemon thread)
    # ------------------------------------------------------------------
    def _start_api_server(self) -> None:
        """Run the FastAPI server in a background daemon thread."""
        import uvicorn
        from tp_vrg.api_server import app  # type: ignore[import-untyped]

        config = uvicorn.Config(
            app,
            host=self.host,
            port=self.port,
            log_level="warning",
        )
        server = uvicorn.Server(config)
        server.run()

    # ------------------------------------------------------------------
    # System tray (daemon thread on Windows)
    # ------------------------------------------------------------------
    def _create_tray_icon(self) -> None:
        """Build and run the system tray icon with a context menu."""
        import pystray
        from PIL import Image

        # Simple coloured square — no external asset required.
        # 64 × 64 teal square with a small white inner square as visual accent.
        img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        pixels = img.load()
        assert pixels is not None
        teal = (0, 150, 136, 255)
        white = (255, 255, 255, 220)
        for y in range(64):
            for x in range(64):
                if 4 <= x < 60 and 4 <= y < 60:
                    # inner accent square
                    if 20 <= x < 44 and 20 <= y < 44:
                        pixels[x, y] = white
                    else:
                        pixels[x, y] = teal

        menu = pystray.Menu(
            pystray.MenuItem("Open Cockpit", self._on_show_window, default=True),
            pystray.MenuItem("Status", self._on_show_status),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", self._on_quit),
        )
        self._tray = pystray.Icon("tp-vrg", img, "TP-VRG Cockpit", menu)
        self._tray.run()  # blocks (Windows message loop)

    # ------------------------------------------------------------------
    # Tray menu callbacks
    # ------------------------------------------------------------------
    def _on_show_window(self, icon: object, item: object) -> None:  # noqa: ARG002
        """Bring the PyWebView window to the front."""
        if self._window is not None:
            try:
                self._window.show()
            except Exception:
                pass

    def _on_show_status(self, icon: object, item: object) -> None:  # noqa: ARG002
        """Show a tray notification with live graph stats from /health."""
        try:
            import requests

            r = requests.get(f"{self.api_url}/health", timeout=2)
            data = r.json()
            msg = (
                f"Nodes: {data.get('node_count', '?')} | "
                f"Edges: {data.get('edge_count', '?')} | "
                f"Passages: {data.get('passage_count', '?')}"
            )
            title = "TP-VRG Status"
        except Exception as exc:
            msg = f"API not responding ({exc})"
            title = "TP-VRG Status"

        if self._tray is not None:
            try:
                self._tray.notify(msg, title)
            except Exception:
                pass  # notify not supported on all platforms

    def _on_quit(self, icon: object, item: object) -> None:  # noqa: ARG002
        """Terminate tray and window cleanly."""
        if self._tray is not None:
            self._tray.stop()
        if self._window is not None:
            try:
                self._window.destroy()
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Main entry
    # ------------------------------------------------------------------
    def run(self, on_ready=None) -> None:
        """Start API server + tray in daemon threads, then open PyWebView (main thread).

        *on_ready*: optional zero-arg callback invoked on the main thread
        immediately before `webview.start()` blocks. This is the load-bearing
        invariant for the startup watchdog: the callback must fire once startup
        has reached the final main-thread step (window created, API healthy).
        Placing the signal AFTER `webview.start()` is wrong — that call blocks
        until the window is closed by the user, so the watchdog would always
        fire at its timeout and kill Cockpit on healthy startups.
        """
        _require("webview")
        _require("pystray")
        _startup_log("CockpitApp.run entered")

        import webview  # type: ignore[import-untyped]

        # 0. Probe for a running tp-vrg-api daemon on our configured port.
        #    If one is alive, attach to it and skip the embedded engine
        #    init entirely — gets us from launch to PyWebView in seconds
        #    regardless of graph size, since the expensive 3–4 min
        #    engine+model load is already paid by the daemon process.
        #    If no daemon is detected, fall back to the historical behavior
        #    (spawn uvicorn-in-thread). See contract §Acceptance gates.
        probe = probe_backend(self.host, self.port)
        self._backend_is_external = probe.alive
        if self._backend_is_external:
            assert probe.response is not None  # alive=True implies response
            _startup_log(
                f"detected tp-vrg-api daemon at {self.api_url} "
                f"(version={probe.response.get('version')}, "
                f"initializing={probe.initializing}) — skipping embedded api spawn"
            )
        else:
            _require("uvicorn")
            _startup_log(
                f"no daemon at {self.api_url} ({probe.error or 'not alive'}) "
                f"— spawning embedded api server"
            )
            # 1. API server — daemon thread (fallback path only)
            api_thread = threading.Thread(
                target=self._start_api_server,
                daemon=True,
                name="tp-vrg-api",
            )
            api_thread.start()
            _startup_log("api-server thread started")

        # 2. System tray — daemon thread (Windows: no main-thread requirement).
        #    Independent of daemon vs embedded; always starts.
        tray_thread = threading.Thread(
            target=self._create_tray_icon,
            daemon=True,
            name="tp-vrg-tray",
        )
        tray_thread.start()
        _startup_log("tray thread started")

        # 3. Wait for API to be ready — only when we spawned it ourselves.
        #    External daemon was already validated by the probe above; the
        #    frontend will poll /health on its own and will show the startup
        #    overlay if initializing=True, dismissing on initializing=False.
        if not self._backend_is_external:
            _wait_for_api(self.api_url)
            _startup_log("API responded to /health")
        else:
            _startup_log("skipped _wait_for_api (external daemon already validated)")

        # 4. PyWebView must run on the main thread
        html_path = str(Path(__file__).parent / "cockpit_ui" / "index.html")
        self._window = webview.create_window(
            "TP-VRG Cockpit",
            url=html_path,
            width=900,
            height=650,
            min_size=(600, 400),
        )
        _startup_log("PyWebView window created")

        # Signal startup complete BEFORE webview.start() blocks. If the watchdog
        # callback is placed after `webview.start()` returns, it would only fire
        # once the user closes the window — meaning the watchdog's timeout fires
        # first on every healthy startup. See docstring above.
        if on_ready is not None:
            on_ready()
        _startup_log("PyWebView starting")
        # debug=False for normal operation. To enable WebView2 DevTools for
        # frontend diagnosis, flip to True, relaunch, right-click in Cockpit
        # → Inspect. See 2026-04-21 incident diagnosis for the worked example
        # that resolved the UI state-machine / event-loop-block debugging.
        webview.start(debug=False)  # blocks until the window is closed


# ---------------------------------------------------------------------------
# API readiness poll
# ---------------------------------------------------------------------------
def _wait_for_api(url: str, timeout: float = 90.0, interval: float = 0.5) -> None:
    """Poll *url*/health until a 200 response is received or *timeout* elapses."""
    try:
        import requests
    except ImportError:
        # If requests is missing, just give the server a moment and continue.
        time.sleep(2.0)
        return

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            r = requests.get(f"{url}/health", timeout=1)
            if r.status_code == 200:
                return
        except Exception:
            pass
        time.sleep(interval)

    print(
        f"[tp-vrg-cockpit] Warning: API at {url} did not respond within {timeout}s. "
        "Opening window anyway — the frontend will retry via auto-refresh.",
        flush=True,
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> None:
    """Console-script entry point: ``tp-vrg-cockpit``."""
    # Configure file logging FIRST — before any thread starts, before any
    # optional import can fail. pythonw sends stdout/stderr to NUL, so the
    # log file at ~/.tp_vrg/cockpit.log is the ONLY place we can see errors.
    from tp_vrg.logging_setup import configure_file_logging
    from tp_vrg.startup_watchdog import StartupWatchdog, mark_startup_checkpoint
    log_path = configure_file_logging("cockpit.log")
    logger.info("Cockpit starting (pid=%d, log=%s)", os.getpid(), log_path)
    watchdog = StartupWatchdog(timeout_seconds=90, logger=logger, terminate_on_fire=True)
    watchdog.start()
    mark_startup_checkpoint("starting", "logger configured")

    # Pre-boot device check. GPU is strongly recommended; CPU runs ingest
    # and queries 20-50x slower. If no CUDA device and TPVRG_ALLOW_CPU is
    # unset, show a modal warning and let the user quit before any model
    # loads (saves ~1-2GB of unwanted HuggingFace downloads on fresh venvs
    # mis-installed with CPU-only torch).
    from tp_vrg.device_check import check_and_warn_for_cockpit
    mark_startup_checkpoint("device-check", "device check started")
    if not check_and_warn_for_cockpit():
        logger.info("Cockpit aborted by user (CPU detected, declined fallback)")
        return

    def _on_startup_ready() -> None:
        """Fires on the main thread right before `webview.start()` blocks.

        This must be called BEFORE the webview event loop starts, not after
        `app.run()` returns — `app.run()` only returns when the user closes
        the window, which is well past the watchdog's 90s timeout.
        """
        watchdog.signal_ready()
        mark_startup_checkpoint("ready", "signalling ready")

    try:
        host = os.environ.get("TPVRG_API_HOST", "127.0.0.1")
        port = int(os.environ.get("TPVRG_API_PORT", "8321"))
        app = CockpitApp(host=host, port=port)
        app.run(on_ready=_on_startup_ready)
    except Exception:
        # Main-thread exception must be logged before the process exits —
        # sys.excepthook runs but pythonw may have already closed handles.
        logger.exception("Cockpit startup failed")
        raise


if __name__ == "__main__":
    main()
