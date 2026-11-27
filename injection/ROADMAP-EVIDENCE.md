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
