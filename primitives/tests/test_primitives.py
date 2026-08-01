"""Tests for the primitives drop.

These double as the specification: each test names the failure the primitive
exists to prevent. Run from the repo root with ``pytest primitives/``.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

import pytest

PRIMITIVES = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PRIMITIVES / "content-addressing"))
sys.path.insert(0, str(PRIMITIVES / "open-core-boundary"))

import boundary_scan  # noqa: E402
from content_identity import eol_normalized_sha256, normalize_eol  # noqa: E402
from digests import (  # noqa: E402
    digests_equal,
    is_bare_sha256,
    normalize,
    qualify,
)


# ── content identity ────────────────────────────────────────────────────────

def test_crlf_and_lf_hash_identically(tmp_path: Path):
    """The whole point: same content, different checkout, same identity."""
    lf = tmp_path / "lf.txt"
    crlf = tmp_path / "crlf.txt"
    lf.write_bytes(b"line one\nline two\nline three\n")
    crlf.write_bytes(b"line one\r\nline two\r\nline three\r\n")
    assert eol_normalized_sha256(lf) == eol_normalized_sha256(crlf)
    # ...and the naive approach is exactly what fails.
    assert hashlib.sha256(lf.read_bytes()).hexdigest() != hashlib.sha256(crlf.read_bytes()).hexdigest()


def test_lone_cr_also_normalizes(tmp_path: Path):
    """Classic-Mac line endings are rare but real, and silently differ."""
    p = tmp_path / "cr.txt"
    p.write_bytes(b"line one\rline two\r")
    q = tmp_path / "lf.txt"
    q.write_bytes(b"line one\nline two\n")
    assert eol_normalized_sha256(p) == eol_normalized_sha256(q)


def test_crlf_does_not_become_a_double_newline():
    """Replacement order matters: CRLF first, then lone CR."""
    assert normalize_eol("a\r\nb") == "a\nb"
    assert normalize_eol("a\rb") == "a\nb"
    assert normalize_eol("a\n\rb") == "a\n\nb"


def test_lf_file_matches_the_raw_bytes_hash(tmp_path: Path):
    """The adoption property — switching an existing LF pin invalidates nothing."""
    p = tmp_path / "already_lf.txt"
    p.write_bytes("héllo\nwörld\n".encode("utf-8"))
    assert eol_normalized_sha256(p) == hashlib.sha256(p.read_bytes()).hexdigest()


# ── algorithm-qualified digests ─────────────────────────────────────────────

SHA = "a" * 64


def test_qualify_is_idempotent():
    assert qualify(SHA) == f"sha256:{SHA}"
    assert qualify(qualify(SHA)) == f"sha256:{SHA}"


def test_empty_passes_through():
    """Unfilled fields must survive a round trip untouched."""
    assert qualify("") == ""
    assert normalize("") == ""


def test_reader_accepts_both_forms():
    """Legacy and qualified coexist indefinitely — that is what makes it forward-only."""
    assert normalize(SHA) == SHA
    assert normalize(f"sha256:{SHA}") == SHA
    assert digests_equal(SHA, f"sha256:{SHA}")


def test_case_is_folded():
    assert digests_equal(SHA.upper(), f"sha256:{SHA}")


def test_unknown_algorithm_raises_rather_than_comparing_unequal():
    """The rule the module exists for: a wrong verdict is worse than a crash.

    A future `sha3:` value compared as an opaque string would silently read as
    "content changed" — a false tamper verdict, believed by whoever sees it.
    """
    with pytest.raises(ValueError, match="unrecognized digest format"):
        normalize(f"sha3:{SHA}")
    with pytest.raises(ValueError):
        digests_equal(SHA, f"sha3:{SHA}")


def test_malformed_values_raise():
    with pytest.raises(ValueError):
        normalize("sha256:nothex")
    with pytest.raises(ValueError):
        qualify("not-a-digest")
    with pytest.raises(ValueError):
        qualify("sha256:tooshort")


def test_is_bare_sha256_boundaries():
    assert is_bare_sha256(SHA)
    assert not is_bare_sha256(SHA[:-1])
    assert not is_bare_sha256(SHA + "a")
    assert not is_bare_sha256("g" * 64)
    assert not is_bare_sha256(None)  # type: ignore[arg-type]


# ── boundary scanner ────────────────────────────────────────────────────────

def _tree(root: Path, files: dict[str, str]) -> Path:
    for rel, body in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8")
    return root


def test_clean_tree_has_no_findings(tmp_path: Path):
    t = _tree(tmp_path, {
        "mypkg/__init__.py": "",
        "mypkg/a.py": "from mypkg.b import thing\n",
        "mypkg/b.py": "thing = 1\n",
    })
    assert boundary_scan.scan_boundary_imports(t) == []


def test_unshipped_import_is_caught(tmp_path: Path):
    """The incident this tool exists for."""
    t = _tree(tmp_path, {
        "mypkg/__init__.py": "",
        "mypkg/a.py": "from mypkg.engine import secret_sauce\n",
    })
    findings = boundary_scan.scan_boundary_imports(t)
    assert len(findings) == 1
    assert findings[0].module == "mypkg.engine"
    assert findings[0].lineno == 1


def test_try_guarded_import_is_allowed(tmp_path: Path):
    """A declared optional dependency with a fallback is correct, not a defect."""
    t = _tree(tmp_path, {
        "mypkg/__init__.py": "",
        "mypkg/a.py": (
            "try:\n"
            "    from mypkg.extras import enrich\n"
            "except ImportError:\n"
            "    enrich = None\n"
        ),
    })
    assert boundary_scan.scan_boundary_imports(t) == []


def test_import_in_the_except_handler_is_not_guarded(tmp_path: Path):
    """A fallback import must itself resolve — it runs precisely when things fail."""
    t = _tree(tmp_path, {
        "mypkg/__init__.py": "",
        "mypkg/a.py": (
            "try:\n"
            "    import json\n"
            "except ImportError:\n"
            "    from mypkg.missing import json\n"
        ),
    })
    findings = boundary_scan.scan_boundary_imports(t)
    assert [f.module for f in findings] == ["mypkg.missing"]


def test_relative_imports_resolve(tmp_path: Path):
    t = _tree(tmp_path, {
        "mypkg/__init__.py": "",
        "mypkg/sub/__init__.py": "",
        "mypkg/sub/a.py": "from ..gone import x\nfrom . import sibling\n",
        "mypkg/sub/sibling.py": "",
    })
    findings = boundary_scan.scan_boundary_imports(t)
    assert [f.module for f in findings] == ["mypkg.gone"]


def test_src_layout_is_understood(tmp_path: Path):
    """`src/` is a packaging convention, not part of the module path."""
    t = _tree(tmp_path, {
        "src/mypkg/__init__.py": "",
        "src/mypkg/a.py": "from mypkg.b import x\n",
        "src/mypkg/b.py": "x = 1\n",
    })
    assert boundary_scan.scan_boundary_imports(t) == []


def test_third_party_imports_are_out_of_scope(tmp_path: Path):
    """Only the packages you ship are checked; real dependencies are not our business."""
    t = _tree(tmp_path, {
        "mypkg/__init__.py": "",
        "mypkg/a.py": "import os\nimport cryptography\nfrom pathlib import Path\n",
    })
    assert boundary_scan.scan_boundary_imports(t) == []


def test_bare_package_import_resolves_via_prefix(tmp_path: Path):
    t = _tree(tmp_path, {"mypkg/__init__.py": "", "mypkg/a.py": "import mypkg\n"})
    assert boundary_scan.scan_boundary_imports(t) == []


def test_cli_exit_codes(tmp_path: Path):
    clean = _tree(tmp_path / "clean", {"p/__init__.py": "", "p/a.py": "x = 1\n"})
    dirty = _tree(tmp_path / "dirty", {"p/__init__.py": "", "p/a.py": "from p.gone import x\n"})
    script = PRIMITIVES / "open-core-boundary" / "boundary_scan.py"

    assert subprocess.run([sys.executable, str(script), str(clean)],
                          capture_output=True).returncode == 0
    bad = subprocess.run([sys.executable, str(script), str(dirty)], capture_output=True, text=True)
    assert bad.returncode == 1
    assert "p.gone" in bad.stderr
    assert subprocess.run([sys.executable, str(script), str(tmp_path / "nope")],
                          capture_output=True).returncode == 2
