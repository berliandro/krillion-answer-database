#!/usr/bin/env python3
"""Verify krillion_only.db is exactly the krillion tier of the full DB."""
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
c = sqlite3.connect(ROOT / "data" / "krillion_full.db")
c.execute("ATTACH DATABASE ? AS only", (str(ROOT / "data" / "krillion_only.db"),))
queries = {
    "only_rows": "SELECT COUNT(*) FROM only.answers",
    "full_krillion_rows": "SELECT COUNT(*) FROM main.answers WHERE is_krillion = 1",
    "foreign_rows_in_only": """SELECT COUNT(*) FROM only.answers o
        WHERE NOT EXISTS (SELECT 1 FROM main.answers f
          WHERE f.question=o.question AND f.answer=o.answer AND f.is_krillion=1)""",
    "missing_krillion_rows": """SELECT COUNT(*) FROM main.answers f
        WHERE f.is_krillion=1 AND NOT EXISTS (SELECT 1 FROM only.answers o
          WHERE o.question=f.question AND o.answer=f.answer)""",
}
for name, sql in queries.items():
    print(f"{name}={c.execute(sql).fetchone()[0]}")
