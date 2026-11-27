# Phase 2 / W2-D — Multiplayer & 1v1 duel rank strategy

**Status:** research only. No live proof in Phase 2; every unmeasured claim is
labelled `hypothesis`. Phase 3 (W3-C) must turn the ranked list below into
`evidence/mp-strategy-<n>.json` runs before any of it is implemented.

**Scope:** room choice (5s/6s marathon, most-populated, long rooms), seat
limits, score/rank mechanics, duel rating, requeue vs leave, other-player
effects, refusal cost. Classic and Krillocity are out of scope except where
their rules contrast with MP/duel. Shop/rewards are excluded.

**Owned file:** this document only. No userscript, bridge, data or site file is
changed by this workstream.

## Evidence key

- `FAQ` — `https://playdaily.org/krillion` JSON-LD/text fetched 2026-11-27
  (room and duel rules) and the site's own guides fetched 2026-11-27:
  `playdaily.org/resources/stories/krillion-1v1-ranked-seasons`,
  `how-to-play-krillion`, `how-to-get-better-at-krillion`,
  `krillocity-vs-krillion`, `rarest-answer-game-night`.
- `BUNDLE` — site Next.js chunks cached in `%TEMP%\opencode\krillion-bundles`
  (`1pb-w_75d3u07.js` / `2dsh2j7-x58f7.js` for duel+arena,
  `1teyoxwdggu1p.js` / `24ukpn77kqf88.js` for lobby) fetched 2026-11-27.
- `CODE` — `injection/krillion-autofill.user.js` v1.1.2 in this worktree;
  `injection/INTERACTIONS.md`, `injection/STATES-MP-DUEL.md`,
  `injection/DECISIONS.md`.
- `DATA` — `data/manifest.json`, `data/answers_injection.jsonl`,
  `data/answers_gameplay.jsonl`, `data/answers.jsonl` in this worktree.
- `LIVE-NOTE` — previously observed in the real game, recorded in
  `injection/STATES.md` / `STATES-MP-DUEL.md` (includes a real 6s/50 room).
  No new live observation was possible: the paired browser was offline, so no
  Phase 2 score/rating measurement was taken.
- `hypothesis` — plausible but not verified by FAQ, bundle, code or measurement.

## Hard constraints (apply to every strategy below)

