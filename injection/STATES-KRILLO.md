# Krillocity state inventory — Phase 1 / W1-B (daily race)

I scoped this to **every on-screen state and script interaction from the `/krillion` landing
page through the `/krillocity` daily race to completion.** I wrote it as a companion to
`STATES.md` (the authority for the `game_state` / `input_state` tags attached to every
archive event). I made this file evidence-only: no code, no policy change.

## Method and evidence labels

- **Source: live** = text fetched from the game itself on 2026-11-27
  (`webfetch https://playdaily.org/krillocity` and `https://playdaily.org/krillion`),
  specifically the on-page "How to play", FAQ and "How a race in Krillocity runs"
  copy. That copy is the game's own description of its screens and clocks.
- **Source: code/live notes** = `injection/krillion-autofill.user.js` (v1.1.2)
  plus the live-mapped `injection/STATES.md` (2026-11-23) and
  `injection/CONTRACT-MODES.md`.

**I could not do live interactive play in this workstream:** the `browse`
browser was offline (`connected:false`, `pairingState:paired-offline`) and no
in-app `browser` tool was exposed to me. I made no row claim a
live *DOM* observation; I labelled DOM selectors and script actions
`code/live notes`, while game rules, clocks and screen names were labelled
`live` (site copy). I kept this distinction deliberately, per row.

I **excluded Shop** — see the Exclusions section at the end. I recorded no shop
catalogue rows in the tables below.

## How to read the table

I read `game_state` as the classifier in `gameState()` (script lines 1075–1088);
`input_state` as the snapshot from `inputState()` (lines 1092–1102). Visibility
meant `offsetParent !== null || getClientRects().length > 0` (`visible()` /
`isVisible()`, lines 1046–1049 and 1522–1525). Logged events carried `mode` from
`mode()` (lines 1059–1069), which returned `krillocity` purely from the path
`/^\/krillocity\/?$/` — no DOM guess.

The Timing constants I used below were all from the script unless marked live:
observer debounce **50 ms** (line 85), bot tick **500 ms** (line 1513), race
fill→submit **50 ms** / submit→next **90 ms** (lines 1753–1754), answers-loading
retry **80 ms** (line 1742), pool-drained retry **150 ms** (line 1750), lookup
timeout **2500 ms** (line 216), retry gaps **400 ms** then **1 s→30 s capped**
(lines 157, 176–177). Live clocks: **~2 s count-in**, **30 s per prompt**,
**7 prompts**, **1 daily attempt, resets 00:00 UTC**.

## State / interaction inventory

