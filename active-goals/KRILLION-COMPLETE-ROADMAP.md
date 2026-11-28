# Krillion Autofill — Complete Roadmap Goal

**Status:** APPROVED — awaiting execution
**Owner:** I am the supervisor session; I delegate all feature work to subagents in isolated worktrees and verify every result before accepting it.
**Created:** 2026-11-23
**Confirmed by user:** "push rank" means in-game depth/rank and multiplayer/duel rating (not GitHub standing); the shop is excluded entirely, including its states and interactions.
**Hard rule I set:** I advance to the next phase ONLY when the current phase has a measurable, recorded result. I never pause a running goal for a decision I can make myself. If I am blocked on knowledge, I search the web before declaring blocked.

---

## Verified baseline (I treat this as settled — I build on it)

- **Data:** Full DB 127,118 answers; Search DB 6,142 questions; Krillion-only DB 21,384 rare answers / 5,801 prompts. Two-tier model (Full = source of truth; Search = one answer/question for webapp).
- **Shipped script:** `injection/krillion-autofill.user.js` v1.1.2, self-updating via `@updateURL`/`@downloadURL` (I bump `@version` on EVERY edit; otherwise users never receive it).
- **Modes today:** Classic, Krillocity daily race, Multiplayer 5s/50 Marathon, Multiplayer most-populated, 1v1 duel.
- **Pick modes:** random, top, God (Gaussian point-group draw centred at 85pt).
- **Engine:** `/api/all` + `/api/all-tier` in-browser preload, `/api/answers` + `/api/answers-tier` with forever-retry, `/api/bank` end-of-dive capture, `/api/evidence`, `/api/prompt-review`, `/api/bot-log`, `/api/miss`, `/api/correction`, `/api/perf`.
- **Bridge:** persistent loopback 127.0.0.1:8768, token `krillion-local-v1` in URL, single-flight LRU caches, O(1) normalized exact map, per-thread SQLite connections, CORS locked to playdaily.org.
- **State map:** `injection/STATES.md` — every game/input state live-mapped, including the custom 6s/50-prompt Marathon and slow-loading shell; log/no-log decision per state.
- **Policy:** play scores NEVER demote; only the game's graded bank demotes. Near-duplicate prompts stay as separate labelled banks. Aliases are logged only, never applied. Other players' answers never recorded.
- **Tests:** `python tests/run_all.py` → 9/9; `node tests/mode_harness.js` → all pass; `python scripts/build.py verify` → PASS; bootstrap command available (`python scripts/bootstrap.py --apply`).
- **UI:** pastel lavender→peach card design copied from the reference image; dynamically wrapping answer chips; balanced motion; audited AA contrast and reduced-motion.

**Known environment caveats I recorded:** I restart the bridge after any `bridge.py` edit; some data JSONL files are dirty from the live bridge (I leave them to the "process the log" workflow); the in-app browser has been intermittently disconnected, so I use Playwright MCP as the verified fallback; `browse` is for real logged-in Chrome only. The `favicon.ico` deletion and the two recent commits (`3300495`, `08eb18d`) came from another session — I left them untouched.

---

## Rules of engagement (the rules I apply to every phase)

1. **Supervisor/observer model.** I write contracts, glue, and merge fixes only; feature code goes to subagents.
2. **No overlapping editors.** I give each workstream one isolated worktree + branch (`git worktree add -b <branch> .worktrees/<name> HEAD`). Each subagent owns an exact file list; crossing ownership is a violation. `.worktrees/` is gitignored.
3. **Self-contained briefs.** I include in every subagent brief: goal, contract, exact owned files, worktree path, acceptance criteria, a scoped check only (no full build/test in a worktree), a commit instruction, and a 3-line result contract (`status`, `artifact`, `evidence`, `blocker`).
4. **Fan-out in one batch** for independent work; I merge each branch with `git merge --no-edit` and resolve conflicts personally.
5. **Evidence before acceptance.** I do not accept a result message without command output. I verify with a scoped check, then re-verify the merged whole.
6. **Hard gates.** I end each phase with a written measurable pass/fail. A failed gate means I redo the phase (with a new, narrower workstream); I never skip ahead.
7. **No stalling.** If a fact is unknown, I research it online (websearch/webfetch) or via the game's own JS bundles before reporting blocked. Only a genuinely external dependency (credentials/manual login) may stop work, and then I state explicitly what is needed.
8. **Browser hierarchy:** in-app browser first → `browse` only for the user's real Chrome → Playwright MCP as fallback. I never solve captchas and never click real-money or destructive controls.
9. **Version discipline:** after ANY userscript edit, I bump `@version` so the self-update fires, and I verify the raw GitHub URL serves the new version.
10. **Evidence ledger:** I append every phase's numbers to `injection/ROADMAP-EVIDENCE.md` (commands, counts, screenshots/paths, commit SHAs).

