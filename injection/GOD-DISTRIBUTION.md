# God-player pick distribution — normal, centred on 85pt

I decided on 2026-11-23 that God mode selected answers by **point group** using a
normal (Gaussian) probability centred on the 85-point "Deep Cut" tier, so lower
point answers were picked rarely and 85 was the single most likely pick. This
replaced the old fixed "1-in-7 rare / rest deepcut" cadence.

## Point groups and probabilities

I followed the game's six grades. With Gaussian `sigma = 1.1` centred on
tier index 4 (85pt), `w(i) = exp(-(i-4)^2 / (2 * 1.1^2))`, normalised:

| Tier index | Points | Chance |
| --- | --- | --- |
| 0 | 10 (Plankton) | 0.05% |
| 1 | 15 (Too Clever) | 0.95% |
| 2 | 30 (Schooler) | 7.54% |
| 3 | 60 (Rare) | 26.04% |
| 4 | 85 (Deep Cut) | **39.37%** |
| 5 | 100 (One in a Krillion) | 26.04% |

I checked the total = 100%. 85pt was the peak; each step down was less likely. I kept the 100pt group
prominent because those answers were the exact, instant ones from the
rare preload — I explicitly wanted those shown instantly.

## Where point values come from

I found `data/krillion_full.db` had **no points/tier column** — only `is_krillion`.
The only graded point data was `injection/data/learned.jsonl` (4,920 rows;
1,043 with `tierIndex` 0-5). For an answer:

1. `tierIndex` -> points = `[10, 15, 30, 60, 85, 100][tierIndex]`.
2. Else tier text -> points (`PLANKTON`=10 ... `ONE IN A KRILLION`=100), or the
   `points` field if it is one of the six grades.
3. Else **unknown -> 85pt** (the Deep Cut bucket): an ungraded low answer is
   exactly the current "deepcut" pool, so treating it as the distribution's
   mode preserves today's behaviour while adding real graded answers as
   distinct groups when they exist.

## Selection algorithm (userscript)

1. Build `groupsByPoints`: map points (`10/15/30/60/85/100`) -> answers for the
   current prompt, from `state.tierPremap` (point-tagged) plus the 100pt list.
2. For each of the six tiers compute `chance` above; if a group is empty,
   redistribute its chance to the nearest non-empty group (prefer 85, then
   60, then 100) so the probabilities still sum to 100% over available groups.
3. Draw a uniform random number in [0,100), walk the tiers in order, pick the
   group whose cumulative band contains the draw, then pick a random answer
   from that group (excluding refused/submitted ones as today).
4. Keep the stale guards, forever-retry fallback and all policy guards.

## Verification I required
- I required a deterministic harness to assert that the empirical distribution over many
  draws matched the table within tolerance when every group was populated, and
  that an empty group's chance was redistributed without ever selecting from it.
- I required `node --check` and the existing 8-test suite to still pass.