| # | State or interaction | Detection (selector + visibility) | Input state | Timing (ms) | Script action | Log? + rationale | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| K-01 | `loading-shell` on `/krillocity` (cold / slow load) | Article shell + site "Loading" text painted; no visible `.kr-intro`, no visible `p.kr-prompt`, no `input.kr-input`, no `.kr-begin` | none (no input element) | Indeterminate until React mounts; observer coalesces mutations with **50 ms** debounce; `readyState=complete` alone does not mean mounted | `mount()` waits for `DOMContentLoaded`, appends panel, arms `MutationObserver`, starts `preloadAnswers()`; nothing is clicked | **No** — transient load/settle frame, no decision-grade signal (STATES.md rule 3) | code/live notes (STATES.md row 1 + script 2073–2098); live site copy shows the "Loading" shell |
| K-02 | `intro` / landing on `/krillocity` | `.kr-intro` visible; `button.kr-begin` visible ("Start daily"/START DAILY); a "Play multiplayer" control and the daily-race explainer; `p.kr-prompt` absent | none | Stable screen; `botTick` polls every **500 ms** | `gameState()`→`intro`; `botTick` calls `startMode()`; `mode()` already returns `krillocity` from the path | **Decision only** — `mode-change` / `bot-start` in `bot_log.jsonl`; no answer data exists | live (site copy: "Press Start daily for today's solo race, or press Play multiplayer") + code/live notes (STATES.md row 2) |
| K-03 | Transition `/krillion` → `/krillocity` via "Play Krillocity" | On `/krillion`: `a.kr-peek` visible ("Play Krillocity"); once navigated, path matches `/^\/krillocity\/?$/` and `mode()` flips to `krillocity` | none | Full page navigation; new document remounts panel and re-runs `preloadAnswers()` (lookup timeout **2500 ms**, retries 400 ms then backoff) | `startMode()` krillocity branch: if not on path, click `a.kr-peek` and `botStatus('opening Krillocity')` | **Decision only** — one `reportBot('krillocity-open', {note:'Play Krillocity'})` (script 1916–1924) | live (site copy on `/krillion`: "Psst… Switch it up? Play Krillocity") + code/live notes |
| K-04 | START DAILY (begin the solo daily race) | On `/krillocity`: `button.kr-begin` present and `offsetParent !== null`; `.kr-intro` still visible | none | **~0 ms** one-shot click, race state cleared on the same tick; next `botTick` poll **500 ms** | `reportBot('krillocity-start', {note:'START DAILY'})`, `begin.click()`, `raceCancel()`, `resetBotRound(false)`, fresh `bot.raceSubmitted = new Set()`, `botStatus('starting daily race')` (script 1926–1934) | **Decision only** — `bot_log.jsonl` `krillocity-start`; no answers yet | live (site copy: "Press Start daily to race alone against the clock") + code/live notes (STATES.md row 12) |
| K-05 | `prompt-reveal` / count-in (prompt before input mounts) | `p.kr-prompt` visible; `input.kr-input` **not** mounted/visible yet; `.kr-begin` gone | none (input pending) | **~2000 ms** count-in before the clock starts (live); in fast rooms prompt precedes input by ~**2900 ms** (live notes); observer debounce **50 ms** | Observer debounce → `loadAnswers(q)`; `answerCurrentPrompt()`/`raceBurst()` see no input → `raceCancel()` and return false; bot waits | **Prompt-level only** — `no-match` / `ambiguous` prompt-review is allowed; **no score/evidence log** because no answer exists yet | live (site copy: "The prompt comes up for two seconds before its clock starts") + code/live notes (STATES.md row 6) |
| K-06 | `answering` — rapid input ("Name as many as you can…") | `p.kr-prompt` + visible `input.kr-input` (`disabled=false`, `readOnly=false`, placeholder "Name as many as you can…"); `form.kr-bar` and `button.kr-send` present/enabled | **enabled**, emptied after each submit; multiple distinct answers per prompt | **30 000 ms** per-prompt clock (live); fill→submit **50 ms**, submit→next **90 ms**; `botTick` fallback **500 ms** | `raceBurst()` fills via native `value` setter + `input`/`change` events; schedules `submitAnswer()` (prefers `form.requestSubmit()`, falls back to Enter, then `button.kr-send`) after 50 ms; self-schedules next step with `raceSchedule(90)` | **Yes — per answer** — evidence with `game_state`+`input_state`+`mode`; nothing from other racers (STATES.md rows 7, 12) | live (site copy: "30-second clock… Type an answer, press Enter and type the next one straight away"; "The same answer only counts once") + code/live notes |
| K-07 | Answer accepted | Input cleared and re-enabled with no `.kr-refusal` text; krill distance increases (site); optional `p`/`.kr-reveal[role="status"]`, `.kr-reveal-points b` "+N PTS", `.kr-reveal-tier`, `button.kr-next` if a solo reveal is rendered | enabled (cleared, ready for next answer) | Immediate on submit (≤**50 ms** to submit; reveal observed on the **50 ms** observer tick) | `raceBurst()` loops to the next pool answer; `checkVerdict()` reads solo `.kr-reveal-points b` (never the shared board in krillocity) and clears per-answer state | **Yes** — authoritative per-answer score → `evidence`; low score → prompt-review, never a demotion | live (site copy: "Every accepted answer swims your krill forward"; tiers 10/15/30/60/85/100 = 100–1000 m) + code/live notes (STATES.md rows 7, 9) |
| K-08 | Answer refused | `.kr-refusal` text, e.g. `"Ice cubes" was not accepted`; `p.kr-prompt` stays, input cleared but re-enabled | **enabled (retry allowed)** | **~0 ms** detection on the **50 ms** observer tick; refusal text **lingers into the next round**, so tag uses `state.refusalActive`, not the stale selector | `checkRefusal()` sets `refusalActive`, adds `prompt\0answer` to `refusedAnswers`, logs; `raceNextAnswer()` skips that key; fill clears `refusalActive` | **Yes** — `prompt-review:refused` + `evidence:refused`; **no demotion**; costs only typing time | live (site copy: "a refused answer costs only the time it took to type") + code/live notes (STATES.md row 8) |
| K-09 | Prompt advance (timer-driven, mid-race) | `p.kr-prompt` **text change** OR a freshly mounted `input.kr-input` element (identity change); clock resets; same-prompt repeats possible | enabled on the new prompt | Live clock **30 000 ms**; "a moment later the judge krill brings the next prompt down over the last" (site); script boundary detected immediately, `botTick` fallback **500 ms** | `botTick` detects text/input change → `resetBotRound(false)`; `raceBurst()` compares `prompt !== bot.racePrompt` or `input !== bot.raceInput` → `raceCancel()`, resets pool/indices; only a **text change** clears the no-repeat sets | **Prompt-level only** — `loadAnswers()` on the new text; no per-answer log at the boundary | live (site copy: "Between prompts… the next prompt… over the last") + code/live notes (script 1721–1735, 1987–2000) |
| K-10 | Race end / results (FINISH) | `.kr-over` / `.kr-over-next` visible; `.kr-row`, `.kr-row-head[aria-expanded="false"]`, `.kr-row-prompt`, `.kr-line`, `.kr-line-answer`, `.kr-line-tier`, `.kr-line-pts`; `.kr-board-head` / `.kr-board-rows` may appear; site shows "FINISH" and the report | cleared / none | After the **7th** 30 s prompt (live); `botTick` edge detection on **500 ms** tick; classic bank capture waits **120 ms + 260 ms** but is not the krillocity path | `botTick` sets `roundClosed` → `resetBotRound(true)`, `raceCancel()`; non-classic branch calls `restartFromResults()`; observer may fire `captureBanks()` on `.kr-row` but the daily report has no dive-end graded bank to import | **Bank import / decision only** — never record other racers' answers or the day's top 10 shown here; only our own outcomes and site API banks | live (site copy: "After prompt seven, FINISH… the report lists every place, its points and what it paid") + code/live notes (STATES.md row 10) |
| K-11 | Daily completion (report; one attempt/day) | Results state persists with the distance/percentile and day's top 10; "Resume daily" resumes at the next prompt if left early (site); no fresh `.kr-begin` for another daily run today | none | Cadence **86 400 000 ms** (1 attempt/day), new race at **00:00 UTC** (live); not a per-prompt clock; report is terminal for today | `restartFromResults()` looks for `play again\|dive again\|restart\|next\|continue`; on the daily report it typically finds none, so bot falls back to `botStatus('waiting for the next round')` / `waiting` rather than replaying | **No new gameplay log** — only the earlier bot decisions; do not fabricate a replay | live (site copy: "one try a day… A new race begins at midnight UTC… Your report at the end shows how far you swam… and the day's top 10") + code/live notes (script 1951–1961, 2007–2014) |
| K-12 | When the bot stops / race is cancelled | No visible DOM change; internal guard `!bot.on \|\| bot.roundClosed`, or no `p.kr-prompt`/`input.kr-input`; also when Bot toggle is switched off or the tab leaves `/krillocity` | n/a (input may still exist; bot simply stops driving it) | Immediate on guard; `botTimer` **500 ms**; cancel clears `raceTimer` + `raceSubmitTimer` synchronously | `raceCancel()` clears both race timers; `setBot(false)` does `clearInterval(bot.timer)`. Pool drained is **not** a stop: `raceSchedule(150)` keeps re-checking | **Decision only** — `bot-start` / `mode-change` already logged; no per-cancel log | code/live notes (script 1495–1519, 1648–1660, 1714–1717) |
| K-13 | Script interaction: `race*` burst helpers (`raceCancel`, `raceSchedule`, `raceBuildPool`, `raceNextAnswer`, `raceBurst`) | n/a — script-internal; requires a visible `input.kr-input` and a non-empty `p.kr-prompt` to act | enabled input required | **50 ms** fill→submit, **90 ms** submit→next, **80 ms** answers-loading, **150 ms** pool-drained, **500 ms** `botTick` | Pool = rare `groups[0].answers` first, then `tierPremap` sorted 85→10; `raceBurst` fills+submits one answer per step and self-schedules; no 700 ms throttle | **Yes — per submitted answer** — same evidence tagging as K-06 | code/live notes (script 1644–1775; CONTRACT-MODES.md Stream B) |
| K-14 | Script interaction: prompt/input boundary detection + dedupe | `prompt` from visible `p.kr-prompt`, `input` from `input.kr-input`: `textChanged = prompt !== bot.racePrompt`; `input !== bot.raceInput`; dedupe keys `prompt\0answer` in `submittedForPrompt`, `raceSubmitted`, `refusedAnswers` | n/a (guard evaluation) | Immediate on boundary; `botTick` fallback **500 ms**; no fixed delay | On text change: clear both no-repeat sets and rebuild pool. On input **remount only** (same text): keep `raceSubmitted` so a React remount cannot cause a duplicate submission | **No** — internal bookkeeping, no user-visible outcome | code/live notes (script 1473–1487, 1695–1711, 1718–1735) |

