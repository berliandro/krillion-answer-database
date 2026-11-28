#!/usr/bin/env python3
"""Non-destructive TRIVIAL / ANSWER-VARIANT cleanup.

Adds normalised-key columns to the Full DB and a `norm_dedupe` lookup table
mapping each (question_norm, answer_norm) to the surviving original wording and
highest-confidence tier. NO raw JSONL is rewritten; NO database row is deleted;
no policy change is applied (paraphrases stay separate banks, aliases stay logs).
"""
from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from audit_paraphrase import norm  # noqa: E402

DB = ROOT / "data" / "krillion_full.db"
LOG = ROOT / "injection" / "data" / "norm_dedupe.jsonl"


def main() -> None:
    con = sqlite3.connect(DB)
    cur = con.cursor()
    cols = {r[1] for r in cur.execute("PRAGMA table_info(answers)")}
    for name in ("question_norm", "answer_norm"):
        if name not in cols:
            cur.execute(f"ALTER TABLE answers ADD COLUMN {name} TEXT")
    rows = cur.execute("SELECT id, question, answer, is_krillion FROM answers").fetchall()
    for rid, q, a, k in rows:
        cur.execute("UPDATE answers SET question_norm=?, answer_norm=? WHERE id=?",
                    (norm(q), norm(a), rid))
    cur.execute("CREATE INDEX IF NOT EXISTS idx_answers_qnorm ON answers(question_norm)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_answers_anorm ON answers(answer_norm)")
    cur.execute("""CREATE TABLE IF NOT EXISTS norm_dedupe (
        question_norm TEXT NOT NULL,
        answer_norm TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        is_krillion INTEGER NOT NULL,
        collapsed INTEGER NOT NULL,
        PRIMARY KEY (question_norm, answer_norm)
    )""")
    cur.execute("DELETE FROM norm_dedupe")
    groups: dict[tuple[str, str], list[tuple[str, str, int]]] = {}
    for rid, q, a, k in rows:
        groups.setdefault((norm(q), norm(a)), []).append((q, a, int(k)))
    collapsed = 0
    with LOG.open("a", encoding="utf-8") as fh:
        for (qn, an), members in groups.items():
            # highest-confidence tier wins; original spelling of that row kept
            winner = sorted(members, key=lambda m: (-m[2], m[0], m[1]))[0]
            n = len(members) - 1
            collapsed += n
            cur.execute(
                "INSERT INTO norm_dedupe VALUES (?,?,?,?,?,?)",
                (qn, an, winner[0], winner[1], winner[2], n),
            )
            if n:
                fh.write(json.dumps({
                    "at": datetime.now(timezone.utc).isoformat(),
                    "kind": "TRIVIAL" if len({m[0] for m in members}) > 1 else "ANSWER-VARIANT",
                    "question_norm": qn, "answer_norm": an,
                    "kept": {"question": winner[0], "answer": winner[1], "is_krillion": winner[2]},
                    "collapsed_count": n,
                    "collapsed": [{"question": q, "answer": a, "is_krillion": k}
                                  for q, a, k in members if (q, a) != (winner[0], winner[1])],
                }, ensure_ascii=False) + "\n")
    con.commit()
    count = cur.execute("SELECT COUNT(*) FROM norm_dedupe").fetchone()[0]
    con.close()
    print(json.dumps({"rows": len(rows), "norm_keys": count,
                      "collapsed_log_entries": collapsed, "log": str(LOG.relative_to(ROOT))}, indent=2))


if __name__ == "__main__":
    main()
