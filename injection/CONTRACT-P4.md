# Phase 4 contract — implement verified strategies (frozen)

Source of truth: `injection/STRATEGY-VERIFIED.md` (14 PROVEN / 4 REJECTED,
55 measured runs). Wire ONLY the PROVEN strategies; do NOT wire any REJECTED one.
Four workstreams edit `injection/krillion-autofill.user.js` in separate worktrees
with DISJOINT function ownership. Crossing ownership is a violation. No bridge
changes are required (every PROVEN strategy is served by existing endpoints), so
W4-E is intentionally NOT spawned; this is recorded, not skipped silently.

## Shared invariants (all workers)
- Keep all 16 IDs, the userscript header (credit, URLs, @version 1.1.2, @connect),
  footer GitHub link, policy guards, bridge API, and the pastel UI.
- Do NOT bump @version — the coordinator bumps it once after merge.
- Never demote from play, never log other players, never merge near-duplicate banks,
  never apply aliases.
- No new dependencies/CDN. No CSS edits in this phase.
- Scoped check only in a worktree (node --check / grep); no full test suite.

## W4-A — Core engine & mode router (branch feat/p4-core)
Owns: the `bot` object literal, `setBot`, `resetBotRound`, `botTick` (all branches
EXCEPT the results branch owned by W4-B), and NEW functions named `strategy*` or
`modeConfig*`.
Must implement/verify: a single per-mode strategy config object sourced from
`STRATEGY-VERIFIED.md` KEEP lists, so each mode declares which proven strategies
are active; `botTick` dispatches to that config without duplicating strategy
logic. Must NOT touch `captureBanks`, `finalizeClassicResults`, `race*`,
`joinLobbyRoom`, `duelTick`, `answerCurrentPrompt`.

## W4-B — Classic (branch feat/p4-classic)
Owns: `captureBanks`, `finalizeClassicResults`, `classicBankSignature`,
`classicRows`, `classicExpandRows`, `restartFromResults`, `checkVerdict`,
`reportScore`, and NEW functions named `classic*`.
Must wire/verify the PROVEN Classic set: exact-100 preload fast path (premap hit,
zero `/api/answers` for exact prompts), God Gaussian pick with empty-tier
redistribution, confidence-gated retry (bounded preload wait, multi-bank manual
pause, refusal retry), capture-banks-before-restart with the 2,200 ms bound.
Must NOT wire the REJECTED classic tier-greedy/rare-first-within-confidence
strategy. Must NOT touch `answerCurrentPrompt` (W4-C owns its race branch),
`botTick`, `race*`, or MP/duel functions.

## W4-C — Krillocity (branch feat/p4-krillo)
Owns: `raceCancel`, `raceSchedule`, `raceBuildPool`, `raceNextAnswer`, `raceBurst`,
and ONLY the `isRace` branch of `answerCurrentPrompt` (including its early
`if (isRace) return raceBurst();`). NEW functions must be named `race*`.
Must wire/verify the PROVEN set: S1 bank-backed supply expansion (use both
`/api/all` rare answers and `/api/all-tier` low-tier answers), S2 rare-100-first
with strict per-prompt dedupe (survives input remount, resets on text change),
S3 50 ms fill / 90 ms step cadence, bounded (not claimed as an exact live
minimum). Must NOT wire S4 buzzer-grace or S5 judge-allowance (REJECTED).
Must NOT touch non-race `answerCurrentPrompt` logic, `botTick`, classic, or MP/duel.

## W4-D — Multiplayer & duel (branch feat/p4-mp-duel)
Owns: `joinLobbyRoom`, `startMode` (all branches), `duelClick`, `duelTick`, and
NEW functions named `lobby*` or `duel*`.
Must wire/verify the PROVEN set: cache+top picks, duel rare-first,
most-populated-trap awareness, marathon-5s-50, long/private rooms,
refusal-calibration, requeue/stop-loss. Must NOT wire rating-protection
(REJECTED — live forfeit test unsafe). Room place must stay unmeasured; low
scores stay evidence-only. Must NOT touch `botTick`, `captureBanks`, classic,
or `race*`.

## W4-VERIFY — Coordinator after merge
Merge all four branches, resolve conflicts, then run:
- `node --check injection/krillion-autofill.user.js`
- `python tests/run_all.py` (must remain 100%)
- `node tests/mode_harness.js` and `node tests/roadmap_helpers.js`
- grep assertions: every PROVEN strategy id appears in the corresponding mode
  config; every REJECTED strategy id appears only in a `do-not-wire` comment;
  all 16 IDs, header and footer intact.
- bump `@version`, push, verify raw GitHub URL serves the new version.

## Gate
`node --check` + full suite 100% + per-mode strategy assertions + version bumped
+ raw URL verified. No PROVEN strategy missing; no REJECTED strategy wired.
