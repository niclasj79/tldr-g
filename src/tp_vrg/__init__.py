"""TP-VRG — public contracts + verification surface.

This is the public launch candidate: the open boundary **contracts** and the
offline **verification** surface — NOT the proprietary rendering engine. It
deliberately does not import the engine, so ``import tp_vrg`` stays light and
dependency-thin.

Exposed:
  - ``tp_vrg.attestation`` — Ed25519 signed-artifact attestation + offline
    integrity verification of exported render traces / portable artifacts.
  - ``tp_vrg.adapters``    — the boundary adapter contracts + registry a host
    integrates against.

The engine that *produces* the artifacts these contracts describe is the
commercial product; this repo lets anyone integrate against it and
independently verify its outputs.
"""

__version__ = "0.3.0"

from tp_vrg import adapters, attestation

__all__ = ["adapters", "attestation", "__version__"]
