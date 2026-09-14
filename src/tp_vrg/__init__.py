"""TLDR-G — public contracts + verification surface.

This is the public launch candidate: the open boundary **contracts** and the
offline **verification** surface — NOT the proprietary rendering engine. It
deliberately does not import the engine, so ``import tp_vrg`` stays light and
dependency-thin.

Exposed:
  - ``tp_vrg.attestation`` — Ed25519 signed-artifact attestation + offline
    integrity verification of exported render traces / portable artifacts.
  - ``tp_vrg.adapters``    — the boundary adapter contracts + registry a host
    integrates against.

The engine that *produces* the artifacts these contracts describe is a free
local app (a closed binary); this repo is its open boundary — letting anyone
integrate against it and independently verify its outputs.
"""

# One number: this equals [project].version in pyproject.toml — the contract-surface
# version (see CHANGELOG.md § Versioning). tests/test_public_overlay_version.py pins
# the two together in the home repo; tests/test_public_version.py checks it against
# the installed distribution here.
__version__ = "0.5.0"

from tp_vrg import adapters, attestation

__all__ = ["adapters", "attestation", "__version__"]
