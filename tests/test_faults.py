#!/usr/bin/env python3
"""Phase 5 / W5-B — Python companion to tests/faults.test.js.

Dependency-free (stdlib only).  It feeds the REAL committed bridge data
(data/tier-data.json, data/paraphrase_tests.json, injection/data/*.jsonl) and
the REAL Python modules (config, derive, paraphrase_match) through the same
four fault classes, plus cross-language source checks on the userscript and
bridge.  No DB is required, no bridge is contacted, no file is written.

Run:  python tests/test_faults.py
Exits non-zero on any FAIL.  Python fault ids are prefixed P- so they never
collide with the Node suite's M/W/T/O ids.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from _common import REPO_ROOT, add_scripts_to_path, load_module

add_scripts_to_path()
cfg = load_module("faults_config", REPO_ROOT / "scripts" / "config.py")
derive = load_module("faults_derive", REPO_ROOT / "scripts" / "derive.py")
pm = load_module("faults_paraphrase_match", REPO_ROOT / "scripts" / "paraphrase_match.py")

USERSCRIPT = (REPO_ROOT / "injection" / "krillion-autofill.user.js").read_text(encoding="utf-8")
BRIDGE = cfg.BRIDGE_SOURCE.read_text(encoding="utf-8")
DERIVE_SRC = (REPO_ROOT / "scripts" / "derive.py").read_text(encoding="utf-8")
TIER = json.loads((REPO_ROOT / "data" / "tier-data.json").read_text(encoding="utf-8"))
TIER_ROWS = TIER.get("rows", TIER.get("data", []))
CASES = json.loads(cfg.PARAPHRASE_TESTS.read_text(encoding="utf-8"))

RESULTS: list[tuple[str, str, bool, str]] = []


def fault(cls: str, fid: str, fn):
    try:
        out = fn()
        if isinstance(out, tuple):
            ok, detail = bool(out[0]), str(out[1])
        else:
            ok, detail = bool(out), str(out)
    except Exception as exc:  # deterministic: a crash is a FAIL, never a silent skip
        ok, detail = False, f"THREW {type(exc).__name__}: {exc}"
    RESULTS.append((cls, fid, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {cls}/{fid}: {detail}")


def source_line(text: str, needle: str) -> str:
    for i, line in enumerate(text.splitlines(), 1):
        if needle in line:
            return f"line {i}: {line.strip()[:150]}"
    return f"<not found: {needle}>"


# ---------------------------------------------------------------------------
# M — miscalculation
# ---------------------------------------------------------------------------
def real_points_schema():
    values: dict[str, int] = {}
    bad = []
    for row in TIER_ROWS:
        if not isinstance(row, (list, tuple)) or len(row) < 2:
            continue
        for entry in row[1]:
            pts = entry[1] if isinstance(entry, (list, tuple)) else entry.get("points")
            if pts is None:
                continue
            if isinstance(pts, bool) or not isinstance(pts, int) or pts not in cfg.TIER_POINTS:
                bad.append((row[0], pts))
            values[str(pts)] = values.get(str(pts), 0) + 1
    return not bad, (f"rows={len(TIER_ROWS)}, real point values={json.dumps(values, sort_keys=True)}, "
                     f"out-of-schema={len(bad)}")


def tier_weight_sum():
    m = re.search(r"GOD_TIER_CHANCE\s*=\s*\{([^}]*)\}", USERSCRIPT)
    if not m:
        return False, "GOD_TIER_CHANCE literal not found"
    weights = [(int(k), float(v)) for k, v in re.findall(r"(\d+)\s*:\s*([\d.]+)", m.group(1))]
    total = sum(v for _, v in weights)
    return (abs(total - 100) < 1e-9,
            f"REPRO: sum {source_line(USERSCRIPT, 'GOD_TIER_CHANCE =')} => weights "
            f"{json.dumps(weights)} sum={total:.2f}. EXPECTED 100.00 (comment claims "
            f"'normalised to 100%'), ACTUAL {total:.2f}; the 0.01 shortfall is silently "
            f"given to the last tier by pickGodAnswer's rounding guard.")


def tier_index_mapping():
    cap = "tierIndex === 5 ? 100 : 0" in USERSCRIPT
    demote = "tier_index_num == 5" in BRIDGE and "tier_index_num != 5" in BRIDGE
    learned = "r.get(\"tierIndex\") == 4 or r.get(\"tier\") == \"DEEP CUT\"" in BRIDGE
    return (cap and demote and learned,
            f"userscript capture tierIndex5->100={cap}; bridge authoritative5={demote}; "
            f"bridge deepcut85 recognition={learned}")


# ---------------------------------------------------------------------------
# W — missed wording (real paraphrases, real policy log, real nq collisions)
# ---------------------------------------------------------------------------
def paraphrase_recall_real_data():
    questions = [row[0] for row in TIER_ROWS if isinstance(row, (list, tuple)) and row[0]]
    matcher = pm.Matcher(questions)
    misses = []
    for case in CASES:
        hits = [h["question"] for h in matcher.search(case["typed"], limit=10)]
        if case["expect"] not in hits:
            misses.append((case["typed"], case["expect"]))
    return (not misses,
            f"real tier prompts={len(questions)}, paraphrase cases={len(CASES)}, "
            f"recall@10={len(CASES) - len(misses)}/{len(CASES)}, misses={json.dumps(misses[:4])}")


def alias_never_applied():
    corrections = []
    path = cfg.CORRECTIONS
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    corrections.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    play_demotions = [r for r in corrections
                      if r.get("action") in cfg.REMOVAL_ACTIONS
                      and r.get("mode") in cfg.PLAY_MODES]
    derive_no_alias = "ALIASES" not in DERIVE_SRC
    all_bank = all(derive.is_bank_authoritative(r) for r in corrections
                   if r.get("action") in cfg.REMOVAL_ACTIONS)
    return (not play_demotions and derive_no_alias and all_bank,
            f"real corrections={len(corrections)}, play-mode demotions={len(play_demotions)}, "
            f"derive reads aliases={not derive_no_alias}, all removals bank-authoritative={all_bank}")


def bank_label_collision_real_data(source: str = USERSCRIPT) -> tuple[bool, str]:
    """nq collisions are EXPECTED; colliding banks must survive as separate labels.

    The old assertion demanded one nq key per distinct bank label. That premise
    contradicts the design: config.py:95-96 says every prompt-key kind is
    multi-valued ("a key may map to many banks; the build never picks a winner
    when real banks collide"), derive.py:140 says prompt_keys() "Never picks a
    winning spelling", and rewrite_query() (derive.py:128-136) deliberately maps
    rewrites onto the same key. The invariant is therefore retention, not
    uniqueness: RESTRUCTURE-CONTRACT.md:12 / CONTRACT-P4.md:14 / CONTRACT-MODES.md:12
    require near-duplicate banks to stay SEPARATE labelled groups, never merged.
    `source` is injectable so the regression check can be replayed against a
    pre-fix buildPremap without touching the shipped userscript.
    """
    # (a) Real data must genuinely exercise the collision path.
    seen: dict[str, str] = {}
    pairs: list[tuple[str, str, str]] = []
    for row in TIER_ROWS:
        if not isinstance(row, (list, tuple)) or len(row) < 2 or not row[0] or not row[1]:
            continue
        key = derive.prompt_keys(str(row[0]))[cfg.KEY_REWRITE]
        if key in seen and seen[key] != row[0]:
            pairs.append((seen[key], row[0], key))
        seen.setdefault(key, row[0])

    # (b) The shipped source must keep MULTIPLE labelled banks per colliding key
    # and pass them to applyResult as separate groups.
    multi_valued = (
        "prev.banks = [{ q: prev.q, answers: prev.answers.slice(), score: prev.score }];",
        "prev.banks.push(bank);",
        "map.set(item.q, bank);",
    )
    separate_groups = (
        "const banks = item && item.banks ? item.banks : [item];",
        "banks.map((b) => ({",
        "answers: b.answers || [],",
    )
    exact_hit = "applyResult({ exact: true, groups: premapGroups(item, question) }, question);"
    state_groups = "state.groups = data.groups || [{ question, score: 1, answers: data.answers || [] }];"
    missing = [n for n in multi_valued + separate_groups + (exact_hit, state_groups) if n not in source]

    # (c) premapGroups() must emit one group per bank — no flat concat into one.
    body_match = re.search(r"function premapGroups\(item, question\) \{(.*?)\n  \}", source, re.S)
    body = body_match.group(1) if body_match else ""
    no_merge = (
        "item.banks ? item.banks : [item]" in body
        and "banks.map((b) => ({" in body
        and ".concat(" not in body
    )

    ok = bool(pairs) and not missing and no_merge
    return (ok,
            f"real tier rows={len(TIER_ROWS)}, nq collisions={len(pairs)} (expected > 0), "
            f"first={json.dumps(pairs[0], ensure_ascii=False) if pairs else 'none'}; "
            f"multi-valued banks per key={not any(n in missing for n in multi_valued)} "
            f"({source_line(source, 'prev.banks.push(bank);')}); "
            f"exact hit passes separate groups={exact_hit in source} "
            f"({source_line(source, 'groups: premapGroups(item, question)')}); "
            f"applyResult preserves data.groups={state_groups in source}; "
            f"premapGroups one-group-per-bank, no concat={no_merge}; "
            f"missing={json.dumps(missing)}. "
            f"EXPECTED nq collisions to be RETAINED as separate labelled banks "
            f"(config.py:95-96, derive.py:140, RESTRUCTURE-CONTRACT.md:12); "
            f"a single-valued Map.set(key, bank) that drops the earlier bank FAILS "
            f"(cross-confirms Node missed-wording/bank-label-collision).")


# ---------------------------------------------------------------------------
# T — missed timing (source invariants that drive the Node functional tests)
# ---------------------------------------------------------------------------
def retry_backoff_source():
    bounded = "setTimeout(go, 400)" in USERSCRIPT
    cap = "Math.min(backoffMs * 2, 30000)" in USERSCRIPT
    forever = "options.forever" in USERSCRIPT and "loggedFinalFail" in USERSCRIPT
    return (bounded and cap and forever,
            f"bounded retry {bounded}, 30s cap {cap}, forever/log-once {forever}")


def observer_debounce_source():
    ms = re.search(r"MO_DEBOUNCE_MS\s*=\s*(\d+)", USERSCRIPT)
    coalesce = "if (timer) clearTimeout(timer)" in USERSCRIPT
    value = int(ms.group(1)) if ms else -1
    return (value == 50 and coalesce,
            f"MO_DEBOUNCE_MS={value} (expected 50), clearTimeout coalescing={coalesce}")


def capture_restart_gate_source():
    timeout = re.search(r"CLASSIC_CAPTURE_TIMEOUT_MS\s*=\s*(\d+)", USERSCRIPT)
    value = int(timeout.group(1)) if timeout else -1
    settled = "bankCaptureSettled" in USERSCRIPT and "bankCapturePromise" in USERSCRIPT
    single = USERSCRIPT.count("restartFromResults(") >= 1
    return (value == 2200 and settled and single,
            f"CLASSIC_CAPTURE_TIMEOUT_MS={value}, capture-settled promise={settled}, "
            f"restart call sites={single}")


# ---------------------------------------------------------------------------
# O — optimisation defects (real cache keys, real policy, source guards)
# ---------------------------------------------------------------------------
def cache_invalidation_source():
    keyed = "st.st_mtime_ns, st.st_size" in BRIDGE
    fresh = "always fresh so demotions reported during play take effect immediately" in BRIDGE
    single_flight = "RESOLVE_CACHE" in BRIDGE and "RESOLVE_MAX = 512" in BRIDGE
    return (keyed and fresh and single_flight,
            f"cache keyed by mtime_ns+size={keyed}, groups rebuilt fresh={fresh}, "
            f"single-flight LRU={single_flight}")


def dedupe_permanent_source():
    adds = USERSCRIPT.count("refusedAnswers.add(")
    clears = USERSCRIPT.count("refusedAnswers.clear(")
    return (clears > 0,
            f"REPRO: userscript has {adds} refusedAnswers.add() site(s) and {clears} "
            f"refusedAnswers.clear() site(s); a play-time refusal is keyed by prompt+answer "
            f"and never removed even after reportScore(...,100,'ONE IN A KRILLION') "
            f"from the game's authoritative graded bank. EXPECTED bank confirmation clears "
            f"the block. ACTUAL the correct answer stays blocked for the session "
            f"(cross-confirms Node optimisation/dedupe-blocks-correct-answer).")


def prefetch_cap_source():
    mx = re.search(r"PREFETCH_MAX\s*=\s*(\d+)", USERSCRIPT)
    conc = re.search(r"PREFETCH_CONCURRENCY\s*=\s*(\d+)", USERSCRIPT)
    maxv = int(mx.group(1)) if mx else -1
    concv = int(conc.group(1)) if conc else -1
    clear = "state.prefetchQueue.length = 0" in USERSCRIPT
    return (maxv == 60 and concv == 3 and clear,
            f"PREFETCH_MAX={maxv}, PREFETCH_CONCURRENCY={concv}, backlog cleared at cap={clear}")


def stale_response_source():
    guard = "const isStale = () => state.question !== question || state.loadToken !== loadToken" in USERSCRIPT
    onload = "if (isStale()) { settleReject(new Error('stale request')); return; }" in USERSCRIPT
    after = "if (isStale()) return; // a newer prompt won while we were retrying" in USERSCRIPT
    return (guard and onload and after,
            f"loadToken+question stale guard={guard}, request onload guard={onload}, "
            f"post-await guard={after}")


def main() -> int:
    print("Krillion Phase 5 / W5-B Python fault companion (stdlib only)")
    print(f"real tier rows={len(TIER_ROWS)}, paraphrase cases={len(CASES)}, "
          f"userscript={cfg.BRIDGE_SOURCE.parent / 'krillion-autofill.user.js'}\n")

    fault("miscalculation", "P-M01-points-schema-real-data", real_points_schema)
    fault("miscalculation", "P-M02-gaussian-weights-sum", tier_weight_sum)
    fault("miscalculation", "P-M03-tier-index-mapping", tier_index_mapping)

    fault("missed-wording", "P-W01-paraphrase-recall-real-data", paraphrase_recall_real_data)
    fault("missed-wording", "P-W02-alias-never-applied", alias_never_applied)
    fault("missed-wording", "P-W03-bank-label-collision-real-data", bank_label_collision_real_data)

    fault("missed-timing", "P-T01-retry-backoff-source", retry_backoff_source)
    fault("missed-timing", "P-T02-observer-debounce-source", observer_debounce_source)
    fault("missed-timing", "P-T03-capture-restart-gate-source", capture_restart_gate_source)

    fault("optimisation", "P-O01-cache-invalidation-source", cache_invalidation_source)
    fault("optimisation", "P-O02-dedupe-permanent-source", dedupe_permanent_source)
    fault("optimisation", "P-O03-prefetch-cap-source", prefetch_cap_source)
    fault("optimisation", "P-O04-stale-response-source", stale_response_source)

    print("\n=== Python fault counts ===")
    for cls in ("miscalculation", "missed-wording", "missed-timing", "optimisation"):
        rows = [r for r in RESULTS if r[0] == cls]
        passes = sum(1 for r in rows if r[2])
        print(f"{cls}: {passes}/{len(rows)} PASS, {len(rows) - passes} FAIL")
    passes = sum(1 for r in RESULTS if r[2])
    fails = [r for r in RESULTS if not r[2]]
    print(f"TOTAL: {passes}/{len(RESULTS)} PASS, {len(fails)} FAIL")
    if fails:
        print("\nFAIL list:")
        for cls, fid, _, detail in fails:
            print(f"- {cls}/{fid}: {detail}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
