#!/usr/bin/env python3
"""Prove an open-core boundary holds: every shipped import resolves in the shipped tree.

If you publish part of a private repo — an SDK, an open-core subset, a vendored
client — you have a boundary, and the boundary is only real if it is checked. The
failure mode is quiet and embarrassing in a specific way:

    A published module imports something you did not publish. On your machine the
    private code is right there, so it imports fine, your tests pass, and you ship.
    The first person to clone the published repo gets ModuleNotFoundError on their
    first command.

That is not hypothetical. This tool exists because a developer's clean clone of a
published repo failed its own test suite on the first ``pytest`` — two failures,
from one import of a module that was correctly *not* published. Nothing in the
release process could have caught it, because every check ran in a tree where the
unpublished module was present.

This scanner reads the **published** tree only. For every ``.py`` file it walks the
AST, collects every import of the packages you are shipping, resolves relative
imports to absolute module names, and asks: did we actually ship this? If not, it
is a finding and the release should fail.

One deliberate exception: an import inside a ``try:`` block is treated as a declared
optional dependency, not a defect. That is the correct way to ship a module that
*enriches* its output when a bigger package is present and degrades gracefully when
it is not — so the tool must not punish it.

    # allowed: an optional enrichment with a graceful fallback
    try:
        from mypkg.extras import enrich
    except ImportError:
        enrich = None

Usage
-----

    python boundary_scan.py PUBLISHED_DIR
    python boundary_scan.py PUBLISHED_DIR --package mypkg --package othertop
    python boundary_scan.py PUBLISHED_DIR --json

Exit codes: ``0`` clean · ``1`` findings · ``2`` bad usage.

Package names default to the top-level importable packages found in the published
tree, which is right for the common case. Pass ``--package`` when you ship a
namespace subset and want imports of the *whole* namespace checked.

Part of the TLDR-G primitives drop — https://tldr-g.ai
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
from dataclasses import dataclass
from pathlib import Path

__all__ = ["Finding", "scan_boundary_imports", "shipped_modules"]

# Directories that never contain shipped source.
IGNORED_DIRS = {
    ".git", ".hg", ".svn", "__pycache__", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".tox", ".venv", "venv", "node_modules", "build", "dist",
}


@dataclass(frozen=True)
class Finding:
    """One unguarded import of a module that is not in the published tree."""

    path: str
    lineno: int
    module: str

    def __str__(self) -> str:
        return (
            f"{self.path}:{self.lineno}: unguarded import of non-shipped module "
            f"'{self.module}' — ship it, or wrap the import in try/except ImportError "
            f"with a graceful fallback"
        )


def _iter_py(root: Path):
    for path in sorted(root.rglob("*.py")):
        if any(part in IGNORED_DIRS for part in path.relative_to(root).parts):
            continue
        yield path


def _file_module(root: Path, path: Path) -> tuple[str, bool]:
    """Dotted module name for a file, and whether it is a package ``__init__``."""
    parts = list(path.relative_to(root).parts)
    is_init = parts[-1] == "__init__.py"
    # A `src/` layout is a packaging convention, not part of the module path.
    if parts and parts[0] == "src":
        parts = parts[1:]
    if is_init:
        return ".".join(parts[:-1]), True
    parts[-1] = parts[-1][: -len(".py")]
    return ".".join(parts), False


def shipped_modules(root: Path) -> set[str]:
    """Every dotted module name present in the published tree."""
    out: set[str] = set()
    for path in _iter_py(root):
        dotted, _ = _file_module(root, path)
        if dotted:
            out.add(dotted)
    return out


def infer_packages(root: Path) -> set[str]:
    """Top-level packages the published tree defines."""
    return {m.split(".", 1)[0] for m in shipped_modules(root) if m}


def _resolve_relative(file_module: str, is_init: bool, level: int, module: str | None) -> str:
    """Turn a relative import into an absolute dotted name.

    ``level`` is the number of leading dots. For a package ``__init__`` the anchor
    is the package itself; for a plain module it is the package containing it.
    """
    anchor = file_module if is_init else (
        file_module.rsplit(".", 1)[0] if "." in file_module else ""
    )
    for _ in range(level - 1):
        anchor = anchor.rsplit(".", 1)[0] if "." in anchor else ""
    if module:
        return f"{anchor}.{module}" if anchor else module
    return anchor


def _in_scope(mod: str, packages: set[str]) -> bool:
    return any(mod == p or mod.startswith(p + ".") for p in packages)


def _import_refs(
    tree: ast.AST, file_module: str, is_init: bool, packages: set[str]
) -> list[tuple[str, int, bool]]:
    """(module, lineno, guarded) for every in-scope import.

    ``guarded`` is True when the import sits inside a ``try:`` body, i.e. an
    ImportError fallback is possible. Each node is visited exactly once.
    """
    refs: list[tuple[str, int, bool]] = []

    def record(node: ast.AST, guarded: bool) -> None:
        if isinstance(node, ast.Import):
            for alias in node.names:
                if _in_scope(alias.name, packages):
                    refs.append((alias.name, node.lineno, guarded))
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                mod = _resolve_relative(file_module, is_init, node.level, node.module)
                if not _in_scope(mod, packages):
                    return
                if node.module:
                    refs.append((mod, node.lineno, guarded))
                else:
                    # `from . import a, b` -> package.a, package.b
                    for alias in node.names:
                        refs.append(
                            (f"{mod}.{alias.name}" if mod else alias.name, node.lineno, guarded)
                        )
            elif node.module and _in_scope(node.module, packages):
                refs.append((node.module, node.lineno, guarded))

    def visit(node: ast.AST, in_try: bool) -> None:
        record(node, in_try)
        if isinstance(node, ast.Try):
            for stmt in node.body:
                visit(stmt, True)          # the guarded region
            for handler in node.handlers:
                visit(handler, in_try)     # the fallback is not itself guarded
            for stmt in node.orelse:
                visit(stmt, in_try)
            for stmt in node.finalbody:
                visit(stmt, in_try)
        else:
            for child in ast.iter_child_nodes(node):
                visit(child, in_try)

    visit(tree, False)
    return refs


def _module_shipped(mod: str, shipped: set[str]) -> bool:
    """A module ships if it is present, or is a package prefix of something present."""
    return mod in shipped or any(s == mod or s.startswith(mod + ".") for s in shipped)


def scan_boundary_imports(
    root: Path, packages: set[str] | None = None
) -> list[Finding]:
    """Every unguarded in-scope import that does not resolve within ``root``."""
    root = Path(root)
    pkgs = packages or infer_packages(root)
    shipped = shipped_modules(root)
    findings: list[Finding] = []
    for path in _iter_py(root):
        rel = path.relative_to(root).as_posix()
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError as exc:
            findings.append(Finding(rel, getattr(exc, "lineno", 0) or 0, f"<syntax error: {exc.msg}>"))
            continue
        file_module, is_init = _file_module(root, path)
        for mod, lineno, guarded in _import_refs(tree, file_module, is_init, pkgs):
            if guarded:
                continue
            if not _module_shipped(mod, shipped):
                findings.append(Finding(rel, lineno, mod))
    return findings


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Check that every import in a published tree resolves within it."
    )
    ap.add_argument("tree", type=Path, help="the PUBLISHED directory to scan")
    ap.add_argument(
        "--package", action="append", default=[],
        help="package name to treat as in-scope (repeatable; default: inferred)",
    )
    ap.add_argument("--json", action="store_true", help="emit findings as JSON")
    args = ap.parse_args(argv)

    if not args.tree.is_dir():
        print(f"not a directory: {args.tree}", file=sys.stderr)
        return 2

    packages = set(args.package) or infer_packages(args.tree)
    if not packages:
        print(f"no Python packages found in {args.tree}", file=sys.stderr)
        return 2

    findings = scan_boundary_imports(args.tree, packages)

    if args.json:
        print(json.dumps([f.__dict__ for f in findings], indent=2))
    elif findings:
        print(f"{len(findings)} boundary violation(s) in {args.tree}:\n", file=sys.stderr)
        for f in findings:
            print(f"  {f}", file=sys.stderr)
        print(
            "\nEach of these imports resolves on a machine that has the private tree "
            "and fails on a clean clone.",
            file=sys.stderr,
        )
    else:
        print(f"boundary clean: {len(shipped_modules(args.tree))} modules, "
              f"packages={','.join(sorted(packages))}")
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
