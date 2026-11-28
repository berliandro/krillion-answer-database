# Phase 5 — live / read-only troubleshooting pass (W5-C)

- **Date/time of observations:** 2026-11-27 08:14:30 Z (local 15:14:25 +07:00).
- **Worktree / branch:** `D:\! Games\Krillion Game\.worktrees\p5-live` / `feat/p5-live`.
- **Owned file:** this file only. No userscript, bridge, other doc, test or bridge process was touched.
- **Mode:** LIVE / READ-ONLY. No game started, no room or duel joined, no answer submitted, no login, no rating/account interaction.

## Tooling outcome (I read this before the observations)

The brief led me to expect `tools.browser.*` (in-app browser). That namespace was **not exposed** to
me: `tools.browser.tabs({action:'list'})` returned `Unknown tool 'browser.tabs'`, and every
in-app variant I probed (`browser.tabs_list`, `browser.navigate`, `browser.status`) failed the same
way. No Playwright MCP was exposed either (`tools.playwright.browser_tabs` → unknown tool; the
error suggested `tools.browse.status`). The only browser MCP present was `tools.browse.*`, and
`tools.browse.status({})` returned:

```json
{"connected":false,"pairingState":"paired-offline","tabs":[],"nextStep":"The paired browser isn't connected right now: open it (the profile with browse) and check that the extension is turned on. It reconnects by itself."}
```

I then attempted a read-only remote render with
`tools.cloudflare.browserRun_quickAction_snapshot({body:{url:'https://playdaily.org/krillion',formats:['content'],...}})`;
it failed with `Insufficient scope: required ... browser-rendering.write`. **I had no browser tab id and
no browser snapshot lines for this pass.**

I used the remaining live read-only path, the `webfetch` tool against the two public URLs. Every
observation below was therefore a **read-only HTTP fetch of the live site** — the server-rendered
document plus the site's own on-page copy — **not an interactive DOM snapshot of the mounted
React game**. I carried this limitation explicitly through every row and every conclusion. I
did not restart the bridge and launched no local service.

## 1. Live read-only observations (LIVE-VERIFIED)

