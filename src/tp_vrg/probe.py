"""Backend probe for the engine-daemon architecture.

When Cockpit, MCP, or CLI want to use a running ``tp-vrg-api`` backend
instead of spawning their own engine-bearing process, they call
:func:`probe_backend`. The probe does a short-timeout HTTP GET on
``/health`` and verifies the response carries the TP-VRG service
signature, so that a port collision with an unrelated service cannot
be mistaken for a running backend.

Synchronous by design — short-lived, small response, used from both
thread (Cockpit) and asyncio (MCP) contexts. Async callers can wrap
via :func:`asyncio.to_thread` if needed; the probe is not expected to
block more than ``timeout`` seconds.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

SERVICE_NAME = "tp-vrg-api"


@dataclass(frozen=True)
class ProbeResult:
    """Outcome of probing a candidate backend.

    ``alive`` is True only when the HTTP call returned 200 AND the
    response payload contained the expected ``service`` signature.
    Missing or mismatched signatures produce ``alive=False`` so that
    an unrelated service squatting on the port is never mistaken for
    a TP-VRG backend.
    """

    alive: bool
    initializing: bool
    service_matches: bool
    response: dict[str, Any] | None
    error: str | None


def probe_backend(
    host: str,
    port: int,
    timeout: float = 2.0,
) -> ProbeResult:
    """Probe ``http://{host}:{port}/health`` for a live TP-VRG backend.

    Returns a :class:`ProbeResult`. Never raises — every error path
    yields ``alive=False`` with a descriptive ``error`` field.
    """
    try:
        import requests  # type: ignore[import-untyped]
    except ImportError:
        return ProbeResult(
            alive=False,
            initializing=False,
            service_matches=False,
            response=None,
            error="requests not installed (pip install tp-vrg[api])",
        )

    url = f"http://{host}:{port}/health"
    try:
        r = requests.get(url, timeout=timeout)
    except requests.exceptions.ConnectionError as exc:
        return ProbeResult(
            alive=False,
            initializing=False,
            service_matches=False,
            response=None,
            error=f"connection refused: {exc}",
        )
    except requests.exceptions.Timeout:
        return ProbeResult(
            alive=False,
            initializing=False,
            service_matches=False,
            response=None,
            error=f"timeout after {timeout}s",
        )
    except Exception as exc:
        return ProbeResult(
            alive=False,
            initializing=False,
            service_matches=False,
            response=None,
            error=f"{type(exc).__name__}: {exc}",
        )

    if r.status_code != 200:
        return ProbeResult(
            alive=False,
            initializing=False,
            service_matches=False,
            response=None,
            error=f"HTTP {r.status_code}",
        )

    try:
        payload = r.json()
    except ValueError:
        return ProbeResult(
            alive=False,
            initializing=False,
            service_matches=False,
            response=None,
            error="response is not valid JSON",
        )

    if not isinstance(payload, dict):
        return ProbeResult(
            alive=False,
            initializing=False,
            service_matches=False,
            response=None,
            error="response is not a JSON object",
        )

    service = payload.get("service")
    service_matches = service == SERVICE_NAME
    if not service_matches:
        logger.warning(
            "probe: %s:%d responded but service=%r (expected %r). Port busy with unrelated service.",
            host, port, service, SERVICE_NAME,
        )
        return ProbeResult(
            alive=False,
            initializing=False,
            service_matches=False,
            response=payload,
            error=f"service signature mismatch (got {service!r})",
        )

    initializing = bool(payload.get("initializing", False))
    return ProbeResult(
        alive=True,
        initializing=initializing,
        service_matches=True,
        response=payload,
        error=None,
    )
