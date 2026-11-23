# Mode-fix workstream contract (frozen)

Both feature streams edit `injection/krillion-autofill.user.js` in their OWN
git worktree. Function ownership is disjoint; crossing ownership is a contract
violation. Merge is done by the coordinator.

## Shared invariants (both streams)
- Keep all 16 IDs exactly once; userscript header (credit @author berliandro,
  @homepage, @downloadURL, @updateURL, @version, @connect lines); footer GitHub
  credit link; GPU design tokens and dynamic wrapping answer-chip layout.
- Preserve policy: play scores never demote; only the game's graded bank demotes;
  never record other players' answers; near-duplicate banks stay separate;
  aliases never applied to matching.
- Preserve bridge API contract (`/api/all`, `/api/all-tier`, `/api/answers`,
  `/api/answers-tier`, all POST endpoints) and the forever-retry/stale guards.
- No new dependencies/CDN. No CSS changes (this round is behaviour-only).

## Stream A — Classic banks (branch feat/classic-banks)
GOAL: at Classic dive end the bot must save all 7 prompts' answers (expand every
row and capture the graded banks) BEFORE clicking Play again / restarting.
Owns ONLY: `captureBanks()`, `restartFromResults()`, and the
`if (roundClosed) { ... }` block inside `botTick()` (the results branch), plus
new functions whose names start with `finalize` or `classic`.
Must NOT edit: `answerCurrentPrompt()`, `resetBotRound()`, race/krillocity code,
`startMode()`, the non-results branches of `botTick()`.
Required behaviour:
- `captureBanks()` currently clicks `.kr-haul-toggle` + every
  `.kr-row-head[aria-expanded=false]`, reads `[data-me]` rows and seenBanks, and
  POSTs `/api/bank` with `state.bankSent` dedupe. It has an in-flight guard
  (`state.bankCapturing`) and awaits 120ms + 260ms then an async POST.
- The results screen (`.kr-over` / `.kr-over-next`) can appear while capture is
  still awaiting. Gate the restart on capture completion: expose a promise/flag
  (e.g. `state.bankCapturePromise`) set when the observer triggers capture, and
  only call `restartFromResults()` once it has settled AND the bank POST/queue
  is done for the current dive signature. Use a fresh-dive guard so a stale
  capture from the previous dive cannot block the next restart forever.
- If capture is impossible (no rows), do not hang — restart after a short,
  bounded wait. Log a bot-log event for the capture-then-restart decision.
- Keep `captureBanks()` idempotent (same signature = no duplicate POST).

## Stream B — Krillocity race (branch feat/krillocity-race)
GOAL: Krillocity is a rapid-fire mode: ONE prompt at a time with a short timer;
the player must type as many correct answers as possible before it expires,
then the game advances to the next prompt. The bot currently submits only one
answer every 700ms to the same prompt — wrong. It must burst-submit rare (100pt)
answers as fast as possible, then fall back to lower-point answers, then move on
when the prompt changes.
Owns ONLY: `answerCurrentPrompt()`, `resetBotRound()`, the krillocity branch of
`startMode()`, and new functions whose names start with `race`.
Must NOT edit: `botTick()`, `captureBanks()`, `restartFromResults()`, the classic
results branch, or any other mode's behaviour.
Required behaviour:
- Understand the real Krillocity DOM/flow FIRST (research subagent ok to use):
  path `/krillocity`, START DAILY, rapid input placeholder "Name as many as you
  can…", per-prompt timer, how the next prompt is detected.
- In race mode, remove the 700ms-per-answer throttle. Fill + submit immediately
  with a small, bounded gap (~40-90ms) so React sees each input; respect the
  site's own refusal/cooldown behaviour.
- Answer pool per prompt: first the rare 100pt list (`state.premap` / `groups`),
  then lower-point answers from `state.tierPremap` (Deep Cut / 85 and below),
  using `parseTierAnswers`/point groups. Never repeat the same answer for the
  same prompt; track with `submittedForPrompt` (key prompt + answer).
- Detect prompt change by text AND by input element identity (`bot.answeredInput`
  pattern) so a new prompt resets the per-prompt answer set and starts bursting.
- Stop cleanly on dive end / results; do not fight the results-screen logic owned
  by Stream A. If the bot is on and a race is active, self-schedule the next
  burst step with `setTimeout` from inside `answerCurrentPrompt`/`race*` helpers —
  do NOT modify the 500ms bot timer.

## Stream C — Tests (branch feat/mode-tests)
Owns NEW files only (no existing file): `tests/test_modes.py` and/or
`tests/mode_harness.js`. No changes to any other file. Add dependency-free
static/DOM-stub tests that assert the two contracts at source level (function
presence, no cross-owned edits, guard wiring) and, if practical, a tiny Node
harness for the race burst ordering. Must not require new packages.

## Verification (coordinator only, after merge)
`node --check injection/krillion-autofill.user.js` and
`python tests/run_all.py` must pass (8 existing tests + any new ones).