| # | URL | Selector / exact DOM snippet (short) | Visibility | Input state | Source / timestamp |
| --- | --- | --- | --- | --- | --- |
| OBS-01 | `/krillion` | `<div data-game-viewport="true" data-site-chrome="hidden" data-page-scrolls="" data-ground="" class="relative flex w-full flex-col overflow-hidden h-svh max-h-svh shrink-0" ...>` | Present in fetched HTML; no `hidden` attribute. Browser-computed `offsetParent`/rects not measured (no browser). | No `input` element anywhere in the fetched document; `inputState()` tuple not measurable. Code-derived mapping would be `{present:false,visible:false,disabled:null,readOnly:null,placeholder:''}` (source-only). | `webfetch` format=html, 2026-11-27 08:14 Z |
| OBS-02 | `/krillion` | `<!--$?--><template id="B:0"></template>` … the viewport … `<!--/$-->` (streaming Suspense boundary) | Present in HTML; the game body is a deferred boundary, not server-rendered. | none | `webfetch` format=html, 08:14 Z |
| OBS-03 | `/krillion` | `<div class="unlimited krillion relative isolate min-h-0 w-full flex-1 overflow-hidden rounded-xl"><div class="game-vignette" aria-hidden="true"></div><div class="relative z-10 flex h-full w-full flex-col items-center justify-center gap-3"><svg class="kr-mark" width="44" height="44" ...></svg><p class="game-label">Loading</p></div></div>` | Fallback markup present; no `hidden` attr; would paint on load. Computed visibility not measured. | none | `webfetch` format=html, 08:14 Z |
| OBS-04 | `/krillion` | `1Choose Classic or Endless and press Begin descent. Each prompt gives you 25 seconds to answer.` / `2Type an answer that fits the prompt and press Dive. If it is refused, try another until the clock runs out.` / `4Every point sinks your krill 10 metres. A perfect Classic dive of 7 prompts reaches 7,000 m.` | N/A — on-page "How to play" copy, not a game control. | n/a (copy) | `webfetch` format=markdown, 08:14 Z |
| OBS-05 | `/krillion` | `The grades, from most common to rarest, are Plankton (10 points), Too Clever (15), Schooler (30), Rare (60), Deep Cut (85) and One in a Krillion (100).` | N/A — FAQ copy. | n/a (copy) | `webfetch` format=markdown, 08:14 Z |
| OBS-06 | `/krillion` | `Press Play multiplayer and pick a live room of up to 40 players, or create your own... A room can run from 5 to 50 prompts, with 5 to 60 seconds for each.` / `send them its 6-digit code` / `You both answer the same 7 prompts, with 15 seconds for each... Everyone starts each 4-month season at a rating of 1,000` | N/A — FAQ copy. | n/a (copy) | `webfetch` format=markdown, 08:14 Z |
| OBS-07 | `/krillocity` | `<div class="unlimited krillion relative isolate min-h-0 w-full flex-1 overflow-hidden rounded-xl"><div class="game-vignette" aria-hidden="true"></div><div class="relative z-10 flex h-full w-full flex-col items-center justify-center gap-3"><svg class="kb-mark" width="64" height="64" ...></svg><p class="game-label">Loading</p></div></div>` (note: the `unlimited krillion` wrapper class is **reused** on the Krillocity page; the mark is `kb-mark`, not `kr-mark`) | Fallback markup present; no `hidden` attr; computed visibility not measured. | none | `webfetch` format=html, 08:14 Z |
| OBS-08 | `/krillocity` | `1Press Start daily for today's solo race, or press Play multiplayer to race in a live room.` / `2Each prompt, such as "Name a fruit", has a 30-second clock. Type an answer, press Enter and type the next one straight away.` / `3...The same answer only counts once.` | N/A — on-page copy. | n/a (copy) | `webfetch` format=markdown, 08:14 Z |
| OBS-09 | `/krillocity` | `Press Start daily to race alone against the clock... A new race begins at midnight UTC. Resume daily picks up at the next prompt if you leave early.` / `The prompt comes up for two seconds before its clock starts` / `After prompt seven, FINISH: the winner is called and crowned, and the report lists every place, its points and what it paid.` | N/A — FAQ + "How a race in Krillocity runs" copy. | n/a (copy) | `webfetch` format=markdown, 08:14 Z |
| OBS-10 | `/krillocity` | `Choose from 2 to 16 racers, 1, 3, 5 or 7 prompts and 20, 30, 45 or 60 seconds per prompt, then share the 6-digit code or invite link.` | N/A — FAQ copy. | n/a (copy) | `webfetch` format=markdown, 08:14 Z |
| OBS-11 | `/krillion` | `Endless deals one prompt at a time and ends when your 3 tanks of air run out. You lose a tank when you pass or when the clock runs out without an accepted answer, and a One in a Krillion answer gives one back... the ocean continues past 7,000 m to 250 km.` / `Small typos and plurals are usually accepted, and an answer still in the box when the clock runs out is submitted for you.` | N/A — FAQ copy (used as evidence for M1 and M3). | n/a (copy) | `webfetch` format=markdown, 08:14 Z |

**I recorded 11 live read-only observations** (4 DOM/shell + 7 on-page copy), spanning both pages.
None of them was an interactive game state; see §3.

## 2. Cross-check against the Phase 1 inventories

Sources I checked: `injection/STATES.md` (Classic table + C1–C19 + original rows 1–12),
`injection/STATES-KRILLO.md` (K-01–K-14), `injection/STATES-MP-DUEL.md` (S01–S03, M01–M18, D00–D11).
I read all three in full in this worktree.

### 2.1 Confirmed — no drift found