## Per-prompt clock, end-to-end (evidence chain)

`loading-shell` (K-01) → `/krillocity` `intro` (K-02), reached from `/krillion`
via `a.kr-peek` (K-03) → `button.kr-begin` START DAILY (K-04) → ~**2 s** count-in
with `p.kr-prompt` but no input (K-05) → `input.kr-input` mounts, **30 s** clock,
rapid "Name as many as you can…" submissions every **50/90 ms** (K-06) →
accept (K-07) or refuse-and-retry (K-08) → timer-driven prompt advance (K-09),
repeated **7** times → FINISH/results (K-10) → daily report, one try until
00:00 UTC (K-11). The bot's `race*` helpers drive K-05–K-09 and cancel at
K-10/K-12.

## Registry selector coverage (Phase 0: 38 selectors / 10 states / 5 modes)

I represented every Krillocity-relevant registry selector above. I mapped all 38 registry selectors
in the table below so coverage was auditable; "NO" entries were
deliberately owned by the Classic (W1-A) or Multiplayer/1v1 (W1-C) inventories.

| Registry selector | Krillocity-relevant? | Where / why |
| --- | --- | --- |
| `.kd-elsewhere` | NO | duel only (W1-C) |
| `.kd-play` | NO | duel only (W1-C) |
| `.kd-result-keys` | NO | duel only (W1-C) |
| `.kd-tab-rule` | NO | duel only (W1-C) |
| `.kd-versus` | NO | duel only (W1-C) |
| `.kr-arena-main` | NO | multiplayer arena; `mode()` uses it only to exclude non-krillocity |
| `.kr-board-head` | YES | K-07 (classic-only score fallback; never read as our score in krillocity), K-10 |
| `.kr-board-rows` | YES | K-10 round-closed detection (multiplayer membership; not our score) |
| `.kr-duel-board` | NO | duel only (W1-C) |
| `.kr-duel-board, .kd-play, .kd-versus, .kd-tab-rule, .kd-result-keys` | NO | duel classifier (W1-C) |
| `.kr-guess-range, .kr-make-go` | NO | create-room slider (private race setup, not the daily path; W1-C) |
| `.kr-intro` | YES | K-01, K-02, K-03, K-04 |
| `.kr-line` | YES | K-10 results row |
| `.kr-line-answer` | YES | K-10 results answer cell |
| `.kr-line-pts` | YES | K-10 results points cell |
| `.kr-line-tier` | YES | K-10 results tier cell |
| `.kr-lobby-tab` | YES | K-02/K-03 "Play multiplayer" tab on `/krillocity` (bot does not join rooms) |
| `.kr-lobby-tab, .kr-room-row` | YES | K-02/K-03 lobby classifier |
| `.kr-over` | YES | K-10, K-11 |
| `.kr-over, .kr-over-next, .kr-board-head, .kr-board-rows, .kr-row` | YES | K-10 `roundClosed` classifier |
| `.kr-over-multi` | NO | multiplayer results (W1-C) |
| `.kr-over-next` | YES | K-10, K-11 |
| `.kr-reveal-points b` | YES | K-07 authoritative solo reveal if rendered |
| `.kr-reveal-tier` | YES | K-07 tier label |
| `.kr-reveal[role="status"]` | YES | K-07 reveal / `roundClosed` guard |
| `.kr-room-row` | YES | K-02/K-03 room list (not driven in daily mode) |
| `.kr-row` | YES | K-10 |
| `.kr-row-head[aria-expanded="false"]` | YES | K-10 expandable report row |
| `.kr-row-prompt` | YES | K-10 report prompt label |
| `.kr-stage-multi` | NO | multiplayer arena (W1-C) |
| `.kr-stage-multi, .kr-wait, .kr-board-head` | NO | arena-wait classifier (W1-C) |
| `button.kr-begin` | YES | K-02, K-04 (START DAILY) |
| `button.kr-haul-toggle` | YES | K-10 "Show answers" toggle (classic capture path; krillocity has no dive-end bank) |
| `button.kr-next` | YES | K-07 classic per-prompt advance; **not used** in krillocity (advance is timer-driven, K-09) |
| `button.kr-send` | YES | K-06 submit fallback (Enter → DIVE) |
| `form.kr-bar` | YES | K-06 primary submit via `requestSubmit()` |
| `input.kr-input` | YES | K-01, K-05, K-06, K-07, K-08, K-09, K-13, K-14 |
| `p.kr-prompt` | YES | K-01, K-05, K-06, K-08, K-09, K-14 |

Registry states represented here: `intro` (K-02), `prompt-reveal` (K-05),
`answering` (K-06–K-08), `refusal` (K-08), `results` (K-10), plus the
krillocity-specific `loading-shell` (K-01). Registry modes represented:
`krillocity` (all rows); `classic`/`duel`/`marathon5`/`showoff` are owned by the
other Phase 1 workstreams.

## Exclusions (I encountered these, deliberately did not inventory them)

- **I excluded SHOP.** I found Live site copy mentioned it ("The two games share their
  answers, depth tokens, shop, avatars and emotes"; the `/krillion` landing has
  a "Shop" link), and the tier table was worth 10/15/30/60/85/100 points. I inventoried no
  shop screen, item, purchase or catalogue state — it was
  out of scope for Phase 1 by project decision. This paragraph is my only
  mention; I recorded **zero shop rows** in the tables above.
- I left Multiplayer rooms / private races on `/krillocity` (`Play multiplayer`,
  `.kr-lobby-tab`, `.kr-room-row`, `.kr-arena-main`) and all duel screens
  out of scope for this daily-race workstream (owned by W1-C).
