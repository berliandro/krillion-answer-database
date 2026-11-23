#!/usr/bin/env python3
"""Dependency-free test runner for the Krillion repository.

Run:  python tests/run_all.py

Each `test_*` function in the modules below must return a short detail string
and raise on failure. The runner prints one PASS/FAIL line per test and exits
non-zero if any test failed. Optional `--verbose` prints full tracebacks.
"""
from __future__ import annotations

import importlib
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

MODULES = (
    ("matcher", "test_matcher"),
    ("build", "test_build"),
    ("bridge", "test_bridge"),
    ("userscript", "test_userscript"),
    ("site-js", "test_site_js"),
    ("policy", "test_policy"),
    ("modes", "test_modes"),
)


def main() -> int:
    verbose = "--verbose" in sys.argv
    results: list[bool] = []
    overall = time.perf_counter()

    for label, module_name in MODULES:
        try:
            module = importlib.import_module(module_name)
            names = sorted(
                name for name in dir(module)
                if name.startswith("test_") and callable(getattr(module, name))
            )
            if not names:
                raise RuntimeError(f"no test_* functions in {module_name}")
        except Exception as exc:  # import failure is itself a failing test
            results.append(False)
            print(f"[FAIL] {label}.import ({type(exc).__name__}: {exc})")
            if verbose:
                traceback.print_exc()
            continue

        for name in names:
            started = time.perf_counter()
            try:
                detail = getattr(module, name)()
                ok = True
            except Exception as exc:
                ok = False
                detail = f"{type(exc).__name__}: {exc}"
                if verbose:
                    traceback.print_exc()
            elapsed = time.perf_counter() - started
            results.append(ok)
            print(f"[{'PASS' if ok else 'FAIL'}] {label}.{name[5:]} ({elapsed:.2f}s) {detail}")

    passed = sum(results)
    failed = len(results) - passed
    total = time.perf_counter() - overall
    print(f"\nSummary: {passed} passed, {failed} failed ({total:.2f}s)")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
