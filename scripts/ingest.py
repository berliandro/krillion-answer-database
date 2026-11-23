#!/usr/bin/env python3
"""Append-only JSONL -> Full DB ingestion.

Every ``data/answers*.jsonl`` file is imported with INSERT OR IGNORE, so source
logs are never rewritten and duplicate (question, answer) pairs are harmless.
The only mutation of tier data is an authoritative demotion from
``injection/data/corrections.jsonl``; a record qualifies ONLY when its action
is a removal AND its mode names the game's graded bank. Play scores, evidence
rows and other players' answers can never demote anything here.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import config as cfg
import derive


def init() -> None:
    derive.init_legacy_schema()
    cfg.DATA.mkdir(parents=True, exist_ok=True)
    (cfg.DATA / "answers.jsonl").touch(exist_ok=True)
    print(
        f"initialized: {cfg.FULL_DB.name}, {cfg.SEARCH_DB.name}, "
        f"{cfg.ONLY_DB.name}, answers.jsonl"
    )


def apply_bank_demotions(c: sqlite3.Connection, path=None) -> int:
    """Demote only game-bank-authoritative (question, answer) pairs.

    Returns the number of Full DB rows actually demoted. Returns 0 for any
    play-based correction, which is the standing user policy.
    """
    path = cfg.CORRECTIONS if path is None else Path(path)
    if not path.exists():
        return 0
    demoted = 0
    seen = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not derive.is_bank_authoritative(rec):
            continue
        question = str(rec.get("question", "")).strip()
        answer = str(rec.get("answer", "")).strip()
        key = (question, answer)
        if not question or not answer or key in seen:
            continue
        seen.add(key)
        cur = c.execute(
            "UPDATE answers SET is_krillion = 0 WHERE question = ? AND answer = ?",
            key,
        )
        demoted += cur.rowcount
    return demoted


def import_answers() -> dict:
    files = cfg.answer_files()
    if not files:
        print("no answers*.jsonl found")
        return {"files": [], "inserted": 0, "skipped": 0, "demoted": 0}
    inserted = 0
    skipped = 0
    with sqlite3.connect(cfg.FULL_DB) as c:
        for path in files:
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    skipped += 1
                    continue
                question = str(rec.get("question", "")).strip()
                answer = str(rec.get("answer", "")).strip()
                if not question or not answer:
                    skipped += 1
                    continue
                is_krillion = 1 if rec.get("is_krillion") else 0
                source_url = rec.get("source_url")
                cur = c.execute(
                    "INSERT OR IGNORE INTO answers(question, answer, is_krillion, source_url) "
                    "VALUES(?, ?, ?, ?)",
                    (question, answer, is_krillion, source_url),
                )
                inserted += cur.rowcount
        demoted = apply_bank_demotions(c)
    names = [p.name for p in files]
    print(f"files={names} inserted={inserted} skipped={skipped} demoted={demoted}")
    return {
        "files": names, "inserted": inserted, "skipped": skipped, "demoted": demoted
    }