---

## Phase 0 — Instrumentation and safe experimentation scaffold

**Goal:** I planned to make every later phase measurable and reversible before touching game behaviour.

- **Owned files (mine as supervisor):** `injection/ROADMAP-EVIDENCE.md` (new), `tests/roadmap_helpers.*` (new), `.gitignore` (already has `.worktrees/`).
- **Tasks:**
  1. I would create the evidence ledger with a fixed table format: Phase | Hypothesis | Command | Result | Pass threshold | Commit.
  2. I would add a reusable stubbed-GM/DOM Node harness scaffold (extending `tests/mode_harness.js` patterns) that can load the userscript and drive any mode state without a live game.
  3. I would add a source-level state/interaction registry generator that lists every selector, state classifier branch, and event log site from `krillion-autofill.user.js` — this would become the checklist for Phase 1.
  4. I would snapshot the current HEAD and confirm the `git status` baseline; I would record the exact bridge health payload.
- **Subagents:** I would use none (supervisor only; zero risk of conflict).
- **Gate I set:** the evidence ledger exists; the harness loads the script with ≥1 successful assertion; the baseline commit + bridge health are recorded.
- **Deliverable:** `injection/ROADMAP-EVIDENCE.md`, `tests/roadmap_helpers.js`, baseline row.

---

## Phase 1 — Find every interaction and game state (shop EXCLUDED)

**Goal:** I planned a complete, evidence-backed inventory of every on-screen state and every user/script interaction in Classic, Krillocity, Multiplayer (all room types), and 1v1 — deliberately excluding the shop.

- **Inputs:** `injection/STATES.md`, live game, site JS bundles, `injection/README.md`, userscript selectors.
- **Workstreams (parallel, disjoint):**
   - **W1-A Classic & results:** dive start, countdown, prompt reveal, input enabled/disabled, accepted/refused answer, per-prompt verdict, Next, all 7 prompts, dive-end results, haul toggle, row expansion, bank tiers, Play again. Owns `injection/STATES.md` section edits only.
   - **W1-B Krillocity:** landing → START DAILY → rapid input, per-prompt timer, answer acceptance/refusal, prompt advance, race end/results, daily completion. Owns a NEW `injection/STATES-KRILLO.md`.
   - **W1-C Multiplayer & 1v1:** lobby, room rows/selection, 5s/6s/15s/30s/60s Marathon, most-populated room, between-round board, prompt reveal before input mount, chat/emotes (interaction, not content), Leave, duel queue/rule/versus/result/requeue. Owns a NEW `injection/STATES-MP-DUEL.md`.
   - **W1-D Interaction catalogue (script side):** every control (Auto/Dive on click, Play for me, Pick, Mode, Hide, chip click, Enter, dropdowns) + every observer/log trigger + slow-loading/cold-start state. Owns a NEW `injection/INTERACTIONS.md`.
- **Method:** I planned live browser observation where possible; otherwise site bundles + existing live-verified notes. I would capture DOM selectors, visibility rules, timing windows (ms), input state (present/visible/enabled/placeholder), and whether logging is allowed. SHOP interactions are explicitly out of scope and I would mark them "excluded" if encountered.
- **Gate (measurable):** the consolidated inventory covers ≥1 row per state in all four modes, each with selector + input state + timing; zero shop rows; every selector referenced in the userscript appears in exactly one inventory row.
- **Deliverable:** `injection/STATES.md` updated + `STATES-KRILLO.md`, `STATES-MP-DUEL.md`, `INTERACTIONS.md`; ledger row.

---

## Phase 2 — Discover every strategy to push rank, leaderboard and score in all modes

**Goal:** I planned a ranked, evidence-backed strategy table per mode — what actually raises score/rank and what is a trap.

