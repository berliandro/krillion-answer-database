#!/usr/bin/env python3
"""Shared helpers for the dependency-free Krillion test suite.

Everything here uses only the Python standard library. Repository paths are
derived from this file so the tests work from any current working directory.
"""
from __future__ import annotations

import hashlib
import importlib.util
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = REPO_ROOT / "scripts"
DATA = REPO_ROOT / "data"


class CheckFailure(AssertionError):
    """A test assertion failed (kept distinct from random stdlib AssertionError)."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CheckFailure(message)


def load_module(name: str, path: Path):
    """Load a standalone .py file as a module (no package needed)."""
    spec = importlib.util.spec_from_file_location(name, str(path))
    if spec is None or spec.loader is None:
        raise CheckFailure(f"cannot load module {name} from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def add_scripts_to_path() -> None:
    """Make scripts/config.py, derive.py, ingest.py importable by bare name."""
    scripts = str(SCRIPTS)
    if scripts not in sys.path:
        sys.path.insert(0, scripts)


def node_check(path: Path, timeout: int = 30) -> None:
    """Fail with useful output if Node cannot parse `path`."""
    try:
        result = subprocess.run(
            ["node", "--check", str(path)],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise CheckFailure("node executable not found on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise CheckFailure(f"node --check timed out for {path.name}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "<no output>").strip()
        raise CheckFailure(f"node --check failed for {path}:\n{detail}")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()
