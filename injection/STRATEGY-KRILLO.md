# Krillocity strategy — maximising daily-race score and rank (Phase 2 / W2-C)

Research note, 2026-11-27. **Evidence-only for this workstream.** This file proposes
strategies; it changes no code, demotes no answer from a play score, and records
nothing about other players. Owner: W2-C, isolated worktree `p2-krillo`
(branch `feat/p2-krillo`); this is its only owned file.

## 0. Evidence labels and authority

- `[live]` — copy fetched 2026-11-27 from the game itself:
  `https://playdaily.org/krillocity`, plus the linked guides
  `/resources/stories/krillocity-daily-race` and
  `/resources/stories/how-to-win-at-krillocity`. This is the game's own description
  of clocks, tiers, judging and the report.
- `[code]` — `injection/krillion-autofill.user.js` v1.1.2 and `injection/bridge.py`
  as present in this worktree, with line numbers.
- `[data]` — counts measured directly from `data/tier-data.json` (schema 2,
  2,879 prompts / 50,573 answer rows), `data/answers_gameplay.jsonl` and
  `data/answers_injection.jsonl`.
- `[hypothesis]` — plausible but **unverified**; every such claim is also listed in
  §4. Do not treat it as established.

Authority order: live `/krillocity` page > the two linked guides > code > data.
The guides are not perfectly consistent with the game page: a search snippet for
`/resources/stories/how-to-play-krillocity` says "after three prompts" and another
guide says Plankton is "40 m", while the live game page says **7 prompts** and
**10 m per point** (100 m for the commonest answer). This note uses the live game
page. No live interactive play was available to this subagent (no browser tool was
exposed), so no row below claims a live DOM observation; DOM behaviour is `[code]`.

## 1. How score and rank actually work (the target function)

### 1.1 Tiers and accumulation

Seven tiers? No — six grades, from the game's own table `[live]`:

| Tier | Points | Metres (10 m per point) |
| --- | --- | --- |
| Plankton | 10 | 100 |
| Too Clever | 15 | 150 |
| Schooler | 30 | 300 |
| Rare | 60 | 600 |
| Deep Cut | 85 | 850 |
| One in a Krillion | 100 | 1,000 |

- `prompt_points = sum of tier points of unique accepted answers to that prompt`;
  `total_points = sum over the 7 prompts`; `distance_m = 10 * total_points`.
  "Answers add up, so several common answers can keep pace with one rare find.
  Your distance after the last prompt is your score." `[live]`
- The game's own worked example: 5 Plankton (50) + 2 Too Clever (30) + 1 Schooler
  (30) + 1 Rare (60) + 1 Deep Cut (85) = **255 points / 2,550 m from 10 answers in
  30 s**; one Deep Cut (85) outweighs five Plankton (50), and one Krillion (100)
  equals ten Plankton. `[live]`
- The same answer counts once, including plural/spelling variants; a refused
  answer scores nothing and "costs only the seconds it took to type". `[live]`
- Answers outside the bank go to an AI judge that fits them to a tier; small typos
  are usually accepted. `[live]`
- Scoring is **server-authoritative**: "the board counts each try once, from the
  answers the server judged as you raced, never from a number your page sends."
  `[live, daily guide]`

### 1.2 Throughput and latency mechanics

- Each prompt shows for a **~2 s count-in**, then a **30 s clock**; the next prompt
  is dealt after the clock; **7 prompts**; the daily is one try, same prompts for
  everyone, reset at 00:00 UTC. `[live]`
- "Type short and press Enter after every answer. You never wait for a verdict:
  the box clears straight away, **up to three answers are with the judge at once
  and the rest queue behind them in order**." `[live, how-to-win guide]`
- "An answer already with the judge when the clock hits zero still counts if its
  verdict lands **within two and a half seconds**." `[live, how-to-win guide]`
- Each player's use of the AI judge "runs on an allowance that refills over time".
  Exact size and refill rate are **not published** `[hypothesis]`.
- Prompts are dealt easiest first; the seventh is usually the hardest to fill.
  `[live, how-to-win guide]`

### 1.3 Race end and rank

- After prompt seven: TIME / FINISH. The daily report shows the day's number,
  distance, exact top-ten place **or** "Higher than X% of racers today", one row
  per prompt with best answers in tier colours, the day's top ten, and the reset
  countdown. A share line looks like `3,450 m / 21 answers in 7 prompts`.
  `[live, daily guide]`