1. **Never demote a 100-point answer from a play score.** The game AI-grades
   unknown answers inconsistently; only the game's dive-end graded bank may
   demote. Refusals, MP board points and duel result points are evidence only
   (`DECISIONS.md` #1, #5, #7; `INTERACTIONS.md` T21/T22).
2. **Never record another player's answer, score, chat or emote.** Board rows,
   `.kr-board-head`, `.kd-result-diver[data-side=foe]`, opponent chat and
   emotes are interaction context only. The bot captures only `[data-me]` lines
   and `source: api` graded banks (`DECISIONS.md` #5/#7; `STATES-MP-DUEL.md`
   M09/M10/D07/D08). This is a policy constraint, not a scoring tactic.
3. **Near-duplicate / reworded prompts stay separate labelled banks.** Duel
   prompts are reworded and cannot be copied off screen (`WEB`); aliases are
   logged, never applied to matching (`DECISIONS.md` #2; `AGENTS.md`).
4. **No shop mechanics** are used or recommended in this document.

## Mechanic model (what actually moves rank)

| Mechanic | Rule | Evidence |
| --- | --- | --- |
| Points | Plankton 10, Too Clever 15, Schooler 30, Rare 60, Deep Cut 85, One in a Krillion 100. Every point = 10 m depth. Tier scores are literal bundle constants `[10,15,30,60,85,100]`, depth = `points × 10`. | FAQ; `BUNDLE` module 712867 (`b.P`, `V: n=>n*b.I`, `I=10`); `DATA` |
| Rarity vs speed | Rarity alone sets points. "Answering quickly earns nothing extra." Speed is only a tiebreak. One 100 (1,000 m) = 10 Plankton (100 m each) and outweighs a whole 7-Pankton dive (70 pts). | FAQ; `WEB`; `DATA` |
| First answer wins the prompt | First **accepted** answer ends that prompt for that player. A refusal keeps the prompt open until the clock expires. | FAQ; `BUNDLE`; `CODE` T19 |
| Refusal cost | Time only: no points removed, no rating penalty, retry allowed until the clock runs out; text left in the box at the buzzer is submitted for you. | FAQ; `WEB` 1v1 guide; `BUNDLE` `.kr-refusal` / `clearRefusal` |
| Room ranking | Board comparator `no()`: **points descending**, then **ms ascending** when points tie and are >0, then name. Site guide: "deepest diver after the last prompt wins, and answer time only breaks ties." | `BUNDLE` `function no(e,t)`; FAQ |
| Room leaderboard | "Krillion's boards rank what you dive in its rooms." Room standings add up your depth for as long as you stay in the room. | `WEB` `krillocity-vs-krillion`, `rarest-answer-game-night`; linkage of cumulative standings to the lobby board is `hypothesis` |
| Room limits | Up to **40 players**; public or private (6-digit code); **5–50 prompts**, **5–60 s** each. `.kr-room-count` shows `Be first` / `N of 40` / `Full`; full rows are `disabled`. Create-room size radios 5/7/10/15/25/50 prompts. | FAQ; `BUNDLE` lobby `s>=i.P` disable; `CODE` M03/M05/M06 |
| Duel format | 7 prompts, 15 s answer, 3 s count-in, 7 s reveal; 8 s VS intro; `grace=3 s`, `abandon=45 s`. Same prompts for both, slightly reworded; both can score the same answer (no stealing). | FAQ; `WEB` 1v1 guide; `BUNDLE` `eo={intro:8e3,countdown:3e3,answer:15e3,grace:3e3,reveal:7e3,abandon:45e3,together:15e3,stale:15e3,rounds:7,start:1e3,k:50,rematch:3,tabout:1250}` |
| Duel winner | More total points; if level, less time on **scoring** answers; if still level, draw. A fast Plankton never beats a slow Rare. | FAQ; `WEB` 1v1 guide; `BUNDLE` `eM()` (`"d" → draw`) and `function no` |
| Duel rating | K=50 Elo from a 1,000 season start. `Δ = round(50 × (score − 1/(1+10^((foe−you)/400))))`, with a floor of ±1 on a decisive result. Beating a higher rating takes more. | FAQ; `BUNDLE` `function nu(e,t,a,n)` and `k:50,start:1e3`; `WEB` "Beat a higher rating, take more of it" |
| Divisions / season | Driftwood 0, Barnacle 800, Seaglass 950, Doubloon 1100, Pearl 1250, Nautilus 1400, Trident 1550, Maelstrom 1700, Abyss 1850, Kraken 2000; steps I/II/III in 50-point bands below each floor. 4-month season, reset to 1,000. Leaderboard ranks rating; season top ten shown in the arches. | FAQ; `BUNDLE` module 293450 floors/steps, season start `2026-10-01`; `WEB` |
| Rematch / seat limits | Max **3 rated matches per 24 h** against the same diver; cancelled games do not count, forfeits do. One live queue/match per player across tabs (`.kd-elsewhere` "Queue here"/"Play it here"; storage key `krillion:duel:seat`). | `BUNDLE` `rematch:3`, `a6=…`; `WEB` 1v1 guide; `CODE` D04/D10 |
| Leave costs | Leave **before** the match starts → you wait to queue again. Leave **once it starts** → counts as a loss. From **1,250 Elo (Pearl)** tab-out during a match is a forfeit; the opponent takes the win. `abandon=45 s`. | `BUNDLE` `eE()` rule text and rotating tips; `WEB` 1v1 guide; `CODE` D02/D05/D11 |
| Bot answer pick | `random`/`top` draw from the **100-point rare list**; `god` draws across tiers with weights `{10:0.05, 15:0.95, 30:7.54, 60:26.04, 85:39.37, 100:26.04}` (peak 85). God expected tier ≈ **77.5 pts** vs **100 pts** for a banked top rare answer. | `CODE` lines 1530–1531, 1589–1642, 1827–1839; `INTERACTIONS.md` P13/T19 |
| Data coverage | Full DB 127,118 answers / 5,801 prompts, of which 21,384 are 100-point (**≈3.69 krillion answers per prompt**). Search DB 6,142. Injection bank 4,920 rows, 3,667 (74.5%) at 100. | `DATA` `manifest.json`; counted from `answers_*.jsonl` |

## Ranked strategies

Ranked by expected effect on **rank / score** with acceptable risk. Every row
has the four required fields; "testable in Phase 3" is explicit.

| # | Strategy | Predicted effect | Evidence source | Risk | Testable in Phase 3 |
| --- | --- | --- | --- | --- | --- |
| **1** | Warm the answer cache and use `pick=top` bank-confirmed 100s in both MP and duel | Up to +22.5 pts/prompt vs `god` (+157 pts over a 7-prompt duel); turns a 5s prompt from a miss into a 100 | `CODE` 1530–1531/1827–1839; `DATA`; `BUNDLE` tier math | Wrong near-duplicate bank → refusal; AI grading can still grade an unknown answer low; **never demote from play** | **Yes** — same prompts, `top` vs `god`, record points/prompt |
| **2** | Prefer the **5s / 50-prompt Marathon** room for depth per minute | 50 prompts × up to 100 pts = up to 5,000 m in ~4–5 min of clock, vs up to 50 min for the same ceiling in a 60s room | FAQ room range; `CODE` `joinLobbyRoom()` 5s/≥50; `LIVE-NOTE` real 5s/50 room; `BUNDLE` depth math | Input mounts late in fast rooms (live ~2.9 s reveal lag), so cold cache misses; fast rooms yield no dive-end bank capture (`STATES-MP-DUEL` M17); depth-per-minute delta is `hypothesis` | **Yes** — 5s vs 30s rooms, record depth/min and answered/prompt |
| **3** | Use **long / private rooms** when the goal is total depth or a room leaderboard place | Higher per-session ceiling and cumulative standings while you stay; a 50-prompt room can out-dive a 7-prompt duel by an order of magnitude | FAQ 5–50 prompts; `WEB` game-night "standings add up … for as long as they stay"; `BUNDLE` comparator | Ties up the browser for up to 50 min; bot never clicks Leave (M18); no seat competition in a private room; leaderboard linkage `hypothesis` | **Yes** — 50-prompt room, record cumulative depth and place |
| **4** | Treat **most-populated** (`showoff`) as a leaderboard-exposure choice, not a score-rate choice | Same prompts and independent grading, so your points do not rise with population; more players can lengthen the between-round "Waiting for N more" settle | FAQ; `CODE` argmax count, full rows disabled; `BUNDLE` `.kr-board-note`; `STATES-MP-DUEL` M06 | `argmax` can select a nearly-full 40-seat room; full rooms are unjoinable; population→wait delta is `hypothesis` | **Yes** — compare inter-round ms at 2 vs 30 players |
| **5** | Duel: decide the rare angle during the 3 s count-in, take the long shot first, keep a safe answer in the box as a buzzer fallback | Rarest confident answer maximizes the tiebreak-proof component; refusals cost nothing; fallback prevents a zero at the buzzer | `WEB` 1v1 guide + "refusal is a free shot"; FAQ; `BUNDLE` 15 s clock; `DATA` 3.69 100s/prompt | 15 s is too short for a live lookup; AI grading inconsistency; buzzer-fallback behaviour for an already-refused typed answer is `hypothesis`; no demotion | **Yes** — 7-prompt duels, record tier/prompt and refusals |
| **6** | Duel: accept the tab rule, stay in one tab, never leave after the match starts | Avoids a guaranteed loss (≈ −25 Elo at equal ratings) and the ≥1,250 tab-out forfeit; keeps the 3/day rematch allowance clean | `BUNDLE` `eE()`, `tabout:1250`, `abandon:45e3`, queue tips; `CODE` `duelTick()` never clicks Leave; `WEB` "forfeits count" | Deliberately testing a forfeit is unsafe/unethical live; multi-tab queue claim can interrupt a match | **Partial** — test rule acceptance, `.kd-elsewhere` claim and leave-before-start via harness; do **not** live-test an actual forfeit |
| **7** | Duel: requeue via `.kd-again` while winning; apply a stop-loss after consecutive losses | More matches at a positive edge compounds K=50 gains; stopping a losing streak limits Elo bleed (a discipline rule, not a game mechanic) | `BUNDLE` `k:50`, `nu()`; `CODE` D09 auto-requeue; `WEB` "opponent near your rating", 3/day cap | Raising your rating raises opponent strength; variance is high at K=50; stop-loss threshold is `hypothesis`; auto-requeue can hit the 3/day same-foe limit and be redirected | **Yes** — log Δ rating vs foe rating across N matches |
| **8** | Spend remaining clock on a rarer answer only when a refusal still leaves time to retry | In 5s rooms a refusal can consume the whole window, so take the banked 100 immediately; in 15–60 s rooms a long shot is nearly free | FAQ "a refusal costs only time"; `WEB` "take the long shot first"; `BUNDLE` room/duel clocks; `CODE` `checkRefusal()` | Overtime in a duel can lose a tiebreak point-equality race (frequency `hypothesis`); refused answers are logged, never demoted | **Yes** — count refused→accepted retries by room clock |

### S1 — Cache-first, `top`-pick banked rare answers (both modes)

- **Predicted effect:** `top` always draws from the 100-point list
  (`CODE` 1833–1838); `god` expects ≈77.5 pts because 39.37% of draws are 85
  and 26.04% are 100. On a 7-prompt duel that is 700 vs ≈543 points before
  grading variance. A warm cache also avoids the 2,500 ms lookup race that a
  5 s room cannot afford.
- **Evidence:** `CODE` T09/T10/T11 preload and `netCache`, lines 1530–1531,
  1589–1642, 1827–1859; `DATA` 21,384 krillion answers / 5,801 prompts;
  `BUNDLE` depth = points × 10.
- **Risk:** bank may be for a wrong near-duplicate bank (duel rewords prompts);
  auto-enter is deliberately paused when several banks match (`DECISIONS.md` #4),
  so a completely automatic `top` pick is not always possible. A play score
  never demotes an answer.
- **Testable in Phase 3: Yes** — fixed prompt set, `top` vs `god`, compare
  accepted tier and points; assert zero play-score demotions.

### S2 — Fast 5s/50 Marathon room for depth per minute

- **Predicted effect:** maximum ceiling 50 × 100 × 10 m = 5,000 m in roughly
  four to five minutes of prompt clocks. Under the same ceiling a 60 s room
  needs ~50 minutes. Faster rooms also reduce idle settle frames. The
  per-minute advantage itself is `hypothesis` until timed live.
- **Evidence:** FAQ (5–50 prompts, 5–60 s, up to 40 seats); `CODE`
  `joinLobbyRoom()` targets `seconds===5 && prompts>=50` (fallback ≥15) and
  waits rather than joining another room; `LIVE-NOTE` a real 5s/50 and a
  custom 6s/50 room; `STATES-MP-DUEL` M04/M05.
- **Risk:** `p.kr-prompt` precedes the input by ~2.9 s in the live 5s room
  (`STATES-MP-DUEL` M11), so a cold lookup misses the prompt; no dive-end
  `.kr-row` banks appear, so no bank capture (M17); the bot has no fallback
  when no 5s room has a free seat; the 6s room is manual (`hypothesis` on
  repeatability).
- **Testable in Phase 3: Yes** — same prompt bank in a 5s room and a 30s room;
  record prompts answered, total depth, elapsed time, refusals.

### S3 — Long / private rooms for total depth and cumulative standings

- **Predicted effect:** more prompts means more depth in one sitting; room
  standings accumulate for as long as you stay. Useful when the objective is
  an absolute depth number or a room leaderboard placing rather than speed.
- **Evidence:** FAQ prompt/time range and 6-digit private codes; `WEB`
  game-night guide ("standings add up everyone's depth for as long as they
  stay"); `BUNDLE` comparator `no()` and `.kr-pill-label` "Depth".
  Linking cumulative room depth to the lobby leaderboard is `hypothesis`.
- **Risk:** maximum wall-clock cost; the bot never clicks Leave (`CODE`
  `duelTick()` and M18), so a human must stop the run; a private room has no
  rival pressure; other players' totals must never be scraped.
- **Testable in Phase 3: Yes** — 50-prompt room, record depth at prompt 7/25/50
  and final standing (own row only).

### S4 — Most-populated room is a trap for score rate

- **Predicted effect:** population does not change our own grade — everyone sees
  the same prompt and answers are graded independently, and a duplicate answer
  earns both players the same points. A crowded room can only add waiting
  ("Waiting for N more · answers in Ns") and competition for a limited number
  of seats. Choose `showoff` only when the goal is beating more people on the
  room board.
- **Evidence:** FAQ (same prompt, all answers shown, up to 40);
  `WEB` 1v1 guide ("You can never lose an answer to your opponent by typing it
  second"); `CODE` `joinLobbyRoom()` argmax count, full disabled; `BUNDLE`
  `.kr-board-note`; `STATES-MP-DUEL` M06. The population→settle-time link is
  `hypothesis` (no live timing was taken).
- **Risk:** argmax may select a nearly-full room with long settles; `Full` rows
  cannot be joined; empty/unknown counts parse as 0; counts can change between
  500 ms ticks.
- **Testable in Phase 3: Yes** — measure inter-round ms at low vs high counts,
  and own depth/prompt (should be unchanged).

### S5 — Duel: count-in planning, rare-first, safe buzzer fallback

- **Predicted effect:** spend the 3 s count-in choosing a specialist/regional/
  smallest-true answer, submit it first because refusals are free, and keep a
  confident banked answer typed so the buzzer still submits something. Points
  dominate; a 100 is worth ten Planktons and speed cannot compensate.
- **Evidence:** `WEB` 1v1 guide (3 s count-in, 15 s answer, "take the long shot
  first", typed answer submitted at the buzzer); FAQ (first accepted answer ends
  the prompt, refusal costs only time); `BUNDLE` `eo`; `CODE` T19 fill+120 ms
  submit; `DATA` ≈3.69 banked 100s per prompt.
- **Risk:** live answer lookup cannot finish in 15 s; AI grading of unknown
  answers is inconsistent; whether a previously refused typed answer is graded
  at the buzzer is `hypothesis`; time spent hunting can cost a points-tie
  tiebreak (frequency `hypothesis`). No play-score demotion.
- **Testable in Phase 3: Yes** — 7-prompt duels, record first-submit tier,
  refusals, retries, and final points vs opponent points (own row only).

### S6 — Duel: protect rating (tab rule, one tab, no post-start leave)

- **Predicted effect:** avoids a near-certain loss. At equal 1,000 ratings a
  loss is ≈ −25 Elo (`nu(1000,1000,0,50)`), a win ≈ +25; from 1,250 Elo a tab
  out is an opponent win by rule. Leaving before the start does not cost rating
  but imposes a queue wait.
- **Evidence:** `BUNDLE` `tabout:1250`, `abandon:45e3`, `eE()` text ("leaving
  this tab … counts as a forfeit … Your opponent takes the win"), rotating
  tips "Leave before the start and you wait to queue again" and "Leaving once
  it starts counts as a loss"; `WEB` "forfeits do [count toward the 3/day cap]";
  `CODE` D02/D05/D11 — `duelTick()` accepts `.kd-tab-rule-key` and never clicks
  `.kd-versus-leave` / `.kd-home`.
- **Risk:** competing tabs steal the queue/match (`.kd-elsewhere`); a human
  switching apps at ≥1,250 forfeits; deliberate forfeit tests are unsafe.
- **Testable in Phase 3: Partial** — rule acceptance, `.kd-elsewhere` claim and
  leave-before-start are harness-testable; do not live-test an actual forfeit.
  Mark such a test `REJECTED — untestable` per the Phase 3 gate.

### S7 — Duel: requeue cadence and stop-loss

- **Predicted effect:** with a positive win edge, immediate `.kd-again` keeps the
  K=50 compounding; a stop after consecutive losses limits variance-driven Elo
  bleed. The stop-loss threshold is `hypothesis`, not a game rule.
- **Evidence:** `BUNDLE` `k:50`, `nu()` expected-score term, `rematch:3` and
  "Beat a higher rating, take more of it"; `WEB` opponent near rating, 3 rated
  matches/24 h per pair, forfeits count; `CODE` D09 auto-requeue.
- **Risk:** requeue after a win raises your rating and therefore opponent
  strength; a 3/day cap against the same diver redirects the queue; auto-requeue
  means "leave" must be a user action, not a bot action.
- **Testable in Phase 3: Yes** — record Δ rating and foe rating for N matches,
  check requeue behaviour at the 3-match cap.

### S8 — Calibrate refusal risk to the clock

- **Predicted effect:** in a 5 s room, take the banked 100 immediately — a
  refused long shot can eat the entire window. In a 15 s duel or 30–60 s room,
  a refused long shot still leaves time for the safe answer, so the expected
  points of trying the rare answer are higher.
- **Evidence:** FAQ and `WEB` ("a refusal costs you only time", "take the long
  shot first"); `BUNDLE` room 5–60 s and duel 15 s clocks; `CODE` `checkRefusal()`
  clears the input and re-enables it.
- **Risk:** a late refusal in a duel can turn a points tie into a lost time
  tiebreak (`hypothesis`); repeated refusals are logged as `prompt-review:refused`
  and `evidence:refused` but never as demotions.
- **Testable in Phase 3: Yes** — count refusal→accepted retry by room clock.

## Requeue vs leave — decision table

| Situation | Bot action | Cost | Source |
| --- | --- | --- | --- |
| Duel result shown | Click `.kd-again` (Find another match) | None; may be redirected after 3/day vs same foe | `CODE` D09; `WEB` |
| `.kd-versus` (match found, not started) | Wait; **never** click Leave before the start | Leaving → queue wait, no rating change | `CODE` D05/D11; `BUNDLE` tip |
| Match in progress | Stay on this tab; accept tab rule; claim `.kd-elsewhere` only if the queue/match was lost to another tab | Leaving or tab-out → loss / forfeit (≥1,250 Elo) | `BUNDLE` `eE()`; `CODE` D02/D10 |
| Multiplayer room mid-dive | Let the bot keep diving; Leave is a user action only | Leaving forfeits accumulated standing for that room (`hypothesis`) | `CODE` M18; `WEB` game-night |
| No 5s room has a free seat | Wait (no fallback) | Lost diving time; no rating effect | `CODE` `joinLobbyRoom()` |

## Other-player effects — verified and prohibited

- **Scoring:** none. Same prompts, independent grading, no answer stealing; if
  both players give the same Deep Cut, both score it (`WEB`). Opponent speed
  affects only the points-tie time tiebreak, which is computed from our own
  scoring answers.
- **Board/chat/emotes:** context only. `.kr-board-head` may read "X went
  deepest … +30" — that is **another player's** points and is never parsed as
  our score (`DECISIONS.md` #7). Chat and emotes are never read or forwarded.
- **Duel result:** `.kd-result-diver[data-side="foe"]`, rating deltas and
  opponent identity are never archived. Only our own submissions/refusals and
  `source: api` graded banks enter the archive.
- **Why it matters for rank:** AI-graded arbitrary answers are inconsistent;
  recording another player's answer would inject false "100" evidence and
  could drive bad bank edits. The prohibition protects the archive, not the
  opponent.

## Phase 3 handoff notes (W3-C)

1. Test S1 first: it is the only strategy with a directly computable expected
   point delta (100 vs ≈77.5 per prompt) and it applies to every room/duel.
2. Test S2/S4 room choice with the same cached prompt bank; record elapsed ms,
   prompts answered, own depth and seat count. Do not read other rows.
3. Test S5/S7 in duels; log Δ rating, foe rating, tier per prompt, refusals.
4. Do not live-test S6 forfeits. If a mechanic cannot be safely tested, write
   `REJECTED — untestable` with the reason in `STRATEGY-VERIFIED.md`.
5. Every proof file must assert: zero play-score demotions, zero other-player
   answer rows, near-duplicate banks kept separate.

## Scoped check (exact output recorded after writing)

Commands run in this worktree only; no full test suite.

```powershell
Select-String -Path injection/STRATEGY-MP-DUEL.md -Pattern '^\| \*\*[1-8]\*\*' | Measure-Object | Select-Object -ExpandProperty Count
Select-String -Path injection/STRATEGY-MP-DUEL.md -Pattern 'Testable in Phase 3' -SimpleMatch | Measure-Object | Select-Object -ExpandProperty Count
Select-String -Path injection/STRATEGY-MP-DUEL.md -Pattern 'hypothesis' | Measure-Object | Select-Object -ExpandProperty Count
Select-String -Path injection/STRATEGY-MP-DUEL.md -Pattern 'Never demote|never demote|no play-score demotion|no demotion' | Measure-Object | Select-Object -ExpandProperty Count
Select-String -Path injection/STRATEGY-MP-DUEL.md -Pattern 'other player|Other player|other-user' | Measure-Object | Select-Object -ExpandProperty Count
```

Exact output of the five commands above, in order:

```text
8
12
20
7
5
```

Interpretation (counts are matching lines, not token occurrences): 8 ranked
strategies; 12 "Testable in Phase 3" lines (one table header + 8 strategy rows
+ supporting notes), including two qualified "Partial"/"REJECTED — untestable"
notes; 20 lines carrying explicit `hypothesis` markers; 7 no-demotion lines; 5
other-player prohibition lines. Zero shop strategies.
