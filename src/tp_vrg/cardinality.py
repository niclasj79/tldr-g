"""Runtime cardinality probes for scale-sensitive graph stages."""

from __future__ import annotations

from collections import deque
from contextlib import contextmanager
from dataclasses import asdict, dataclass
import logging
import os
import shutil
from threading import Lock
import time
from typing import Iterator

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CardinalitySample:
    """One input -> intermediate -> output cardinality observation."""

    stage: str
    input_rows: int
    intermediate_rows: int
    output_rows: int
    wall_s: float
    timestamp: float


@dataclass
class CardinalityCounter:
    """Mutable probe counters owned by the instrumented stage."""

    intermediate: int = 0
    output: int = 0


class CardinalityBudgetError(RuntimeError):
    """Raised by strict probes when a stage exceeds its cardinality budget."""


class CardinalityRecorder:
    """Thread-safe bounded ring buffer of recent cardinality samples."""

    def __init__(self, *, history_limit: int = 500) -> None:
        self._history: deque[CardinalitySample] = deque(maxlen=max(1, int(history_limit)))
        self._lock = Lock()

    def record(self, sample: CardinalitySample) -> None:
        """Append one sample to the bounded history."""
        with self._lock:
            self._history.append(sample)

    def recent(self, limit: int = 50) -> list[dict[str, float | int | str]]:
        """Return the newest-bounded samples, oldest-first within the slice."""
        limit = max(1, min(int(limit), self._history.maxlen or 500))
        with self._lock:
            samples = list(self._history)[-limit:]
        return [asdict(sample) for sample in samples]

    def clear(self) -> None:
        """Clear history. Intended for tests and controlled diagnostics resets."""
        with self._lock:
            self._history.clear()


cardinality = CardinalityRecorder()


def _budget_breach_message(
    stage: str,
    counter: CardinalityCounter,
    wall_s: float,
    *,
    max_intermediate: int | None,
    max_wall_s: float | None,
) -> str | None:
    breaches: list[str] = []
    if max_intermediate is not None and counter.intermediate > max_intermediate:
        breaches.append(
            f"intermediate={counter.intermediate} > max_intermediate={max_intermediate}"
        )
    if max_wall_s is not None and wall_s > max_wall_s:
        breaches.append(f"wall_s={wall_s:.2f} > max_wall_s={float(max_wall_s):.2f}")
    if not breaches:
        return None
    return f"[cardinality] BUDGET BREACH stage={stage} " + "; ".join(breaches)


@contextmanager
def probe(
    stage: str,
    *,
    input_rows: int = 0,
    max_intermediate: int | None = None,
    max_wall_s: float | None = None,
    strict: bool = False,
) -> Iterator[CardinalityCounter]:
    """Record one stage's row-cardinality and optional budget result."""
    counter = CardinalityCounter()
    start = time.perf_counter()
    body_failed = False
    try:
        yield counter
    except BaseException:
        body_failed = True
        raise
    finally:
        wall_s = time.perf_counter() - start
        sample = CardinalitySample(
            stage=str(stage),
            input_rows=int(input_rows),
            intermediate_rows=int(counter.intermediate),
            output_rows=int(counter.output),
            wall_s=wall_s,
            timestamp=time.time(),
        )
        cardinality.record(sample)
        logger.info(
            "[cardinality] stage=%s input=%d intermediate=%d output=%d wall_s=%.2f",
            sample.stage,
            sample.input_rows,
            sample.intermediate_rows,
            sample.output_rows,
            sample.wall_s,
        )
        breach = _budget_breach_message(
            sample.stage,
            counter,
            sample.wall_s,
            max_intermediate=max_intermediate,
            max_wall_s=max_wall_s,
        )
        if breach is not None and not body_failed:
            if strict:
                raise CardinalityBudgetError(breach)
            logger.warning(breach)


BAKE_MIN_FREE_GB_ENV = "TPVRG_BAKE_MIN_FREE_GB"
_BAKE_FREE_FACTOR = 3.0
_BAKE_FREE_FLOOR_GB = 2.0

ISOLATE_MIN_FREE_GB_ENV = "TPVRG_ISOLATE_MIN_FREE_GB"
_ISOLATE_FREE_FLOOR_GB = 10.0
_ISOLATE_PER_QUESTION_GB = 0.10


class InsufficientDiskError(RuntimeError):
    """Raised by the bake/isolate preflight when free disk is below the budget."""


def _main_db_path(conn) -> str | None:
    """Best-effort resolve the 'main' SQLite database file path from a connection."""
    try:
        for _seq, name, filename in conn.execute("PRAGMA database_list"):
            if name == "main" and filename:
                return str(filename)
    except Exception:
        pass
    return None