- **Research inputs I planned:** the game's own scoring rules (tiers 10/15/30/60/85/100), FAQ/JSON-LD, Next.js bundles for leaderboard/rank calculation, `data/` answer distribution, and online sources for Krillion strategy if the game's docs are thin.
- **Workstreams (parallel):**
   - **W2-A Scoring & answer economics:** which tiers are worth chasing; "one in a krillion" payoff; rare-but-wrong risk; AI-grading inconsistency; why play scores cannot demote. Owns NEW `injection/STRATEGY-SCORING.md`.
   - **W2-B Classic dive optimisation:** 7 prompts, 25s each; first accepted answer ends the prompt; rarest confident answer vs greedy safety; bank expansion timing; depth/rank relationship. Owns NEW `injection/STRATEGY-CLASSIC.md`.
   - **W2-C Krillocity optimisation:** rapid-fire, as many correct answers as possible per prompt; rare-first vs breadth; low-tier fallback value; fastest safe submit cadence. Owns NEW `injection/STRATEGY-KRILLO.md`.
   - **W2-D Multiplayer/duel optimisation:** room choice (populated vs fast), seat limits, score/rank mechanics, duel rating, other-player effects, leave/requeue rules. Owns NEW `injection/STRATEGY-MP-DUEL.md`.
- **Method:** I would build a score model from the game's own data; quantify each strategy's expected points/second or rank delta where possible; mark anything unverified as `hypothesis`.
- **Gate (measurable):** each mode has ≥3 concrete strategies with (a) predicted effect, (b) evidence source, (c) risk, (d) "testable in Phase 3" flag; I would not allow any strategy to rely on demoting from play or recording other players.
- **Deliverable:** four strategy docs + a one-page ranked summary `injection/STRATEGY.md`; ledger row.

---

## Phase 3 — PROVE the strategies in every mode (hard exploratory gate)

**Goal:** I planned to test each top strategy live in its mode; only strategies with measured results would advance to implementation.

- **Method:** I would run scripted live runs using the current bot (or a controlled harness) with fixed prompts where possible; record points gained, answers accepted/refused, time per prompt, rank/depth change, and failures. I would use the in-app browser; fall back to Playwright. If a mechanic is unclear, I would search the web for Krillion rules/strategy before proceeding.
- **Workstreams (parallel, disjoint test artefacts):**
   - **W3-A Classic proof runs** → `docs/evidence/classic-strategy-<n>.json`
   - **W3-B Krillocity proof runs** → `docs/evidence/krillo-strategy-<n>.json`
   - **W3-C Multiplayer/duel proof runs** → `docs/evidence/mp-strategy-<n>.json`
   - **W3-D Analyse & rank** (reads all three, owns `injection/STRATEGY-VERIFIED.md`) — converts raw runs into a keep/discard table.
- **Gate (measurable):** I would mark every candidate strategy either `PROVEN` (≥3 runs with recorded numbers, no policy violation) or `REJECTED` (reason recorded). I would not let any `UNTESTED` entry reach Phase 4. If a strategy cannot be safely live-tested, I would mark `REJECTED — untestable` with the reason and continue.
- **Deliverable:** `injection/STRATEGY-VERIFIED.md` + raw evidence files; ledger row.
- **No pause:** if the live browser is unavailable, I would use the harness + game bundles + online research to reach a defensible verdict, and record the limitation.

---

## Phase 4 — Implement all modes with the proven strategies

**Goal:** I planned for the script to support every game mode with the proven strategies wired in, without regressing existing behaviour.

- **Workstreams (parallel, isolated worktrees, disjoint file ownership):**
   - **W4-A Core engine & mode router:** `krillion-autofill.user.js` — mode registry, per-mode strategy config from `STRATEGY-VERIFIED.md`, shared state tagging. Owns the script's engine sections only.
   - **W4-B Classic implementation:** classic dive strategy, bank-capture gate, results handling. Owns classic functions only.
   - **W4-C Krillocity implementation:** burst cadence, rare→low-tier pool, prompt/input boundary logic. Owns `race*` functions only.
   - **W4-D Multiplayer/duel implementation:** room selection, fast-room timing, board/refusal handling, duel state machine. Owns MP/duel functions only.
   - **W4-E Bridge/data support:** new endpoints or fields only if a proven strategy requires them. Owns `injection/bridge.py` + `data/*.json` generation scripts.
