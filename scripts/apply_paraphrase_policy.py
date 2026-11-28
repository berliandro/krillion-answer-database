#!/usr/bin/env python3
"""Apply the user-approved paraphrase policy (non-destructively).

Approved 2026-11-28:
  1. merge the 477 game-graded PARAPHRASE banks into link groups;
  2. hold one answer per paraphrase group in the Search DB;
  3. apply aliases to the matcher.

Implementation is derived and reversible: NO Full DB row is deleted or edited,
NO raw JSONL is touched, and the legacy search_answers table stays intact.
New tables carry the merged/grouped view. Alias rewrites are generated as a
data file for the bridge (exact match still wins before any rewrite).
"""
from __future__ import annotations

import json
import sqlite3
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import paraphrase_match as pm  # noqa: E402
from audit_paraphrase import norm  # noqa: E402

FULL = ROOT / "data" / "krillion_full.db"
SEARCH = ROOT / "data" / "krillion_search.db"
AUDIT = ROOT / "data" / "norm_audit.json"
ALIASES = ROOT / "injection" / "data" / "aliases.jsonl"
OUT = ROOT / "data" / "paraphrase_policy_applied.json"
ALIAS_OUT = ROOT / "data" / "alias_rewrites.json"


def main() -> None:
    audit = json.loads(AUDIT.read_text(encoding="utf-8"))
    groups = audit["groups"]

    # Union-find over graded paraphrase pairs (transitive closure).
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for g in groups:
        union(g["canonical"], g["variant"])

    members: dict[str, list[str]] = {}
    for text in parent:
        members.setdefault(find(text), []).append(text)
    ordered = sorted(members.items(), key=lambda kv: (-len(kv[1]), sorted(kv[1])[0]))
    final_groups = []
    for i, (_, texts) in enumerate(ordered, start=1):
        texts = sorted(texts)
        final_groups.append({"group_id": f"mrg-{i:04d}", "members": texts,
                             "canonical": texts[0]})

    # Full DB: merged bank view (no row deleted).
    con = sqlite3.connect(FULL)
    cur = con.cursor()
    cur.execute("""CREATE TABLE IF NOT EXISTS paraphrase_group_member (
        question TEXT PRIMARY KEY, group_id TEXT NOT NULL)""")
    cur.execute("""CREATE TABLE IF NOT EXISTS paraphrase_group_answer (
        group_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL,
        is_krillion INTEGER NOT NULL, PRIMARY KEY (group_id, answer))""")
    cur.execute("DELETE FROM paraphrase_group_member")
    cur.execute("DELETE FROM paraphrase_group_answer")
    for g in final_groups:
        for q in g["members"]:
            cur.execute("INSERT OR REPLACE INTO paraphrase_group_member VALUES (?,?)",
                        (q, g["group_id"]))
            for (answer, krillion) in cur.execute(
                    "SELECT answer, is_krillion FROM answers WHERE question=?", (q,)):
                cur.execute("INSERT OR REPLACE INTO paraphrase_group_answer VALUES (?,?,?,?)",
                            (g["group_id"], q, answer, int(krillion)))
    con.commit()
    merged_answers = cur.execute("SELECT COUNT(*) FROM paraphrase_group_answer").fetchone()[0]
    con.close()

    # Search DB: one answer per group, rare answer preferred then shortest.
    scon = sqlite3.connect(SEARCH)
    scur = scon.cursor()
    scur.execute("""CREATE TABLE IF NOT EXISTS group_search_answers (
        group_id TEXT PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL)""")
    scur.execute("DELETE FROM group_search_answers")
    fcon = sqlite3.connect(f"file:{FULL}?mode=ro", uri=True)
    group_rows: dict[str, list[tuple[str, int]]] = {}
    for gid, q, answer, krillion in fcon.execute(
            "SELECT group_id, question, answer, is_krillion FROM paraphrase_group_answer"):
        group_rows.setdefault(gid, []).append((answer, int(krillion)))
    fcon.close()
    for g in final_groups:
        answers = group_rows.get(g["group_id"], [])
        if not answers:
            continue
        winner = sorted(answers, key=lambda a: (-a[1], len(a[0]), a[0]))[0][0]
        scur.execute("INSERT OR REPLACE INTO group_search_answers VALUES (?,?,?)",
                     (g["group_id"], g["canonical"], winner))
    scon.commit()
    group_answers = scur.execute("SELECT COUNT(*) FROM group_search_answers").fetchone()[0]
    scon.close()

    # Alias rewrites: generated from the log-only alias file; exact match wins
    # first in the bridge, so a rewrite only applies where no exact bank exists.
    fcon = sqlite3.connect(f"file:{FULL}?mode=ro", uri=True)
    banks = {q for (q,) in fcon.execute("SELECT DISTINCT question FROM answers")}
    fcon.close()
    rewrites: dict[str, str] = {}
    alias_rows = []
    for line in ALIASES.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        canon = str(rec.get("canonical", "")).strip()
        variant = str(rec.get("variant", "")).strip()
        if not canon or not variant or canon not in banks or variant == canon:
            continue
        key = norm(variant)
        rewrites.setdefault(key, canon)
        alias_rows.append({"variant": variant, "canonical": canon})
    ALIAS_OUT.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "count": len(rewrites),
        "aliases": alias_rows,
        "norm_to_bank": rewrites,
        "policy": "exact bank match wins first; rewrite only on no exact match",
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    OUT.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "approved_groups": len(final_groups),
        "merged_questions": sum(len(g["members"]) for g in final_groups),
        "merged_bank_answers": merged_answers,
        "search_group_answers": group_answers,
        "alias_rewrite_keys": len(rewrites),
        "groups": final_groups,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "approved_groups": len(final_groups),
        "merged_questions": sum(len(g["members"]) for g in final_groups),
        "merged_bank_answers": merged_answers,
        "search_group_answers": group_answers,
        "alias_rewrite_keys": len(rewrites),
        "outputs": [str(OUT.relative_to(ROOT)), str(ALIAS_OUT.relative_to(ROOT))],
    }, indent=2))


if __name__ == "__main__":
    main()
