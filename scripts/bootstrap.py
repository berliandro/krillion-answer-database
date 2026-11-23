#!/usr/bin/env python3
"""Bootstrap a fresh Krillion clone with one command.

    python scripts/bootstrap.py            # inspect, then apply what is missing
    python scripts/bootstrap.py --check    # read-only inspection only
    python scripts/bootstrap.py --apply    # same as the default invocation

A fresh clone keeps source JSONLs + scripts in git but not the derived SQLite
DBs or generated artefacts, so the bridge cannot start. This tool inspects the
repo, reports every input / DB / artefact as OK, MISSING or STALE (with counts),
and --apply runs the EXISTING pipeline commands via subprocess. It never
reimplements their logic, never deletes data, and never rotates or processes
logs. All paths come from scripts/config.py, so KRILLION_ROOT is respected.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

# Make the sibling modules (config, derive) importable from any cwd.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import config as cfg  # noqa: E402  (path setup must come first)
import derive  # noqa: E402  (read-only counts(); no side effects)

PY = sys.executable
SCRIPTS = Path(cfg.SCRIPTS)  # real-repo scripts dir, even under KRILLION_ROOT

OK, MISSING, STALE = "OK", "MISSING", "STALE"
HEALTH_URL = f"http://127.0.0.1:{cfg.PORT}/api/health?t={cfg.TOKEN}"
BRIDGE_CMD = "python injection/bridge.py"

# (manifest artifact key, path relative to ROOT, builder that produces it)
ARTIFACTS = [
    ("matcher_index.json", cfg.DATA / "matcher_index.json", "build.py emit + publish"),
    ("shared/norm.generated.js", cfg.NORM_JS, "build.py emit + publish"),
    ("search-data.json", cfg.ROOT / cfg.LEGACY_SEARCH_JSON, "build_static.py"),
    ("krillion/krillion-data.json", cfg.ROOT / cfg.LEGACY_KRILLION_JSON, "build_krillion_site.py"),
    ("search-data.v2.json", cfg.ROOT / cfg.V2_SEARCH_JSON, "build.py emit + publish"),
    ("krillion-data.v2.json", cfg.ROOT / cfg.V2_KRILLION_JSON, "build.py emit + publish"),
]


# ------------------------------------------------------------------- helpers
def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _source_etag() -> str:
    """Mirror emit.etag(): sha256 over answer JSONLs + corrections."""
    h = hashlib.sha256()
    for path in cfg.answer_files() + [cfg.CORRECTIONS]:
        if path.exists():
            h.update(path.read_bytes())
    return h.hexdigest()


def _ro(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)


def _scalar(path: Path, sql: str) -> int | None:
    if not path.exists():
        return None
    try:
        with _ro(path) as c:
            return int(c.execute(sql).fetchone()[0])
    except sqlite3.Error:
        return None


def _has_table(path: Path, table: str) -> bool:
    if not path.exists():
        return False
    try:
        with _ro(path) as c:
            return bool(
                c.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
                ).fetchone()
            )
    except sqlite3.Error:
        return False


def _manifest() -> dict | None:
    if not cfg.MANIFEST.exists():
        return None
    try:
        m = json.loads(cfg.MANIFEST.read_text(encoding="utf-8"))
        return m if isinstance(m, dict) else None
    except (OSError, ValueError):
        return None


def _counts() -> dict | None:
    try:
        return derive.counts()
    except Exception:
        return None


def _display(path: Path) -> str:
    try:
        return path.relative_to(cfg.ROOT).as_posix()
    except ValueError:
        return str(path)


def _command(script: str, *args: str) -> list[str]:
    return [PY, str(SCRIPTS / script), *args]


# ---------------------------------------------------------------- inspection
def inspect() -> tuple[list[tuple[str, str, str, str]], dict]:
    """Read-only inspection. Returns (rows, info) where rows are printable."""
    rows: list[tuple[str, str, str, str]] = []
    manifest = _manifest()
    counts = _counts()
    etag = _source_etag()
    etag_ok = bool(manifest and manifest.get("etag") == etag)
    counts_ok = bool(manifest and counts and manifest.get("counts") == counts)

    info = {
        "manifest": manifest,
        "counts": counts,
        "etag_ok": etag_ok,
        "counts_ok": counts_ok,
        "db_missing": [],
        "db_stale": [],
        "artifact_missing": [],
        "artifact_stale": [],
        "sources_missing": [],
    }

    # --- sources -----------------------------------------------------------
    answer_files = cfg.answer_files()
    if not answer_files:
        rows.append(("Sources", "answers*.jsonl", MISSING, "no answer files in data/"))
        info["sources_missing"].append("answers*.jsonl")
    else:
        lines = sum(
            1
            for p in answer_files
            for line in p.read_text(encoding="utf-8", errors="replace").splitlines()
            if line.strip()
        )
        rows.append(
            ("Sources", "answers*.jsonl", OK,
             f"{len(answer_files)} files, {lines:,} rows")
        )

    tests = cfg.PARAPHRASE_TESTS
    if not tests.exists():
        rows.append(("Sources", "paraphrase_tests.json", MISSING, "required by verify"))
        info["sources_missing"].append("paraphrase_tests.json")
    else:
        try:
            ntests = len(json.loads(tests.read_text(encoding="utf-8")))
            rows.append(("Sources", "paraphrase_tests.json", OK, f"{ntests} cases"))
        except (OSError, ValueError) as exc:
            rows.append(("Sources", "paraphrase_tests.json", STALE, f"unreadable: {exc}"))
            info["sources_missing"].append("paraphrase_tests.json")

    # --- databases ---------------------------------------------------------
    db_specs = [
        ("krillion_full.db", cfg.FULL_DB,
         lambda p: _scalar(p, "SELECT COUNT(*) FROM answers"), "answers"),
        ("krillion_search.db", cfg.SEARCH_DB,
         lambda p: _scalar(
             p, "SELECT COUNT(*) FROM search_answer"
             if _has_table(p, "search_answer") else "SELECT COUNT(*) FROM search_answers"
         ), "questions"),
        ("krillion_only.db", cfg.ONLY_DB,
         lambda p: _scalar(p, "SELECT COUNT(*) FROM answers"), "rare answers"),
    ]
    for name, path, counter, unit in db_specs:
        if not path.exists():
            rows.append(("Databases", name, MISSING, "file absent"))
            info["db_missing"].append(name)
            continue
        value = counter(path)
        if value is None:
            rows.append(("Databases", name, STALE, "unreadable / table missing"))
            info["db_stale"].append(name)
            continue
        if not (etag_ok and counts_ok):
            rows.append(
                ("Databases", name, STALE,
                 f"{value:,} {unit}; source/manifest out of sync")
            )
            info["db_stale"].append(name)
        else:
            rows.append(("Databases", name, OK, f"{value:,} {unit}"))

    if counts is not None:
        rows.append(
            ("Counts", "manifest vs DB", OK if counts_ok else STALE,
             f"full={counts['full']} search={counts['search']} "
             f"krillion={counts['krillion']} prompts={counts['prompts']}")
        )
    else:
        rows.append(("Counts", "manifest vs DB", MISSING, "DBs unreadable"))

    # --- manifest ----------------------------------------------------------
    if manifest is None:
        rows.append(("Generated", "data/manifest.json", MISSING, "not built"))
    elif not (etag_ok and counts_ok):
        rows.append(
            ("Generated", "data/manifest.json", STALE,
             f"version={manifest.get('data_version')} etag match={etag_ok} "
             f"counts match={counts_ok}")
        )
    else:
        rows.append(
            ("Generated", "data/manifest.json", OK,
             f"version={manifest.get('data_version')} counts match")
        )

    # --- generated artefacts ----------------------------------------------
    artifacts = manifest.get("artifacts", {}) if manifest else {}
    for key, path, builder in ARTIFACTS:
        if not path.exists():
            rows.append(("Generated", _display(path), MISSING, f"via {builder}"))
            info["artifact_missing"].append(key)
            continue
        detail = f"sha256={_sha256(path)[:12]} via {builder}"
        status = OK
        expected = artifacts.get(key) if isinstance(artifacts, dict) else None
        if manifest is None:
            status, detail = STALE, detail + "; no manifest"
        elif expected != _sha256(path):
            status, detail = STALE, detail + "; manifest hash mismatch"
        if key == "matcher_index.json" and status == OK:
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
                src_sha = payload.get("matcher_source_sha256")
                if src_sha != _sha256(cfg.PARAPHRASE_SOURCE):
                    status = STALE
                    detail += "; matcher source hash stale"
            except (OSError, ValueError) as exc:
                status = STALE
                detail += f"; invalid JSON ({exc})"
        rows.append(("Generated", _display(path), status, detail))
        if status == MISSING:
            info["artifact_missing"].append(key)
        elif status == STALE:
            info["artifact_stale"].append(key)

    return rows, info


def _print_report(rows: list[tuple[str, str, str, str]]) -> None:
    last_section = None
    for section, name, status, detail in rows:
        if section != last_section:
            print(f"\n{section}")
            last_section = section
        print(f"  {status:<8} {name}: {detail}")
    print()
    tally = {OK: 0, MISSING: 0, STALE: 0}
    for _, _, status, _ in rows:
        tally[status] += 1
    print(
        f"[bootstrap] SUMMARY: {tally[OK]} OK, {tally[MISSING]} MISSING, "
        f"{tally[STALE]} STALE"
    )


# --------------------------------------------------------------------- apply
def _plan(info: dict) -> list[tuple[str, list[str]]]:
    """Ordered pipeline commands needed to bring the repo back to READY."""
    steps: list[tuple[str, list[str]]] = []
    db_problem = bool(info["db_missing"] or info["db_stale"])
    source_problem = bool(info["sources_missing"])

    if source_problem:
        # No existing command can manufacture source data. Fail with a clear
        # diagnostic instead of running an empty import.
        return [("__SOURCE_ERROR__", [", ".join(info["sources_missing"])])]

    if info["db_missing"]:
        steps.append(("init", _command("krillion_db.py", "init")))
    if db_problem or not (info["etag_ok"] and info["counts_ok"]):
        # krillion_db.py import already calls derive.rebuild() (legacy search
        # DB) and derive.build_krillion_only() (krillion-only DB), so no extra
        # `rebuild` / `krillion-only` invocations are needed here.
        steps.append(("import", _command("krillion_db.py", "import")))

    legacy = {
        "search-data.json", "krillion/krillion-data.json"
    }
    legacy_problem = any(
        k in legacy for k in (info["artifact_missing"] + info["artifact_stale"])
    )
    if legacy_problem or db_problem:
        steps.append(("build_static", _command("build_static.py")))
        steps.append(("build_krillion_site", _command("build_krillion_site.py")))

    artifact_problem = bool(
        info["artifact_missing"] or info["artifact_stale"]
    )
    if (artifact_problem or db_problem or not info["manifest"]
            or not info["etag_ok"] or not info["counts_ok"]):
        steps.append(("emit", _command("build.py", "emit")))
        steps.append(("publish", _command("build.py", "publish")))

    # verify is read-only but runs the full policy/paraphrase suite; only run
    # it when we actually changed something (keeps --apply idempotent).
    if steps:
        steps.append(("verify", _command("build.py", "verify")))
    return steps


def _run(name: str, cmd: list[str]) -> bool:
    pretty = " ".join(str(x) for x in cmd)
    print(f"[bootstrap] RUN  {name}: {pretty}", flush=True)
    proc = subprocess.run(cmd, cwd=str(SCRIPTS), env=os.environ.copy())
    if proc.returncode != 0:
        print(f"[bootstrap] FAILED command (exit {proc.returncode}): {pretty}")
        return False
    return True


def _all_ok(rows: list[tuple[str, str, str, str]]) -> bool:
    return all(status == OK for _, _, status, _ in rows)


def apply() -> int:
    rows, info = inspect()
    _print_report(rows)

    steps = _plan(info)
    if any(name == "__SOURCE_ERROR__" for name, _ in steps):
        print(f"[bootstrap] BLOCKED: missing required source files: {steps[0][1][0]}")
        print("[bootstrap] Restore the source JSONLs in data/ and re-run bootstrap.")
        return 1

    if not steps:
        print("[bootstrap] READY - everything is present and current; nothing to do.")
        print(f"[bootstrap] Start the bridge with: {BRIDGE_CMD}")
        print(f"[bootstrap] Bridge health: {HEALTH_URL}  (once the bridge is running)")
        return 0

    print(f"[bootstrap] APPLY plan: {' -> '.join(name for name, _ in steps)}")
    for name, cmd in steps:
        if not _run(name, cmd):
            print("[bootstrap] Bootstrap failed at the command shown above.")
            return 1

    print("\n[bootstrap] Re-checking after apply ...")
    new_rows, _ = inspect()
    _print_report(new_rows)
    if not _all_ok(new_rows):
        print("[bootstrap] Bootstrap incomplete: see MISSING/STALE rows above.")
        return 1

    print("[bootstrap] DONE - clone is ready: DBs, manifest, matcher index, "
          "generated JS and site JSON all current.")
    print(f"[bootstrap] Start the bridge with: {BRIDGE_CMD}")
    print(f"[bootstrap] Bridge health: {HEALTH_URL}  (once the bridge is running)")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true",
                      help="read-only inspection; never writes or runs commands")
    mode.add_argument("--apply", action="store_true",
                      help="build missing/stale artefacts (default)")
    args = p.parse_args()

    root_note = "KRILLION_ROOT set" if os.environ.get("KRILLION_ROOT") else "default"
    print("[bootstrap] Krillion bootstrap")
    print(f"[bootstrap] root: {cfg.ROOT} ({root_note})")
    print(f"[bootstrap] scripts: {SCRIPTS}")
    print(f"[bootstrap] mode: {'CHECK (read-only)' if args.check else 'APPLY'}")

    if args.check:
        rows, _ = inspect()
        _print_report(rows)
        if _all_ok(rows):
            print("[bootstrap] READY (check only; no files written).")
            print(f"[bootstrap] Bridge health: {HEALTH_URL}  "
                  "(once the bridge is running)")
            return 0
        print("[bootstrap] NOT READY - run `python scripts/bootstrap.py` to fix "
              "the MISSING/STALE rows above.")
        return 1

    return apply()


if __name__ == "__main__":
    raise SystemExit(main())
