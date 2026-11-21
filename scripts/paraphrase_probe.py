#!/usr/bin/env python3
"""Probe canonical questions: token patterns and genuine near-duplicate pairs."""
import re
import sqlite3
from collections import defaultdict, Counter
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "data" / "krillion_search.db"
c = sqlite3.connect(DB)
rows = c.execute("SELECT question, answer FROM search_answers").fetchall()
print("questions:", len(rows))

print("\n-- 'park' questions --")
for q, a in rows:
    if "park" in q.lower():
        print(f"  {q!r} => {a!r}")

print("\n-- skeleton patterns (words with articles/numbers removed, quoted kept) --")
skel = Counter()
for q, _ in rows:
    s = q.lower()
    s = re.sub(r"\b(name|give|list|state|any|one|a|an|the|of|example|examples)\b", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    skel[s] += 1
for k, v in skel.most_common(15):
    print(f"  {v:4}  {k!r}")

def toks(q):
    # keep quoted words as distinct high-signal tokens
    q = q.lower()
    quoted = re.findall(r'"([^"]+)"', q)
    q = re.sub(r'"[^"]*"', " ", q)
    stop = {"a", "an", "the", "any", "one", "of", "name", "give", "list", "state", "in", "or", "and", "to", "for", "that", "is", "it", "with", "from"}
    words = [w for w in re.findall(r"[a-z0-9]+", q) if w not in stop]
    return set(words) | {("Q:" + w) for w in quoted}

print("\n-- near-duplicate pairs (Jaccard >= 0.75, quoted tokens kept) --")
pairs = []
for i, (q1, _) in enumerate(rows):
    t1 = toks(q1)
    if not t1:
        continue
    for q2, _ in rows[i + 1:]:
        t2 = toks(q2)
        if not t2:
            continue
        j = len(t1 & t2) / len(t1 | t2)
        if j >= 0.75:
            pairs.append((j, q1, q2))
pairs.sort(reverse=True)
for j, q1, q2 in pairs[:40]:
    print(f"  {j:.2f}  {q1!r}  ||  {q2!r}")
print("pairs found:", len(pairs))