def assert_free_disk_for_bake(conn, *, stage: str = "bake", env=None) -> None:
    """Fail loudly BEFORE a disk-hungry bake stage when free disk is low.

    Prevents the mid-stream SQLite ``database or disk is full`` failure (the
    2026-06-04 island-rung incident) by checking free space against a budget
    first. Required free = ``max(floor, factor x graph-size)`` GB, or an explicit
    ``TPVRG_BAKE_MIN_FREE_GB`` override. No-ops for in-memory / unknown databases
    (tests). Raises ``InsufficientDiskError`` with an actionable message otherwise.
    """
    env_map = os.environ if env is None else env
    db_path = conn if isinstance(conn, str) else _main_db_path(conn)
    if not db_path or not os.path.exists(db_path):
        return
    db_dir = os.path.dirname(os.path.abspath(db_path)) or "."
    try:
        size_gb = os.path.getsize(db_path) / 1e9
        free_gb = shutil.disk_usage(db_dir).free / 1e9
    except OSError:
        return
    override = (env_map.get(BAKE_MIN_FREE_GB_ENV) or "").strip()
    try:
        required_gb = float(override) if override else max(_BAKE_FREE_FLOOR_GB, _BAKE_FREE_FACTOR * size_gb)
    except ValueError:
        required_gb = max(_BAKE_FREE_FLOOR_GB, _BAKE_FREE_FACTOR * size_gb)
    if free_gb < required_gb:
        raise InsufficientDiskError(
            f"[cardinality] bake preflight ({stage}): only {free_gb:.1f} GB free at {db_dir}, "
            f"~{required_gb:.1f} GB needed for a {size_gb:.1f} GB graph (SQLite temp/spill). "
            f"Free disk (e.g. delete an old graph backup) and retry, or set {BAKE_MIN_FREE_GB_ENV}."
        )


def assert_free_disk_for_isolate_run(
    temp_root,
    *,
    n_questions: int = 0,
    cache_dir=None,
    stage: str = "isolate",
    env=None,
) -> None:
    """Fail loudly BEFORE a ``--isolate-per-question`` benchmark run when free disk is low.

    Prevents the 2026-06-08 ENOSPC class (silent ``backlog-completed.md`` truncation
    after a 156-question cat2 run filled C:) by checking free space against a
    budget first. Sibling to :func:`assert_free_disk_for_bake` — same fail-loud
    pattern, different stage.

    Required free = ``max(floor, factor x n_questions)`` GB, or an explicit
    ``TPVRG_ISOLATE_MIN_FREE_GB`` override. The override ``=0`` IS the kill-switch
    (sets required to 0 ⇒ always passes); ``>0`` overrides the heuristic.

    Args:
        temp_root: a path used to resolve free space on the same drive as
            the per-question home dirs (typically ``C:/tmp`` on Windows, the
            POSIX tempdir on Linux/macOS).
        n_questions: count of instances about to be run (informs the budget).
        cache_dir: optional path to the regenerable benchmark cache; if
            provided and exists, its current size is logged for visibility.
        stage: label embedded in error messages and logs.
        env: environment dict (defaults to ``os.environ``); test seam.

    Raises:
        InsufficientDiskError: with an actionable message when free < required.
    """
    env_map = os.environ if env is None else env
    root_path = str(temp_root)
    if not root_path or not os.path.exists(root_path):
        return
    try:
        free_gb = shutil.disk_usage(root_path).free / 1e9
    except OSError:
        return

    override = (env_map.get(ISOLATE_MIN_FREE_GB_ENV) or "").strip()
    if override:
        try:
            required_gb = float(override)
        except ValueError:
            required_gb = max(
                _ISOLATE_FREE_FLOOR_GB,
                _ISOLATE_PER_QUESTION_GB * max(0, int(n_questions)),
            )
    else:
        required_gb = max(
            _ISOLATE_FREE_FLOOR_GB,
            _ISOLATE_PER_QUESTION_GB * max(0, int(n_questions)),
        )

    # Best-effort cache-dir size log (visibility only; never fails the preflight).
    if cache_dir:
        cache_path = str(cache_dir)
        if os.path.exists(cache_path):
            try:
                cache_bytes = 0
                for dirpath, _dirnames, filenames in os.walk(cache_path):
                    for filename in filenames:
                        full = os.path.join(dirpath, filename)
                        try:
                            cache_bytes += os.path.getsize(full)
                        except OSError:
                            continue
                msg = (
                    f"[cardinality] isolate preflight ({stage}): "
                    f"cache_dir {cache_path} currently {cache_bytes / 1e9:.2f} GB"
                )
                logger.info(msg)
                print(msg, flush=True)
            except OSError:
                pass

    summary = (
        f"[cardinality] isolate preflight ({stage}): "
        f"{free_gb:.1f} GB free at {root_path}, "
        f"{required_gb:.1f} GB required for {n_questions} questions"
    )
    logger.info(summary)
    print(summary, flush=True)

    if required_gb > 0 and free_gb < required_gb:
        raise InsufficientDiskError(
            f"[cardinality] isolate preflight ({stage}): only {free_gb:.1f} GB free at "
            f"{root_path}, ~{required_gb:.1f} GB required for {n_questions} questions "
            f"(per-question budget {_ISOLATE_PER_QUESTION_GB:.2f} GB; floor "
            f"{_ISOLATE_FREE_FLOOR_GB:.1f} GB). Free disk (e.g. delete an old graph "
            f"backup or clear ~/.cache/tp-vrg/benchmarks) and retry, set "
            f"{ISOLATE_MIN_FREE_GB_ENV}=<gb> to override the heuristic, or "
            f"{ISOLATE_MIN_FREE_GB_ENV}=0 as the explicit kill-switch."
        )


__all__ = [
    "BAKE_MIN_FREE_GB_ENV",
    "ISOLATE_MIN_FREE_GB_ENV",
    "InsufficientDiskError",
    "assert_free_disk_for_bake",
    "assert_free_disk_for_isolate_run",
    "CardinalityBudgetError",
    "CardinalityCounter",
    "CardinalityRecorder",
    "CardinalitySample",
    "cardinality",
    "probe",
]
