# Krillion — "Process the log" full run + paraphrase-duplicate audit

**Status:** APPROVED — awaiting execution
**Created:** 2026-11-28
**Owner:** Supervisor session; execute directly in the main worktree (no new worktrees needed — this is data/pipeline work, not feature work).
**Source:** user directive, verbatim intent preserved below.

---

## 0. Read first (do not skip, do not skim)

Project root `D:\! Games\Krillion Game` (repo `berliandro/krillion-answer-database`, branch `main`). Read **completely, in this order**:

1. `AGENTS.md`
2. `injection/PROCESS-LOG.md`
3. `injection/DECISIONS.md`
4. `README.md`
5. `injection/README.md`
6. `injection/STATES.md`
7. `injection/PERF.md`
8. `scripts/ingest.py`
9. `scripts/derive.py`
10. `scripts/paraphrase_match.py`
11. Last ~150 lines of `injection/CHANGELOG.md`

Then report understanding in ≤10 lines, including the two-tier model:

- **Full DB** = every answer to every question; source of truth; optimised for completeness.
- **Search DB** = derived, **one answer per question**; the webapp searches this only; rebuild from Full DB.

Run `git pull` and `git status` **before changing anything**.

---

## What was understood (baseline)

- Full DB `answers` is append-only via `INSERT OR IGNORE`; the only tier mutation is `apply_bank_demotions()`, which requires `action` in `REMOVAL_ACTIONS` and `mode` in `BANK_AUTHORITATIVE_MODES` (`derive.is_bank_authoritative`). Play scores never qualify.
- `krillion_db.py import` = `ingest.import_answers()` + `derive.rebuild()` + `derive.build_krillion_only()`. `derive` keeps near-duplicate banks as distinct `prompt_bank` ids with multi-valued `prompt_key`, never merged; `aliases.jsonl` is never read.
- `paraphrase_match.py` is the reference matcher: NFKC/casefold/diacritic/quote/whitespace normalisation, IDF-weighted token overlap, trigram Dice, negation guard, quote-aware matching. `shared/norm.generated.js` is the generated JS equivalent. Both must agree with the audit.
- Standing policy (`DECISIONS.md`): never demote from play; never pin aliases; other players' answers quarantined; prompts/answers only from the game's graded banks; log by game/input state; one indexed DB, caching for speed; lookup GETs retry forever.
- `PROCESS-LOG.md` is the standing workflow: review logs → bank demotions → import → static rebuild (both site builders) → commit → changelog → rotate diagnostics → report. `scripts/build.py all` does **not** run the site builders.
- Environment: bridge on 127.0.0.1:8768 (token in URL); restart after any `bridge.py` edit; respect ~65s fetch cooldown and `KRILLION_NO_FETCH=1`; `favicon.ico` deletion and two older commits belong to another session — untouched.
- Current harvest: 13,067 unique Krillocity wordings, saturated; canonical merge wired into userscript v1.1.9 with verbatim-bank-only lookup keys; `tests/run_all.py` = 10 passed / 0 failed; `HEAD == origin/main == 9812880`.

---

## 1. Safety baseline

- Copy `data/*.db` and `data/*.jsonl` to a **timestamped backup folder outside the repo tree**.
- Record BEFORE counts: answers, one-in-a-krillion answers, distinct prompts, exact duplicate pairs.
- Run `python tests/run_all.py`; note the result.
- Run `git pull` + `git status` before changes.

## 2. Read ALL logs, report counts + anomalies

`injection/data/`: `evidence.jsonl`, `prompt_review.jsonl`, `bot_log.jsonl`, `aliases.jsonl`, `failed_prompts.jsonl`, `fetch_queue.jsonl`, `corrections.jsonl`, `learned.jsonl`, `other_users_quarantine.jsonl`; plus `data/answers_injection.jsonl`.

Read the **real content** of every `ambiguous` / `no-match` / `low-score` / `refused` entry in `prompt_review.jsonl` — not just counts. Group repeated entries; decide root cause (missing rewrite, near-duplicate confusion, absent bank, inconsistent AI grading). Propose concrete fixes (rewrite rules in `bridge.py`, never pinned aliases). Play scores never demote.

## 3. Paraphrase-duplicate audit (main new task)

Goal: the same question must not exist twice under different wording, and the same answer must not exist twice under different spelling, **without** breaking the rule that the game treats near-duplicate prompts as separate banks.

**3a. Normalized keys** for prompts and answers: casefold, Unicode NFKC, strip diacritics, curly→straight quotes, collapse whitespace, drop trailing punctuation. Use the same normalisation as `shared/norm.generated.js` and `scripts/paraphrase_match.py` so the audit agrees with the search layer.

