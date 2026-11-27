#!/usr/bin/env python3
"""Snapshot bridge counters and log tails for Krillion live-validation evidence.

Usage:
  python injection/live_validation.py snapshot --label before-classic --out injection/data/live_validation/before-classic.json
  python injection/live_validation.py diff --before <file> --after <file> --label classic
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data")
BRIDGE = "http://127.0.0.1:8768/api/health?t=krillion-local-v1"
LOGS = (
    "evidence.jsonl",
    "prompt_review.jsonl",
    "bot_log.jsonl",
    "failed_prompts.jsonl",
    "learned.jsonl",
    "corrections.jsonl",
)


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def health() -> dict:
    try:
        with urllib.request.urlopen(BRIDGE, timeout=5) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:  # bridge down is itself evidence
        return {"ok": False, "error": str(e)}


def line_count(path: str) -> int:
    if not os.path.exists(path):
        return 0
    with open(path, "rb") as f:
        return sum(1 for _ in f)


def tail(path: str, n: int = 8) -> list[dict]:
    if not os.path.exists(path):
        return []
    with open(path, "rb") as f:
        lines = f.readlines()
    out = []
    for raw in lines[-n:]:
        try:
            out.append(json.loads(raw.decode("utf-8")))
        except Exception:
            out.append({"raw": raw.decode("utf-8", "replace").strip()})
    return out


def snapshot(label: str) -> dict:
    h = health()
    return {
        "captured_at": utcnow(),
        "label": label,
        "health": h,
        "log_lines": {name: line_count(os.path.join(DATA, name)) for name in LOGS},
        "tails": {name: tail(os.path.join(DATA, name)) for name in LOGS},
    }


def diff(before: dict, after: dict, label: str) -> dict:
    b, a = before["log_lines"], after["log_lines"]
    return {
        "label": label,
        "before_at": before["captured_at"],
        "after_at": after["captured_at"],
        "delta": {name: a.get(name, 0) - b.get(name, 0) for name in LOGS},
        "new_evidence": [
            e for e in after["tails"]["evidence.jsonl"]
            if e.get("at", "") > before["captured_at"]
        ],
        "new_bot_events": [
            e for e in after["tails"]["bot_log.jsonl"]
            if e.get("at", "") > before["captured_at"]
        ],
        "new_prompt_review": [
            e for e in after["tails"]["prompt_review.jsonl"]
            if e.get("at", "") > before["captured_at"]
        ],
        "health_before": before["health"],
        "health_after": after["health"],
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot")
    s.add_argument("--label", required=True)
    s.add_argument("--out", required=True)
    d = sub.add_parser("diff")
    d.add_argument("--before", required=True)
    d.add_argument("--after", required=True)
    d.add_argument("--label", required=True)
    args = p.parse_args()

    if args.cmd == "snapshot":
        result = snapshot(args.label)
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        print(json.dumps({
            "wrote": args.out,
            "label": result["label"],
            "health": result["health"],
            "log_lines": result["log_lines"],
        }, indent=2))
        return 0

    with open(args.before, encoding="utf-8") as f:
        before = json.load(f)
    with open(args.after, encoding="utf-8") as f:
        after = json.load(f)
    print(json.dumps(diff(before, after, args.label), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
