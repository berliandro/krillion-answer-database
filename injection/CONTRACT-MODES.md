# Mode-fix workstream contract (frozen)

I had both feature streams edit `injection/krillion-autofill.user.js` in their OWN
git worktree. Function ownership was disjoint; crossing ownership was a contract
violation. I did the merge as coordinator.

## Shared invariants (both streams)
- I required them to keep all 16 IDs exactly once; userscript header (credit @author berliandro,
  @homepage, @downloadURL, @updateURL, @version, @connect lines); footer GitHub
  credit link; GPU design tokens and dynamic wrapping answer-chip layout.
- I had them preserve policy: play scores never demote; only the game's graded bank demotes;
  never record other players' answers; near-duplicate banks stay separate;
  aliases never applied to matching.
- I had them preserve the bridge API contract (`/api/all`, `/api/all-tier`, `/api/answers`,
  `/api/answers-tier`, all POST endpoints) and the forever-retry/stale guards.
- I allowed no new dependencies/CDN and no CSS changes (this round was behaviour-only).

## Stream A — Classic banks (branch feat/classic-banks)
I set the goal that at Classic dive end the bot saved all 7 prompts' answers (expanding every
row and capturing the graded banks) BEFORE clicking Play again / restarting.
I assigned Stream A ONLY: `captureBanks()`, `restartFromResults()`, and the
`if (roundClosed) { ... }` block inside `botTick()` (the results branch), plus
new functions whose names start with `finalize` or `classic`.
I barred Stream A from editing: `answerCurrentPrompt()`, `resetBotRound()`, race/krillocity code,
`startMode()`, the non-results branches of `botTick()`.
The behaviour I required:
- `captureBanks()` clicked `.kr-haul-toggle` + every
  `.kr-row-head[aria-expanded=false]`, read `[data-me]` rows and seenBanks, and
  POSTed `/api/bank` with `state.bankSent` dedupe. It had an in-flight guard
  (`state.bankCapturing`) and awaited 120ms + 260ms then an async POST.
- I found the results screen (`.kr-over` / `.kr-over-next`) could appear while capture was
  still awaiting. I gated the restart on capture completion: I exposed a promise/flag
  (e.g. `state.bankCapturePromise`) set when the observer triggered capture, and
  only called `restartFromResults()` once it had settled AND the bank POST/queue
  was done for the current dive signature. I used a fresh-dive guard so a stale
  capture from the previous dive could not block the next restart forever.
- If capture was impossible (no rows), I had it not hang — restart after a short,
  bounded wait. I logged a bot-log event for the capture-then-restart decision.
- I kept `captureBanks()` idempotent (same signature = no duplicate POST).

## Stream B — Krillocity race (branch feat/krillocity-race)
I set the goal around Krillocity as a rapid-fire mode: ONE prompt at a time with a short timer;
the player had to type as many correct answers as possible before it expired,
then the game advanced to the next prompt. The bot was submitting only one
answer every 700ms to the same prompt — wrong. I had it burst-submit rare (100pt)
answers as fast as possible, then fall back to lower-point answers, then move on
when the prompt changed.
I assigned Stream B ONLY: `answerCurrentPrompt()`, `resetBotRound()`, the krillocity branch of
`startMode()`, and new functions whose names start with `race`.
I barred Stream B from editing: `botTick()`, `captureBanks()`, `restartFromResults()`, the classic
results branch, or any other mode's behaviour.
The behaviour I required:
- I had them understand the real Krillocity DOM/flow FIRST (I allowed a research subagent):
  path `/krillocity`, START DAILY, rapid input placeholder "Name as many as you
  can…", per-prompt timer, how the next prompt is detected.
- In race mode I had them remove the 700ms-per-answer throttle. Fill + submit immediately
  with a small, bounded gap (~40-90ms) so React would see each input; I had them respect the
  site's own refusal/cooldown behaviour.
- Answer pool per prompt: first the rare 100pt list (`state.premap` / `groups`),
  then lower-point answers from `state.tierPremap` (Deep Cut / 85 and below),
  using `parseTierAnswers`/point groups. I required no repeating the same answer for the
  same prompt; I tracked it with `submittedForPrompt` (key prompt + answer).
- I had them detect prompt change by text AND by input element identity (`bot.answeredInput`
  pattern) so a new prompt reset the per-prompt answer set and started bursting.
- I had it stop cleanly on dive end / results; I kept it from fighting the results-screen logic owned
  by Stream A. If the bot was on and a race was active, I had it self-schedule the next
  burst step with `setTimeout` from inside `answerCurrentPrompt`/`race*` helpers —
  I did not modify the 500ms bot timer.

## Stream C — Tests (branch feat/mode-tests)
I assigned Stream C NEW files only (no existing file): `tests/test_modes.py` and/or
`tests/mode_harness.js`. I allowed no changes to any other file. I had them add dependency-free
static/DOM-stub tests that asserted the two contracts at source level (function
presence, no cross-owned edits, guard wiring) and, if practical, a tiny Node
harness for the race burst ordering. I required no new packages.

## Verification (I did this as coordinator, after merge)
`node --check injection/krillion-autofill.user.js` and
`python tests/run_all.py` had to pass (8 existing tests + any new ones).