| Phase 1 claim | Live read-only evidence | Result |
| --- | --- | --- |
| Six tiers 10/15/30/60/85/100 (STATES.md C16, K-07, M16/D06) | OBS-05, OBS-09 | Confirmed (copy-level) |
| Classic: 7 prompts, 25 s, Begin descent, Dive, refusal keeps prompt open (C2/C5/C8/C12) | OBS-04 | Confirmed (copy-level) |
| Multiplayer: up to 40, 5–50 prompts, 5–60 s, 6-digit code (M03/M04/M05/M07) | OBS-06 | Confirmed (copy-level) |
| 1v1: 7 prompts, 15 s, rating from 1,000, 4-month season (D06 + FAQ note) | OBS-06 | Confirmed (copy-level) |
| Krillocity: Start daily, 30 s, 7 prompts, 1 attempt/day, midnight UTC, ~2 s count-in (K-02/K-04/K-05/K-11) | OBS-08, OBS-09 | Confirmed (copy-level) |
| Cold shell: `<p class="game-label">Loading</p>` inside `[data-game-viewport]` before React mounts (C1, S01, K-01) | OBS-01, OBS-03, OBS-07 | Confirmed live again on 2026-11-27 |
| `mode()` returns `krillocity` from path alone, no DOM guess (K-02) | `mode()` lines 1063–1073 (read-only) | Consistent; not live-DOM verified |

**I found zero live-DOM selector drift** — there was no mounted game DOM to compare against.
The only DOM I actually compared was the pre-hydration shell, and it matched.

### 2.2 Mismatches / gaps I found (all SOURCE-ONLY, none live-DOM verified)

| ID | Type | Inventory expectation | Live evidence of gap | Severity |
| --- | --- | --- | --- | --- |
| M1 | **Missing state / new mode** | No row in any of the three inventories covers an **Endless**-specific screen or HUD. STATES.md C2 only records `button.kr-mode` Classic/Endless on the intro; STATES-MP-DUEL.md M12 records `button.kr-pass` as a multiplayer control. | OBS-04: `Choose Classic or Endless and press Begin descent`; OBS-11 FAQ: `Endless deals one prompt at a time and ends when your 3 tanks of air run out... the ocean continues past 7,000 m to 250 km`. Source check: `mode()` (userscript lines 1063–1073) has **no Endless branch** and returns `classic`; `startMode()` (lines 2067–2068) finds `button.kr-mode` matching `/classic/i`. So a live-confirmed player mode is neither inventoried nor distinguished by `mode()`. | Medium (coverage gap; DOM not observed) |
| M2 | **New state, out of Phase 1 scope** | Krillocity private-race setup is excluded from STATES-KRILLO.md (lines 136–138, owned by W1-C), but STATES-MP-DUEL.md M05 only documents **Krillion** setup (`input.kr-guess-range` 5–60 step 1, `.kr-size` 5/7/10/15/25/50). No inventory row covers Krillocity's different setup. | OBS-10: `Choose from 2 to 16 racers, 1, 3, 5 or 7 prompts and 20, 30, 45 or 60 seconds per prompt, then share the 6-digit code or invite link.` No selectors were observed live, so this is a copy-level gap only. | Low (known scope exclusion, but now a confirmed live feature) |
| M3 | **Missing behaviour / state** | No inventory row represents the site auto-submitting an answer left in the box at clock expiry. C7 covers explicit submit only; C8 and M13 cover retry-until-expiry; C6 covers a locked input frame. | OBS-11 FAQ: `Small typos and plurals are usually accepted, and an answer still in the box when the clock runs out is submitted for you.` A read-only grep of `STATES*.md` for `runs out|expir|auto-submit|submitted for you` returns only retry/expiry lines (STATES.md 54, 105; STATES-MP-DUEL.md 86, 88) — no auto-submit row. | Low (site behaviour, not a script state) |

**I counted 3 mismatches** (M1, M2, M3), all source-only. **Live-DOM mismatch count: 0.**

## 3. Script-side states I could NOT observe live, and why

I found one common cause for every row below: the game is a client-mounted React app behind a streaming
Suspense boundary (OBS-02). The fetched document contained only the shell fallback, so no
`.kr-intro`, `.kr-prompt`, `.kr-input`, room row or duel control existed in the observed HTML.
Reaching any of them would have required clicking into a scored game / live room / daily race or a duel,
which the brief forbade; the paired browser was offline and no other browser was available.

