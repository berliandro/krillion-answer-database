# Krillion — "Process the log" full run + paraphrase-duplicate audit

**Status:** EXECUTED — all 12 pipeline steps complete; policy changes applied after user approval 2026-11-28.
**Created:** 2026-11-28
**Owner:** I ran this directly in the main worktree as the supervisor session (no new worktrees needed — this was data/pipeline work, not feature work).
**Source:** user directive, verbatim intent preserved below.

---

## 0. What I read first (I did not skip or skim)

At the project root `D:\! Games\Krillion Game` (repo `berliandro/krillion-answer-database`, branch `main`), I read these completely, in this order:

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

I then reported my understanding in ≤10 lines, including the two-tier model:

- **Full DB** = every answer to every question; source of truth; optimised for completeness.
- **Search DB** = derived, **one answer per question**; the webapp searches this only; rebuilt from Full DB.

I ran `git pull` and `git status` **before changing anything**.

---

## What I understood (baseline)

- Full DB `answers` is append-only via `INSERT OR IGNORE`; the only tier mutation is `apply_bank_demotions()`, which requires `action` in `REMOVAL_ACTIONS` and `mode` in `BANK_AUTHORITATIVE_MODES` (`derive.is_bank_authoritative`). Play scores never qualify.
- `krillion_db.py import` = `ingest.import_answers()` + `derive.rebuild()` + `derive.build_krillion_only()`. `derive` keeps near-duplicate banks as distinct `prompt_bank` ids with multi-valued `prompt_key`, never merged; `aliases.jsonl` is never read.
- `paraphrase_match.py` is the reference matcher: NFKC/casefold/diacritic/quote/whitespace normalisation, IDF-weighted token overlap, trigram Dice, negation guard, quote-aware matching. `shared/norm.generated.js` is the generated JS equivalent. I required both to agree with the audit.
- Standing policy (`DECISIONS.md`): never demote from play; never pin aliases; other players' answers quarantined; prompts/answers only from the game's graded banks; log by game/input state; one indexed DB, caching for speed; lookup GETs retry forever.
- `PROCESS-LOG.md` is the standing workflow: review logs → bank demotions → import → static rebuild (both site builders) → commit → changelog → rotate diagnostics → report. `scripts/build.py all` does **not** run the site builders.
- Environment: bridge on 127.0.0.1:8768 (token in URL); restart after any `bridge.py` edit; respect ~65s fetch cooldown and `KRILLION_NO_FETCH=1`; `favicon.ico` deletion and two older commits belong to another session — I left them untouched.
- Current harvest: 13,067 unique Krillocity wordings, saturated; canonical merge wired into userscript v1.1.9 with verbatim-bank-only lookup keys; `tests/run_all.py` = 10 passed / 0 failed; `HEAD == origin/main == 9812880`.

---

## 1. Safety baseline

- I copied `data/*.db` and `data/*.jsonl` to a **timestamped backup folder outside the repo tree**.
- I recorded BEFORE counts: answers, one-in-a-krillion answers, distinct prompts, exact duplicate pairs.
- I ran `python tests/run_all.py` and noted the result.
- I ran `git pull` + `git status` before changes.

---

## 2. The logs I read, and the counts + anomalies I reported

`injection/data/`: `evidence.jsonl`, `prompt_review.jsonl`, `bot_log.jsonl`, `aliases.jsonl`, `failed_prompts.jsonl`, `fetch_queue.jsonl`, `corrections.jsonl`, `learned.jsonl`, `other_users_quarantine.jsonl`; plus `data/answers_injection.jsonl`.

I read the **real content** of every `ambiguous` / `no-match` / `low-score` / `refused` entry in `prompt_review.jsonl` — not just counts. I grouped repeated entries and decided the root cause (missing rewrite, near-duplicate confusion, absent bank, inconsistent AI grading). I proposed concrete fixes (rewrite rules in `bridge.py`, never pinned aliases). Play scores never demote.

---

## 3. Paraphrase-duplicate audit (my main new task)

My goal was that the same question must not exist twice under different wording, and the same answer must not exist twice under different spelling, **without** breaking the rule that the game treats near-duplicate prompts as separate banks.

**3a. Normalized keys** for prompts and answers: casefold, Unicode NFKC, strip diacritics, curly→straight quotes, collapse whitespace, drop trailing punctuation. I used the same normalisation as `shared/norm.generated.js` and `scripts/paraphrase_match.py` so the audit agrees with the search layer.

**3b. I classified every candidate pair into exactly one class:**
- `TRIVIAL` — identical after normalization (case/spacing/punctuation/quotes only). Effectively the same game prompt; safe to collapse at import time.
- `PARAPHRASE` — different meaning-bearing wording (synonym, word order, `a`/`any one`, `from X` vs `X`). I used the paraphrase matcher and flagged negation traps (`with`/`without`).
- `ANSWER-VARIANT` — same prompt, answers equal after normalization but differing in case/spacing/punctuation/accents.

**3c. Evidence gate for each PARAPHRASE pair:** I checked whether the game serves both strings as graded banks (`source: "api"` or `"own"` for BOTH).
- Both game-graded → separate in the game. I did not merge or delete; I recorded it as a paraphrase group with a shared group id (link only).
- Only on-screen play evidence / bridge rewrite / fuzzy match, no graded bank → I did not insert it as a new prompt in the Full DB. Prompts and answers are imported **only** from the game's own graded banks under the game's exact prompt text.

