# Multiplayer & 1v1 duel state inventory (Phase 1 / W1-C)

I scoped this to every multiplayer and 1v1 state/interaction from intro to results/leave,
including room selection (Marathon 5s/50, custom 6s/50, most-populated),
room countdown, between-round board, chat/emotes as interactions only,
prompt-before-input, active input, refusal/verdict, round transition,
duel queue/rule/versus/answers/result/requeue/elsewhere/leave.

## Evidence key (live vs code-derived)

- `LIVE-NOTE` — previously observed in the real game and recorded in
  `injection/STATES.md` (live-mapped 2026-11-23, including a real 6s/50 room).
  No **new** live observation was possible in this worktree.
- `CODE` — derived from `injection/krillion-autofill.user.js` v1.1.2 selectors,
  classifiers, timers and actions in this worktree.
- `BUNDLE` — derived from the site's own Next.js chunks fetched 2026-11-27
  (`1pb-w_75d3u07.js`, `2dsh2j7-x58f7.js`, `1teyoxwdggu1p.js`,
  `24ukpn77kqf88.js`). Two duplicate chunk pairs exist; they contain identical
  game code.
- `FAQ` — site JSON-LD FAQ fetched from `https://playdaily.org/krillion` on
  2026-11-27 (room/duel rules).

I ran a Live-browser check (exact result): `tools.browse.status` returned
`{"connected":false,"pairingState":"paired-offline","tabs":[]}` with
`nextStep: "The paired browser isn't connected right now…"`. The in-app
`browser` tool and Playwright MCP were not exposed in my session, so I recorded
**zero new live rows**; each row below carries its source label.
I fetched the Site shell that day and it confirmed the cold-load state (`<p class="game-label">
Loading</p>` inside `[data-game-viewport]`), and the FAQ confirmed: rooms of up
to 40 players, 5–50 prompts at 5–60 s each, 6-digit private-room codes; 1v1 =
7 prompts at 15 s each with rating changes (start 1000).

## Policy I applied to every row

1. **I never recorded OTHER PLAYERS' ANSWERS AND SCORES.** I treated Board rows, chat,
   emotes and opponent results as interaction/context only. I let only our own
   (`[data-me]`, `source: own`) rows and the site's graded API banks
   (`source: api`) enter the archive.
