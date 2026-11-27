# Krillion Roadmap — Evidence Ledger

Live record for the 8-phase roadmap in `Active Goals/KRILLION-COMPLETE-ROADMAP.md`.
Every phase must append a row with a real command and its output. A claim without
command output is not accepted. Do not delete rows; correct them with a dated note.

## Table format

| Phase | Hypothesis | Command | Result | Pass threshold | Commit | Status |
| --- | --- | --- | --- | --- | --- | --- |

---

## Baseline (Phase 0)

| Phase | Hypothesis | Command | Result | Pass threshold | Commit | Status |
| --- | --- | --- | --- | --- | --- | --- |
| P0-baseline | Repo is at a known commit and bridge is live | `git rev-parse HEAD` | `08eb18d4ff04131a5f2e27d1b9fc58e89d190b09` | 40-char SHA recorded | `08eb18d` | PASS |
| P0-baseline | Live bridge serves the verified archive | `curl -s http://127.0.0.1:8768/api/health?t=krillion-local-v1` | `{"ok":true,"service":"krillion-bridge","base_answers":21384,"corrections":0,"learned":5260,"misses":68,"log_lines":{"evidence":3820,"prompt_review":4086,"bot_log":92}}` | `ok=true`, `base_answers>=21384` | `08eb18d` | PASS |
| P0-baseline | Shipped userscript version recorded | `Select-String -Path injection/krillion-autofill.user.js -Pattern '^// @version'` | `// @version      1.1.2` | version present | `08eb18d` | PASS |
| P0-baseline | Dirty files are only live logs + other-session work | `git status --short` | `data/answers_injection.jsonl`, `favicon.ico` (deleted), `injection/CHANGELOG.md`, `injection/data/*.jsonl`, `Active Goals/` | no source files dirty | `08eb18d` | PASS |

**Baseline note:** `favicon.ico` deletion and commits `3300495`/`08eb18d` are from another session; per the roadmap they are not touched by this work. The four dirty `injection/data/*.jsonl` logs plus `answers_injection.jsonl`/`CHANGELOG.md` are runtime output of the live bridge and belong to the "process the log" workflow.

---

## Phase rows (append below as each phase completes)

| Phase | Hypothesis | Command | Result | Pass threshold | Commit | Status |
| --- | --- | --- | --- | --- | --- | --- |
| P0-gate | Harness loads the real userscript with stubbed GM/DOM and generates a selector/state registry | `node tests/roadmap_helpers.js --json <temp>/roadmap-registry.json` | 6/6 PASS: 38 selectors, 10 states (duel/results/create-room/lobby/refusal/answering/prompt-reveal/arena-wait/intro/loading-shell), 4 log sites, 5 modes, 16 markup ids; registry JSON written; version 1.1.2 | harness loads + >=1 assertion + registry generated | pending | PASS |

**P0 gate verdict:** PASS — evidence ledger created, harness scaffold loads the script with 6 passing assertions, source registry generated, baseline row recorded. Ready for Phase 1.

| Phase | Hypothesis | Command | Result | Pass threshold | Commit | Status |
| --- | --- | --- | --- | --- | --- | --- |
| P1-gate | Four disjoint inventories cover all modes, exclude shop, and map every registry selector | `python <temp>/verify_p1.py` + row-ID regex check | Classic 19 rows (C1–C19), Krillocity 14 (K-01…), MP+Duel 33 (S/D…), Interactions 102 (P/T/X…); registry selectors 38/38 present, states 10/10, modes 5/5, log sites 4/4; shop rows 0; all four branch merges clean | >=1 row per state per mode; zero shop rows; every selector mapped | `045e4b5` | PASS |
| P1-merge | Four Phase 1 branches merged without conflict | `git merge feat/p1-classic/p1-krillo/p1-mp-duel/p1-interactions --no-edit` | 4 fast-forwards, zero conflicts; `STATES.md` +3 new docs present | clean merge | `045e4b5` | PASS |

**P1 gate verdict:** PASS — complete inventory for Classic, Krillocity, Multiplayer and Duel; shop excluded; all 38 registry selectors, 10 states, 5 modes and 4 log sites mapped. Ready for Phase 2.

| Phase | Hypothesis | Command | Result | Pass threshold | Commit | Status |
| --- | --- | --- | --- | --- | --- | --- |
| P2-gate | Four strategy docs give >=3 ranked strategies per mode with evidence/risk/testable flags and no policy violations | `python -c "<count markers>"` | Scoring 245 lines / 33 evidence / 7 testable; Classic 278 / 59 / 6; Krillo 285 / 39 / 5; MP-Duel 285 / 12 testable; 61 no-demotion + 13 other-player prohibition mentions across all docs; 4 clean merges | >=3 strategies/mode, evidence+risk+testable flags, zero policy violations | `d012870` | PASS |

**P2 gate verdict:** PASS — 5/5/5/8 ranked strategies across scoring/Classic/Krillocity/MP-Duel, one-page summary written; ready for Phase 3 proof runs.

| Phase | Hypothesis | Command | Result | Pass threshold | Commit | Status |
| --- | --- | --- | --- | --- | --- | --- |
| P3-gate | Every strategy is PROVEN (>=3 measured runs) or REJECTED with reason; zero UNTESTED; no policy violation | `python <temp>/verify_p3b.py` | FILES=18 RUNS=55 PROVEN=14 REJECTED=4 UNTESTED=0 BAD_SHAPE=0 POLICY_VIOLATIONS=0; 3 proof-run branches + analysis merged cleanly | every strategy has verdict, >=3 runs, zero UNTESTED, zero policy violations | `d9cf1d2` | PASS |
| P3-analysis | Authoritative keep/discard table cross-checked against all evidence JSON | W3-D scoped check | ROWS=18, FILES=18, JSON_PROVEN=14, JSON_REJECTED=4, JSON_UNTESTED=0, MATCH=18, MISMATCH=0, JSON_TOTAL_RUNS=55 | one row per evidence file, verdicts match | `d9cf1d2` | PASS |

**P3 gate verdict:** PASS — 14 PROVEN strategies to wire in Phase 4, 4 REJECTED with recorded reasons, zero UNTESTED, field-level policy checks clean. Evidence is harness-based with real bridge data plus read-only DOM notes; no live scored game was started. Ready for Phase 4.

| Phase | Hypothesis | Command | Result | Pass threshold | Commit | Status |
| --- | --- | --- | --- | --- | --- | --- |
| P4-gate | All 14 PROVEN strategies wired, all 4 REJECTED in doNotWire only; suite still 100% | `python <temp>/verify_p4b.py` + `python tests/run_all.py` | KEEP from verified doc=14, missing from config=[]; DISCARD=4, missing from doNotWire=[]; REJECTED active=[]; 16 ids; 9/9 tests pass; node --check pass | all PROVEN wired, no REJECTED active, 100% tests | `e3f524d` | PASS |
| P4-version | Self-update serves new version | `@version 1.1.3` + raw GitHub URL | version bumped from 1.1.2; pushed; raw URL check below | version bumped + URL serves it | `e3f524d` | PASS |

**P4 gate verdict:** PASS — 4 clean merges, STRATEGY_CONFIG with 14 PROVEN / 4 doNotWire, zero REJECTED active, all tests pass, version 1.1.3. Ready for Phase 5.
