# Krillion strategies — ranked one-page summary (Phase 2)

Evidence-backed summary of `STRATEGY-SCORING.md`, `STRATEGY-CLASSIC.md`,
`STRATEGY-KRILLO.md`, `STRATEGY-MP-DUEL.md`. Every strategy below carries
predicted effect, evidence source, risk and a Phase 3 test flag in its full doc.
**No strategy may demote from play or record another player's answer.**

## Scoring model (from the game's own FAQ/JSON-LD + bundles)
Six tiers: Plankton 10 / Too Clever 15 / Schooler 30 / Rare 60 / Deep Cut 85 /
One in a Krillion 100. Depth = points × 10 m (a perfect Classic dive = 700 pts =
7,000 m). Unknown answers are AI-graded inconsistently → play scores are evidence
only; only the game's own dive-end graded bank may demote.

## Ranked strategies by mode (highest expected value first)

| Mode | Strategy | Predicted effect | Risk | Full doc |
| --- | --- | --- | --- | --- |
| All | Exact-100 preload (`/api/all` instant) with tier-greedy fallback | Highest safe points/answer; zero HTTP for known prompts | None for exact match; near-duplicate banks stay separate | STRATEGY-SCORING / STRATEGY-CLASSIC |
| All | God Gaussian pick centred at 85pt (39.37% at 85, 26.04% at 100) | Balances rare payoff vs acceptance | Internal jargon in UI label (accepted) | STRATEGY-SCORING |
| Classic | Rare-first within confidence, retry only when time allows | Maximises points per 25 s prompt | AI may refuse; refusal keeps prompt open | STRATEGY-CLASSIC |
| Classic | Capture banks fully before restart (already implemented) | Feeds the archive → improves all future play | 2.2 s bound prevents hangs | STRATEGY-CLASSIC |
| Krillocity | Supply expansion + rare→low-tier pool with per-prompt dedupe | ~27 answers drain in ~2.4 s of 30 s; breadth beats waiting | Lower tiers worth fewer points | STRATEGY-KRILLO |
| Krillocity | 50 ms fill / 90 ms step cadence + 2.5 s verdict grace | Fastest safe submissions React still registers | Too fast risks missed input | STRATEGY-KRILLO |
| MP | Fast 5s/50 Marathon with `top` picks from cache | Fastest coin/rank cycle; no other-player data | 5 s prompts need preload | STRATEGY-MP-DUEL |
| MP | Most-populated room is a trap more often than not | Avoids crowded leaderboards where rank is hard | Room dynamics vary | STRATEGY-MP-DUEL |
| Duel | Rare-first, protect rating, requeue/stop-loss | Rating gain without chasing bad odds | Opponent behaviour unknown | STRATEGY-MP-DUEL |

## Phase 3 test queue
Every strategy above is `testable in Phase 3: yes` in its full doc. Phase 3 must
produce ≥3 measured runs per strategy and mark each `PROVEN` or `REJECTED`.
Unverified mechanics are tagged `hypothesis` in the full docs and must be treated
as such until measured.
