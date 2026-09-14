"""Conformance suite v0 for the TLDR-G open contracts.

Validates an Attestation Envelope (and its dispatched payload — render_trace or
portable_artifact) against the JSON Schemas in ``../contracts/schemas/``
(relative to this file).

Two validation backends, same verdict:
  * ``jsonschema`` (Draft 2020-12) when importable — the reference path;
  * a small stdlib-only fallback otherwise (required / const / enum / type /
    pattern / array-items / if-then), so an external party can run the
    conformance check with nothing but the standard library.

This is deliberately self-contained: it depends on NOTHING under ``src/tp_vrg``,
because the contracts ship in the public repo and an outside integrator must be
able to validate their own envelopes without the engine.

CLI:
    python conformance.py                 # run the fixture suite, exit 0 iff all conform
    python conformance.py validate FILE   # validate one envelope JSON file
    python conformance.py --stdlib        # force the stdlib fallback backend
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
SCHEMA_DIR = _HERE.parent / "contracts" / "schemas"
FIXTURE_DIR = _HERE / "fixtures"

ENVELOPE_SCHEMA = "attestation-envelope-v1.schema.json"
PAYLOAD_SCHEMA_BY_TYPE = {
    "render_trace": "render-trace-v1.schema.json",
    "portable_artifact": "portable-artifact-v1.schema.json",
}


def load_schema(name: str) -> dict[str, Any]:
    path = SCHEMA_DIR / name
    if not path.exists():  # fail loud — a missing schema voids the whole proof
        raise FileNotFoundError(f"schema not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


# --------------------------------------------------------------------- backends


def _jsonschema_errors(instance: Any, schema: dict[str, Any]) -> list[str] | None:
    """Validate with the jsonschema package; None if it isn't importable."""
    try:
        from jsonschema import Draft202012Validator
    except ImportError:
        return None
    validator = Draft202012Validator(schema)
    return [
        f"{'/'.join(str(p) for p in e.path) or '<root>'}: {e.message}"
        for e in sorted(validator.iter_errors(instance), key=lambda e: list(e.path))
    ]


def _type_ok(value: Any, expected: Any) -> bool:
    types = expected if isinstance(expected, list) else [expected]
    for t in types:
        if t == "null" and value is None:
            return True
        if t == "object" and isinstance(value, dict):
            return True
        if t == "array" and isinstance(value, list):
            return True
        if t == "string" and isinstance(value, str):
            return True
        # bool is a subclass of int — exclude it from the integer/number checks
        if t == "integer" and isinstance(value, int) and not isinstance(value, bool):
            return True
        if t == "number" and isinstance(value, (int, float)) and not isinstance(value, bool):
            return True
        if t == "boolean" and isinstance(value, bool):
            return True
    return False


def _stdlib_errors(instance: Any, schema: dict[str, Any], path: str = "") -> list[str]:
    """A minimal Draft-2020-12 subset covering exactly the keywords our
    contract schemas use. Not a general validator — a dependency-free floor."""
    errors: list[str] = []
    here = path or "<root>"

    if "const" in schema and instance != schema["const"]:
        errors.append(f"{here}: expected const {schema['const']!r}, got {instance!r}")
    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{here}: {instance!r} not in enum {schema['enum']}")
    if "type" in schema and not _type_ok(instance, schema["type"]):
        errors.append(f"{here}: wrong type, expected {schema['type']}")
    if "pattern" in schema and isinstance(instance, str):
        if not re.search(schema["pattern"], instance):
            errors.append(f"{here}: {instance!r} does not match pattern {schema['pattern']}")
    if "minLength" in schema and isinstance(instance, str) and len(instance) < schema["minLength"]:
        errors.append(f"{here}: shorter than minLength {schema['minLength']}")

    if isinstance(instance, dict):
        for key in schema.get("required", []):
            if key not in instance:
                errors.append(f"{here}: missing required property {key!r}")
        for key, subschema in schema.get("properties", {}).items():
            if key in instance:
                errors.extend(_stdlib_errors(instance[key], subschema, f"{path}/{key}" if path else key))

    if isinstance(instance, list) and "items" in schema:
        for i, item in enumerate(instance):
            errors.extend(_stdlib_errors(item, schema["items"], f"{path}/{i}" if path else str(i)))

    for sub in schema.get("allOf", []):
        if "if" in sub:
            if not _stdlib_errors(instance, sub["if"], path):  # condition holds
                errors.extend(_stdlib_errors(instance, sub.get("then", {}), path))
        else:
            errors.extend(_stdlib_errors(instance, sub, path))

    return errors


