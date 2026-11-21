#!/usr/bin/env python3
"""Rotate diagnostic logs without losing data.

Append-only gameplay logs grow forever. This archives the FULL current file to
`data/archive/<name>-<timestamp>.jsonl.gz`, then keeps only the most recent
lines active. Authoritative files (corrections, learned, answers_injection,
fetch_queue) are NEVER rotated — they feed the database.

Default is a dry run. Use --apply to actually rotate.

Run from anywhere:  python injection/rotate_logs.py [--apply]
"""
import argparse
import gzip
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "injection" / "data"
CHANGELOG = ROOT / "injection" / "CHANGELOG.md"

# Only diagnostic logs are rotated. These are preserved verbatim.
DIAGNOSTIC = {
    "evidence.jsonl": {"max": 5000, "keep": 2000},
    "prompt_review.jsonl": {"max": 5000, "keep": 2000},
    "bot_log.jsonl": {"max": 3000, "keep": 1000},
    "failed_prompts.jsonl": {"max": 2000, "keep": 500},
}


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def stamp():
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def read_lines(path):
    if not path.exists():
        return []
    return [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]


def rotate(data_dir, apply, max_override, keep_override):
    archive = data_dir / "archive"
    results = []
    for name, cfg in DIAGNOSTIC.items():
        path = data_dir / name
        lines = read_lines(path)
        limit = max_override or cfg["max"]
        keep = keep_override or cfg["keep"]
        if len(lines) <= limit:
            results.append({"file": name, "lines": len(lines), "action": "ok"})
            continue

        target = archive / f"{path.stem}-{stamp()}.jsonl.gz"
        try:
            shown_to = str(target.relative_to(ROOT))
        except ValueError:
            shown_to = str(target)
        results.append({
            "file": name, "lines": len(lines), "action": "archive",
            "to": shown_to, "keep": keep,
        })
        if not apply:
            continue

        archive.mkdir(parents=True, exist_ok=True)
        # Write the complete archive first; only then shrink the active file.
        with gzip.open(target, "wt", encoding="utf-8") as f:
            for line in lines:
                f.write(line.rstrip("\n") + "\n")
        path.write_text("\n".join(lines[-keep:]) + "\n", encoding="utf-8")

    if apply and any(r["action"] == "archive" for r in results):
        summary = "; ".join(
            f"{r['file']}: {r['lines']} -> {r.get('keep', r['lines'])} ({r.get('to','')})"
            for r in results if r["action"] == "archive"
        )
        with CHANGELOG.open("a", encoding="utf-8") as f:
            f.write(f"- {now()} LOG ROTATION {summary}\n")
    return results


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="actually rotate (default: dry run)")
    ap.add_argument("--dir", type=Path, default=DATA, help="log directory")
    ap.add_argument("--max-lines", type=int, default=0)
    ap.add_argument("--keep", type=int, default=0)
    args = ap.parse_args()
    results = rotate(args.dir, args.apply, args.max_lines, args.keep)
    print(json.dumps({"at": now(), "applied": args.apply, "results": results}, indent=2))


if __name__ == "__main__":
    main()
