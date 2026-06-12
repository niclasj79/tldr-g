"""TP-VRG data directory layout + atomic legacy migration.

Single source of truth for the `~/.tp_vrg/*` directory structure.

Layout (post-F16):
    ~/.tp_vrg/
        README.txt              — explains the layout to curious users
        internal/               — engine artifacts, not designed for inspection
            graph.db            — SQLite knowledge graph (hidden from users)
            graph.db-wal        — WAL sidecar
            graph.db-shm        — shared memory sidecar
        provenance.db           — user-facing audit trail (F16)

Legacy layout (pre-F16):
    ~/.tp_vrg/
        graph.db                — will be migrated to internal/graph.db
        graph.db-wal
        graph.db-shm

The migration is atomic via a staging directory (`internal.staging/`) to
protect against mid-flight failures on Windows where file locks can
interrupt partial moves.
"""

from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path

__all__ = [
    "get_data_dir",
    "get_graph_db_path",
    "get_log_path",
    "get_provenance_db_path",
    "ensure_data_dir_layout",
]


_README_CONTENT = """TP-VRG data directory
=====================

This directory holds TP-VRG state across sessions.

Layout:
  internal/        Engine artifacts (SQLite knowledge graph + sidecars).
                   These files are NOT designed to be inspected or modified
                   directly. Opening graph.db with a SQLite browser will
                   reveal the internal schema, which is an engine artifact
                   and not part of the product's public API. It can change
                   between versions without notice.

  provenance.db    Your query audit trail. Each answer produced by TP-VRG
                   records which source segments contributed to it, so you
                   can see "why did the engine say X?" This file is safe
                   to read — use any SQLite client. Do NOT write to it
                   directly; use the TP-VRG tools/API instead.

  README.txt       This file.

To reset everything: delete the entire ~/.tp_vrg directory. TP-VRG will
recreate the layout on next run.
"""


def get_data_dir() -> Path:
    """Return the TP-VRG data directory.

    Overridable via the TP_VRG_HOME environment variable (useful for
    isolated tests and alternate installs).
    """
    override = os.environ.get("TP_VRG_HOME")
    if override:
        return Path(override)
    return Path.home() / ".tp_vrg"


def get_graph_db_path(data_dir: Path | None = None) -> Path:
    """Return the canonical path to the active graph database.

    Post-F16 default: `<data_dir>/internal/graph.db`.

    UX-12 (multi-graph picker): if a graph registry exists, resolve through the
    active named-graph profile instead. This is the single seam every surface
    (Cockpit, HTTP API, MCP server, CLI) inherits, so switching the active graph
    switches all of them at once (INV-1: one source of truth for the path).
    Registry resolution must never break the legacy default — any absence or
    error falls back to `internal/graph.db`, the exact pre-UX-12 behaviour.
    """
    if data_dir is None:
        data_dir = get_data_dir()
    try:
        # Lazy import avoids a circular dependency (graph_registry imports this
        # module for get_data_dir).
        from tp_vrg.graph_registry import resolve_active_graph_path

        active = resolve_active_graph_path(data_dir)
        if active is not None:
            return active
    except Exception:
        pass
    return data_dir / "internal" / "graph.db"


def get_provenance_db_path(data_dir: Path | None = None) -> Path:
    """Return the canonical path to the user-facing provenance database."""
    if data_dir is None:
        data_dir = get_data_dir()
    return data_dir / "provenance.db"


def get_log_path(name: str = "cockpit.log", data_dir: Path | None = None) -> Path:
    """Return the canonical path to a TP-VRG log file.

    Layout: `<data_dir>/<name>` (not under ``internal/`` — users may
    legitimately want to read these when reporting bugs, unlike the
    graph artifacts). The caller is responsible for ensuring the
    directory exists before writing — see ``logging_setup.configure_file_logging``.
    """
    if data_dir is None:
        data_dir = get_data_dir()
    # Never accept traversal-style names — ``name`` must be a plain filename.
    if "/" in name or "\\" in name or name.startswith(".."):
        raise ValueError(f"log name must be a plain filename, got {name!r}")
    return data_dir / name


def _write_readme(data_dir: Path) -> None:
    """Write the README.txt file if missing."""
    readme_path = data_dir / "README.txt"
    if not readme_path.exists():
        readme_path.write_text(_README_CONTENT, encoding="utf-8")


def _rename_dir_with_windows_retry(src: Path, dst: Path) -> None:
    """Rename a directory, tolerating transient Windows file-lock races."""
    delay_s = 0.05
    for attempt in range(5):
        try:
            src.rename(dst)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(delay_s)
            delay_s *= 2


def _migrate_legacy_graph(data_dir: Path) -> bool:
    """Atomically migrate a legacy `graph.db` to `internal/graph.db`.

    Returns True if a migration was performed, False if none was needed.
    Uses a staging directory (`internal.staging/`) so a mid-flight
    failure does not leave the user in a half-migrated state.
    """
    legacy_graph = data_dir / "graph.db"
    internal_graph = data_dir / "internal" / "graph.db"

    # Already migrated or nothing to migrate
    if internal_graph.exists():
        return False
    if not legacy_graph.exists():
        return False

    staging = data_dir / "internal.staging"

    # Clean up any leftover staging from a previous failed run
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)

    try:
        staging.mkdir(parents=True, exist_ok=False)

        # Copy all three files (main + WAL sidecars) to staging
        files_to_move: list[tuple[Path, Path]] = []
        for name in ("graph.db", "graph.db-wal", "graph.db-shm"):
            src = data_dir / name
            if src.exists():
                dst = staging / name
                shutil.copy2(str(src), str(dst))
                # Verify the copy is readable and non-empty (for main file)
                if name == "graph.db" and dst.stat().st_size != src.stat().st_size:
                    raise OSError(
                        f"staged copy size mismatch for {name}: "
                        f"{dst.stat().st_size} vs {src.stat().st_size}"
                    )
                files_to_move.append((src, dst))

        # Atomic rename: staging -> internal
        _rename_dir_with_windows_retry(staging, data_dir / "internal")

        # Only delete originals AFTER the rename succeeds
        for src, _dst in files_to_move:
            try:
                src.unlink()
            except OSError:
                # Non-fatal: the new location is authoritative;
                # leftover originals will just be ignored next time.
                pass

        print(
            f"[tp-vrg] Migrated legacy graph.db → {data_dir / 'internal' / 'graph.db'}",
            file=sys.stderr,
        )
        return True

    except Exception:
        # Clean up staging on any failure; leave legacy files untouched
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        raise


def ensure_data_dir_layout(data_dir: Path | None = None) -> None:
    """Ensure the TP-VRG data directory has the correct layout.

    Idempotent. Safe to call multiple times. Performs:
      1. Create the data directory if missing.
      2. Create the `internal/` subdirectory if missing.
      3. Migrate a legacy `graph.db` to `internal/graph.db` if present.
      4. Write the README.txt if missing.
    """
    if data_dir is None:
        data_dir = get_data_dir()

    data_dir.mkdir(parents=True, exist_ok=True)

    # Attempt legacy migration first; this will create internal/ via rename.
    migrated = False
    try:
        migrated = _migrate_legacy_graph(data_dir)
    except Exception as exc:
        # Log but do not crash — user can investigate manually
        print(
            f"[tp-vrg] WARNING: legacy graph migration failed: {exc}",
            file=sys.stderr,
        )

    # If no migration happened, still ensure internal/ exists
    if not migrated:
        (data_dir / "internal").mkdir(parents=True, exist_ok=True)

    _write_readme(data_dir)
