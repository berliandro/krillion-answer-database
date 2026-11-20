#!/usr/bin/env python3
"""Krillion answer store.

The scraper appends one JSON object per line to data/answers.jsonl:
  {"question": "...", "answer": "...", "is_krillion": true, "source_url": "..."}

Commands:
  init              create data dir + both DBs + JSONL file
  import            import answers.jsonl into the full DB, then rebuild search DB
  rebuild           regenerate the small search DB from the full DB
  search TERM       fast FTS search over the small search DB
  stats             print row counts
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
FULL_DB = DATA / "krillion_full.db"
SEARCH_DB = DATA / "krillion_search.db"
JSONL = DATA / "answers.jsonl"

FULL_SCHEMA = """
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  is_krillion INTEGER NOT NULL DEFAULT 0,
  source_url TEXT,
  scraped_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(question, answer)
);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question);
CREATE INDEX IF NOT EXISTS idx_answers_krillion ON answers(is_krillion);
"""

SEARCH_SCHEMA = """
CREATE TABLE IF NOT EXISTS search_answers (
  question TEXT PRIMARY KEY,
  answer TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(question, answer);
"""


def init():
    DATA.mkdir(exist_ok=True)
    with sqlite3.connect(FULL_DB) as c:
        c.executescript(FULL_SCHEMA)
    with sqlite3.connect(SEARCH_DB) as c:
        c.executescript(SEARCH_SCHEMA)
    JSONL.touch(exist_ok=True)
    print(f"initialized: {FULL_DB.name}, {SEARCH_DB.name}, {JSONL.name}")


def rebuild():
    """Small search DB: exactly one answer per question, preferring the
    'one in a krillion' answer, then the shortest answer."""
    with sqlite3.connect(FULL_DB) as src, sqlite3.connect(SEARCH_DB) as dst:
        rows = src.execute(
            """
            SELECT question, answer FROM (
              SELECT question, answer,
                     ROW_NUMBER() OVER (
                       PARTITION BY question
                       ORDER BY is_krillion DESC, LENGTH(answer) ASC
                     ) AS rn
              FROM answers
            ) WHERE rn = 1 ORDER BY question
            """
        ).fetchall()
        dst.execute("DELETE FROM search_answers")
        dst.execute("DELETE FROM search_fts")
        dst.executemany(
            "INSERT OR REPLACE INTO search_answers(question, answer) VALUES(?, ?)", rows
        )
        dst.executemany(
            "INSERT INTO search_fts(question, answer) VALUES(?, ?)", rows
        )
    print(f"rebuilt search DB: {len(rows)} questions")


def answer_files():
    """All append-only answer sources: API harvester + gameplay harvester + manual."""
    return sorted(DATA.glob("answers*.jsonl"))


def import_answers():
    files = answer_files()
    if not files:
        print("no answers*.jsonl found")
        return
    inserted = 0
    skipped = 0
    with sqlite3.connect(FULL_DB) as c:
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
    print(f"files={[p.name for p in files]} inserted={inserted} skipped={skipped}")
    rebuild()


def search(term, limit=10):
    with sqlite3.connect(SEARCH_DB) as c:
        rows = c.execute(
            "SELECT question, answer, bm25(search_fts) AS score "
            "FROM search_fts WHERE search_fts MATCH ? "
            "ORDER BY score LIMIT ?",
            (term, limit),
        ).fetchall()
    if not rows:
        print("no matches")
        return
    for question, answer, score in rows:
        print(f"[{score:.3f}] Q: {question}\n       A: {answer}\n")


def stats():
    with sqlite3.connect(FULL_DB) as c:
        total = c.execute("SELECT COUNT(*) FROM answers").fetchone()[0]
        krillion = c.execute(
            "SELECT COUNT(*) FROM answers WHERE is_krillion = 1"
        ).fetchone()[0]
    with sqlite3.connect(SEARCH_DB) as c:
        small = c.execute("SELECT COUNT(*) FROM search_answers").fetchone()[0]
    jsonl_lines = 0
    for path in answer_files():
        jsonl_lines += sum(1 for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip())
    print(
        f"full_answers={total} krillion_answers={krillion} "
        f"search_questions={small} jsonl_lines={jsonl_lines}"
    )


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    sub.add_parser("import")
    sub.add_parser("rebuild")
    s = sub.add_parser("search")
    s.add_argument("term")
    s.add_argument("-n", "--limit", type=int, default=10)
    sub.add_parser("stats")
    args = p.parse_args()

    {
        "init": init,
        "import": import_answers,
        "rebuild": rebuild,
        "search": lambda: search(args.term, args.limit),
        "stats": stats,
    }[args.cmd]()


if __name__ == "__main__":
    main()
