# Krillion state inventory — what to log and what not to log

Live-mapped on 2026-11-23 on `playdaily.org/krillion` (Chrome, in-app browser).
Every row below was observed in the real game, not inferred from a bundle. The
fast-room finding is from actually entering a custom **6-second / 50-prompt
Marathon** room and playing several rounds (not just reading the lobby).

This document is the authority for the `game_state` tag now attached to every
archive event (`evidence.jsonl`, `prompt_review.jsonl`, `bot_log.jsonl`). The
classifier lives in `gameState()` / `inputState()` in
`krillion-autofill.user.js`.

## Rules that govern every decision

1. **Never record another player's answer or score.** In multiplayer/1v1 the
   site AI-grades arbitrary answers inconsistently, and the shared board shows
   everyone. Only OUR rows (`[data-me]`) and the site's own graded bank (API)
   are trustworthy.
2. **Never demote from play.** A low play score is evidence only; only the
   game's own dive-end graded bank may change the rare tier (DECISIONS.md #1).
3. **Log the situation, not the noise.** A log must carry a decision-grade
   signal (an answer outcome, an uncertain prompt, a bot decision). Transient
   load/settle frames and idle screens are not logged.

## The states

| # | `game_state` | How to detect it (DOM) | Input state | Log? | What / why |
| --- | --- | --- | --- | --- | --- |
| 1 | `loading-shell` | Article heading + ad iframes painted, but no `.kr-intro`, no `.kr-prompt`, no `.kr-arena` | none | **No** | Cold/slow load. `readyState=complete` while the React game is not mounted yet — a real state I saw on first navigation. Nothing to log; script waits for the observer. |
| 2 | `intro` | `.kr-intro` visible; `.kr-begin` "Begin descent"; `.kr-mode` Classic/Endless; `.kr-online` "Play multiplayer / Play 1 vs 1"; Krillocity link | none | **No** | Home screen. No prompt. Bot may emit `mode-change` / `bot-start` decision logs only. |
| 3 | `lobby` | `.kr-lobby-tab` (Rooms/Leaderboard), `.kr-room-row` list, `.kr-lobby-back` | none | **Decision only** | Room picker. Bot emits one `room-select` per distinct room signature; no answer data. |
| 4 | `create-room` | `.kr-guess-range` slider (min 5, max 60, step 1), `.kr-size` (5/7/10/15/25/50 prompts), `.kr-who-key`, `.kr-make-go` | only the range slider | **No** | Manual setup. Not play evidence. (This is where the 6s room was made.) |
| 5 | `arena-wait` | `.kr-stage-multi`, `.kr-wait`, `.kr-board-head` "No catch this time." / "X went deepest: SCHOOLER (+30)", `.kr-board-row`, `.kr-chat-sys`, depth `.kr-pill-value`, Leave | none | **No** | Between rounds (multiplayer/1v1). The board head and rows here show OTHER players — never logged, never read as our score. This is the multi-second settle frame between prompts in fast rooms. Note: `checkVerdict()` reads `.kr-board-head` only in classic mode (as a fallback when the solo reveal is absent); in multiplayer it is never read (DECISIONS.md #7). |
| 6 | `prompt-reveal` | `p.kr-prompt` visible, but `input.kr-input` not mounted yet | none | **Prompt-level only** | In the fast rooms the prompt appears ~2.9s BEFORE the input (live-measured in the 5s room). `loadAnswers()` runs here: `no-match` / `ambiguous` prompt-review is fine; NO score/evidence log — no answer exists yet. |
| 7 | `answering` | `.kr-prompt` + `input.kr-input` visible, `disabled=false`, `readOnly=false`, placeholder "Type one answer…" (classic/multi) / "Name as many as you can…" (Krillocity); `.kr-send` enabled | enabled, empty or typed | **Yes — on submit** | The one answerable state. Evidence is logged here with `game_state` + `input_state` + points/outcome. |
| 8 | `refusal` | `.kr-refusal` text, e.g. `"Ice cubes" was not accepted`; prompt stays, input cleared but re-enabled | enabled (retry allowed) | **Yes** | Log `prompt-review:refused` + `evidence:refused`, no demotion. NOTE: refusal text LINGERS into the next round, so the state tag uses the `refusalActive` flag, not the stale selector. |
| 9 | `verdict` (solo/classic) | `.kr-reveal-points b` "+N PTS", `.kr-reveal-tier`, `button.kr-next` | cleared | **Yes** | Authoritative per-answer score → `evidence`. Only the SOLO reveal may be read as our score. |
| 9b | `verdict` (multiplayer/1v1) | OTHER players' points appear in `.kr-chat-sys` / `.kr-board-head` / board rows; our own per-answer score is NOT shown there (unlike classic's `.kr-reveal-points b`) | cleared | **Outcome only** | `.kr-board-head` is parsed ONLY in classic mode; in multiplayer/1v1 `checkVerdict()` never reads it. The authoritative classic per-answer score is the solo reveal `.kr-reveal-points b`, with `.kr-board-head` used only as a classic-mode fallback. In multiplayer only our own refusal/submit outcomes are logged — no board-scraped score (DECISIONS.md #7). |
| 10 | `results` | `.kr-over` / `.kr-over-multi` / `.kr-over-next`, `.kr-row`, `.kr-row-head[aria-expanded=false]`, `.kr-haul-toggle` | none | **Bank import** | Dive end. `captureBanks()` expands rows and imports only `[data-me]` own rows plus API banks (`source: own` / `source: api`). Never other-user DOM rows. |
| 11 | `duel` | `.kd-play` (queue), `.kd-versus` (match found), `.kd-tab-rule-key`, `.kd-elsewhere-key`, `.kd-result-keys`, `.kd-again`, `.kr-duel-board` | none | **Decision only** | Bot decision logs (queue/rule/requeue); never click Leave/Back; never record the opponent. |
| 12 | `krillocity` | path `/krillocity`, START DAILY `.kr-begin`, rapid-fire input "Name as many as you can…" | enabled (rapid) | **Yes — per answer** | Rapid race. Evidence per submitted answer, deduped by prompt+answer (`submittedForPrompt`). |

## The six-second / 50-prompt Marathon (played live)

- **There is no preset 6-second room.** The presets are 5s, 15s, 30s
  ("The Marathon · 5 sec" = 50 prompts, 5s each). A 6s room is created through
  the slider (`input.kr-guess-range`, min 5 / max 60 / step 1) → the button
  becomes "Enter The Marathon · 6 sec".
- In that room the HUD shows **"Prompt 24 of 50"**, a player count, difficulty
  ("Hard"), a depth readout, and **Pass / Dive** controls alongside the answer
  input. Prompts rotate on the room timer whether or not you answer.
- Timing is the dominant factor. In the fastest room the prompt is on screen
  ~2.9s before the input mounts; refusals clear the box but leave it enabled,
  so a retry is possible until the timer expires. The bot already gates on
  `visible(SEL.input)` and on `lastFilled`, so it neither answers a
  not-yet-answerable prompt nor double-submits a refused one.
- **Net logging rule for this mode:** log OUR submission outcomes and refusals
  (with the state tag), but log NOTHING from `.kr-board-row`, `.kr-board-head`
  or `.kr-chat-sys` — those are the other players whose answers the policy
  forbids recording. Bank import is impossible here (no dive-end rows), so
  only single-answer outcomes flow to the archive.

## What changed in the code

- `gameState()` / `inputState()` classify every state above; `ctx()` attaches
  both to all evidence, prompt-review, miss and bot-log events.
- `checkVerdict()` reads the shared board head **only in classic mode**; in
  multiplayer/1v1 no other player's points can be mistaken for ours.
- `state.refusalActive` flag keeps the `refusal` tag accurate despite the
  site's lingering refusal text.
- `bridge.py` persists `game_state` and `input_state` in the three log files.