2. I kept play scores from demoting an answer; I let only the game's dive-end graded bank
   demote (`DECISIONS.md` #1).
3. I logged the situation, not the noise: I required a log to carry a decision-grade signal
   (answer outcome, uncertain prompt, bot decision). Idle frames and other
   players' activity were not logged.

## Scope exclusions (no inventory rows I recorded)

- **I excluded SHOP.** I saw the Colosseum rewards rail and the shop card markup
  (`.kr-shop-card-head`, `emote-*` track items, depth-token spend) in
  the bundles and in the site FAQ but deliberately did not inventory them.
  I listed Emotes below only as in-room interactions, never as shop content.
- I left Classic-only solo verdict and Krillocity out of W1-C scope; I included the shared
  rows below only where needed to contrast MP behaviour or to
  cover the Phase 0 registry.

I noted the modes in the Phase 0 registry: `classic`, `krillocity` (out of scope),
`marathon5`, `showoff`, `duel` (all three in scope). Bot mode values came from
`#ka-mode` in the userscript: `Multiplayer · 5s / 50 prompts`,
`Multiplayer · most players`, `1 vs 1`.

## Inventory — shared entry / classic contrast

I gave all rows detection, input state, timing, script action and logging rationale.

| ID | State / interaction | Evidence | Detection (selector + visibility) | Input state | Timing | Script action (v1.1.2) | Logging allowed? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S01 | Cold / slow shell (`loading-shell`) before game mount | CODE+BUNDLE | `document.body` painted, no visible `.kr-intro` / `p.kr-prompt` / `.kr-arena-main`; site shell `<p class="game-label">Loading</p>` in `[data-game-viewport]` | none (no answer box) | `readyState=complete` while React is unmounted; observer waits; no fixed ms | `mount()` installs 50 ms-debounced MutationObserver; no clicks | **No** — transient load frame, no decision-grade signal |
| S02 | Intro: `Begin descent`, mode pick, Play multiplayer / Play 1 vs 1 | LIVE-NOTE+CODE+BUNDLE | `.kr-intro` visible; `button.kr-begin`; `button.kr-online` with text `Play multiplayer` / `Play 1 vs 1` (both share the class; hidden intro buttons must not be trusted); Krillocity link out of scope | none (answer box absent) | persists until a mode button is clicked; bot re-evaluates on 500 ms tick | `startMode()` matches `/multiplayer/i` or `/1\s*vs\s*1/i` on visible `button.kr-online`, clicks once; `mode-change` / `bot-start` on enable | **Decision only** — mode start is a bot decision; no answer data exists |
| S03 | Solo/classic verdict (contrast only — NOT an MP score source) | LIVE-NOTE+CODE+BUNDLE | `.kr-reveal[role="status"]`, `.kr-reveal-points b` (`+N PTS`), `.kr-reveal-tier`, `button.kr-next`; only this solo reveal is authoritative for our score | cleared | per-prompt verdict; auto-Next after 180 ms when Auto/Bot on | `checkVerdict()` parses `+(\d+)\s*PTS` from solo reveal; `resetBotRound(true)`; clicks `button.kr-next` after 180 ms | **Yes (classic only)** — our own graded score; in MP this selector must not be used |

## Inventory — multiplayer

| ID | State / interaction | Evidence | Detection (selector + visibility) | Input state | Timing | Script action (v1.1.2) | Logging allowed? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M01 | Play multiplayer → lobby navigation | CODE+BUNDLE | Visible `button.kr-online` text `Play multiplayer`; then `.kr-lobby-tab` / `.kr-lobby-rooms` appear; site emits `arena_open` analytics | none | click is immediate; lobby mounts on next React commit; bot polls every 500 ms | `startMode()` clicks the visible Play-multiplayer button; status `opening lobby` | **Decision only** — bot-start/mode-change at most; no answers |
| M02 | Lobby tabs (Rooms / Leaderboard) and online count | BUNDLE+FAQ | `.kr-lobby-tab[role=tab][aria-selected]` (`Rooms`, `Leaderboard`), `.kr-lobby-tabs[role=tablist]`, `.kr-lobby-online`, `.kr-lobby-foot`; `gameState()` → `lobby` via `.kr-lobby-tab, .kr-room-row` | answer box absent; `.kr-input` may exist as the **name field** (`Your name in the room`) — never filled by the bot | persists until a tab or room is chosen; tab click is immediate; 500 ms bot tick | `botTick()` checks lobby branch before answer branch; no tab click by the bot | **No** — idle picker chrome; only the later room choice is logged |
| M03 | Room rows: list, seat counts, create-room row | CODE+BUNDLE+FAQ | Visible `.kr-room-row` buttons (not `.kr-room-make`), with `.kr-room-name`, `.kr-room-detail` (`"50 prompts, 5s each"`), `.kr-room-count` (`Be first` / `N of 40` / `Full`), `.kr-room-go`; full rows `disabled`, in-flight rows `aria-busy` | none (name field only, not an answer box) | lobby re-renders on seat changes; bot scans every 500 ms | `joinLobbyRoom()` filters visible non-`kr-room-make` rows, reads name/detail/count | **No** — list is context; only the selected-room decision is logged |
| M04 | Room selection: Marathon 5s / 50 prompts | CODE+BUNDLE+LIVE-NOTE | `.kr-room-row` whose `.kr-room-detail` matches `/(\d+)\s*prompts?\s*,\s*(\d+)\s*s(?:ec)?/`; target `seconds===5 && prompts>=50`, fallback `seconds===5 && prompts>=15` (the Marathon preset; live-verified 50 prompts) | none | waits until a matching room has a free seat (no fallback to other rooms); 500 ms ticks | `joinLobbyRoom()` computes signature `name + reason`, calls `target.row.click()`, status `joining …` | **Decision only** — one `room-select` per distinct signature incl. full room list (max 20); no answer data |
| M05 | Create-room / custom 6s / 50 Marathon | LIVE-NOTE+CODE+BUNDLE+FAQ | `gameState()` → `create-room` via `.kr-guess-range, .kr-make-go`; slider `input.kr-guess-range` min 5 / max 60 / step 1; size radios `.kr-size` = 5/7/10/15/25/50; `.kr-who-key`; `.kr-make-go` becomes `Enter The Marathon · 6 sec` at 6 s | slider + radios only; **no answer box** | manual setup; room names generated as `The Marathon · N sec` for any N≠25; no preset 6s room exists | Script only classifies the state; bot never creates a room | **No** — manual setup, not play evidence. (This is where the live 6s/50 room was made.) |
| M06 | Room selection: most-populated (`showoff`) | CODE+BUNDLE | Same `.kr-room-row` / `.kr-room-name` / `.kr-room-detail` / `.kr-room-count` hooks; `parseInt(count,10)` with 0 fallback, empty/unknown counts parse as 0 | none | re-picked on each 500 ms tick if counts change; `Full` rows disabled so cannot win | `joinLobbyRoom()` takes argmax count, logs `most populated room`, clicks that row | **Decision only** — `room-select` with chosen room + all candidates; never answers |
| M07 | Private room code join | BUNDLE+FAQ | Lobby `.kr-code-field` (`input.kr-input`, placeholder `6-digit code`, `inputMode=numeric`), `.kr-make-go` (`Join <code>`), `.kr-lobby-back` (`◂ All rooms`) | code field only; not the answer input, so `botTick()` never fills it | user-driven; 6-digit code; no bot timing | No bot action; no bridge event | **No** — setup/interaction only, no answer evidence |
| M08 | Room countdown / gate before first prompt | BUNDLE+CODE | `.kr-countin` + `.kr-countin-num` (`Clock starting in N`), `.kr-wait` (`Reaching the arena…`), `.kr-stage-multi` gate (`readyCount`, `players`, `needed`, `due`); no `p.kr-prompt` yet | none | gate constant `N=5000` ms (5 s) with `3s + n + 5s` formula (`Z`); `.kr-countin` shows seconds until clock starts | Script waits; no click; `gameState()` still `arena-wait` while board/gate visible | **No** — transient countdown, no decision-grade signal |
| M09 | Between-round board, depth HUD, Leave (board is context only) | LIVE-NOTE+CODE+BUNDLE | `.kr-stage-multi` / `.kr-arena-main` present for the whole room; `.kr-wait`, `.kr-board-head` (`No catch this time.` / `X went deepest … +30`), `.kr-board-rows`, `.kr-board-row[data-me]`, `.kr-board-note` (`Waiting for N more · answers in Ns`), `.kr-pill-value` depth | none (input unmounted between prompts) | multi-second settle frame; in the live 5s/6s rooms the board sits between prompts; `mode()` sees the arena for the whole room | `mode()` → `multiplayer`; `gameState()` → `arena-wait`; `botTick()` waits (`waiting for the next round`) | **No. OTHER PLAYERS' ANSWERS/SCORES ARE NEVER RECORDED** — board rows/head are never read as our score; `checkVerdict()` parses `.kr-board-head` only in classic mode |
| M10 | Chat + emotes as interactions (not content) | BUNDLE+CODE | Side `.kr-panel` chat (`onSend`, `onReact`, `.kr-unread`), `.kr-chat-sys` system lines, `.kr-diver[data-emote]` / emote bubbles on the board; no separate answer box | chat draft / emote picker only; **not** `form.kr-bar` | available throughout the room, including between rounds; no bot cadence | Script never clicks, types, reads or forwards chat/emotes | **No. OTHER PLAYERS' CHAT/ANSWERS ARE NEVER RECORDED** — emotes and chat lines are interaction-only; nothing from `.kr-chat-sys` enters an archive event |
| M11 | Prompt reveal BEFORE input mounts | LIVE-NOTE+CODE | `p.kr-prompt` visible, `input.kr-input` not mounted; `.kr-card` may animate; `gameState()` → `prompt-reveal` | none | **live-measured ~2.9 s** in the 5s room before the input appears | 50 ms observer calls `loadAnswers(q)` when prompt text changes; bot does not answer yet (`botTick` requires both prompt and input visible) | **Prompt-level only** — `no-match` / `ambiguous` prompt-review is fine; **no score/evidence log** because no answer exists |
| M12 | Active input / submit | LIVE-NOTE+CODE+BUNDLE | `form.kr-bar` + visible `input.kr-input` (placeholder `Type one answer…`, `disabled=false`, `readOnly=false`), `button.kr-send` (`Dive`), `button.kr-pass`, `.kr-clock[role=timer]` with `data-low`; `gameState()` → `answering` | enabled, empty → typed (native value setter + `input`/`change` events) | room timer 5–60 s (FAQ); first accepted answer ends the prompt; bot fills on a 500 ms tick, submits after 120 ms | `answerCurrentPrompt()` gates on `visible(SEL.input)` + `bot.answeredPrompt`; `submitAnswer()` tries `form.requestSubmit()`, then Enter, then `button.kr-send` | **Yes — on our submit only** — evidence carries `game_state` + `input_state` + points/outcome; never another player's row |
| M13 | Refusal / retry | LIVE-NOTE+CODE+BUNDLE | `.kr-refusal` (`"X" was not accepted`), `input.kr-input[data-bad]`; prompt stays, input cleared but re-enabled | enabled (retry allowed until the room timer expires) | text lingers into the next round, so state uses `refusalActive`, not the stale selector; retry clears the flag | `checkRefusal()` sets `refusalActive`/`refusalKey`, clears `lastFilled`, returns true; next answer resets `refusalActive=false` | **Yes** — `prompt-review:refused` + `evidence:refused`; **no demotion**; refusing costs time only |
| M14 | Verdict in multiplayer (no solo reveal) | LIVE-NOTE+CODE | `.kr-board-head` / `.kr-chat-sys` may show points; `.kr-reveal-points b` is **absent** (classic-only); `mode()` → `multiplayer`; `gameState()` → `arena-wait` | cleared | settle frame between prompts; no classic-style Next gate | `checkVerdict()` sets `board = mode()==='classic' ? … : null`, so in MP it never parses board points | **Outcome only** — our own submit/refusal outcomes are logged; **no board-scraped score**; never another player's points |
| M15 | Round transition (same prompt text / fresh input) | LIVE-NOTE+CODE | `bot.lastPrompt` text change, fresh `input` element identity, or `roundClosed` via `.kr-reveal, .kr-over, .kr-over-next, .kr-board-head, .kr-board-rows, .kr-row`; 50 ms observer + 500 ms bot tick | input may be absent, then re-enabled with a new element | 50 ms debounce; bot re-arms within one 500 ms tick; room timer controls prompt expiry | `resetBotRound(false/true)` clears per-answer state; `bot.roundClosed` edge-trigger prevents double answers | **No** — bookkeeping transition; no new answer information |
| M16 | Multiplayer results / haul / bank import | LIVE-NOTE+CODE+BUNDLE | `.kr-over` + `.kr-over-multi`, `.kr-over-next` (`Next dive starts from here in Ns`), `.kr-row`, `.kr-row-head[aria-expanded="false"]`, `button.kr-haul-toggle`, `.kr-row-prompt`, `.kr-line`, `.kr-line-answer`, `.kr-line-tier`, `.kr-line-pts` with `[data-me]`; API banks via `/api/krillion/answers` | none | end of room; next dive countdown shown in `.kr-over-next`; observer fires 50 ms after DOM change | `captureBanks()` clicks haul + every collapsed row head (120 ms + 260 ms waits), imports **only `[data-me]` lines + `source:api` banks**, deduped by dive signature; then `restartFromResults()` clicks a visible restart/next/continue button | **Bank own-only** — `source: own`/`source: api`; **other-user DOM rows are never captured**; play scores never demote |
| M17 | Fastest Marathon end (no dive-end rows) | LIVE-NOTE+CODE | Same `.kr-over*` hooks may exist, but the live 5s/6s rooms yielded no dive-end `.kr-row` banks; `.kr-board-head`/`.kr-board-rows` stop updating | none | prompts rotate on the room timer; results follow the last prompt | Observer still calls `captureBanks()` if haul/rows appear, but with no rows/learned data it returns without a POST; `restartFromResults()` handles the next dive | **Own submissions/refusals only** — no bank import, hence no other player's data can leak |
| M18 | Leave multiplayer (user action) | BUNDLE | `.kr-lobby-back` with `◂ Dive on your own` / `◂ All rooms` / `◂ Back to the arena`; `.kr-fold` collapse control | none | user-driven; instant navigation back to intro/lobby | Bot never clicks leave/back controls | **No** — navigation chrome, not play evidence |

## Inventory — 1v1 duel (Colosseum)

| ID | State / interaction | Evidence | Detection (selector + visibility) | Input state | Timing | Script action (v1.1.2) | Logging allowed? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D00 | Duel classifier precedence | CODE | `visible('.kr-duel-board, .kd-play, .kd-versus, .kd-tab-rule, .kd-result-keys')` or `/duel/i` in `location.hash`; `gameState()` returns `duel` **before** results/lobby/answering; `mode()` → `1v1` | none | evaluated on every `ctx()` log event and every 500 ms bot tick | `ctx()` attaches `game_state=duel`, `input_state`, `mode=duel` to all events | **Decision/outcome only** — classifier itself emits nothing; it only tags real events |
| D01 | Play 1 vs 1 entry | CODE+BUNDLE+FAQ | Visible `button.kr-online` text `Play 1 vs 1` (site analytics `duel_open`); leads to `.kd-dock` Colosseum | none | click immediate; Colosseum mounts on next commit | `startMode()` matches `/1\s*vs\s*1/i`, clicks, status `finding opponent` | **Decision only** — mode-start log; no answers |
| D02 | Colosseum dock + tab-rule gate | BUNDLE+CODE+FAQ | `.kd-dock` (`THE COLOSSEUM`, `.kd-season`), `.kd-tab-rule[role=alertdialog]` with `.kd-tab-rule-key` (`agree`), `.kd-versus-rule`, `.kd-tab-reached[role=status]`; rule appears for tab-out ratings (`tabout=1250` ms grace) | none (rule acknowledgment button only) | shown before queue when applicable; instant accept; leaving the tab during a match can forfeit | `duelTick()` calls `duelClick('.kd-tab-rule-key','duel-rule','accepted tab rule')` | **Decision only** — rule acceptance is a bot decision; no match content |
| D03 | Duel queue | BUNDLE+CODE | `.kd-play` (`▶ Find a match`), `.kd-play-note[role=status]` (`The Colosseum is closed…` / notice), `disabled` while `pending`; queue heartbeat `krillion_duel_queue_beat` | none | waits until matched; `duelTick()` every 500 ms; no fixed match time | `duelClick('.kd-play','duel-queue','finding a match')`; guard `bot.lastDuelAction` prevents repeat clicks | **Decision only** — one `duel-queue` event; no opponent data |
| D04 | Elsewhere (queued in another tab) | BUNDLE+CODE | `.kd-elsewhere[role=alertdialog]` title `You're queued in another tab`, `.kd-elsewhere-key` (`Queue here`), `.kd-elsewhere-keys` secondary buttons | none (claim button only) | appears when another tab holds the queue; claim instant | `duelTick()` calls `duelClick('.kd-elsewhere-key','duel-claim','claimed queue here')` | **Decision only** — claim decision; nothing from the other tab is recorded |
| D05 | Match found / versus countdown | BUNDLE+CODE | `.kd-versus[role=status]` with `aria-label="<you> versus <foe>"`, `.kd-versus-kicker` (`Match found`), `.kd-versus-row`, `.kd-versus-rule`, `.kd-versus-chat`, `.kd-versus-leave` (`Leave before it starts`) | none | duel `intro=8000` ms, `countdown=3000` ms before first prompt; `tabout=1250` ms tab-out rule | `duelTick()` sees `.kd-versus` and only sets status `match found — waiting for first prompt`; **never clicks Leave** | **No** — silent wait; opponent identity/rating is never logged |
| D06 | Duel answers (input + submit) | CODE+BUNDLE+FAQ | `.kr-duel-board` marks the duel arena; `p.kr-prompt`, `form.kr-bar`, `input.kr-input` (`Type one answer…`), `button.kr-send`, `.kr-clock`; `mode()` → `1v1`, `gameState()` → `answering` | enabled, empty → typed | `answer=15000` ms, `grace=3000` ms, 7 rounds; first accepted answer closes the prompt | `answerCurrentPrompt()` + `submitAnswer()` run exactly as in MP; refusal handled by `checkRefusal()` | **Yes — our submissions/refusals only** — `game_state` tagged `duel`; opponent answers never enter the archive |
| D07 | Duel between-round board | BUNDLE+CODE | `.kr-duel-board`, `.kr-board-head` (`You said … +N` / `No catch this time.`), `.kr-board-rows`, `.kr-board-row[data-me]`, `.kr-chat-sys`; input unmounted | none | `reveal=7000` ms, `together=15000` ms, `stale=15000` ms from duel timings | `checkVerdict()` never reads board points in duel mode (`mode()!=='classic'`); bot waits | **No. OTHER PLAYERS' ANSWERS/SCORES ARE NEVER RECORDED** — board/chat are context only |
| D08 | Duel result | BUNDLE+CODE+FAQ | `.kd-result[data-outcome]` with `.kd-result-title` (`Victory` / `Defeat` / `Draw`), `.kd-result-why`, `.kd-result-divers .kd-result-diver[data-side]` (`you` / `foe`), `.kd-result-keys`, `.kd-result-chat`, `.kd-home` (`Back to the arena`) | none | after all 7 rounds; rating K=50, rematch window constant `rematch=3` | `duelTick()` detects `.kd-result-keys` and requeues; no score scraping | **No answer data** — result is a bot-decision context; opponent/rating rows are never archived |
| D09 | Requeue after result | CODE+BUNDLE | `.kd-again` (`Find another match`) inside `.kd-result-keys`; guard `bot.lastDuelAction` | none | immediate after result detection; one click per button identity | `duelClick('.kd-again','duel-requeue','queued another match')` | **Decision only** — `duel-requeue` log; no match content |
| D10 | Elsewhere mid-match (match in another tab) | BUNDLE+CODE | `.kd-elsewhere` title `Your match is in another tab` / `You have a match in progress`, `.kd-elsewhere-key` (`Play it here`), `.kd-elsewhere-keys` | none (claim button only) | appears while a match is live in a different tab; claim instant | `duelClick('.kd-elsewhere-key','duel-claim',…)` | **Decision only** — claim decision; never records the other tab's match/answers |
| D11 | Leave duel (user action, never automated) | BUNDLE+CODE | `.kd-versus-leave` (`Leave before it starts`, `disabled` while leaving), `.kd-home` (`Back to the arena`) | none | user-driven only; `abandon=45000` ms and tab-out forfeit rules apply | Bot explicitly **never** clicks these controls (README + `duelTick()` comment) | **No** — navigation/forfeit chrome, no answer evidence |

## Phase 0 registry coverage (all 38 selectors)

I mapped MP/duel-relevant selectors to their row above; I listed classic-only hooks
as contrast rows. I mapped no selector to a shop row.

| Registry selector | Row(s) | Scope |
| --- | --- | --- |
| `.kd-elsewhere` | D04, D10 | duel |
| `.kd-play` | D03 | duel |
| `.kd-result-keys` | D08, D09 | duel |
| `.kd-tab-rule` | D02 | duel |
| `.kd-versus` | D05 | duel |
| `.kr-arena-main` | M09 | multiplayer |
| `.kr-board-head` | M09, D07 (S03 classic fallback) | multiplayer/duel |
| `.kr-board-rows` | M09, D07 | multiplayer/duel |
| `.kr-duel-board` | D00, D06, D07 | duel |
| `.kr-duel-board, .kd-play, .kd-versus, .kd-tab-rule, .kd-result-keys` | D00 | duel classifier |
| `.kr-guess-range, .kr-make-go` | M05, M07 | multiplayer |
| `.kr-intro` | S02 | shared |
| `.kr-line` | M16, M17 | results |
| `.kr-line-answer` | M16 | results |
| `.kr-line-pts` | M16 | results |
| `.kr-line-tier` | M16 | results |
| `.kr-lobby-tab` | M02 | multiplayer |
| `.kr-lobby-tab, .kr-room-row` | M02, M03 | lobby classifier |
| `.kr-over` | M16, M17 | results |
| `.kr-over, .kr-over-next, .kr-board-head, .kr-board-rows, .kr-row` | M15 | bot round-closed gate |
| `.kr-over-multi` | M16 | multiplayer results |
| `.kr-over-next` | M16 | results |
| `.kr-reveal-points b` | S03 | classic-only contrast |
| `.kr-reveal-tier` | S03 | classic-only contrast |
| `.kr-reveal[role="status"]` | S03, M15 | verdict / round gate |
| `.kr-room-row` | M03, M04, M06 | multiplayer |
| `.kr-row` | M15, M16, M17 | results |
| `.kr-row-head[aria-expanded="false"]` | M16 | results |
| `.kr-row-prompt` | M16 | results |
| `.kr-stage-multi` | M08, M09 | multiplayer |
| `.kr-stage-multi, .kr-wait, .kr-board-head` | M09 | arena-wait classifier |
| `button.kr-begin` | S02 | shared |
| `button.kr-haul-toggle` | M16 | results |
| `button.kr-next` | S03 | classic-only contrast |
| `button.kr-send` | M12, D06 | submit |
| `form.kr-bar` | M12, D06 | input |
| `input.kr-input` | M02, M07, M11, M12, D06 | shared input/name/code field |
| `p.kr-prompt` | M11, M12, D06 | prompt |

## Scoped check (I recorded the exact output after writing)

I ran Commands in this worktree with no full test suite.

```powershell
Select-String -Path injection/STATES-MP-DUEL.md -Pattern '^\| [SMD]\d' | Measure-Object | Select-Object -ExpandProperty Count
Select-String -Path injection/STATES-MP-DUEL.md -Pattern '^\| [SMD]\d.*LIVE-NOTE' | Measure-Object | Select-Object -ExpandProperty Count
Select-String -Path injection/STATES-MP-DUEL.md -Pattern '^\| [SMD]\d.*CODE' | Measure-Object | Select-Object -ExpandProperty Count
Select-String -Path injection/STATES-MP-DUEL.md -Pattern '^\|.*[Ss]hop' | Measure-Object | Select-Object -ExpandProperty Count
```

I recorded the Exact output of the four commands above, in order:

```text
33
12
31
0
```

I ran a Structural check (same file, registry at
`C:\Users\nberl\AppData\Local\Temp\opencode\roadmap-registry.json`):

```text
rows=33
rows_missing_detection_input_timing_action_log=0
registry_selectors=38 missing=0
registry_states=10 missing=0
registry_modes=5 missing=0
```

I interpreted this as 33 inventory rows (3 shared/classic-contrast, 18 multiplayer,
12 duel); 12 carried a live-verified note, 31 carried code/bundle derivation (some
rows carried both); zero shop inventory rows; every registry selector, state and
mode was represented in this document.
