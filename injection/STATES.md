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

---

## Phase 1 — complete Classic-mode state and interaction inventory (2026-11-27)

**Evidence legend.** **[L]** = live-observed in the real game on 2026-11-23 and
recorded in the original table above. **[S]** = static-verified on 2026-11-27
from `injection/krillion-autofill.user.js` v1.1.2 (`SEL`, `gameState()`,
`inputState()`, `checkVerdict()`, `captureBanks()`, `finalizeClassicResults()`,
`botTick()`) plus the live page HTML fetched read-only from
`https://playdaily.org/krillion` on 2026-11-27. The browser MCP relay was
offline (`status`: `paired-offline`, 0 connected browsers) and no Playwright MCP
was available, so no new game was started and no account was touched. Page HTML
confirms the Classic contract: **7 prompts per dive, 25 seconds per prompt,
"Begin descent", press Dive to submit, refusal keeps the prompt open, and six
tiers** (Plankton 10 / Too Clever 15 / Schooler 30 / Rare 60 / Deep Cut 85 /
One in a Krillion 100). Timing marked [S] is derived from the script's own
timers or the site's published rules, not from a new stopwatch run.

Input-state tuples below use the exact shape returned by `inputState()`:
`present`, `visible`, `disabled`, `readOnly`, `placeholder`. For states with no
input, `present=false, visible=false, disabled=null, readOnly=null,
placeholder=''` (the code's early return).

| # | `game_state` / interaction | Detect (selector + visibility) | Input state | Timing window | What the script does | Log? (rationale) |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | `loading-shell` (slow-loading shell) [L][S] | Article heading + ad iframes painted, but `isVisible('.kr-intro')`, `visible('p.kr-prompt')` and `visible('.kr-arena-main')` are all false; live HTML shows a bare "Loading" label before React mounts | none — `present=false`, `visible=false`, `disabled=null`, `readOnly=null`, `placeholder=''` | static (from `@run-at document-start` until React mount; no fixed ms; MO debounce 50 ms) | `gameState()` returns this only as the last fallback; `mount()` appends the panel on DOMContentLoaded, starts `preloadAnswers()` and waits on a `MutationObserver` (childList/subtree/characterData) rather than acting | **No** — transient mount/settle frame with no answer, verdict or decision-grade signal (rule 3) |
| C2 | `intro` — dive start [L][S] | `.kr-intro` visible OR `button.kr-begin` visible; `button.kr-mode` Classic/Endless; `button.kr-online` "Play multiplayer"/"Play 1 vs 1"; `a.kr-peek` Krillocity link | none — `present=false`, `visible=false`, `disabled=null`, `readOnly=null`, `placeholder=''` | static until Begin descent is clicked | `startMode()` selects `button.kr-mode` matching `/classic/i` when not already selected, then clicks visible `button.kr-begin`; `setBot()` emits one `bot-start` and starts `setInterval(botTick, 500)` only when Play for me is switched on | **Decision only** — `bot-start` / `mode-change`; no prompt or answer data exists yet (rule 3) |
| C3 | intro → first-prompt countdown [S] | `button.kr-begin` has been clicked/removed; `.kr-intro` still in the DOM but `offsetParent === null`; `p.kr-prompt` and `input.kr-input` not yet visible | none — `present=false`, `visible=false`, `disabled=null`, `readOnly=null`, `placeholder=''` | 25,000 ms per Classic prompt starts when the prompt is dealt; bot re-checks every 500 ms | `promptText()` deliberately returns `''` while `.kr-intro` is visible, so neither the bot nor `loadAnswers()` acts; `botTick()` falls through to `botStatus('waiting')`. Note `gameState()` has no dedicated countdown tag — this frame classifies as `loading-shell` until a prompt mounts | **No** — no graded answer or bot decision; the observer is armed and silent (rule 3) |
| C4 | `prompt-reveal` [L][S] | `p.kr-prompt` visible (`isVisible(SEL.prompt)`) but `input.kr-input` absent or not visible (`visible(SEL.input)` false) — `gameState()` uses exactly this split | `present=false`, `visible=false`, `disabled=null`, `readOnly=null`, `placeholder=''` | ~2,900 ms prompt→input measured in the 5s/6s fast rooms [L]; Classic clock is 25,000 ms from reveal; observer 50 ms, bot 500 ms | Observer sees a new prompt text → `loadAnswers(q)` (premap → netCache → `/api/answers`, prefetched from `/deal`); `applyResult()` may emit `reportPrompt('no-match')` / `'ambiguous'`. `answerCurrentPrompt()` requires a visible input and does nothing here | **Prompt-level only** — no-match/ambiguous review is decision-grade; **no** score/evidence event because no answer exists yet |
| C5 | `answering` — input enabled [L][S] | `p.kr-prompt` + `input.kr-input` visible; `input.disabled=false`, `input.readOnly=false`, placeholder "Type one answer…"; `form.kr-bar` and `button.kr-send` present/enabled | `present=true`, `visible=true`, `disabled=false`, `readOnly=false`, `placeholder="Type one answer…"` (Krillocity uses "Name as many as you can…") | 25,000 ms Classic per prompt [S: site rules]; fill→submit `setTimeout(submitAnswer, 120)` (220 ms for Dive on click); bot poll 500 ms; MO debounce 50 ms | `answerCurrentPrompt()` picks a rare answer, sets the value through the native `HTMLInputElement.value` setter and fires `input` + `change`; `submitAnswer()` uses `form.requestSubmit()`, then a synthetic Enter on `input.kr-input`, then `button.kr-send.click()` as mutually exclusive fallbacks | **Yes — on submit** — `evidence` with `ctx()` (`game_state`, `input_state`, `mode`), points/outcome at verdict; this is the only answerable state |
| C6 | input present but disabled/read-only (lock frame) [S] | `document.querySelector('input.kr-input')` exists with `.disabled === true` or `.readOnly === true`, or is mounted but not yet visible; `inputState()` reports it while `gameState()` may still say `answering` because it only calls `visible(SEL.input)` | `present=true`, `visible=true|false`, `disabled=true` and/or `readOnly=true`, `placeholder` as mounted | static while the control is locked; sampled at the instant of any log event | No Classic instance was observed with `disabled=true`; the script **records** both flags in `inputState()` but **does not gate** filling/submitting on them — `botTick()` and `answerCurrentPrompt()` gate only on `visible(SEL.input)` and `bot.roundClosed`. See dated correction 2026-11-27 (a) | **No standalone log** — but `input_state` travels with every evidence/prompt/bot event, so a disabled frame is auditable if one ever produces an event |
| C7 | accepted answer / submission [S] | Native `form.kr-bar` submit fired (or Enter / `button.kr-send` fallback); prompt text unchanged; no `.kr-refusal` line; input cleared and re-enabled, awaiting `.kr-reveal[role="status"]` | `present=true`, `visible=true`, `disabled=false`, `readOnly=false`, `placeholder="Type one answer…"`, `value=''` | 120 ms after fill (220 ms Dive on click); verdict normally follows within the same 25,000 ms prompt window | `submitAnswer()` submits once through the React-visible form; `state.lastFilled` is retained until `checkVerdict()` consumes it; `bot.answeredPrompt` / `bot.answeredInput` prevent double submit; `refusedAnswers` blocks re-picking a refused answer | **Deferred** — no score exists at submit time; the outcome is logged at C9/C10 as `ok` or `below-100` |
| C8 | `refusal` — refused answer [L][S] | `.kr-refusal` line, e.g. `"Ice cubes" was not accepted`; `p.kr-prompt` stays; input cleared but re-enabled for a retry | `present=true`, `visible=true`, `disabled=false`, `readOnly=false`, `placeholder="Type one answer…"`, `value=''` | inside the same 25,000 ms window, until accepted or clock expiry; refusal text **lingers into later rounds**, so the tag uses `state.refusalActive`, cleared on the next `fill()` / `answerCurrentPrompt()` | `checkRefusal()` keys on prompt + answer + line, emits `reportPrompt('refused')` and an `evidence` POST with `outcome: 'refused'`, clears `lastFilled` and `bot.answeredPrompt`, and marks the answer in `refusedAnswers` | **Yes** — an answer outcome and a bot decision. Never a demotion: a refusal or low score is evidence only; only the dive-end graded bank may change a tier (DECISIONS.md #1) |
| C9 | per-prompt verdict — solo/classic reveal [L][S] | `.kr-reveal[role="status"]` visible; `.kr-reveal-points b` contains "+N PTS"; `.kr-reveal-tier` holds the tier label; `button.kr-next` visible. `.kr-reveal[role="status"]` is also the `roundClosed` gate in `botTick()` | cleared — `present=false|true`, `visible=false`, `disabled=null|false`, `readOnly=null|false`, `placeholder=''` | evaluated on each 50 ms-debounced observer tick; Next auto-click at `setTimeout(..., 180)` when autoEnter/bot is on | `checkVerdict()` parses `+(\d+)\s*PTS`, reads `.kr-reveal-tier`, calls `reportScore()` (deduped by question+answer+points), clears `lastFilled`, calls `resetBotRound(true)`, and clicks `button.kr-next` once per `advanceKey` | **Yes** — authoritative per-answer score; a `<100` score also emits `reportPrompt('low-score')`. Only the solo reveal may be read as OUR score |
| C10 | verdict fallback — classic `.kr-board-head` [L][S] | `mode() === 'classic'` (no `.kr-arena-main` / `.kr-board-rows` / `.kr-over-multi` / `.kr-duel-board`, not `/krillocity`) AND `.kr-board-head` visible, used only when the solo reveal is absent | cleared — `present=false`, `visible=false`, `disabled=null`, `readOnly=null`, `placeholder=''` | same 50 ms observer tick as C9; no separate timer | `checkVerdict()` explicitly gates the board read on `mode() === 'classic'` and parses `+(\d+)\s*$` from the head text; in multiplayer/1v1 the board is never read (DECISIONS.md #7) | **Yes, classic only** — it is still the site's own score for our answer; in other modes the same DOM is other players and is never logged (rule 1) |
| C11 | `Next` [L][S] | `button.kr-next` visible after the verdict; clicking mounts the next `p.kr-prompt` and a fresh `input.kr-input` element | cleared at verdict, then re-mounted enabled for the next prompt: `present=true`, `visible=true`, `disabled=false`, `readOnly=false`, `placeholder="Type one answer…"` | auto-click 180 ms after the verdict; player-driven otherwise; starts the next 25,000 ms prompt | `checkVerdict()` clicks `button.kr-next` once per `advanceKey`; `botTick()` treats a changed prompt text **or a remounted input element** as the round boundary and calls `resetBotRound(false)` | **No standalone log** — the following prompt gets prompt-level review (C4) and its answer gets evidence (C5–C9) |
| C12 | all 7 Classic prompts (dive progress) [S] | Repeated `p.kr-prompt` + `input.kr-input` cycle, 7 times; after prompt 7's verdict, `.kr-over` / `.kr-over-next` appears. `bot.lastPrompt`, `bot.answeredInput`, `bot.answeredPrompt` and `bot.roundClosed` track each round | enabled at each of the 7 prompts, cleared at each verdict — same tuple as C5/C9 | 7 × 25,000 ms; perfect dive = 700 points = 7,000 m [S: live page HTML] | `resetBotRound()` clears per-round dedupe on prompt change, input remount or verdict/results transition; each prompt runs C4→C5→C9→C11; the 7th verdict leads into C13 | **Yes, per prompt** — one evidence event per accepted answer plus prompt reviews for ambiguous/no-match; no aggregate "dive score" is scraped |
| C13 | `results` — dive end [L][S] | `.kr-over` OR `.kr-over-multi` OR `.kr-row` visible; combined gate `visible('.kr-over, .kr-over-next, .kr-board-head, .kr-board-rows, .kr-row')` closes the round in `botTick()`; Classic path uses `.kr-row` | none — `present=false`, `visible=false`, `disabled=null`, `readOnly=null`, `placeholder=''` | static until Play again; capture gate bounded by `CLASSIC_CAPTURE_TIMEOUT_MS = 2200` ms | Observer sees `button.kr-haul-toggle` or `.kr-row` → `captureBanks()` (50 ms debounce + in-flight guard); `botTick()` calls `finalizeClassicResults()` for Classic | **Bank import only** — `source: 'own'` (only `[data-me]` DOM lines) plus `source: 'api'` graded banks; never other-user DOM rows (rule 1) |
| C14 | `haul toggle` (reveal answers) [S] | `button.kr-haul-toggle` visible; `aria-expanded="false"` means the answer section is still hidden | none — `present=false`, `visible=false`, `disabled=null`, `readOnly=null`, `placeholder=''` | static on the results screen; click followed by `await 120 ms` settle before row heads are clicked | `captureBanks()` clicks the haul toggle only when `aria-expanded === 'false'`; no other code touches it | **No standalone log** — it is a UI prerequisite for C15/C16; no answer data is created by the click itself |
| C15 | row expansion [S] | Inside each `.kr-row`, `.kr-row-head[aria-expanded="false"]` (code also queries plain `.kr-row-head`); `.kr-row-prompt` supplies the question text used by `classicBankSignature()` | none — `present=false`, `visible=false`, `disabled=null`, `readOnly=null`, `placeholder=''` | 120 ms after haul click, then `await 260 ms` after head clicks; `finalizeClassicResults()` re-clicks only after capture settles, hard cap 2,200 ms | `captureBanks()` clicks each collapsed `SEL.rowHead`; `classicExpandRows()` re-clicks unexpanded heads, deduped by a per-dive `WeakSet` so a React-lag double toggle cannot re-collapse a row | **No standalone log** — expansion is a capture prerequisite; the resulting bank rows are logged at C16 |
| C16 | bank tiers / graded lines [L][S] | `.kr-line` elements inside `.kr-row`; only `line.hasAttribute('data-me')` is read; `.kr-line-answer`, `.kr-line-tier`, `.kr-line-pts` supply answer, tier text and points; API rows arrive from `/api/krillion/answers` (`tierIndex === 5` → 100 points) | none — `present=false`, `visible=false`, `disabled=null`, `readOnly=null`, `placeholder=''` | static at dive end; a single POST `/api/bank` per dive signature, queued if the bridge is offline; DOM shows ~10 answers/tier, API supplies the full tiers | `captureBanks()` builds `{question, answer, tier, points, source:'own'}` for our lines and `{source:'api'}` for site responses; unparseable points stay `null` (never 0) so a selector drift cannot demote a correct answer | **Yes — bank import** (own + site API only). Tiers: Plankton 10 / Too Clever 15 / Schooler 30 / Rare 60 / Deep Cut 85 / One in a Krillion 100. Never demote from play (DECISIONS.md #1) |
| C17 | classic capture/restart gate (per-dive signature) [S] | `classicRows()` → `classicBankSignature(rows)` = `rows.length + ':' + rowPrompt texts joined by '\|'`; a changed signature starts a fresh `state.classicFinalize` gate | none — `present=false`, `visible=false`, `disabled=null`, `readOnly=null`, `placeholder=''` | `kickoff` on first tick; `120 ms` haul + `260 ms` expansion waits; ready when capture settled AND heads expanded, or hard timeout 2,200 ms; no rows → 400 ms | `finalizeClassicResults()` ensures a capture is in flight, waits for `bankCaptureSettled` and `bankCaptureSignature === signature`, verifies every visible `.kr-row-head` is `aria-expanded="true"`, then reports and restarts | **One decision log per dive** — `reportBot('classic-bank-capture', {rows, answers, gated, all_expanded, timed_out})`; no answer data, and it fires before restart so no bank is lost |
| C18 | `Play again` / restart [S] | `.kr-over-next` visible, or any visible `button` whose text matches `/play again\|dive again\|restart\|next\|continue/i` | none — `present=false`, `visible=false`, `disabled=null`, `readOnly=null`, `placeholder=''` | only after C17 is ready (≤2,200 ms, or 400 ms with no rows); `bot.lastAction` dedupes repeated clicks | `restartFromResults()` clicks the matched button once per action; Classic calls it only through `finalizeClassicResults()`, other modes call it directly from `botTick()` | **No answer log** — the restart is a bot decision already covered by the single `classic-bank-capture` event; starting the next dive returns to C2/C3 |
| C19 | mode guards (non-Classic selectors that keep the Classic path honest) [S] | `mode()` checks `.kr-stage-multi`, `.kr-arena-main`, `.kr-board-rows`, `.kr-over-multi` (multiplayer), `.kr-duel-board` or `/duel/` hash (1v1), `/krillocity` path; `gameState()` also checks the combined `visible('.kr-duel-board, .kd-play, .kd-versus, .kd-tab-rule, .kd-result-keys')`, `visible('.kr-guess-range, .kr-make-go')`, `visible('.kr-lobby-tab, .kr-room-row')` and `visible('.kr-stage-multi, .kr-wait, .kr-board-head')` before falling through to Classic | none — `present=false`, `visible=false`, `disabled=null`, `readOnly=null`, `placeholder=''` | static; evaluated on every `ctx()` / `botTick()` (500 ms) | These selectors are **negative signals** for Classic: when any is visible the script uses the existing lobby/create-room/arena-wait/duel/results rows instead. They are listed here so every Phase 0 registry selector is accounted for, not to add new Classic states | **Per existing rows** — lobby/duel decision logs only; no Classic answer data is ever read from these nodes |

### Phase 0 registry selector coverage (v1.1.2, 38 selectors)

All 38 registry selectors are present in this file. Classic-path selectors are
mapped to the rows above; the remaining ones are represented by the original
non-Classic rows (3, 4, 5, 9b, 11) and by the mode-guard row C19:

- Dive start / prompt / input / submit / verdict: `button.kr-begin`, `p.kr-prompt`, `input.kr-input`, `form.kr-bar`, `button.kr-send`, `button.kr-next`, `.kr-reveal[role="status"]`, `.kr-reveal-points b`, `.kr-reveal-tier` → C2, C3, C4, C5, C7, C9, C11.
- Dive end / haul / rows / tiers: `.kr-over`, `.kr-over-next`, `.kr-row`, `.kr-row-head[aria-expanded="false"]`, `.kr-row-prompt`, `.kr-line`, `.kr-line-answer`, `.kr-line-tier`, `.kr-line-pts`, `button.kr-haul-toggle`, `.kr-over, .kr-over-next, .kr-board-head, .kr-board-rows, .kr-row` → C13–C17.
- Classic fallback + non-Classic mode guards: `.kr-board-head`, `.kr-arena-main`, `.kr-board-rows`, `.kr-stage-multi`, `.kr-stage-multi, .kr-wait, .kr-board-head`, `.kr-wait`, `.kr-over-multi` → C10, C19 and rows 5, 9b.
- Lobby / room setup (non-Classic): `.kr-intro`, `.kr-lobby-tab`, `.kr-room-row`, `.kr-lobby-tab, .kr-room-row`, `.kr-guess-range, .kr-make-go` → C2, C19 and rows 3–4.
- Duel (non-Classic): `.kd-elsewhere`, `.kd-play`, `.kd-result-keys`, `.kd-tab-rule`, `.kd-versus`, `.kr-duel-board`, `.kr-duel-board, .kd-play, .kd-versus, .kd-tab-rule, .kd-result-keys` → C19 and row 11.

**Shop — excluded (out of scope).** The intro contains a Shop / depth-token link
on the live page; it is not a game state, has no answer or scoring interaction,
and is deliberately not catalogued, selected, logged or automated.

### Dated corrections to the original table (2026-11-27)

- (a) Row 7 `answering` describes the input as always enabled. Correction:
  `inputState()` snapshots `disabled` / `readOnly`, but `gameState()` and
  `botTick()` gate only on `visible(SEL.input)`; a present-but-disabled input is
  not a separate state in the classifier (see C6). The placeholder distinction
  ("Type one answer…" vs Krillocity's "Name as many as you can…") remains
  accurate.
- (b) Row 9 `verdict` omitted `.kr-reveal[role="status"]`, which is the
  `roundClosed` gate in `botTick()` and a registry selector; added in C9.
- (c) Row 10 `results` omitted the `button.kr-haul-toggle` prerequisite, the
  `.kr-row-prompt` signature, the `.kr-line` / `.kr-line-answer` /
  `.kr-line-tier` / `.kr-line-pts` capture selectors, the API `tierIndex === 5`
  → 100 rule, and the 120 ms / 260 ms / 2,200 ms / 400 ms gate timings; added
  in C13–C17.
- (d) Row 11 listed the duel click keys `.kd-tab-rule-key` and
  `.kd-elsewhere-key`. Both still exist in `duelClick()`, but `duelTick()` tests
  the registry selectors `.kd-tab-rule` and `.kd-elsewhere` for visibility;
  C19 now carries the exact combined visibility selector.
- (e) The original table had no separate countdown, Next, seven-prompt,
  haul-toggle, row-expansion, tier or Play-again rows; those are C3, C11, C12,
  C14, C15, C16 and C18. No previously accurate row was removed or rewritten.
