# Phase 4 contract — implement verified strategies (frozen)

I used `injection/STRATEGY-VERIFIED.md` (14 PROVEN / 4 REJECTED,
55 measured runs) as the source of truth. I wired ONLY the PROVEN strategies and did NOT wire any REJECTED one.
I had four workstreams edit `injection/krillion-autofill.user.js` in separate worktrees
with DISJOINT function ownership. Crossing ownership was a violation. I required no bridge
changes (every PROVEN strategy was served by existing endpoints), so
I intentionally did NOT spawn W4-E; I recorded this rather than skipping it silently.

## Shared invariants (all workers)
- I required them to keep all 16 IDs, the userscript header (credit, URLs, @version 1.1.2, @connect),
  footer GitHub link, policy guards, bridge API, and the pastel UI.
- I told them not to bump @version — I, as coordinator, bumped it once after merge.
- I told them: never demote from play, never log other players, never merge near-duplicate banks,
  never apply aliases.
- I allowed no new dependencies/CDN and no CSS edits in this phase.
- I had them run scoped checks only in a worktree (node --check / grep); no full test suite.

## W4-A — Core engine & mode router (branch feat/p4-core)
I assigned W4-A: the `bot` object literal, `setBot`, `resetBotRound`, `botTick` (all branches
EXCEPT the results branch I assigned to W4-B), and NEW functions named `strategy*` or
`modeConfig*`.
I had W4-A implement/verify: a single per-mode strategy config object sourced from
`STRATEGY-VERIFIED.md` KEEP lists, so each mode declared which proven strategies
were active; `botTick` dispatched to that config without duplicating strategy
logic. I barred W4-A from touching `captureBanks`, `finalizeClassicResults`, `race*`,
`joinLobbyRoom`, `duelTick`, `answerCurrentPrompt`.

## W4-B — Classic (branch feat/p4-classic)
I assigned W4-B: `captureBanks`, `finalizeClassicResults`, `classicBankSignature`,
`classicRows`, `classicExpandRows`, `restartFromResults`, `checkVerdict`,
`reportScore`, and NEW functions named `classic*`.
I had W4-B wire/verify the PROVEN Classic set: exact-100 preload fast path (premap hit,
zero `/api/answers` for exact prompts), God Gaussian pick with empty-tier
redistribution, confidence-gated retry (bounded preload wait, multi-bank manual
pause, refusal retry), capture-banks-before-restart with the 2,200 ms bound.
I kept the REJECTED classic tier-greedy/rare-first-within-confidence
strategy unwired. I barred W4-B from touching `answerCurrentPrompt` (W4-C owned its race branch),
`botTick`, `race*`, or MP/duel functions.

## W4-C — Krillocity (branch feat/p4-krillo)
I assigned W4-C: `raceCancel`, `raceSchedule`, `raceBuildPool`, `raceNextAnswer`, `raceBurst`,
and ONLY the `isRace` branch of `answerCurrentPrompt` (including its early
`if (isRace) return raceBurst();`). I required NEW functions to be named `race*`.
I had W4-C wire/verify the PROVEN set: S1 bank-backed supply expansion (use both
`/api/all` rare answers and `/api/all-tier` low-tier answers), S2 rare-100-first
with strict per-prompt dedupe (survives input remount, resets on text change),
S3 50 ms fill / 90 ms step cadence, bounded (not claimed as an exact live
minimum). I kept S4 buzzer-grace and S5 judge-allowance unwired (REJECTED).
I barred W4-C from touching non-race `answerCurrentPrompt` logic, `botTick`, classic, or MP/duel.

## W4-D — Multiplayer & duel (branch feat/p4-mp-duel)
I assigned W4-D: `joinLobbyRoom`, `startMode` (all branches), `duelClick`, `duelTick`, and
NEW functions named `lobby*` or `duel*`.
I had W4-D wire/verify the PROVEN set: cache+top picks, duel rare-first,
most-populated-trap awareness, marathon-5s-50, long/private rooms,
refusal-calibration, requeue/stop-loss. I kept rating-protection unwired
(REJECTED — live forfeit test unsafe). I kept room place unmeasured; low
scores evidence-only. I barred W4-D from touching `botTick`, `captureBanks`, classic,
or `race*`.

## W4-VERIFY — I did this as coordinator after merge
I merged all four branches, resolved conflicts, then ran:
- `node --check injection/krillion-autofill.user.js`
- `python tests/run_all.py` (I required 100%)
- `node tests/mode_harness.js` and `node tests/roadmap_helpers.js`
- grep assertions: every PROVEN strategy id appears in the corresponding mode
  config; every REJECTED strategy id appears only in a `do-not-wire` comment;
  all 16 IDs, header and footer intact.
- I bumped `@version`, pushed, and verified the raw GitHub URL served the new version.

## Gate
I required `node --check` + full suite 100% + per-mode strategy assertions + version bumped
+ raw URL verified. I checked that no PROVEN strategy was missing and no REJECTED strategy was wired.