### 3.1 Phase 0 mode coverage (5 registry modes + 1 live-confirmed extra)

| Mode | Phase 1 source | Live status | Why unobservable |
| --- | --- | --- | --- |
| `classic` | STATES.md C1–C19, rows 2/6–10 | Shell + copy only (OBS-01/03/04/05) | Requires clicking Begin descent and playing a 7-prompt scored dive |
| `krillocity` | STATES-KRILLO.md K-01–K-14 | Shell + copy only (OBS-07/08/09/10) | Requires Start daily → daily race, one attempt/day; touching that would consume the user's daily attempt |
| `marathon5` | STATES-MP-DUEL.md M04/M08/M09/M11–M17 | not observed live | Requires joining a live room with other players (gameplay, shared board) |
| `showoff` | STATES-MP-DUEL.md M06 | not observed live | Requires joining the most-populated live room (gameplay) |
| `duel` | STATES-MP-DUEL.md D00–D11 | not observed live | Requires queueing and a scored match; rating changes are explicitly forbidden |
| `Endless` (live-confirmed, **not** in registry) | none (see M1) | not observed live | Requires selecting the Endless mode button and starting a scored game |

### 3.2 Every `game_state` / interaction family represented in Phase 1

| State / family | Where inventoried | Live status |
| --- | --- | --- |
| `loading-shell` (C1 / S01 / K-01) | STATES.md, STATES-MP-DUEL.md, STATES-KRILLO.md | **LIVE-VERIFIED** (OBS-01/02/03/07) |
| `intro` (row 2, C2, S02, K-02) | all three | not observed live — no `.kr-intro` in fetched HTML; requires landing screen after hydration |
| `lobby` (row 3, M01–M07, C19) | STATES.md, STATES-MP-DUEL.md | not observed live — requires Play multiplayer click |
| `create-room` (row 4, M05/M07, C19) | STATES.md, STATES-MP-DUEL.md | not observed live — requires create-room click |
| `arena-wait` (row 5, M08/M09, C19) | STATES.md, STATES-MP-DUEL.md | not observed live — requires room entry and between-round settle frame |
| `prompt-reveal` / countdown (row 6, C4, M11, K-05) | all three | not observed live — requires a dealt prompt; ~2 s / ~2.9 s timings remain source-only |
| `answering` + input placeholders (row 7, C5/C6, M12, K-06) | all three | not observed live — no `input.kr-input` in fetched HTML; "Type one answer…" / "Name as many as you can…" remain source-only |
| `refusal` (row 8, C8, M13, K-08) | all three | not observed live — requires submitting a refused answer |
| `verdict` solo / classic fallback (rows 9/9b, C9/C10, S03, M14, K-07) | all three | not observed live — requires a scored answer |
| `results` / haul / rows / tiers (row 10, C13–C17, M16/M17, K-10/K-11) | all three | not observed live — requires dive end |
| `duel` (row 11, D00–D11, C19) | STATES.md, STATES-MP-DUEL.md | not observed live — requires queue + match (rating risk) |
| `krillocity` race / rapid input (row 12, K-04–K-14) | STATES.md, STATES-KRILLO.md | not observed live — requires Start daily / live room |

I therefore **explicitly marked** room rows, duel entry, countdown, prompt and reveal
**unobservable** in this pass; I carried their selectors, placeholders and timings over from the
Phase 1 inventory unchanged.

## 4. Repro steps for each mismatch / gap

I made all steps read-only.

- **M1 (Endless):** (1) `webfetch https://playdaily.org/krillion` with `format='markdown'`; read
  "How to play" step 1 and the FAQ question "What is the difference between Classic and Endless?".
  (2) Read `injection/krillion-autofill.user.js` lines 1063–1073 (`mode()`) and 2067–2068
  (`startMode()`). (3) Search `injection/STATES*.md` for `Endless` — only STATES.md lines 30 and 99
  (the mode button) appear. To close this gap live, a human would have needed to select Endless and start a
  scored game; I deliberately did not in this pass.
