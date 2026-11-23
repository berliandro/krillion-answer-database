#!/usr/bin/env python3
"""Read-only verification of the Krillion build and its policy invariants.

Nothing in this module writes to the repository: DBs are opened with mode=ro,
FTS integrity-checks run against a temporary copy, and the demotion policy
probe uses an in-memory DB plus a temp corrections file.

Checks:
  1. counts (full / search / krillion / prompts)
  2. SQLite PRAGMA integrity + FTS5 integrity-check
  3. paraphrase suite 36/36 (recall@10, with @1/@3 reported)
  4. policy: bank-only demotions, separate groups, aliases never applied
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path

import config as cfg
import derive
import ingest
import paraphrase_match as pm


def _ro(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)


def _count(path: Path, sql: str) -> int:
    with _ro(path) as c:
        return int(c.execute(sql).fetchone()[0])


def check_counts() -> tuple[bool, dict]:
    counts = derive.counts()
    full_prompts = _count(cfg.FULL_DB, "SELECT COUNT(DISTINCT question) FROM answers")
    bank_prompts = _count(cfg.ONLY_DB, "SELECT COUNT(DISTINCT question) FROM answers")
    ok = all(counts[k] > 0 for k in ("full", "search", "krillion", "prompts"))
    print(
        f"[verify] counts: full={counts['full']} search={counts['search']} "
        f"krillion={counts['krillion']} prompts={counts['prompts']} "
        f"(full_distinct_questions={full_prompts}, bank_prompts={bank_prompts})"
    )
    return ok, counts


def check_integrity() -> bool:
    ok = True
    for path in (cfg.FULL_DB, cfg.SEARCH_DB, cfg.ONLY_DB):
        with _ro(path) as c:
            result = c.execute("PRAGMA integrity_check").fetchone()[0]
        print(f"[verify] pragma: {path.name}={result}")
        ok &= result == "ok"

    # FTS5's integrity-check is a special INSERT, which needs a writable DB.
    # Copy to a temp file so the repository DBs stay byte-for-byte unchanged.
    with tempfile.TemporaryDirectory() as td:
        copy = Path(td) / cfg.SEARCH_DB.name
        shutil.copy2(cfg.SEARCH_DB, copy)
        with closing(sqlite3.connect(copy)) as c:
            for table in ("search_fts", "prompt_fts"):
                exists = c.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
                ).fetchone()
                if not exists:
                    print(f"[verify] fts: {table}=absent")
                    continue
                result = c.execute(
                    f"INSERT INTO {table}({table}) VALUES('integrity-check')"
                ).fetchall()
                print(f"[verify] fts: {table}={'ok' if not result else result}")
                ok &= not result
    return ok


def check_paraphrase() -> bool:
    with _ro(cfg.SEARCH_DB) as c:
        rows = c.execute(
            "SELECT question, answer FROM search_answers ORDER BY question"
        ).fetchall()
    tests = json.loads(cfg.PARAPHRASE_TESTS.read_text(encoding="utf-8"))
    matcher = pm.Matcher([q for q, _ in rows])
    hits = {1: 0, 3: 0, 10: 0}
    for t in tests:
        got = [x["question"] for x in matcher.search(t["typed"], cfg.SEARCH_LIMIT)]
        for k in hits:
            if t["expect"] in got[:k]:
                hits[k] += 1
    total = len(tests)
    print(
        f"[verify] paraphrase: {hits[10]}/{total} recall@10 "
        f"(recall@1={hits[1]}/{total}, recall@3={hits[3]}/{total})"
    )
    return hits[10] == total and total >= 36


def check_matcher_index() -> bool:
    """A present index must be valid and byte-identical to a fresh build."""
    path = cfg.DATA / "matcher_index.json"
    if not path.exists():
        print("[verify] matcher index: absent (bridge rebuilds from questions)")
        return True

    try:
        raw = path.read_bytes()
        expected = None
        if cfg.MANIFEST.exists():
            manifest = json.loads(cfg.MANIFEST.read_text(encoding="utf-8"))
            artifacts = manifest.get("artifacts", {})
            if isinstance(artifacts, dict):
                expected = artifacts.get("matcher_index.json")
        actual = hashlib.sha256(raw).hexdigest()
        if expected != actual:
            print(f"[verify] matcher index: manifest sha mismatch ({expected} != {actual})")
            return False

        payload = json.loads(raw.decode("utf-8"))
        src_sha = hashlib.sha256(cfg.PARAPHRASE_SOURCE.read_bytes()).hexdigest()
        if payload.get("matcher_source_sha256") != src_sha:
            print("[verify] matcher index: stale matcher source hash")
            return False

        loaded = pm.Matcher.from_index(path)
        with _ro(cfg.ONLY_DB) as c:
            questions = [r[0] for r in c.execute(
                "SELECT DISTINCT question FROM answers ORDER BY question"
            )]
        fresh = pm.Matcher(questions)
    except Exception as e:
        print(f"[verify] matcher index: invalid ({e})")
        return False

    # Same queries the bridge actually sends, across several (limit, threshold)
    # combinations, over every paraphrase test case.
    combos = (
        (cfg.SEARCH_LIMIT, cfg.MATCH_THRESHOLD),   # general search default
        (5, cfg.BRIDGE_THRESHOLD),                 # bridge _resolve_candidates
        (5, 0.34),                                 # permissive relative cut-off
    )
    tests = json.loads(cfg.PARAPHRASE_TESTS.read_text(encoding="utf-8"))
    comparisons = 0
    mismatches = 0
    for t in tests:
        for limit, threshold in combos:
            a = fresh.search(t["typed"], limit=limit, threshold=threshold)
            b = loaded.search(t["typed"], limit=limit, threshold=threshold)
            comparisons += 1
            if a != b:
                mismatches += 1
                if mismatches <= 3:
                    print(f"[verify]   mismatch: {t['typed']!r} ({limit},{threshold})")
    print(
        f"[verify] matcher index: {len(loaded.questions)} questions, "
        f"{comparisons} comparisons, {mismatches} mismatches"
    )
    return mismatches == 0


def check_corrections() -> bool:
    records = derive.read_jsonl(cfg.CORRECTIONS)
    bad = [
        r for r in records
        if not derive.is_bank_authoritative(r)
    ]
    print(
        f"[verify] policy: corrections={len(records)} "
        f"bank_authoritative={len(records) - len(bad)} rejects={len(bad)}"
    )
    for rec in bad[:5]:
        print(f"[verify]   REJECT mode={rec.get('mode')!r} action={rec.get('action')!r}")

    # Behavioural probe: a play record must not demote; a bank record must.
    with tempfile.TemporaryDirectory() as td:
        probe = Path(td) / "corrections.jsonl"
        probe.write_text(
            json.dumps({"question": "Q", "answer": "A", "action": "remove", "mode": "play"})
            + "\n"
            + json.dumps({"question": "Q", "answer": "A", "action": "remove", "mode": "bank"})
            + "\n",
            encoding="utf-8",
        )
        with sqlite3.connect(":memory:") as c:
            c.execute(
                "CREATE TABLE answers(question TEXT, answer TEXT, is_krillion INTEGER)"
            )
            c.execute("INSERT INTO answers VALUES('Q', 'A', 1)")
            demoted = ingest.apply_bank_demotions(c, probe)
    ok = demoted == 1
    print(f"[verify] policy: demotion probe (play rejected, bank applied)={'ok' if ok else 'FAIL'}")
    return not bad and ok


def _table_exists(c: sqlite3.Connection, name: str) -> bool:
    return bool(
        c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
    )


def check_groups_and_aliases() -> bool:
    ok = True
    with _ro(cfg.SEARCH_DB) as c:
        has_keys = _table_exists(c, "prompt_key") and _table_exists(c, "prompt_bank")
        banks = set()
        keys = []
        if has_keys:
            banks = {r[0] for r in c.execute("SELECT DISTINCT bank_id FROM prompt_key")}
            keys = [r[0] for r in c.execute("SELECT DISTINCT key FROM prompt_key")]
        multi = 0
        if has_keys:
            multi = c.execute(
                "SELECT COUNT(*) FROM (SELECT key, key_kind FROM prompt_key "
                "GROUP BY key, key_kind HAVING COUNT(DISTINCT bank_id) > 1)"
            ).fetchone()[0]
    with _ro(cfg.ONLY_DB) as c:
        stored = {r[0] for r in c.execute("SELECT DISTINCT question FROM answers")}

    print(
        f"[verify] policy: groups stored_banks={len(stored)} keyed_banks={len(banks)} "
        f"multi-valued_keys={multi} (collisions kept, no winner picked)"
    )
    if has_keys:
        unknown = banks - stored
        ok &= not unknown
        print(f"[verify] policy: keyed bank ids all real stored wordings={'ok' if not unknown else sorted(unknown)[:3]}")

    # Near-duplicate prompts from the test suite must remain separate banks.
    tests = json.loads(cfg.PARAPHRASE_TESTS.read_text(encoding="utf-8"))
    pairs = [
        (t["typed"], t["expect"]) for t in tests
        if t["typed"] != t["expect"]
        and t["typed"] in stored and t["expect"] in stored
    ]
    if has_keys:
        pairs = [p for p in pairs if p[0] in banks or p[1] in banks]
    ok &= all(a != b for a, b in pairs)
    print(f"[verify] policy: near-duplicate pairs kept separate={len(pairs)}")

    # aliases.jsonl is log-only: no alias-only phrase may become a matcher key.
    aliases = derive.read_jsonl(cfg.ALIASES)
    alias_only = {
        str(r.get("alias", "")).strip() for r in aliases
    } - stored
    leaked = sorted(alias_only & set(keys)) if has_keys else []
    matcher_src = cfg.PARAPHRASE_SOURCE.read_text(encoding="utf-8")
    bridge_src = cfg.BRIDGE_SOURCE.read_text(encoding="utf-8")
    referenced = "aliases.jsonl" in matcher_src or "aliases.jsonl" in bridge_src
    ok &= not leaked and not referenced
    print(
        f"[verify] policy: aliases logged={len(aliases)} alias_only_phrases={len(alias_only)} "
        f"applied_keys={len(leaked)} matcher_references_aliases={referenced}"
    )
    return ok


def check_manifest(counts: dict) -> bool:
    if not cfg.MANIFEST.exists():
        print("[verify] manifest: absent (consumer fallback is old behaviour)")
        return True
    try:
        m = json.loads(cfg.MANIFEST.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"[verify] manifest: invalid JSON ({e})")
        return False
    ok = (
        m.get("schema_version") == cfg.SCHEMA_VERSION
        and int(m.get("data_version", 0)) >= 1
        and m.get("counts") == counts
    )
    print(
        f"[verify] manifest: schema={m.get('schema_version')} "
        f"version={m.get('data_version')} counts_match={m.get('counts') == counts}"
    )
    return ok


def check_tier_data() -> bool:
    """God-mode snapshot: well-formed and in sync with the FULL DB low tier."""
    path = cfg.TIER_DATA
    if not path.exists():
        print(f"[verify] tier data: MISSING {path}")
        return False
    try:
        raw = path.read_bytes()
        payload = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError) as e:
        print(f"[verify] tier data: invalid JSON ({e})")
        return False
    if not isinstance(payload, dict):
        print("[verify] tier data: payload is not a JSON object")
        return False

    schema = payload.get("schema")
    version = payload.get("version")
    rows = payload.get("rows")
    ok = True
    if isinstance(schema, bool) or schema != cfg.TIER_SCHEMA_VERSION:
        print(f"[verify] tier data: bad schema={schema!r}")
        ok &= False
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        print(f"[verify] tier data: bad version={version!r}")
        ok &= False
    if not isinstance(rows, list):
        print(f"[verify] tier data: bad rows (type={type(rows).__name__})")
        return False

    questions = []
    bad_shape = bad_points = over_limit = duplicates = 0
    point_hist: dict[str, int] = {}
    for row in rows:
        if (not isinstance(row, list) or len(row) != 2
                or not isinstance(row[0], str) or not isinstance(row[1], list)):
            bad_shape += 1
            continue
        question, answers = row
        questions.append(question)
        over_limit += len(answers) > 20
        answer_strings = []
        for entry in answers:
            if (not isinstance(entry, list) or len(entry) != 2
                    or not isinstance(entry[0], str)):
                bad_shape += 1
                continue
            points = entry[1]
            if isinstance(points, bool) or (points is not None and not (
                isinstance(points, int) and points in cfg.TIER_POINTS
            )):
                bad_points += 1
                continue
            answer_strings.append(entry[0])
            label = "null" if points is None else str(points)
            point_hist[label] = point_hist.get(label, 0) + 1
        duplicates += len(set(answer_strings)) != len(answer_strings)
    if bad_shape or bad_points or over_limit or duplicates:
        print(
            f"[verify] tier data: bad rows (shape={bad_shape} bad_points={bad_points} "
            f"over_20={over_limit} duplicate_answers={duplicates})"
        )
        ok &= False
    if questions != sorted(questions) or len(set(questions)) != len(questions):
        print("[verify] tier data: questions not sorted/unique")
        ok &= False

    with _ro(cfg.FULL_DB) as c:
        expected = {
            r[0] for r in c.execute(
                "SELECT DISTINCT question FROM answers WHERE is_krillion=0"
            )
        }
    got = set(questions)
    if got != expected:
        ok &= False
        print(
            f"[verify] tier data: question set mismatch "
            f"(missing={sorted(expected - got)[:3]}, extra={sorted(got - expected)[:3]})"
        )

    manifest_sha = None
    if cfg.MANIFEST.exists():
        try:
            m = json.loads(cfg.MANIFEST.read_text(encoding="utf-8"))
            if isinstance(m, dict) and isinstance(m.get("artifacts"), dict):
                manifest_sha = m["artifacts"].get(cfg.TIER_DATA_JSON)
        except (OSError, ValueError):
            pass
    actual_sha = hashlib.sha256(raw).hexdigest()
    if manifest_sha != actual_sha:
        print(
            f"[verify] tier data: manifest sha mismatch "
            f"({manifest_sha} != {actual_sha})"
        )
        ok &= False

    print(
        f"[verify] tier data: schema={schema} version={version} rows={len(rows)} "
        f"questions={len(got)} db_low_tier_questions={len(expected)} "
        f"set_match={got == expected} points={point_hist} bytes={len(raw)} "
        f"manifest_sha={str(manifest_sha)[:12]} -> {'ok' if ok else 'FAIL'}"
    )
    return bool(ok)


def verify() -> dict:
    ok_counts, counts = check_counts()
    ok = ok_counts
    ok &= check_integrity()
    ok &= check_paraphrase()
    ok &= check_matcher_index()
    ok &= check_corrections()
    ok &= check_groups_and_aliases()
    ok &= check_manifest(counts)
    ok &= check_tier_data()
    print(f"[verify] RESULT: {'PASS' if ok else 'FAIL'}")
    return {"ok": bool(ok), "counts": counts}


def main() -> int:
    return 0 if verify()["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
