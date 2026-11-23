#!/usr/bin/env python3
"""Matcher parity tests: reference algorithm + derived-index loader."""
from __future__ import annotations

import json
import sqlite3
from functools import lru_cache

from _common import CheckFailure, DATA, REPO_ROOT, load_module, require


@lru_cache(maxsize=1)
def pm():
    """Load the actual scripts/paraphrase_match.py used by the build/bridge."""
    return load_module("krillion_paraphrase_under_test", REPO_ROOT / "scripts" / "paraphrase_match.py")


def _tests() -> list[dict]:
    cases = json.loads((DATA / "paraphrase_tests.json").read_text(encoding="utf-8"))
    require(len(cases) >= 36, f"expected at least 36 paraphrase cases, got {len(cases)}")
    return cases


def _search_questions() -> list[str]:
    """Exact source build.py verify.check_paraphrase() uses."""
    db = DATA / "krillion_search.db"
    with sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True) as c:
        rows = c.execute(
            "SELECT question, answer FROM search_answers ORDER BY question"
        ).fetchall()
    require(bool(rows), "krillion_search.db / search_answers is empty")
    return [q for q, _ in rows]


def _only_questions() -> list[str]:
    db = DATA / "krillion_only.db"
    with sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True) as c:
        rows = c.execute(
            "SELECT DISTINCT question FROM answers ORDER BY question"
        ).fetchall()
    require(bool(rows), "krillion_only.db / answers is empty")
    return [r[0] for r in rows]


def test_parity_recall() -> str:
    """Every documented paraphrase case must rank its expected bank in top 10."""
    matcher = pm().Matcher(_search_questions())
    cases = _tests()
    hits = {1: 0, 3: 0, 10: 0}
    for case in cases:
        typed, expect = case["typed"], case["expect"]
        got = [x["question"] for x in matcher.search(typed, 10)]
        for k in hits:
            if expect in got[:k]:
                hits[k] += 1
        require(
            expect in got,
            f"recall@10 miss: {typed!r} expected {expect!r}, got {got[:3]}",
        )
    total = len(cases)
    require(hits[10] == total, f"recall@10 {hits[10]}/{total}, expected {total}/{total}")
    return (
        f"recall@1={hits[1]}/{total} recall@3={hits[3]}/{total} "
        f"recall@10={hits[10]}/{total} ({total} cases)"
    )


def test_persisted_index_parity() -> str:
    """Persisted matcher_index.json loader must match a freshly built Matcher."""
    matcher_cls = pm().Matcher
    index_path = DATA / "matcher_index.json"
    require(index_path.exists(), f"missing persisted index: {index_path}")
    loaded = matcher_cls.from_index(index_path)
    questions = _only_questions()
    fresh = matcher_cls(questions)
    require(
        len(loaded.questions) == len(questions),
        f"index has {len(loaded.questions)} questions, DB has {len(questions)}",
    )

    # (limit, threshold) pairs the bridge actually uses, plus the general default.
    combos = ((10, 0.34), (5, 0.62), (5, 0.34))
    comparisons = 0
    mismatches = 0
    for case in _tests():
        for limit, threshold in combos:
            a = fresh.search(case["typed"], limit=limit, threshold=threshold)
            b = loaded.search(case["typed"], limit=limit, threshold=threshold)
            comparisons += 1
            if a != b:
                mismatches += 1
                if mismatches <= 3:
                    print(f"    mismatch: {case['typed']!r} ({limit},{threshold})")
    require(
        mismatches == 0,
        f"{mismatches}/{comparisons} fresh-vs-persisted search mismatches",
    )
    return f"{len(loaded.questions)} questions, {comparisons} comparisons, 0 mismatches"
