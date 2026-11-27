# P2-A — Scoring & answer economics (Phase 2 strategy research)

Research note, written 2026-11-27. **Evidence-only: no code, no policy change, no bridge
restart.** This document explains what raises score and rank in Krillion and what is a
trap, so the autofill can spend its one answer per prompt on the right tier. It is the
scoring companion to `DECISIONS.md` (policy), `STATES.md` (state inventory) and
`GOD-DISTRIBUTION.md` (pick weights).

**Two hard guards apply to every strategy below, without exception:**

1. **No strategy may demote an answer from a play score.** A low or refused score is
   evidence only; only the game's own dive-end graded bank may change a tier
   (`DECISIONS.md` #1).
2. **No strategy may record another player's answer or score.** Only our own rows
   (`[data-me]`, `source: own`) and the game's graded banks (`source: api`) enter the
   archive (`DECISIONS.md` #5, #7; `STATES.md` rule 1).

## Evidence labels

- **[EVIDENCE]** = a claim checked against a named source this run: the live page's
  `application/ld+json` FAQ at <https://playdaily.org/krillion> (fetched 2026-11-27),
  the site's Next.js chunks (`2dsh2j7-x58f7.js`, `1teyoxwdggu1p.js`), or a repo file.
- **HYPOTHESIS:** = plausible but unverified by this workstream (no new live game was
  started; the browser relay was offline). Do not treat it as measured.
- Source files: `README.md`, `data/manifest.json`, `data/tier-data.json`,
  `data/scrape-notes.md`, `data/gameplay-notes.md`, `injection/DECISIONS.md`,
  `injection/STATES.md`, `injection/STATES-KRILLO.md`,
  `injection/STATES-MP-DUEL.md`, `injection/INTERACTIONS.md`,
  `injection/GOD-DISTRIBUTION.md`, `injection/CHANGELOG.md`.

## 1. The scoring model — six tiers and the depth conversion

The game's own FAQ and bundle tier table agree exactly. [EVIDENCE] FAQ JSON-LD
"How does Krillion score my answer?" at <https://playdaily.org/krillion>; bundle
`1teyoxwdggu1p.js` module 712867, `score: b.P[0]` … `b.P[5]` with labels
`PLANKTON`, `TOO CLEVER`, `SCHOOLER`, `RARE`, `DEEP CUT`, `ONE IN A KRILLION`;
`STATES.md` row C16; `scrape-notes.md` line 10 (`tierIndex 5 = One in a Krillion`).

| Tier | Index | Points | Depth (points × 10 m) | Bundle blurb |
| --- | ---: | ---: | ---: | --- |
| Plankton | 0 | 10 | 100 m | "Everyone said it. You drift." |
| Too Clever | 1 | 15 | 150 m | "The clever pick. The school thought of it too." |
| Schooler | 2 | 30 | 300 m | "Known, but not the first thing said." |
| Rare | 3 | 60 | 600 m | "Few would reach for that." |
| Deep Cut | 4 | 85 | 850 m | "True obscurity. Few go this deep." |
| **One in a Krillion** | 5 | **100** | **1,000 m** | "Nobody else is down here." |
| NO CATCH / miss | — | 0 | 0 m | "No answer counted for this prompt." |

- **depth = points × 10 metres.** Explicit in the FAQ ("Each point sinks you 10
  metres") and enumerated per tier in the article copy ("Plankton 10 points, 100 m …
  One in a Krillion 100 points, 1,000 m"). [EVIDENCE]
- **Perfect Classic dive = 7 × 100 = 700 points = 7,000 m.** [EVIDENCE] FAQ
  "top score of 700 points"; `STATES.md` C12; `STATES-KRILLO.md` K-07.
- **Speed pays nothing.** "answering quickly earns nothing extra"; "Speed earns
  nothing: the clock only decides whether you answer at all." Time is only a
  tie-break in multiplayer and 1v1. [EVIDENCE] FAQ; bundle keeps `depth` and `speed`
  as separate fields.
- **A refusal costs only time.** The prompt stays open and a retry is allowed until
  the clock expires; "an answer that is not accepted scores nothing." [EVIDENCE] FAQ;
  `STATES.md` row 8 / C8; `STATES-KRILLO.md` K-08; `STATES-MP-DUEL.md` M13.
- The single graded answer bank is per prompt: `POST /api/krillion/deal` deals 7
  prompts; `GET /api/krillion/answers` returns `[tierIndex, answer]` pairs
  (~60 answers/prompt). [EVIDENCE] `scrape-notes.md` lines 9–13; `gameplay-notes.md`
  lines 8–14.

## 2. Payoff of a 100-point answer

- **Immediate:** 100 points = 1,000 m on one answer — 10× a Plankton (10 pt / 100 m),
  +900 m over Plankton, +700 m over Schooler, +400 m over Rare, +150 m over Deep Cut.
  [EVIDENCE] tier table in §1.
- **Currency:** depth tokens are earned "one for every metre you dive, in every mode",
  so a 100 pt answer nominally yields **1,000 depth tokens** (HYPOTHESIS: the game may
  round or cap per dive; the FAQ states the 1:1 rate). [EVIDENCE] FAQ "What are depth
  tokens?"; shop contents are out of scope.
- **Endless:** "a One in a Krillion answer gives one back" — it restores one of the
  three tanks of air, extending the run past 7,000 m toward 250 km. [EVIDENCE] FAQ.
- **Archive payoff:** the Krillion-only DB holds **21,384** One-in-a-Krillion answers
  over **5,801** prompts = ~3.7 per prompt; the Search DB keeps the 100-point answer
  when one exists (6,142 questions); full DB = 127,118 graded answers. [EVIDENCE]
  `data/manifest.json`, `README.md` §"How the data is organized" and "Final tally".
- The panel's God pick weights the 100 pt group at 26.04% and 85 pt at 39.37%
  (deep-cut peak); these are bot behaviour, not game scoring. [EVIDENCE]
  `GOD-DISTRIBUTION.md`.

## 3. Grade stability, AI inconsistency, and why play scores can never demote

- **Bank grades are stable.** If an answer is in the prompt's bank, it takes that
  bank's fixed grade; the graded bank is what the results screen downloads
  (`tierIndex 0..5`). Only this bank is authoritative. [EVIDENCE] FAQ;
  `scrape-notes.md` lines 10–13; `DECISIONS.md` confidence table "Authoritative".
- **The game itself claims AI grades are saved:** "If it is not [in the bank], an AI
  model decides whether it fits the prompt and how rare it is, **and the result is
  saved so that everyone who gives the same answer gets the same score**."
  [EVIDENCE] FAQ JSON-LD.
- **Observed play contradicts that stability for unknown answers.** The project's
  live finding is that "the game AI-grades unknown answers inconsistently; the same
  answer can be 100 once and 30 or 85 the next time" (`DECISIONS.md` #1) and, in
  multiplayer/1v1, "100 once, 60 or 85 later" (#5). HYPOTHESIS: the save is keyed by
  answer version, prompt variant, session or AI model state, or a race in the grade
  write — we have no bundle proof of the key. Both statements are recorded; we do not
  resolve them here.
- **Therefore a play score can NEVER demote an answer.** A low score is ambiguous
  evidence (wrong bank, fuzzy wording, or AI variance), not a correction.
  `DECISIONS.md` #1 and scenario matrix rows A–E: only an exact-match single bank or
  the game's dive-end graded bank (scenario F) may demote; multiple banks shown →
  "ambiguous and likely wrong bank — no demotion"; unparseable points stay `null`,
  never `0`, so a selector drift cannot demote a correct answer (`STATES.md` C16).
  `INTERACTIONS.md` T21 explicitly: "never demote a 100 from a play score, so low
  scores are sent for review instead." [EVIDENCE]
- The shared board head is **other players'** points ("X went deepest: SCHOOLER
  (+30)"); `checkVerdict()` parses it only in classic mode and never in
  multiplayer/1v1. [EVIDENCE] `DECISIONS.md` #7; `STATES.md` row 5 / C10;
  `STATES-MP-DUEL.md` M09, M14, D07.
- **Aliases are never pinned.** A 100 on a fuzzy bank logs an alias candidate; it is
  promoted only after 2 distinct answers from that bank score 100 on the same prompt
  and no other bank does. [EVIDENCE] `DECISIONS.md` #2 and scenario rows B/C/D/I.

## 4. How score maps to rank / leaderboard

| Mode | Rank signal | Tie-break | Evidence |
| --- | --- | --- | --- |
| Classic | Total points / depth (max 700 pt / 7,000 m); no public leaderboard in the FAQ | — | FAQ; `STATES.md` C12 |
| Endless | Depth continues past 7,000 m to 250 km; 3 tanks, lose one on pass/timeout, 100 pt refunds one | — | FAQ |
| Multiplayer (≤40 players, 5–50 prompts, 5–60 s) | "The deepest diver after the last prompt wins" | Answer time | FAQ JSON-LD; `STATES-MP-DUEL.md` M04, M09 |
| 1v1 Colosseum (7 prompts × 15 s) | More points after 7 wins; rating rises/falls; starts **1,000** each 4-month season; ladder steps pay depth tokens | Less time on scoring answers | FAQ JSON-LD; `STATES-MP-DUEL.md` D06, D08 (bundle `K=50`) |
| Krillocity daily | Distance + percentile and the day's top 10; 1 attempt/day, resets 00:00 UTC | — | `STATES-KRILLO.md` K-04, K-11 |
| Depth tokens | 1 token per metre, every mode | — | FAQ "What are depth tokens?" |

Bundle evidence: `2dsh2j7-x58f7.js` maps player fields `rating`, `games`, `points`,
`ms`, `delta`; `1teyoxwdggu1p.js` fetches `/api/krillion/spread?v=2` with
`{points, counts}` (how rarity counts map to points) and stores score as
`{depth, speed}`. [EVIDENCE] HYPOTHESIS: the exact rating delta for a duel is a
function of K=50 and expected score; we did not verify the formula.

## 5. Traps

1. **The Too Clever trap.** The second tier exists to catch the answer everyone
   reaches after binning the obvious one. [EVIDENCE] FAQ article "Why the Too Clever
   answer is not the rare one"; bundle blurb above.
2. **The rare-but-wrong trap.** An obscure answer that is refused or graded low scores
   0 or few points; "obscure only pays when it is unarguably correct." [EVIDENCE] FAQ.
3. **The wrong-bank trap.** Clicking a 70–80% matching bank for a near-duplicate prompt
   can turn a correct 100-point answer into an 85: no demotion, but a wasted answer.
   [EVIDENCE] `DECISIONS.md` scenario D and the two questions raised.
4. **The shared-board trap.** In multiplayer/1v1 the board head and rows are other
   players; scraping them as our score both breaks policy and mis-ranks us.
   [EVIDENCE] `DECISIONS.md` #7.
5. **The speed trap.** Rushing to answer early buys no points; only answer-time
   tie-breaks use it. [EVIDENCE] FAQ.
6. **The AI-variance trap.** Treating a single play score as a grade correction is
   invalid for unknown answers (§3). [EVIDENCE] `DECISIONS.md` #1/#5.

## 6. Ranked strategies

Ranked by expected score impact per answer, then by safety. Each carries the four
required fields. None may demote from play or record other players.

### Strategy 1 — Spend the answer on a known 100-point bank answer (exact prompt only)
- **Predicted effect (number):** +100 pt / +1,000 m vs 0 for a pass; +900 m vs the
  Plankton default. A 7/7 dive of these = 700 pt / 7,000 m (the stated perfect dive).
  Bank coverage ~3.7 krillion answers per prompt (21,384 / 5,801). [EVIDENCE]
- **Evidence source:** FAQ JSON-LD + article tier table; `data/manifest.json`;
  `README.md` (Search DB keeps the 100 pt answer when one exists); `STATES.md` C5/C9;
  `GOD-DISTRIBUTION.md` (26.04% weight).
- **Risk:** wrong near-duplicate bank → low score (trap 3); refusal → 0 pt but costs
  only time; unknown answer's grade cannot be validated by one play (trap 6).
- **`testable in Phase 3` flag:** yes — compare solo `.kr-reveal-points b` on an exact
  prompt for a listed 100 pt answer; log score only, never demote.

### Strategy 2 — Bin the first two answers; attack from a different angle (region/era/specialism)
- **Predicted effect (number):** moving one answer from Too Clever (15 pt / 150 m) to
  Deep Cut (85 pt / 850 m) = **+70 pt / +700 m (5.7×)**; to Rare (60 pt) = +45 pt /
  +450 m. The site's own guide recommends this. HYPOTHESIS: the angle heuristic
  raises the *expected* tier, not a guaranteed grade.
- **Evidence source:** FAQ JSON-LD "How can I score higher…" and article sections
  "Why is everyone's first answer the same answer?" / "How to find the uncommon answer
  in 25 seconds"; bundle blurbs; `GOD-DISTRIBUTION.md` (85 pt = modal pick).
- **Risk:** specialist answer may be refused (0 pt) or land in Too Clever anyway;
  25 s clock in Classic, 30 s in Krillocity.
- **`testable in Phase 3` flag:** yes — record tier per submission by angle category
  in evidence logs and compare distributions (no demotions).

### Strategy 3 — Prefer exact bank matches; never auto-pick when several banks are shown
- **Predicted effect (number):** eliminates the 85-vs-100 wrong-bank loss of up to
  100 pt / 1,000 m per affected prompt; preserves alias evidence (a 100 needs 2
  distinct confirming answers). [EVIDENCE]
- **Evidence source:** `DECISIONS.md` scenario D/H/I and alias promotion rule;
  `INTERACTIONS.md` T13 (`ambiguous`), P17 (multi-bank auto pause); `STATES.md` C4.
- **Risk:** fewer answers auto-filled; a required manual choice may miss a short
  (5 s) room clock.
- **`testable in Phase 3` flag:** yes — compare low-score rate on `exact=true` vs
  `ambiguous` multibank submissions in `evidence.jsonl`.

### Strategy 4 — Treat low play scores as evidence only; import the dive-end bank as truth
- **Predicted effect (number):** prevents a false demotion that would delete up to
  1,000 m of value from the archive for one 85-point play; bank import sets
  `tierIndex === 5 → 100` authoritatively. [EVIDENCE]
- **Evidence source:** `DECISIONS.md` #1, scenario matrix F, "Core principle";
  `STATES.md` rule 2, C16; `INTERACTIONS.md` T21; `scrape-notes.md` line 10.
- **Risk:** a genuinely wrong bank answer stays listed and may waste a future
  submission; accepted deliberately over false demotion.
- **`testable in Phase 3` flag:** yes (audit) — assert zero `corrections.jsonl` writes
  whose only source is a play score; verify bank demotions cite `source: api`.

### Strategy 5 — In multiplayer/1v1, rank by own points/depth and ignore the shared board
- **Predicted effect (number):** correct win condition: deepest diver (MP) or more
  points after 7 (1v1); time only breaks ties. Avoids contaminating the archive with
  other players' data. Rating starts 1,000 (HYPOTHESIS: ±≤50 per duel from K=50).
- **Evidence source:** FAQ JSON-LD "How does Krillion multiplayer work?" / "How does
  1 vs 1 work?"; `DECISIONS.md` #5/#7; `STATES-MP-DUEL.md` M09/M14/D07/D08;
  `STATES.md` rule 1.
- **Risk:** a board-scraped score would be mis-attributed and forbidden by policy;
  MP/1v1 could not be re-tested live this run (relay offline).
- **`testable in Phase 3` flag:** partial — needs a live room; until then assert
  statically that `checkVerdict()` reads `.kr-board-head` only when `mode()==='classic'`.

**Non-goals:** no strategy in this file changes the shipped userscript, restarts the
bridge, edits other files, or authorises demotions from play or recording other
players. Shop interactions/ranks are out of scope by project decision.

## 7. Scoped check (exact output recorded after writing)

Commands run in this worktree; no full test suite or build was run.

```powershell
Select-String -Path injection/STRATEGY-SCORING.md -Pattern '^### Strategy ' | Measure-Object | Select-Object -ExpandProperty Count
Select-String -Path injection/STRATEGY-SCORING.md -Pattern '\[EVIDENCE\]' | Measure-Object | Select-Object -ExpandProperty Count
Select-String -Path injection/STRATEGY-SCORING.md -Pattern 'HYPOTHESIS' | Measure-Object | Select-Object -ExpandProperty Count
Select-String -Path injection/STRATEGY-SCORING.md -Pattern 'testable in Phase 3' | Measure-Object | Select-Object -ExpandProperty Count
```

Exact output of the four commands above, in order:

```text
5
28
8
7
```

Interpretation: 5 ranked strategies; 28 `[EVIDENCE]` markers; 8 `HYPOTHESIS` markers;
7 "testable in Phase 3" mentions (5 strategy flags + this check's pattern line and
interpretation). Every strategy has predicted effect, source, risk and a Phase 3 flag;
the two hard guards (no demotion from play, no recording other players) are stated
above and restated in the non-goals.