- **M2 (Krillocity private race):** (1) `webfetch https://playdaily.org/krillocity` with
  `format='markdown'`; read FAQ "How do I race with friends in Krillocity?". (2) Compare with
  `injection/STATES-KRILLO.md` lines 136–138 (exclusion) and `injection/STATES-MP-DUEL.md` M05
  (Krillion-only setup). I did not open the private-race form to observe live DOM selectors.
- **M3 (auto-submit at clock expiry):** (1) `webfetch https://playdaily.org/krillion` with
  `format='markdown'`; read FAQ "Why didn't Krillion accept my answer?" and the final sentence.
  (2) Grep `injection/STATES*.md` for `submitted for you` — zero matches. Observing the DOM frame
  would have required a timed prompt; I did not do it.

## 5. Live-verified vs source-only — explicit statement

- **LIVE-VERIFIED (11 observations):** the two live pages' server-rendered shell markup
  (`[data-game-viewport]` attributes, the `<!--$?-->` Suspense boundary, `p.game-label` "Loading",
  `svg.kr-mark` / `svg.kb-mark`, and the reused `unlimited krillion` wrapper on Krillocity), plus
  the site's own current "How to play", FAQ and race-description copy on both pages. These proved
  the cold-load `loading-shell` state and the published rules/tiers still matched Phase 1.
- **SOURCE-ONLY (everything else):** every interactive state, every selector inside the mounted
  game, every input placeholder, room row, duel control, countdown, prompt and reveal frame, all
  timing constants, and all three gaps M1–M3. I reported these from the Phase 1 inventories and
  the userscript, not from a live browser. I made no claim in this document that asserts a live DOM observation
  of a mounted game state.
- **I invented no data:** I did not observe,
  guess or record any answer, score, opponent, room, rating or account value.

## 6. Scoped check (exact commands and results; no full tests)

I ran tool namespace discovery and browser probes via `execute()`:

```text
search({query:'browser tabs list navigate snapshot'})        -> no tools.browser.* in catalog
tools.browser.tabs({action:'list'})                          -> ERROR: Unknown tool 'browser.tabs'
tools.browser.tabs_list({})                                  -> ERROR: Unknown tool 'browser.tabs_list'
tools.browser.navigate({url:'about:blank'})                  -> ERROR: Unknown tool 'browser.navigate'
tools.playwright.browser_tabs({action:'list'})               -> ERROR: Unknown tool 'playwright.browser_tabs'
tools.browse.status({})                                      -> connected:false, pairingState:paired-offline, tabs:[]
tools.cloudflare.browserRun_quickAction_snapshot({...})      -> ERROR: Insufficient scope (needs browser-rendering.write)
```

I had **no tab id and no snapshot line** to report: `tools.browse.tabs` had zero tabs and the
in-app browser was not exposed. My read-only substitutes were:

```text
webfetch https://playdaily.org/krillion    format=html      -> 200, SSR shell + FAQ JSON-LD
webfetch https://playdaily.org/krillocity  format=html      -> 200, SSR shell + FAQ JSON-LD
webfetch https://playdaily.org/krillion    format=markdown  -> 200, full "How to play" + FAQ copy
webfetch https://playdaily.org/krillocity  format=markdown  -> 200, full "How to play" + FAQ copy
```

I ran local read-only checks (PowerShell, `Get-Date` for timestamps only; no git except the final commit):

```text
Get-Date -Format 'yyyy-MM-dd HH:mm:ss K'                -> 2026-11-27 15:14:25 +07:00
(Get-Date).ToUniversalTime().ToString('...')            -> 2026-11-27 08:14:30 Z
Test-Path injection/TROUBLESHOOTING.md (before write)   -> False
```

Counts: **11 live read-only observations**, **3 gaps/mismatches (0 live-DOM, 3 source-only)**,
**5/5 registry modes accounted for** (1 partially live, 4 explicitly unobservable) plus 1 extra
live-confirmed mode (Endless), **12/12 state tags accounted for** (1 live-verified, 11 explicitly
unobservable), **0 full tests run**, **0 game/rating/account actions performed**.
