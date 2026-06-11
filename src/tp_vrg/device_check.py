"""tp_vrg.device_check — pre-boot GPU availability check + user warning.

Runs at the entry point of every startup path (Cockpit, MCP, API) to detect
whether a CUDA-capable GPU is available. On CPU-only systems, the Cockpit
presents a modal warning before loading models (which take many minutes on
CPU). MCP and API entry points log-warn only — they cannot block
headless/script contexts and must not print to stdout (MCP owns it for
JSON-RPC).

Environment variables:
    TPVRG_ALLOW_CPU=1     Skip the modal and proceed silently on CPU.
                          Useful for CI, headless deployments, or users
                          who explicitly want CPU for testing.

Design decisions:
    - tkinter over pywebview for the modal: pywebview requires the API
      server to be running, which requires torch imports, which we want
      to gate BEFORE they happen. tkinter is stdlib and fires synchronously
      before anything heavy loads.
    - Default button is "Quit" — fresh mis-installs should fail safe.
    - Decision is re-prompted every launch. CPU is almost always accidental
      on mis-configured venvs; re-prompting is a self-healing nudge to
      install the CUDA torch wheel.
    - `cpu_wheel` detection distinguishes "CPU-only torch wheel installed
      on a machine that probably has a GPU" from "genuine no-GPU machine" —
      different copy for each case.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Literal

logger = logging.getLogger(__name__)

# Recommended minimum VRAM for the full stack (BGE-large + GLiNER2 + spaCy trf
# + fastcoref LingMess). Below this, large models may OOM.
MIN_RECOMMENDED_VRAM_MB = 4096


@dataclass
class DeviceInfo:
    """Result of device detection. Used for logging and modal routing."""

    kind: Literal["cuda", "cpu"]
    device_name: str
    vram_mb: int  # 0 if cpu
    cpu_wheel: bool  # True if torch wheel is +cpu variant
    torch_version: str
    warnings: list[str] = field(default_factory=list)

    def summary(self) -> str:
        """One-line summary suitable for logging."""
        if self.kind == "cuda":
            parts = [
                f"CUDA on {self.device_name}",
                f"{self.vram_mb}MB VRAM",
                f"torch {self.torch_version}",
            ]
            if self.warnings:
                parts.append("warnings: " + "; ".join(self.warnings))
            return " | ".join(parts)
        wheel_suffix = " (+cpu wheel)" if self.cpu_wheel else ""
        return f"CPU-only{wheel_suffix} | torch {self.torch_version}"


def detect_device() -> DeviceInfo:
    """Inspect torch and return DeviceInfo. Does not load any models."""
    try:
        import torch
    except ImportError:
        # torch is a transitive dep — should always be importable. If not,
        # treat as CPU; downstream code will raise a clearer error.
        return DeviceInfo(
            kind="cpu",
            device_name="CPU (torch not importable)",
            vram_mb=0,
            cpu_wheel=False,
            torch_version="unknown",
        )

    torch_version = str(torch.__version__)
    cpu_wheel = "+cpu" in torch_version

    if torch.cuda.is_available():
        try:
            name = torch.cuda.get_device_name(0)
            props = torch.cuda.get_device_properties(0)
            vram_mb = int(props.total_memory) // (1024 * 1024)
        except Exception as exc:  # pragma: no cover (driver-dependent)
            logger.warning(
                "CUDA reported available but device query failed: %s", exc
            )
            return DeviceInfo(
                kind="cpu",
                device_name="CPU (CUDA query failed)",
                vram_mb=0,
                cpu_wheel=cpu_wheel,
                torch_version=torch_version,
            )

        warnings_list: list[str] = []
        if vram_mb < MIN_RECOMMENDED_VRAM_MB:
            warnings_list.append(
                f"GPU has {vram_mb}MB VRAM, below the "
                f"{MIN_RECOMMENDED_VRAM_MB}MB recommended minimum. "
                "Large models (BGE-large + GLiNER2 + fastcoref) may OOM."
            )

        return DeviceInfo(
            kind="cuda",
            device_name=name,
            vram_mb=vram_mb,
            cpu_wheel=False,
            torch_version=torch_version,
            warnings=warnings_list,
        )

    return DeviceInfo(
        kind="cpu",
        device_name="CPU",
        vram_mb=0,
        cpu_wheel=cpu_wheel,
        torch_version=torch_version,
    )


def should_skip_warning() -> bool:
    """Return True if env override set (CI / headless / advanced users)."""
    raw = os.environ.get("TPVRG_ALLOW_CPU", "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def prompt_cpu_warning(info: DeviceInfo) -> bool:
    """Show tkinter modal warning. Returns True=proceed, False=quit.

    Blocks the calling thread until the user clicks a button. Runs its own
    local tk mainloop so it can fire before any other GUI framework
    initializes (pywebview, pystray, uvicorn).

    Fails open: if tkinter is unavailable or the display cannot be opened
    (headless Linux), logs a warning and returns True. This is a
    best-effort dialog, not a hard gate.
    """
    try:
        import tkinter as tk
        from tkinter import ttk
    except ImportError:
        logger.warning(
            "CPU warning dialog unavailable (tkinter missing). "
            "Proceeding on CPU."
        )
        return True

    # Diagnosis copy differs based on cpu_wheel vs no-GPU
    if info.cpu_wheel:
        diagnosis = (
            f"Detected: CPU-only PyTorch wheel (torch {info.torch_version}).\n"
            "A working NVIDIA GPU may still be present on this machine — the "
            "CPU-only wheel was installed instead of the CUDA variant.\n\n"
            "Fix: reinstall torch from the CUDA index:\n"
            "    pip uninstall -y torch\n"
            "    pip install torch --index-url https://download.pytorch.org/whl/cu121"
        )
    else:
        diagnosis = (
            f"Detected: No CUDA-capable GPU (torch {info.torch_version}).\n"
            "Either no NVIDIA GPU is present, or the driver is not installed."
        )

    message = (
        "TLDR-G runs 20-50x slower on CPU.\n"
        "Ingesting a moderate document takes many minutes instead of seconds.\n\n"
        "Recommended hardware:\n"
        "    NVIDIA GPU with 4GB+ VRAM (GTX 1060 6GB or better)\n"
        "    CUDA 12.x driver\n\n"
        f"{diagnosis}\n\n"
        "Proceed anyway?"
    )

    try:
        root = tk.Tk()
    except Exception as exc:
        logger.warning(
            "CPU warning dialog could not open a display (%s). "
            "Proceeding on CPU.",
            exc,
        )
        return True

    root.title("TLDR-G - GPU recommended")
    root.resizable(False, False)
    try:
        root.attributes("-topmost", True)
    except Exception:  # pragma: no cover (platform-dependent)
        pass

    decision: dict[str, bool] = {"proceed": False}

    def on_proceed() -> None:
        decision["proceed"] = True
        root.destroy()

    def on_quit() -> None:
        decision["proceed"] = False
        root.destroy()

    frame = ttk.Frame(root, padding=20)
    frame.grid(row=0, column=0)

    ttk.Label(
        frame,
        text="GPU recommended",
        font=("Segoe UI", 12, "bold"),
    ).grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 10))

    ttk.Label(
        frame,
        text=message,
        justify="left",
        wraplength=520,
    ).grid(row=1, column=0, columnspan=2, sticky="w", pady=(0, 15))

    quit_btn = ttk.Button(frame, text="Quit", command=on_quit)
    quit_btn.grid(row=2, column=0, padx=(0, 10), sticky="e")

    proceed_btn = ttk.Button(frame, text="Proceed anyway", command=on_proceed)
    proceed_btn.grid(row=2, column=1, sticky="w")

    # Keyboard: Escape = Quit (safe default), Enter = Quit
    root.bind("<Escape>", lambda _evt: on_quit())
    root.bind("<Return>", lambda _evt: on_quit())
    # Window close (X) = Quit
    root.protocol("WM_DELETE_WINDOW", on_quit)

    # Center on screen
    root.update_idletasks()
    w = root.winfo_reqwidth()
    h = root.winfo_reqheight()
    x = (root.winfo_screenwidth() // 2) - (w // 2)
    y = (root.winfo_screenheight() // 2) - (h // 2)
    root.geometry(f"+{x}+{y}")

    root.focus_force()
    quit_btn.focus_set()
    root.mainloop()

    return decision["proceed"]


def check_and_warn_for_cockpit() -> bool:
    """Full Cockpit pre-boot check. Returns True=proceed, False=quit.

    Call this BEFORE starting the API server or loading any models. Logs
    the detected device and shows a modal warning if CPU is detected and
    the TPVRG_ALLOW_CPU override is not set.
    """
    info = detect_device()
    logger.info("Device check: %s", info.summary())

    if info.kind == "cuda":
        for warning in info.warnings:
            logger.warning("Device warning: %s", warning)
        return True

    # CPU path
    if should_skip_warning():
        logger.warning(
            "Device check: CPU-only (TPVRG_ALLOW_CPU override set — "
            "proceeding silently)"
        )
        return True

    logger.warning("Device check: CPU-only — showing user warning dialog")
    proceed = prompt_cpu_warning(info)
    if proceed:
        logger.warning(
            "User chose to proceed on CPU. Expect long ingest/query times."
        )
    else:
        logger.info("User chose to quit on CPU warning.")
    return proceed


def log_device_for_headless(component: str) -> None:
    """Log device info for MCP/API headless entry points. Never blocks.

    MCP writes JSON-RPC on stdout, so this must log to file only (which
    the logger does once configure_file_logging has been called upstream).
    """
    info = detect_device()
    if info.kind == "cuda":
        logger.info("[%s] Device: %s", component, info.summary())
        for warning in info.warnings:
            logger.warning("[%s] %s", component, warning)
    else:
        logger.warning(
            "[%s] Device: %s - expect 20-50x slower ingest/query than GPU.",
            component,
            info.summary(),
        )