**3d. Tier disagreement:** for answers with the same normalized key under paraphrase-grouped prompts, I reported any tier disagreement (100 vs <100) — report only; I never demoted from this.

**3e. Automatic applications ONLY:** I limited these to `TRIVIAL` prompt cleanup and `ANSWER-VARIANT` cleanup, non-destructively in the import/derive layer (e.g. normalized key column or unique index), preserving original strings. I never rewrote or deleted rows in raw JSONL. Where a duplicate existed in the Full DB, I kept the row with the highest-confidence tier and the original spelling, and logged what was collapsed.

**3f. I wrote the full findings to `injection/PROCESS-REPORT.md`:** counts per class, 20 examples per class, proposed paraphrase-group list. I then **stopped and asked the user** before any policy change (merging paraphrases, changing Search DB to one answer per group, applying aliases to the matcher).

---

## 4. Hard rules I did not break

- I never demoted from a play score (`points < 100`). Only dive-end graded bank data (`mode: "bank"`) may demote. I verified every `corrections.jsonl` record; I removed older play-based records and told the user.
- I never imported `injection/data/other_users_quarantine.jsonl` or other players' answers.
- I never pinned an alias into the matcher from one observation. Aliases stay log-only.
- I never deleted log entries without telling the user. I never edited the userscript (it self-updates from GitHub).
- I never edited webapp-optimizer-owned files (`README.md`, `index.html`, `scripts/krillion_db.py`, site templates, `docs/*`) except by running their documented commands.
- I respected the ~65s fetch cooldown and `KRILLION_NO_FETCH=1`.
- I told the user about any proposed `bridge.py` rewrite-rule change; I proposed a concrete fix instead of pinning an alias.

---

## 5. The pipeline I executed

1. I ran `python scripts/krillion_db.py import` and confirmed `inserted=` and `demoted=`.
2. I ran the import **again** and required `inserted` = 0 (idempotence); if it were not, I would stop and investigate.
3. I ran `python scripts/build_static.py`.
4. I ran `python scripts/build_krillion_site.py`.
5. I ran `python scripts/build_webapp.py` (PROCESS-LOG.md omits this; README and the commit step include `webapp/index.html`). I noted that `scripts/build.py all` does NOT run the site builders.
6. I required `python tests/run_all.py` to pass.
7. I spot-checked by searching `Name any one famous park` on the rebuilt site and required `Name a famous park` to come back.
8. I recorded AFTER counts, compared them to BEFORE, and explained every difference.
9. I ran `git add data injection/data index.html search-data.json krillion/index.html krillion/krillion-data.json webapp/index.html`, committed `Process log: +N answers, -M demotions, K trivial dups collapsed`, and pushed.
10. I appended a summary to `injection/CHANGELOG.md`.
11. I ran `python injection/rotate_logs.py` (dry run), showed the output, then ran `--apply`. Only `evidence`, `prompt_review`, `bot_log`, `failed_prompts` rotate; I never rotated `corrections`, `learned`, `answers_injection`, `fetch_queue`.
12. I committed and pushed the archives + trimmed logs.

---

## 6. The final report I gave the user

I reported the BEFORE/AFTER table; `inserted`; `demoted`; still unresolved; anomalies; paraphrase audit summary and decisions needed; rotation counts; tests result. I did not say "done" without evidence — command output, counts, commit hash.

---

## Completion criteria

- I executed all 12 pipeline steps with command output recorded.
- `data/paraphrase_eval.json` / `injection/PROCESS-REPORT.md` contain per-class counts, examples and proposed groups; I honoured the policy STOP at 3f.
- `python tests/run_all.py` passed; the second import was idempotent; the spot-check passed.
- I explained BEFORE/AFTER; `HEAD == origin/main` after both commits; the final report cites hashes.

---

## Execution record (2026-11-28)

- Backup: `C:\Users\nberl\AppData\Local\Temp\opencode\krillion-backup-20261128T075557`.
- Pipeline: import `+9 / demoted 0` → second import `inserted=0` → three site builders →
  `tests/run_all.py` 10/10 → spot-check resolves (exact bank now exists; `Name a famous park` rank 3)
  → BEFORE/AFTER → commit `5d5cedf` → changelog → rotation dry-run + `--apply` (all logs `ok`, no trim)
  → commit `b1161ce`.
- Audit: `injection/PROCESS-REPORT.md`, `data/norm_audit.json` — 0 TRIVIAL, 0 ANSWER-VARIANT,
  10,187 PARAPHRASE pairs, 477 game-graded link-only groups, 2 tier disagreements (report-only).
- User approved all three policy questions. Applied via `scripts/apply_paraphrase_policy.py`:
  468 transitive merged groups (945 wordings / 861 merged answers),
  `group_search_answers` 468 one-answer rows, 2,808 alias rewrite keys.
  Bridge loads `data/alias_rewrites.json` and applies rewrites only after exact and
  rewritten-exact fail. Live check: `name an example of a christmas film` →
  `What's an example of a Christmas movie?`.
- `tests/run_all.py` 10/10 and `python scripts/build.py verify` PASS after the policy change.
- Final commit `fd0a552`; `HEAD == origin/main`.
- **Fresh-clone note:** DB files are generated/ignored, so after `scripts/bootstrap.py --apply`
  or `krillion_db.py import`, I run `python scripts/apply_paraphrase_policy.py` to recreate the
  group tables and alias map, then restart the bridge.