- The percentile graph bands distances into **250-point / 2,500 m** buckets and
  appears only after at least 100 finishers; only a complete seven-prompt run gets
  a pin or a place; the board refreshes about every half minute. `[live, daily guide]`
  Whether the printed percentile is computed from exact or banded distance is
  `[hypothesis]`.
- The **daily pays no tokens and no leaderboard points — only the standing**.
  Multiplayer is where finishing place pays 2,350 tokens per scoring racer behind
  (up to 11) plus 1,150 for the win, and 3/2/1 podium points. `[live]`
- Practical consequence: for the daily, the only objective is **total points**
  (equivalently total metres). There is no partial-credit trick, no pass key, and
  no benefit to answer *count* except through points.

## 2. Current script baseline (what we are optimising)

From `injection/krillion-autofill.user.js` and `injection/INTERACTIONS.md` /
`injection/STATES-KRILLO.md` `[code]`:

- Krillocity is detected by path `/^\/krillocity\/?$/`; `START DAILY` is clicked by
  `startMode()` (lines 1915–1934), then the race is driven entirely by the
  self-scheduled `race*` helpers (lines 1644–1775) while the 500 ms `botTick`
  remains untouched. This implements the one-prompt-at-a-time, type-as-many-as-you-
  can flow the game describes. `[code]` + `[live]`
- **Cadence:** `SUBMIT_GAP = 50` ms from native-setter fill to `submitAnswer()`,
  `STEP_GAP = 90` ms from submit to next fill (lines 1753–1754), with `raceSchedule`
  retries of 80 ms while answers are loading and 150 ms when the pool is drained
  (lines 1742, 1750). Ceiling ~11 submissions/s after the first. The old 700 ms
  per-answer throttle is gone. `[code]`
- **Pool order:** `raceBuildPool()` (lines 1665–1693) takes `groups[0].answers`
  (the rare 100-point bank) first, then `state.tierPremap` answers parsed by
  `parseTierAnswers()` and sorted by points descending (85 before 60/30/15/10).
  Near-duplicate banks are never merged: only `groups[0]` is used and aliases are
  never applied to matching. `[code]`
- **Null points default to 85** via `tierPointsOf()` (lines 1537–1549), so the
  "85" block is mostly ungraded low answers, not only graded Deep Cuts. `[code]`
- **Dedupe:** `seen` within the pool, plus `refusedAnswers`, `submittedForPrompt`
  and `raceSubmitted` keyed by `prompt + NUL + answer` (lines 1668–1676,
  1702–1709, 1755–1757). A prompt **text** change clears the no-repeat sets; a
  bare React input remount keeps `raceSubmitted`, preventing duplicate submits.
  `[code]`
- **Guards:** `!bot.on || bot.roundClosed`, or missing prompt/input, cancels the
  burst (lines 1714–1717); results/verdict handling stays with the other stream.
  `[code]`

### 2.1 The binding constraint is supply, not cadence

`[data]` + `[code]`: the tier snapshot is capped at **20 answers per prompt**
(median 20, 86.8% of 2,879 prompts at exactly 20, maximum 20); the rare bank in
`answers_gameplay.jsonl` has median **8** per prompt (mean 7.13, maximum 10,
suggesting a scrape cap `[hypothesis]`). So the usable pool is roughly **27 answers
per prompt**. At a 90 ms step that drains in about **2.4 s of the 30 s clock** —
roughly 90% of every prompt is idle. The 50/90 ms cadence is already far faster
than the answer supply can sustain, and faster filling cannot create points that
are not in the pool. This finding sets the ranking in §3.

## 3. Ranked strategies

Ranking is by expected marginal points per prompt **at today's data coverage**.
S2–S5 become material only once S1 makes the pool large enough to fill the clock.

| Rank | Strategy | Predicted marginal effect | Risk |
| --- | --- | --- | --- |
| 1 | Expand bank-backed supply per prompt | Highest: adds points to ~90% idle clock | Low if bank-backed |
| 2 | Keep rare → 85 → 60 → 30 → 15 → 10 order + strict dedupe | Protects value of anything that lands | Very low |
| 3 | Hold the 50/90 ms safe cadence | Enables all supply; further speed ≈ 0 gain | Medium if pushed too fast |
| 4 | Submit to the buzzer; use the 2.5 s grace | Recovers late answers | Low |
| 5 | Protect the AI-judge allowance | Avoids wasted allowance/refusal churn | Low–medium |