- **Contract before fan-out:** I would set the exact function ownership table + shared invariants (16 IDs, header/credit, policy guards, bridge API, self-update version bump).
- **Integration:** I would merge all feat/* branches, resolve conflicts, and run the full suite.
- **Gate (measurable):** I would require `node --check` + `tests/run_all.py` 100% pass; every mode has at least one automated assertion that its proven strategy path is wired; no policy violation; `@version` bumped; raw URL serves the new version.
- **Deliverable:** merged script + docs; ledger row.

---

## Phase 5 — Harden: prove robustness with measurable outcomes

**Goal:** I planned to demonstrate, not assert, that the script is robust across every script state and game state, including bugs/mismatches.

- **Method:** I would enumerate the full cross-product of script states × game states from Phase 1; drive each in a stubbed harness and, where possible, live; inject controlled faults.
- **Fault classes I would test explicitly:**
   - **Miscalculation** — wrong points parsed, wrong tier mapped, wrong rank/depth math, Gaussian pick weights sum ≠ 100, low-tier fallback ordering.
   - **Missed wording** — prompt paraphrase not matching, selector drift, refusal text lingering, alias wrongly applied, bank label collision.
   - **Missed timing** — prompt appears before input mounts, fast-room expiry, 50ms observer debounce overlap, retry backoff, capture-vs-restart race, cold-load preload gap.
   - **Optimisation defects** — cache invalidation, dedupe permanently blocking a correct answer, prefetch cap, stale response applying to a newer prompt.
- **Workstreams (parallel):**
   - **W5-A State-matrix harness** → `tests/state_matrix.js` (owns new files only).
   - **W5-B Fault injection suite** → `tests/faults.test.js` + Python companion (owns new files only).
   - **W5-C Live troubleshooter** → owns a new `injection/TROUBLESHOOTING.md`; runs the script live, lists every observed script+game state, logs every mismatch with reproduction steps.
   - **W5-D Fix worker** — activated only after A–C report; owns the specific functions implicated, in one worktree.
- **Gate (measurable):** I would require the state matrix to cover 100% of Phase 1 rows; every injected fault either (a) handled correctly, or (b) fixed and re-tested with a PASS; `tests/run_all.py` still 100%; a signed-off robustness table in `injection/ROADMAP-EVIDENCE.md` with pass counts. If any FAIL remained, I would loop within Phase 5 until zero.
- **Deliverable:** robustness report + fixes; ledger row.

---

## Phase 6 — Optimise: lightweight, instant, clear UX

**Goal:** I planned the fastest possible operation with a clear, uncluttered toolset.

- **Targets I set (measurable):**
   - Prompt-visible → chips rendered: **p95 < 100 ms** (stretch < 50 ms).
   - Exact/premap path: **p95 < 25 ms**, zero HTTP.
   - Cold fuzzy path: **p95 < 150 ms** (already achieved by the matcher hoist; re-measure).
   - Bridge small lookup: **p95 < 5 ms**; `/api/all` client parse+map **< 20 ms**.
   - **0 missed prompts, 0 timeouts per 50-prompt room.**
   - Userscript file size and injected DOM node count recorded before/after; no growth >10% without justification.
- **Workstreams (parallel, disjoint):**
   - **W6-A Profiling & micro-optimisation** — owns `injection/krillion-autofill.user.js` performance sections only (cache keys, prefetch, timers, DOM batching).
   - **W6-B UX clarity audit** — owns `injection/UX.md` (new) + CSS-only refinements in a separate worktree. I would keep the reference-look faithful, AA contrast, reduced-motion, and the 16 IDs; no new controls without removing an obsolete one (I stated the clutter cap as a rule).
   - **W6-C Measurement harness** — owns `tests/perf.js` (new) that replays N prompts and reports p50/p95 against the targets above.
- **Gate (measurable):** I would require every numeric target met with a printed p50/p95 table; the UX audit lists tool count before/after and confirms no net increase; the full suite still 100%; the impeccable detector clean.
- **Deliverable:** perf report + UX notes; ledger row.

---

## Phase 7 — Report

**Goal:** I planned a final, evidence-only report to the user.

- **Contents:** I would report what was built per phase; each hard gate's measured result; all commits and push status; remaining limitations (honest); the live-verified vs harness-only distinction; the version served on GitHub; bridge health; worktree cleanup confirmation.
- **Rule I set:** I would report ONLY after Phase 6's gate passes and `HEAD == origin/main`. If any phase is blocked by a genuine external dependency, I would report that explicitly with the exact missing input.

---

## Execution order summary

```
P0 scaffold → P1 states (exclude shop) → P2 strategies → P3 PROVEN strategies
    → P4 all modes implemented → P5 robustness PROVEN (zero FAIL) → P6 perf targets MET
    → P7 report
```

Each arrow is a hard gate I set: no skipping, no pausing for decisions, web research when stuck.
