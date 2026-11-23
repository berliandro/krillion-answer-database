#!/usr/bin/env python3
"""Build invariant: `python scripts/build.py verify` is read-only and passes."""
from __future__ import annotations

import subprocess
import sys
import time

from _common import DATA, REPO_ROOT, CheckFailure, require, sha256_file

DB_NAMES = ("krillion_full.db", "krillion_search.db", "krillion_only.db")


def test_build_verify() -> str:
    before = {name: sha256_file(DATA / name) for name in DB_NAMES}
    started = time.perf_counter()
    try:
        result = subprocess.run(
            [sys.executable, "scripts/build.py", "verify"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired as exc:
        raise CheckFailure("build.py verify timed out (120s)") from exc
    elapsed = time.perf_counter() - started
    output = (result.stdout or "") + (result.stderr or "")
    require(
        result.returncode == 0,
        f"build.py verify exit={result.returncode}\n{output[-3000:]}",
    )
    require("[verify] RESULT: PASS" in output, f"missing RESULT: PASS\n{output[-3000:]}")
    after = {name: sha256_file(DATA / name) for name in DB_NAMES}
    require(before == after, "build.py verify mutated a repository DB")

    # Surface the strongest signal lines for the summary without flooding output.
    signals = [
        line.strip()
        for line in output.splitlines()
        if "recall@10" in line or "matcher index:" in line or "RESULT:" in line
    ]
    return f"exit=0, RESULT: PASS, DB bytes unchanged ({elapsed:.1f}s); " + " | ".join(signals)
