"""tp-vrg-verify — offline integrity verification of a signed TLDR-G export.

A thin CLI over ``tp_vrg.attestation.verify_envelope`` so a counterparty can
check a signed render trace / portable artifact without writing Python and
without the engine. Exit 0 = valid, 1 = invalid, 2 = unusable input.
"""

from __future__ import annotations

import json
import sys


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("usage: tp-vrg-verify <signed-export.json>", file=sys.stderr)
        return 2
    try:
        with open(argv[0], encoding="utf-8") as fh:
            envelope = json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"cannot read {argv[0]}: {exc}", file=sys.stderr)
        return 2

    from tp_vrg.attestation import verify_envelope

    verdict = verify_envelope(envelope)
    print(f"Attestation: {'VALID' if verdict['valid'] else 'INVALID'}")
    print(f"  reason:    {verdict.get('reason')}")
    print(f"  key_id:    {verdict.get('key_id')}")
    print(f"  signed_by: {verdict.get('signed_by')}")
    return 0 if verdict["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