**3b. Classify every candidate pair into exactly one class:**
- `TRIVIAL` — identical after normalization (case/spacing/punctuation/quotes only). Effectively the same game prompt; safe to collapse at import time.
- `PARAPHRASE` — different meaning-bearing wording (synonym, word order, `a`/`any one`, `from X` vs `X`). Use the paraphrase matcher; flag negation traps (`with`/`without`).
- `ANSWER-VARIANT` — same prompt, answers equal after normalization but differing in case/spacing/punctuation/accents.

**3c. Evidence gate for each PARAPHRASE pair:** check whether the game serves both strings as graded banks (`source: "api"` or `"own"` for BOTH).
- Both game-graded → separate in the game. Do NOT merge or delete. Record as a paraphrase group with a shared group id (link only).
- Only on-screen play evidence / bridge rewrite / fuzzy match, no graded bank → do NOT insert as a new prompt in the Full DB. Prompts and answers are imported **only** from the game's own graded banks under the game's exact prompt text.

**3d. Tier disagreement:** for answers with the same normalized key under paraphrase-grouped prompts, report any tier disagreement (100 vs <100). **Report only — never demote from this.**

**3e. Automatic applications ONLY:** `TRIVIAL` prompt cleanup and `ANSWER-VARIANT` cleanup, non-destructively in the import/derive layer (e.g. normalized key column or unique index), preserving original strings. **Never rewrite or delete rows in raw JSONL.** If a duplicate exists in the Full DB, keep the row with the highest-confidence tier and the original spelling, and log what was collapsed.

**3f. Write full findings to `injection/PROCESS-REPORT.md`:** counts per class, 20 examples per class, proposed paraphrase-group list. Then **STOP and ask the user** before any policy change (merging paraphrases, changing Search DB to one answer per group, applying aliases to the matcher).

## 4. Hard rules (do not break)

- NEVER demote from a play score (`points < 100`). Only dive-end graded bank data (`mode: "bank"`) may demote. Verify every `corrections.jsonl` record; remove older play-based records and tell the user.
- NEVER import `injection/data/other_users_quarantine.jsonl` or other players' answers.
- NEVER pin an alias into the matcher from one observation. Aliases stay log-only.
- NEVER delete log entries without telling the user. NEVER edit the userscript (self-updates from GitHub).
- NEVER edit webapp-optimizer-owned files (`README.md`, `index.html`, `scripts/krillion_db.py`, site templates, `docs/*`) except by running their documented commands.
- Respect the ~65s fetch cooldown. Respect `KRILLION_NO_FETCH=1`.
- Tell the user about any proposed `bridge.py` rewrite-rule change; propose a concrete fix instead of pinning an alias.

## 5. Execute the pipeline

1. `python scripts/krillion_db.py import` — confirm `inserted=` and `demoted=`.
2. Run import **again** — `inserted` must be 0 (idempotence). If not, stop and investigate.
3. `python scripts/build_static.py`
4. `python scripts/build_krillion_site.py`
5. `python scripts/build_webapp.py` (PROCESS-LOG.md omits this; README and commit step include `webapp/index.html`). `scripts/build.py all` does NOT run the site builders.
6. `python tests/run_all.py` must pass.
7. Spot-check: search `Name any one famous park` on the rebuilt site → must return `Name a famous park`.
8. AFTER counts. Compare to BEFORE and explain every difference.
9. `git add data injection/data index.html search-data.json krillion/index.html krillion/krillion-data.json webapp/index.html`; commit `Process log: +N answers, -M demotions, K trivial dups collapsed`; push.
10. Append summary to `injection/CHANGELOG.md`.
11. `python injection/rotate_logs.py` (dry run) — show output — then `--apply`. Only `evidence`, `prompt_review`, `bot_log`, `failed_prompts` rotate. NEVER rotate `corrections`, `learned`, `answers_injection`, `fetch_queue`.
12. Commit and push archives + trimmed logs.

## 6. Final report to the user

BEFORE/AFTER table; `inserted`; `demoted`; still unresolved; anomalies; paraphrase audit summary and decisions needed; rotation counts; tests result. **Do not say "done" without evidence** — command output, counts, commit hash.

---

## Completion criteria

- All 12 pipeline steps executed with command output recorded.
- `data/paraphrase_eval.json` / `injection/PROCESS-REPORT.md` contain per-class counts, examples and proposed groups; the policy STOP at 3f was honoured.
- `python tests/run_all.py` passes; second import is idempotent; spot-check passes.
- BEFORE/AFTER explained; `HEAD == origin/main` after both commits; final report cites hashes.
