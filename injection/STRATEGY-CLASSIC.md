# Classic strategy — maximise score, depth and rank

I wrote this Phase 2 research note on 2026-11-27 as worker W2-B on branch `feat/p2-classic`.
I scoped it to **solo Classic only** (7 prompts × 25 s). I proposed no multiplayer/1v1 data, no
other-player answers, and no play-score demotion anywhere here.

## Evidence legend and policy guard

| Mark | Meaning |
| --- | --- |
| **[O]** | Official `playdaily.org/krillion` FAQ/live page, fetched read-only 2026-11-27. Authoritative for rules. |
| **[S]** | Static-verified in `krillion-autofill.user.js` v1.1.2 via `injection/STATES.md` and `injection/INTERACTIONS.md` (Phase 1 inventory). |
| **[L]** | Live-observed in the game on 2026-11-23 (`STATES.md`). |
| **[D]** | Derived from repo data/docs (`README.md`, `DECISIONS.md`, `GOD-DISTRIBUTION.md`, `GOD-PRELOAD-CONTRACT.md`, `data/manifest.json`, `data/answers*.jsonl`). |
| **[3P]** | Third-party strategy guide from web search (divekrillion.com, krilliontoday.com, krillionunlimitedgame.net). Unofficial → every specific claim from these is tagged `hypothesis`. |
| `hypothesis` | Not directly verified in the official rules, the code, or the local data. Treat as a Phase 3 test candidate, not a fact. |

**I applied this policy guard (DECISIONS.md #1, #5, #7; STATES.md rules 1–3).** I treated a low play
score or a refusal as **evidence only**; I let only the game's own dive-end graded
bank change the rare tier. I kept near-duplicate prompts as separate banks
and aliases logged, never applied to matching. I never read Other players' DOM rows
and board text as our score. The Strategies below changed *answer
selection*, never the database.

## 1. The verified Classic contract

| Fact | Value | Source |
| --- | --- | --- |
| Dive shape | 7 prompts, 25 s each; "Begin descent" → Dive to submit | [O], [S: C2–C5, C12] |
| First accepted answer | **Ends the prompt immediately** — one graded answer per prompt, no combos | [O] rule 3; [S: C7→C9→C11] |
| Refusal | Costs only time; prompt stays open; retry until clock expires | [O] FAQ; [S: C8] |
| Clock-out | An answer still in the box when the clock runs out **is submitted for you** | [O] FAQ |
| Speed bonus | **None** — answering in 2 s and 20 s score the same | [O] FAQ, [O] scoring article |
| Scoring | Rarity only: bank grade if in bank, else AI grade saved for everyone | [O] FAQ |
| Tiers | Plankton 10 / Too Clever 15 / Schooler 30 / Rare 60 / Deep Cut 85 / One in a Krillion 100 | [O], [S: C16] |
| Depth conversion | 1 point = 10 m; **perfect dive = 700 pts = 7,000 m** | [O], [S: C12] |
| Uniform-tier benchmarks | 7×Plankton 700 m · 7×Schooler 2,100 m · 7×Rare 4,200 m · 7×Deep Cut 5,950 m · 7×Krillion 7,000 m | [O] tiers + arithmetic; [3P] same figures (`hypothesis` on third-party copy) |
| Prompt bank | 6,142 distinct prompts; none repeats until all have been played | [O] FAQ, [D] `manifest.json` |
| Deck exhaustion | Harvest ended 2026-11-21 when new prompts stopped; "dive is over" | [D] README |
| Depth tokens | 1 token per metre in every mode (so 7,000 tokens on a perfect dive) | [O] FAQ |
| Difficulty | `/deal` prompts carry a `level` field | [D] `data/scrape-notes.md` |
| 1v1 / rooms (excluded) | 1v1 = 7 prompts at 15 s, rating; rooms = 5–50 prompts at 5–60 s, speed breaks ties | [O] FAQ — context only, never used for Classic scoring |

## 2. Mechanics that decide the score

### 2.1 One accepted answer per prompt → additive, no combo play
I found that, because the first accepted answer closes the prompt [O][S: C7/C9/C11], a dive
was the **sum of seven independent single choices**. I saw no benefit to
holding answers, no partial credit for a near miss, and no way to recover a
prompt after a low grade. I aimed to maximise the expected tier of *the one answer that
would be accepted*, prompt by prompt. `hypothesis`: because prompts never
repeated within a lap [O], cross-prompt answer budgeting (saving a rare answer
for later) had no mathematical value.

### 2.2 Rarity-only scoring → time is a resource, not a bonus
I found Speed earned nothing [O], so the 25 s existed purely to move past the crowd's
answers. I read the Official method [O] "How to find the uncommon answer in 25 seconds":
(1) say the obvious answer and bin it; (2) bin the second one too; (3) change
the angle — another country, era, or field you know; (4) stay inside the prompt
so the answer is accepted. Official FAQ also says to set aside the first two
answers that come to mind and pick the rarest one you are **sure** is correct.
`hypothesis` [3P]: "Too Clever" is a focal-point trap — the second clever idea
is what everyone who skipped the prototype also picks; "one to two rungs down
the generality ladder" is the sweet spot; longer, more exact answers (species
not animal, full name not surname) land deeper.