def validate(instance: Any, schema: dict[str, Any], *, force_stdlib: bool = False) -> list[str]:
    """Return a list of conformance errors ([] = conforms)."""
    if not force_stdlib:
        result = _jsonschema_errors(instance, schema)
        if result is not None:
            return result
    return _stdlib_errors(instance, schema)


def active_backend(*, force_stdlib: bool = False) -> str:
    if force_stdlib:
        return "stdlib"
    try:
        import jsonschema  # noqa: F401
        return "jsonschema"
    except ImportError:
        return "stdlib"


# ----------------------------------------------------------------- envelope API


def validate_envelope(envelope: Any, *, force_stdlib: bool = False) -> dict[str, Any]:
    """Validate the envelope shape, then dispatch its payload to the payload
    schema named by payload_type. Returns {conforms, errors, payload_type}."""
    errors = list(validate(envelope, load_schema(ENVELOPE_SCHEMA), force_stdlib=force_stdlib))

    payload_type = envelope.get("payload_type") if isinstance(envelope, dict) else None
    if payload_type in PAYLOAD_SCHEMA_BY_TYPE and isinstance(envelope, dict) and isinstance(envelope.get("payload"), dict):
        payload_errors = validate(
            envelope["payload"],
            load_schema(PAYLOAD_SCHEMA_BY_TYPE[payload_type]),
            force_stdlib=force_stdlib,
        )
        errors.extend(f"payload/{e}" for e in payload_errors)

    return {
        "conforms": not errors,
        "errors": errors,
        "payload_type": payload_type,
        "backend": active_backend(force_stdlib=force_stdlib),
    }


def _load_fixtures(subdir: str) -> list[tuple[str, Any]]:
    out: list[tuple[str, Any]] = []
    d = FIXTURE_DIR / subdir
    for path in sorted(d.glob("*.json")):
        if path.name == "manifest.json":
            continue
        out.append((path.name, json.loads(path.read_text(encoding="utf-8"))))
    return out


def run_conformance(*, force_stdlib: bool = False) -> dict[str, Any]:
    """The fixture suite: every valid/ envelope must conform; every invalid/
    envelope must be rejected. Returns a report with ``all_conform``."""
    results: list[dict[str, Any]] = []

    for name, env in _load_fixtures("valid"):
        v = validate_envelope(env, force_stdlib=force_stdlib)
        results.append({"fixture": f"valid/{name}", "expected": "conform",
                        "ok": v["conforms"], "errors": v["errors"]})

    for name, env in _load_fixtures("invalid"):
        v = validate_envelope(env, force_stdlib=force_stdlib)
        # a rejection is the SUCCESS condition here
        results.append({"fixture": f"invalid/{name}", "expected": "reject",
                        "ok": not v["conforms"], "errors": v["errors"]})

    return {
        "suite": "oss-contracts-conformance-v0",
        "backend": active_backend(force_stdlib=force_stdlib),
        "results": results,
        "all_conform": all(r["ok"] for r in results),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", nargs="?", default="suite",
                        choices=["suite", "validate"],
                        help="suite (default) runs the fixture suite; validate checks one file")
    parser.add_argument("file", nargs="?", help="envelope JSON file (for `validate`)")
    parser.add_argument("--stdlib", action="store_true",
                        help="force the dependency-free stdlib backend")
    args = parser.parse_args(argv)

    if args.command == "validate":
        if not args.file:
            parser.error("validate requires a FILE argument")
        envelope = json.loads(Path(args.file).read_text(encoding="utf-8"))
        verdict = validate_envelope(envelope, force_stdlib=args.stdlib)
        print(json.dumps(verdict, indent=2))
        return 0 if verdict["conforms"] else 1

    report = run_conformance(force_stdlib=args.stdlib)
    print(json.dumps(report, indent=2))
    return 0 if report["all_conform"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