### S1 (rank 1) — Expand bank-backed answer supply for every prompt

- **Mechanism:** raise the number of *correct, tier-known* answers available per
  prompt (graded 85/60/30/15/10 rows and complete rare banks) before and during
  the daily, so the pool covers more of the 30 s. This is the only lever with a
  large headroom given §2.1.
- **Predicted effect:** near-linear point gain while the clock is idle: each extra
  accepted Deep Cut is +85 pts / +850 m, each extra Krillion +100 pts / +1,000 m;
  ~3 extra Deep Cuts per prompt move the daily result roughly one 250-point graph
  band. `[live]` + `[data]`
- **Evidence:** `[data]` median 20 tier + median 8 rare answers; `[code]`
  `raceBuildPool` / `raceBurst` self-scheduling; `[live]` answers add up, 30 s
  clock, tier values. That additional *banked* answers will be accepted is
  `[hypothesis]` until measured (game coverage of our data is unknown).
- **Risk:** unbanked guesses can be refused or burn the AI-judge allowance; wrong-
  bank near-duplicates can produce a run of refusals. Mitigation: only import
  answers from the game's own graded banks / verified scrape sources; never
  demote a 100 from a play score; keep near-duplicate banks separate.
- testable in Phase 3: **yes** — compare accepted answers and points per prompt
  before/after a supply increase on the same prompt set; success = more accepted
  answers with no rise in refused-answer rate.

### S2 (rank 2) — Keep rare-100 first, then 85/60/30/15/10, with strict dedupe

- **Mechanism:** retain the current `raceBuildPool` ordering and all three de-dupe
  sets. Because a large backlog would be judged in submission order and verdicts
  can land up to 2.5 s after the buzzer, the highest-value answers should be the
  ones already with the judge when time expires. `[code]` + `[live, how-to-win guide]`
