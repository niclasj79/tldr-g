"""One version: what ``tp_vrg.__version__`` reports is what was installed.

The package once reported 0.1.0 while its distribution said 0.4.0. An
integration pinning a contract version reads one of those two numbers, so they
must never disagree.
"""

from importlib.metadata import PackageNotFoundError, version

import pytest

import tp_vrg


def test_reported_version_matches_the_installed_distribution() -> None:
    try:
        installed = version("tp-vrg")
    except PackageNotFoundError:
        pytest.skip("tp-vrg is not installed here (running from a bare checkout)")
    assert tp_vrg.__version__ == installed