### 2.3 Time spent per prompt
I found the official rules gave no per-prompt timing target beyond 25 s [O]. The decision
rule I used: **Easy/Very easy → spend the clock hunting** (obvious answers
are packed); **Hard/Very hard → secure an accepted answer early**, then walk
the set in order (map coast-to-coast, timeline decade-by-decade) rather than
waiting for inspiration. `hypothesis` [3P]: the "three-second count-in" reveals
the level before the dial starts; an anchor answer (a rare-but-valid default
per category) should be banked so a blank never happens. Local note [L]:
filling during a countdown frames could hang because the input was not mounted —
I had `gameState()`/`visible(SEL.input)` gating in the bot avoid this
([S: C4/C6], `data/gameplay-notes.md`).

### 2.4 When to refuse and when to retry
I found a refusal was **free except for seconds**: the prompt stayed open and retries
continued until the clock expired [O][S: C8]. I therefore never accepted a candidate
I was not confident was correct — I refused it and tried the next one. Two
caveats: (a) a reach that lands outside the bank scores 0, so "rarest you can
imagine" loses to "rarest you are sure of" [O]; (b) the box was **auto-submitted
at clock-out** [O], so an unvetted answer left in the input at 0:00 became your
grade — I cleared it or committed before expiry. `hypothesis` [3P]: in the solo
Classic path a Pass control is not described by the official rules (Pass is
documented for Endless and rooms), so I assumed only refusals and clock-out.
I logged Every refusal as `prompt-review:refused` + `evidence:refused`; it
**never demoted** an answer [S: T22, DECISIONS #1].

### 2.5 Preloaded rare answers vs low-tier fallback
I had the script preload 21,384 graded 100-point answers from `/api/all` into
`state.premap` at mount, so an exact prompt match was instant [S: T09/T11, D].
I had Low tiers (10–85) come from `/api/all-tier` into `state.tierPremap`, fetched in
parallel; if a prompt had no low-tier entry I had it **use the rare
list rather than stall** [S: T10/T19, D: GOD-PRELOAD-CONTRACT]. Local data [D]:
128,161 graded rows in `data/answers*.jsonl`; 21,543 (16.8%) are 100-point;
5,801 of 6,142 prompts (94.5%) have at least one graded 100 — so the exact-100
preload covers the large majority of prompts, and the fallback matters on the
remaining ~5.5% plus fuzzy/ambiguous matches. `hypothesis`: a random bank answer
would expect at most 87.5 pts even if every non-100 were an 85 (and as little as
25 pts if they were all Plankton), so selecting the flagged 100 is a strict gain
whenever the bank matches the on-screen prompt. The Full DB has **no points/tier
column**, only `is_krillion` [D: GOD-DISTRIBUTION], so low-tier frequencies come
only from `learned.jsonl` (1,043 tiered rows of 4,920).

### 2.6 Depth and rank
I found Depth = points × 10, and nothing else changed it — not speed, not reach
[O]. In solo Classic there was no opponent: **rank was simply total depth**
(the per-prompt squares fill with the tier's colour, and multiplayer's "deepest
diver wins" uses the same depth). `hypothesis`: leaderboard rank bands above a
given depth are not published in the official FAQ, so I asserted no specific rank threshold
here. I excluded Speed, a tie-break only in rooms and 1v1 [O], from this document. I also left out Endless, which continues to 250 km and uses air tanks [O].

### 2.7 Bank-expansion timing (already implemented)
I required Capture to finish before the dive restarted, and it already did:
`finalizeClassicResults()` gated "Play again" on capture settled + all
`.kr-row-head` expanded, with a hard cap of 2,200 ms (400 ms if no rows), then
emitted one `classic-bank-capture` bot-log and clicked restart [S: C13–C18,
T16–T17]. I imported only `[data-me]` own rows and site API banks [D:
DECISIONS #5]. I kept this gate intact — a restart before capture would lose
the dive's graded bank. I proposed no change here; this was a preservation
strategy (S4).

## 3. Ranked strategies

I ranked them for the stated objective: **maximise Classic score / depth / rank**.
I marked all five `testable in Phase 3: yes`.

### S1 (rank 1) — Exact-match 100-point preload first ("authoritative rarest")
**Mechanic.** On each prompt, resolve `keyFor(prompt)` against `state.premap`
(`/api/all`) and, on an **exact** bank match, submit the flagged 100-point
answer as the single accepted answer. Because the first accepted answer ends
the prompt [O], no other answer needs to be held. Auto-choose only when the
match is exact and singular; if several near-duplicate banks match or the
fuzzy score is weak, pause auto-pick and require a manual bank choice (already
the policy in DECISIONS #4/#8).

**Predicted effect:** 1,000 m per matched prompt — the per-prompt maximum;
seven matches = 700 pts = 7,000 m. Since 94.5% of prompts have a graded 100
[D], this puts most dives near the ceiling. Versus a random bank answer, whose
expected value is bounded at ≤87.5 pts even under the most favourable low-tier
assumption [D + arithmetic, `hypothesis` on the distribution], exact-100
selection is a strict depth gain.

**Evidence source:** [O] FAQ rule 3, tiers and "speed earns nothing"; [S] C5,
C12, T09/T11; [D] `manifest.json` counts, local distribution count, README
tally, DECISIONS #4.

**Risk:** A near-duplicate/wrong bank can yield a low play score; that is
evidence only and I kept it from ever demoting a stored 100 [D: DECISIONS #1].
Ambiguous multi-bank prompts need a manual choice, which costs clock time.
No AI-graded out-of-bank guess is involved, so the main variance is bank
identity, not grading.

**`testable in Phase 3: yes`** — A/B per dive (exact-100 pick vs tier-greedy
fallback); compare mean depth and the per-prompt tier histogram.

### S2 (rank 2) — Tier-greedy preloaded fallback (highest graded tier)
**Mechanic.** When no exact 100 exists (≈5.5% of prompts [D]) or the rare
premap misses, resolve `state.tierPremap` (`/api/all-tier`) and pick the
**highest graded tier available**: Deep Cut 85 > Rare 60 > Schooler 30 >
Too Clever 15 > Plankton 10 [D: GOD-DISTRIBUTION]. If the tier map has no
entry, use the rare list instead of stalling on "loading 85-point answers"
[S: GOD-PRELOAD-CONTRACT]; only then fall back to the async `/api/answers-tier`.

**Predicted effect:** 850 m for a Deep Cut; seven Deep Cuts = 595 pts =
5,950 m (85% of perfect). On a no-100 prompt this converts a floor-tier answer
into 85 or 60 — one Deep Cut instead of one Plankton is +75 pts / +750 m on
that prompt. Synchronous premap lookup removes the 500 ms tick + HTTP stall
that could otherwise eat clock time [S: T10/T19].

**Evidence source:** [S] T10, T19, GOD-PRELOAD-CONTRACT §Userscript; [D]
GOD-DISTRIBUTION tier map, `tier-data.json` contract, local no-100 prompt
count; [O] tier point values.

**Risk:** Low-tier coverage is partial (2,538/5,801 archive prompts have any
low-tier answer; only 24 exact Deep Cuts in `learned.jsonl` [D:
GOD-PRELOAD-CONTRACT]), so many prompts fall through to the async path or the
rare list; the forever-retry backoff (up to 30 s) can outlast a 25 s clock.
Unknown-answer AI grades were inconsistent, so I trusted only bank-graded entries;
a low grade never demoted [D: DECISIONS #1].

**`testable in Phase 3: yes`** — compare mean depth on no-100 prompts under
tier-greedy vs random pick, and count async stalls vs synchronous hits.

### S3 (rank 3) — Confidence-gated refusal/retry with clock budgeting
**Mechanic.** I held back the first available answer. I spent the clock to get
past the prototype and second-focal answers [O]; I refused candidates that were
not confidently correct (the prompt stayed open and retries were free) [O][S:
C8]; I submitted the rarest answer I was **sure** was correct. For Hard prompts,
I banked an accepted mid-tier answer before the clock got short; for Easy prompts,
I hunted longer (`hypothesis` [3P] on reading the level from the count-in). I cleared
the input before 0:00 if I did not intend to commit, because clock-out
auto-submitted [O]. For the bot: I let the `/api/all` preload race resolve
(≤2,500 ms [S: T11]) before filling, so a premature low-tier fallback could not
steal a rare answer.

**Predicted effect:** Raises mean tier by screening out Plankton/Too Clever
candidates and turns out-of-bank "clever" guesses into free refusals instead
of 0-point accepted blanks; avoids 0-point clock-outs. The bot-side wait costs
at most ~2.5 s of a 25 s prompt [S] and buys access to the instant rare list.

**Evidence source:** [O] FAQ rule 3, refusal FAQ, "How to find the uncommon
answer in 25 seconds"; [S] C4/C8, T11, T19; [3P] count-in/anchor guidance —
`hypothesis`.

**Risk:** Hunting too long risks clock-out auto-submission of an unvetted
answer, or a blank (0 pts); refusals consume seconds; "rarest imaginable"
answers are frequently refused. `hypothesis`: an early anchor (30 pts) beats a
late blank, so greed must be capped by a confidence threshold. I logged Refusals and
low scores as evidence only; they never demoted [D: DECISIONS #1].

**`testable in Phase 3: yes`** — compare mean tier and blank/refusal rates for
immediate submit vs wait-for-preload + confidence gate.

### S4 (rank 4) — Bank-expansion flywheel (protect capture-before-restart)
**Mechanic.** I finished every dive through `finalizeClassicResults()`: haul
toggle → row expansion → `/api/bank` import of own `[data-me]` lines and site
API banks → only then "Play again" [S: C13–C18, T16–T17]. I kept the in-flight
guard, signature gate and 2,200 ms cap intact. Repeating dives expanded the
set of prompts with an exact graded 100, which raises S1's hit-rate on later
dives; every metre also earns a depth token [O].

**Predicted effect:** Compounding future S1 coverage and zero bank loss on
restart; token accrual equals depth (7,000 tokens on a perfect dive). This
does not raise a single dive's score directly — it raises the expected score
of subsequent dives (`hypothesis` on the size of the compounding effect).

**Evidence source:** [S] C13–C18, T16–T17, INTERACTIONS §B; [D] DECISIONS #5,
README final tally; [O] depth-token FAQ.

**Risk:** A 2,200 ms timeout can restart before full expansion and drop rows
[S: T17]; I kept the gate and did not shorten it to save time. Only own rows and API banks were
imported — no other-player DOM data [D: DECISIONS #5]. Already implemented, so
the only risk here is regression.

**`testable in Phase 3: yes`** — assert one `classic-bank-capture` log per dive
with `all_expanded=true`, `timed_out=false`, and rows imported before restart.

### S5 (rank 5) — God-mode Gaussian pick (variety/practice, not peak depth)
**Mechanic.** With `bot.pick = god`, draw a tier via Gaussian σ=1.1 centred on
Deep Cut (85): Plankton 0.05%, Too Clever 0.95%, Schooler 7.54%, Rare 26.04%,
Deep Cut 39.37%, Krillion 26.04%; redistribute an empty group's chance to
85 → 60 → 100 [D: GOD-DISTRIBUTION].

**Predicted effect:** Expected value ≈77.5 pts/prompt ≈775 m; ≈543 pts /
≈5,430 m over seven prompts — about 78% of a perfect dive and ~9% below an
all-Deep-Cut dive (595 pts). Useful for covering all tiers and generating
graded evidence; **inferior to S1/S2 for the max-depth objective**.

**Evidence source:** [D] GOD-DISTRIBUTION table and selection algorithm;
[O] tier points; arithmetic derived from both.

**Risk:** 26% of draws land in ≤30-pt tiers, materially lowering depth;
coverage gaps redistributed probability; AI-grading inconsistency for
non-bank answers, and a low score never demoted [D: DECISIONS #1]. I ranked it last
precisely because it trades depth for variety.

**`testable in Phase 3: yes`** — deterministic distribution harness over many
draws (existing verification requirement) plus mean-depth-per-dive comparison
against S2.

## 4. Skipped / out of scope

- I started no new game and performed no bridge restart; I did not need the browser
  relay because I fetched the official FAQ read-only.
- I did not re-inspect any site JS bundle: no bundles were vendored in this worktree
  (only harvesters and the userscript). I took Scoring facts from the official
  FAQ, repo notes and the userscript inventory instead.
- I excluded Multiplayer, 1v1, Krillocity, Marathon/rooms, shop and depth-token spending
  from scoring claims; I used no other-player data.
- I proposed no play-score demotion, alias promotion, database write or userscript code
  change — this document only selected answers and preserved the
  existing capture gate.
