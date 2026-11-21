#!/usr/bin/env python3
"""Krillion answer store.

The scraper appends one JSON object per line to data/answers.jsonl:
  {"question": "...", "answer": "...", "is_krillion": true, "source_url": "..."}

Commands:
  init              create data dir + both DBs + JSONL file
  import            import answers.jsonl into the full DB, then rebuild search DB
  rebuild           regenerate the small search DB from the full DB
  search TERM       fast FTS search over the small search DB
  krillion-only     rebuild data/krillion_only.db from the krillion-tier rows
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
ONLY_DB = DATA / "krillion_only.db"
JSONL = DATA / "answers.jsonl"
# Append-only demotions from the injection bridge. Read-only from our side.
CORRECTIONS = ROOT / "injection" / "data" / "corrections.jsonl"

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


ONLY_SCHEMA = """
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  source_url TEXT,
  scraped_at TEXT,
  UNIQUE(question, answer)
);
CREATE INDEX IF NOT EXISTS idx_only_question ON answers(question);
"""


def init():
    DATA.mkdir(exist_ok=True)
    with sqlite3.connect(FULL_DB) as c:
        c.executescript(FULL_SCHEMA)
    with sqlite3.connect(SEARCH_DB) as c:
        c.executescript(SEARCH_SCHEMA)
    with sqlite3.connect(ONLY_DB) as c:
        c.executescript(ONLY_SCHEMA)
    JSONL.touch(exist_ok=True)
    print(f"initialized: {FULL_DB.name}, {SEARCH_DB.name}, {ONLY_DB.name}, {JSONL.name}")


def build_krillion_only():
    """Rebuild the dedicated DB that contains ONLY One-in-a-Krillion answers."""
    with sqlite3.connect(FULL_DB) as src, sqlite3.connect(ONLY_DB) as dst:
        dst.executescript(ONLY_SCHEMA)
        rows = src.execute(
            "SELECT question, answer, source_url, scraped_at FROM answers "
            "WHERE is_krillion = 1 ORDER BY question, answer"
        ).fetchall()
        dst.execute("DELETE FROM answers")
        dst.executemany(
            "INSERT OR IGNORE INTO answers(question, answer, source_url, scraped_at) "
            "VALUES(?, ?, ?, ?)", rows
        )
        count = dst.execute("SELECT COUNT(*) FROM answers").fetchone()[0]
    print(f"built {ONLY_DB.name}: {count} krillion answers")


def apply_corrections(c, path=None):
    """Apply append-only demotions from the injection bridge.

    Each correction is {"question","answer","points","action":"remove"}.
    A matching (question, answer) row is demoted to is_krillion=0, so the
    rebuilt krillion-only DB stops listing it. Verified 100-point answers
    are not written to the corrections file by the bridge, so no promotion
    is possible here.
    """
    path = Path(path) if path else CORRECTIONS
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
        if rec.get("action") != "remove":
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
    demoted = apply_corrections(c)
    print(
        f"files={[p.name for p in files]} inserted={inserted} skipped={skipped} "
        f"demoted={demoted}"
    )
    rebuild()
    build_krillion_only()


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
    with sqlite3.connect(ONLY_DB) as c:
        only = c.execute("SELECT COUNT(*) FROM answers").fetchone()[0]
    jsonl_lines = 0
    for path in answer_files():
        jsonl_lines += sum(1 for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip())
    print(
        f"full_answers={total} krillion_answers={krillion} "
        f"search_questions={small} krillion_only_db={only} jsonl_lines={jsonl_lines}"
    )


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    sub.add_parser("import")
    sub.add_parser("rebuild")
    sub.add_parser("krillion-only")
    s = sub.add_parser("search")
    s.add_argument("term")
    s.add_argument("-n", "--limit", type=int, default=10)
    sub.add_parser("stats")
    args = p.parse_args()

    {
        "init": init,
        "import": import_answers,
        "rebuild": rebuild,
        "krillion-only": build_krillion_only,
        "search": lambda: search(args.term, args.limit),
        "stats": stats,
    }[args.cmd]()


if __name__ == "__main__":
    main()
