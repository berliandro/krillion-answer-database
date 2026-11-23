#!/usr/bin/env python3
"""Materialise the small derived datasets from the authoritative Full DB.

Legacy materialisations (``search_answers`` in krillion_search.db and
``answers`` in krillion_only.db) are rebuilt with the exact same SQL as the
original scripts, so the existing static-site builders keep producing the same
bytes. New materialisations live in the search DB as well:

  search_answer   one answer per question, fingerprinted
  krillion_answer one row per (question, answer) rare answer, fingerprinted
  prompt_bank     one row per stored bank wording (the bank id IS the wording)
  prompt_key      MULTI-VALUED raw / strict / rewrite key -> bank id
  prompt_fts      FTS5 over normalised bank questions

Only questions touched since the last derive (new full-DB rowids, plus any
question named by an authoritative correction) are updated in the new
materialisations. Near-duplicate banks are different bank ids and are never
merged; aliases.jsonl is never read here.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from pathlib import Path

import config as cfg
import paraphrase_match as pm

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

BUILT_SCHEMA = """
CREATE TABLE IF NOT EXISTS build_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS search_answer (
  question TEXT PRIMARY KEY,
  answer TEXT NOT NULL,
  fingerprint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS krillion_answer (
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  source_url TEXT,
  scraped_at TEXT,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (question, answer)
);
CREATE TABLE IF NOT EXISTS prompt_bank (
  bank_id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  nq TEXT NOT NULL,
  fingerprint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prompt_key (
  key TEXT NOT NULL,
  key_kind TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  PRIMARY KEY (key, key_kind, bank_id)
);
CREATE INDEX IF NOT EXISTS idx_prompt_key_bank ON prompt_key(bank_id);
CREATE VIRTUAL TABLE IF NOT EXISTS prompt_fts USING fts5(nq, bank_id);
"""


def digest(value) -> str:
    """Stable fingerprint for a JSON-serialisable value."""
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def is_bank_authoritative(rec: dict) -> bool:
    """True only for a dive-end / graded-bank demotion record."""
    return (
        str(rec.get("action", "")).strip().lower() in cfg.REMOVAL_ACTIONS
        and str(rec.get("mode", "")).strip().lower() in cfg.BANK_AUTHORITATIVE_MODES
    )


def rewrite_query(text: str) -> str:
    """Same strict pipeline as injection/bridge.py rewrite_query()."""
    q = pm.normalise(text)
    for pattern, replacement in cfg.REWRITES:
        changed = re.sub(pattern, replacement, q)
        if changed != q:
            q = changed
            break
    return re.sub(r"\bbeginning\s+with\b", "starting with", q, flags=re.I)


def prompt_keys(question: str) -> dict[str, str]:
    """All lookup keys for one bank. Never picks a winning spelling."""
    raw = " ".join(str(question).strip().split())
    strict = pm.normalise(question)
    rewrite = rewrite_query(strict)
    return {cfg.KEY_RAW: raw, cfg.KEY_STRICT: strict, cfg.KEY_REWRITE: rewrite}


# ------------------------------------------------------------- legacy schemas
def init_legacy_schema() -> None:
    cfg.DATA.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(cfg.FULL_DB) as c:
        c.executescript(FULL_SCHEMA)
    with sqlite3.connect(cfg.SEARCH_DB) as c:
        c.executescript(SEARCH_SCHEMA)
    with sqlite3.connect(cfg.ONLY_DB) as c:
        c.executescript(ONLY_SCHEMA)


def init_schema() -> None:
    """Create legacy + new tables. Idempotent; never drops anything."""
    init_legacy_schema()
    with sqlite3.connect(cfg.SEARCH_DB) as c:
        c.executescript(BUILT_SCHEMA)


# ----------------------------------------------------------- legacy rebuilds
def rebuild() -> None:
    """Unchanged legacy logic: one answer per question, rare then shortest."""
    with sqlite3.connect(cfg.FULL_DB) as src, sqlite3.connect(cfg.SEARCH_DB) as dst:
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


def build_krillion_only() -> None:
    """Unchanged legacy rebuild of the dedicated rare-answer DB."""
    with sqlite3.connect(cfg.FULL_DB) as src, sqlite3.connect(cfg.ONLY_DB) as dst:
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
    print(f"built {cfg.ONLY_DB.name}: {count} krillion answers")


def search(term: str, limit: int = 10) -> None:
    with sqlite3.connect(cfg.SEARCH_DB) as c:
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


def stats() -> None:
    with sqlite3.connect(cfg.FULL_DB) as c:
        total = c.execute("SELECT COUNT(*) FROM answers").fetchone()[0]
        krillion = c.execute(
            "SELECT COUNT(*) FROM answers WHERE is_krillion = 1"
        ).fetchone()[0]
    with sqlite3.connect(cfg.SEARCH_DB) as c:
        small = c.execute("SELECT COUNT(*) FROM search_answers").fetchone()[0]
    with sqlite3.connect(cfg.ONLY_DB) as c:
        only = c.execute("SELECT COUNT(*) FROM answers").fetchone()[0]
    jsonl_lines = 0
    for path in cfg.answer_files():
        jsonl_lines += sum(
            1 for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()
        )
    print(
        f"full_answers={total} krillion_answers={krillion} "
        f"search_questions={small} krillion_only_db={only} jsonl_lines={jsonl_lines}"
    )


# --------------------------------------------------------------- new material
def _state_get(c: sqlite3.Connection, key: str, default: str = "") -> str:
    row = c.execute("SELECT value FROM build_state WHERE key=?", (key,)).fetchone()
    return default if row is None else str(row[0])


def _state_set(c: sqlite3.Connection, key: str, value: str) -> None:
    c.execute(
        "INSERT INTO build_state(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


def _upsert_question(src: sqlite3.Connection, dst: sqlite3.Connection, question: str) -> None:
    """Delta UPSERT of one touched question across all new materialisations."""
    best = src.execute(
        "SELECT answer FROM ("
        "  SELECT answer, ROW_NUMBER() OVER ("
        "    ORDER BY is_krillion DESC, LENGTH(answer) ASC) AS rn"
        "  FROM answers WHERE question=?"
        ") WHERE rn=1",
        (question,),
    ).fetchone()
    if best is not None:
        fp = digest([question, best[0]])
        dst.execute(
            "INSERT INTO search_answer(question, answer, fingerprint) VALUES(?, ?, ?) "
            "ON CONFLICT(question) DO UPDATE SET "
            "answer=excluded.answer, fingerprint=excluded.fingerprint "
            "WHERE search_answer.fingerprint <> excluded.fingerprint",
            (question, best[0], fp),
        )

    rare_rows = src.execute(
        "SELECT answer, source_url, scraped_at FROM answers "
        "WHERE question=? AND is_krillion=1 ORDER BY answer",
        (question,),
    ).fetchall()
    dst.execute("DELETE FROM krillion_answer WHERE question=?", (question,))
    if rare_rows:
        dst.executemany(
            "INSERT INTO krillion_answer(question, answer, source_url, scraped_at, fingerprint) "
            "VALUES(?, ?, ?, ?, ?)",
            [(question, a, u, s, digest([question, a, u, s])) for a, u, s in rare_rows],
        )
    else:
        # No rare answers any more: this wording is not a bank.
        dst.execute("DELETE FROM prompt_key WHERE bank_id=?", (question,))
        dst.execute("DELETE FROM prompt_bank WHERE bank_id=?", (question,))

    if rare_rows:
        keys = prompt_keys(question)
        bank_fp = digest([question, keys, [[a, u, s] for a, u, s in rare_rows]])
        dst.execute(
            "INSERT INTO prompt_bank(bank_id, question, nq, fingerprint) VALUES(?, ?, ?, ?) "
            "ON CONFLICT(bank_id) DO UPDATE SET "
            "question=excluded.question, nq=excluded.nq, fingerprint=excluded.fingerprint "
            "WHERE prompt_bank.fingerprint <> excluded.fingerprint",
            (question, question, keys[cfg.KEY_STRICT], bank_fp),
        )
        for kind in cfg.KEY_KINDS:
            dst.execute("DELETE FROM prompt_key WHERE bank_id=? AND key_kind=?", (question, kind))
            key = keys.get(kind, "")
            if key:
                # INSERT OR IGNORE is deliberate: several banks may share a key.
                dst.execute(
                    "INSERT OR IGNORE INTO prompt_key(key, key_kind, bank_id) VALUES(?, ?, ?)",
                    (key, kind, question),
                )


def _rebuild_prompt_fts(dst: sqlite3.Connection) -> None:
    """Small (~6k) FTS5 index; rebuilt wholesale for simplicity and integrity."""
    dst.execute("DELETE FROM prompt_fts")
    dst.execute(
        "INSERT INTO prompt_fts(nq, bank_id) "
        "SELECT nq, bank_id FROM prompt_bank ORDER BY bank_id"
    )


def derive_all() -> dict:
    """Delta-update materialisations for touched questions, then legacy DBs."""
    init_schema()
    with sqlite3.connect(cfg.FULL_DB) as src, sqlite3.connect(cfg.SEARCH_DB) as dst:
        last = int(_state_get(dst, "last_rowid", "0") or 0)
        max_rowid = int(src.execute("SELECT COALESCE(MAX(id), 0) FROM answers").fetchone()[0])
        touched = set(
            r[0] for r in (
                src.execute("SELECT DISTINCT question FROM answers ORDER BY question").fetchall()
                if last == 0 else
                src.execute(
                    "SELECT DISTINCT question FROM answers WHERE id > ? ORDER BY question",
                    (last,),
                ).fetchall()
            )
        )
        for rec in read_jsonl(cfg.CORRECTIONS):
            if is_bank_authoritative(rec):
                question = str(rec.get("question", "")).strip()
                if question:
                    touched.add(question)
        touched = sorted(touched)

        for question in touched:
            _upsert_question(src, dst, question)
        _rebuild_prompt_fts(dst)
        _state_set(dst, "last_rowid", str(max_rowid))

    rebuild()
    build_krillion_only()
    result = counts()
    with sqlite3.connect(cfg.SEARCH_DB) as c:
        key_count = c.execute("SELECT COUNT(*) FROM prompt_key").fetchone()[0]
    print(
        f"derived: touched={len(touched)} search_answer={result['search']} "
        f"krillion_answer={result['krillion']} prompts={result['prompts']} "
        f"prompt_keys={key_count}"
    )
    return {"touched": len(touched), **result}


def _count(path: Path, sql: str) -> int:
    with sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True) as c:
        return int(c.execute(sql).fetchone()[0])


def _has_table(path: Path, name: str) -> bool:
    with _count_connection(path) as c:
        return bool(
            c.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
            ).fetchone()
        )


def _count_connection(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)


def counts() -> dict:
    """Read-only counts used by emit.py and verify.py.

    Works both before and after the new materialisations exist: it falls back
    to the legacy tables so a verify run on untouched data is still valid.
    """
    out = {"full": _count(cfg.FULL_DB, "SELECT COUNT(*) FROM answers")}
    out["search"] = (
        _count(cfg.SEARCH_DB, "SELECT COUNT(*) FROM search_answer")
        if _has_table(cfg.SEARCH_DB, "search_answer")
        else _count(cfg.SEARCH_DB, "SELECT COUNT(*) FROM search_answers")
    )
    out["krillion"] = (
        _count(cfg.SEARCH_DB, "SELECT COUNT(*) FROM krillion_answer")
        if _has_table(cfg.SEARCH_DB, "krillion_answer")
        else _count(cfg.ONLY_DB, "SELECT COUNT(*) FROM answers")
    )
    out["prompts"] = (
        _count(cfg.SEARCH_DB, "SELECT COUNT(DISTINCT bank_id) FROM prompt_bank")
        if _has_table(cfg.SEARCH_DB, "prompt_bank")
        else _count(cfg.ONLY_DB, "SELECT COUNT(DISTINCT question) FROM answers")
    )
    return out