- **Predicted effect:** small but strictly positive when the queue is non-empty;
  zero when the pool drains early (today's case). Prevents duplicate submits,
  each of which would otherwise waste one slot and add nothing (game counts a
  repeated answer once). `[live]`
- **Evidence:** `[code]` lines 1662–1693, 1702–1709, 1755–1757; `[live]` tier
  table and "the same answer only counts once"; `[live, guide]` in-order queue.
  That the game's queue is strictly FIFO under bot-scale cadence is `[hypothesis]`.
- **Risk:** if a matched bank is a wrong near-duplicate, rare-first ordering
  front-loads refusals. Policy forbids filtering by play score and applying
  aliases, so the safe response is logging for review, not mutation.
- testable in Phase 3: **yes** — log submitted order vs accepted tier per prompt
  and check that the last-counted answers are the high-tier ones under an
  artificially large pool.

### S3 (rank 3) — Hold the fastest *safe* cadence (50 ms fill / 90 ms step)

- **Mechanism:** keep the current self-scheduled burst; never restore the 700 ms
  throttle, and do not shorten the 50 ms fill→submit gap. The gap exists so React
  registers each input before submit; the 90 ms step keeps every answer inside the
  clock even for a full pool. `[code]`
- **Predicted effect:** all available bank answers are submitted well inside
  30 s. Making it faster has **near-zero** marginal gain while supply-limited
  (§2.1); making it slower than ~700 ms would strand answers. `[code]` + `[data]`
- **Evidence:** `[code]` lines 1753–1773 and `CONTRACT-MODES.md` Stream B
  ("~40–90 ms so React sees each input"); `[live, guide]` three answers in flight,
  rest queued — the current cadence sits inside that window. That 50 ms is the
  *minimum* safe React gap, and that >3 in-flight answers are dropped or delayed,
  are both `[hypothesis]`.
- **Risk:** faster fills risk unregistered input / duplicate submits; very high
  volumes of AI-judged answers may exhaust the judge allowance `[hypothesis]`.
  The 80/150 ms retry backoff already avoids hammering an unavailable bridge.
- testable in Phase 3: **yes** — A/B the accepted-minus-submitted delta at
  50/90 ms versus a slower and a faster setting; success = equal or better
  accepted count with no duplicate/refusal increase.

### S4 (rank 4) — Submit to the buzzer and claim the 2.5 s verdict grace

- **Mechanism:** keep bursting until the prompt boundary, including the last
  10 s when easy answers are gone for everyone; rely on the documented grace for
  answers already with the judge at zero. In the daily there is no Pass key and
  every prompt runs its full 30 s, so easing off is pure loss. `[live]`
- **Predicted effect:** recovers answers that would be lost to an early stop;
  especially relevant on the last (hardest) prompt. `[live, guides]`
- **Evidence:** `[live, how-to-win guide]` "keep typing to the buzzer", 2.5 s
  grace; `[live, daily guide]` no Pass key, full 30 s, leave-after-queued-answers
  behaviour; `[code]` boundary detection at 1721–1735 cancels the burst only on a
  real prompt change. Whether the bot actually keeps a tail of in-flight answers
  past the buzzer is `[hypothesis]` (the queue depth is client-invisible).
- **Risk:** if the queue is longer than the judge can clear in 2.5 s, tail answers
  may be dropped `[hypothesis]`; no score penalty is documented, only lost time.
- testable in Phase 3: **yes** — count verdicts attributed to a prompt that land
  in the 2.5 s after its clock, and compare last-10 s answer counts.

### S5 (rank 5) — Protect the AI-judge allowance: prefer bank-known answers

- **Mechanism:** the pool is already bank-backed (rare bank + tier snapshot), so
  keep it that way. Do not fill idle clock with speculative nonsense just to
  increase answer count; a refused answer scores zero and consumes typing time,
  and the judge allowance is finite and refills over time. `[live, guide]`
- **Predicted effect:** avoids wasting the judge allowance on answers unlikely to
  count, preserving it for plausible unusual answers late in a prompt; protects
  against refusal churn. `[live]`
- **Evidence:** `[live, how-to-win guide]` "each player's use of that judge runs
  on an allowance that refills over time. Spend it on answers you believe in";
  `[live]` "a refused answer costs only the seconds it took to type"; `[code]`
  `refusedAnswers` filtering at 1673/1687/1705. Allowance size, refill rate and
  whether bank-known answers consume it at all are `[hypothesis]`.
- **Risk:** overly conservative filtering could leave clock idle; but today the
  pool already drains early, so the cost is low until S1 lands more answers.
- testable in Phase 3: **yes, partially** — track refused-answer rate and any
  visible "judge busy" behaviour across a daily; allowance size itself is only
  observable through repeated play `[hypothesis]`.

## 4. Hypothesis register (unverified — do not act on as fact)

| # | Hypothesis | How to falsify in Phase 3 |
| --- | --- | --- |
| H1 | Rare bank capped at ~10 answers/promp is a scrape cap, not game truth | Compare with game's own graded bank at results |
| H2 | Additional banked answers will be accepted at their listed tier | Log accepted tier for newly supplied answers |
| H3 | Game's judge queue is strictly FIFO; >3 in flight delays the tail | Correlate submit order with verdict order/timestamps |
| H4 | 50 ms is the minimum safe React fill→submit gap | A/B fill gaps; measure unregistered/duplicate submits |
| H5 | AI-judge allowance is finite, refills, and may be hit by bot-scale volume | Watch refusal/judge responses over a full daily |
| H6 | Percentile uses exact distance, not 250-point bands | Compare printed percentile with known finisher distances |
| H7 | Null-tier answers defaulting to 85 are actually graded 85 by the game | Read the game's graded bank for those answers |
| H8 | Bot retains a tail of in-flight answers past the buzzer | Timestamp verdicts in the 2.5 s grace window |

## 5. Phase 3 measurement plan (not executed here)

Per prompt, capture: answers in pool, submissions, accepted answers, refused
answers, tier of each accepted answer, points, in-flight count if observable, and
verdicts in the 2.5 s grace window. Run at least one named control daily before
changing anything. Success criteria: **higher total points / percentile** with no
increase in refused-answer rate and no duplicate submissions. Keep all logs
scoped to our own answers and our own bot decisions.

## 6. Non-goals and guardrails

- **No play-score demotion.** A low score from play is evidence only; only the
  game's own graded bank may change the rare tier (`DECISIONS.md`).
- **No other-player logging.** Never read a shared board head or rival answer as
  our score or record rivals' answers. The daily report's top ten is not a data
  source.
- **No alias application and no bank merging.** Near-duplicate prompts stay
  separate labelled banks; aliases/rewordings are logged, never applied to
  matching.
- **No code, bridge, or site changes in this workstream** — this document is the
  whole deliverable.
