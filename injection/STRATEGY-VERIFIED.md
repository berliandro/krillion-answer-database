# Phase 3 — verified strategy keep/discard table

This is the authoritative Phase 3 gate result. It is derived field-by-field from the
18 `docs/evidence/*-strategy-*.json` result files; no result here is
invented, inferred from a keyword, or carried over from an earlier document.

## Gate / verification header

- Phase 3 gate numbers: `FILES=18 RUNS=55 PROVEN=14 REJECTED=4 UNTESTED=0 BAD_SHAPE=0 POLICY_VIOLATIONS=0`.
- Verification command used (coordinator): `python <temp>/verify_p3b.py`, whose output was
  `FILES=18 RUNS=55 PROVEN=14 REJECTED=4 UNTESTED=0 BAD_SHAPE=0 POLICY_VIOLATIONS=0`.
- Coverage: 18 evidence files, exactly one table row per file, 55 measured runs in total
  (Classic 16, Krillocity 15, Multiplayer 24). 14 strategies PROVEN, 4 REJECTED, 0 UNTESTED.
- Mode codes: `classic` = Classic banks, `krillo` = Krillocity race, `mp` = Multiplayer.
- A verdict is the file's top-level `verdict`, not a per-run verdict (one Classic file has a
  PROVEN run inside an overall REJECTED file; that file is counted REJECTED).

## Authoritative keep/discard table

| Mode | Strategy id / name | Verdict | Runs | Measured effect (quoted from JSON runs) | Evidence file | REJECTED reason (verbatim) |
| --- | --- | --- | --- | --- | --- | --- |
| classic | capture-banks-before-restart flywheel | PROVEN | 3 | 3/3 runs: `captureLogCount=1`, `bankRowsImported=4`, `ownRowsImported=4`, `otherPlayerRowsImported=0`, `captureSettledBeforeRestart=true`, `all_expanded=true`, `timed_out=false` on normal and delayed POST; never-settling POST hit `hardCapHit=true` with `timed_out=true`, `captureSettledAt=null`, `restartClicks=1`. Run `ms`: 4.884 / 0.787 / 0.668. | docs/evidence/classic-strategy-capture-banks-before-restart.json | — |
| classic | confidence-gated retry (refusal handling) | PROVEN | 3 | Run 1: `preloadWaitRealMs=76.067`, `preloadWaitCapMs=2500`, `answersApiCalls=0`, `answerCount=9`, `usedRareRatherThanLowTier=true`. Run 2: `groupCount=2`, `pausedAutoPick=true`, `submits=0`, `inputValue="Superegg"`. Run 3: `refusalDetected=true`, `retried=true`, `retryAnswer="Zur-En-Arrh Batman"`, `distinctAnswer=true`, `evidencePosts=1`, `demotionPosts=0`, `playScoreUsedForDemotion=false`. | docs/evidence/classic-strategy-confidence-gated-retry.json | — |
| classic | exact-100 preload fast path | PROVEN | 3 | 3/3 runs resolved from the `/api/all` premap: `answersApiCalls=0`, `tier=100`, `submits=1`, `submitMethod="form.requestSubmit"`. `lookupMs` 1.345 / 0.3 / 0.759; run `ms` 2.415 / 0.58 / 0.834. Caveat in file: `preloadItems=3970` normalised keys for 5,801 prompts, so near-duplicate wordings collapse to one bank. | docs/evidence/classic-strategy-exact-100-preload.json | — |
| classic | God Gaussian pick | PROVEN | 3 | 10,000 seeded draws per run. All six buckets populated: `maxAbsDeltaPct=0.45`, `withinTolerance=true`, 85-point mode `39.42%`. Real bank (only 85/100 tagged): `sharesPct` 85=`73.63`, 100=`26.37`, `emptyGroups=[10,15,30,60]`. 60/100 only: `illegalDraws=0`, 60=`34.72%`, 100=`65.28%`, `redistributionCorrect=true`. | docs/evidence/classic-strategy-god-gaussian-pick.json | — |
| classic | tier-greedy fallback / rare-first within confidence | REJECTED | 4 | 3 real no-100 prompts: `has100InPremap=false`, `tierEntries=20`, `tierPointsObserved=[85]`, `poolBuildMs` 0.322 / 0.094 / 0.097, `poolHttpCalls=0`, `classicAnswerSubmitted=false`, `classicUsesTierPremap=false`. Run 4 (race pool only): `rareCount=1`, `poolLength=21`, `rareFirstThreeMatch=true`, `firstThree=[Superegg, Antiprism, Bipyramid]`. | docs/evidence/classic-strategy-tier-greedy-fallback.json | REJECTED as a Classic strategy. 3/3 real no-100 prompts produced an 85-point tier-greedy pick only through raceBuildPool() (Krillocity race path); Classic answerCurrentPrompt() never reads state.tierPremap for non-God picks and submitted nothing on those prompts. A 4th run verified rare-first ordering inside the race pool. Proving the Classic variant requires a userscript change, which is outside W3-A file ownership; no result was fabricated. |
| krillo | S4 submit to buzzer + claim 2.5s verdict grace | REJECTED | 3 | `baseDrained=true`; `baseLastSubmitMs` 2660 / 2570 / 2660; 6 late submissions after injection at 29,600 ms, `lastSubmitMs` 30200 / 30110 / 30200, `submissionsInLast1s=6`, `inFlightAtBuzzerModeled=6`, `verdictsInGraceModeled=6` (400 ms latency model); `graceEnd=32500`. | docs/evidence/krillo-strategy-buzzer-grace.json | Not provable in this harness: the decisive signals (which verdicts the server attributes to a prompt, their timestamps, and whether an answer with the judge at zero is credited in the 2.5s grace) are server-authoritative and unavailable without a live scored daily, which is forbidden by account risk. Three measured runs DID confirm the client side: the burst polls/continues while idle, resumes on late bank supply after >20s idle, and late submits exist; grace verdict counts are model outputs (400ms latency), not live observations (H8 unproven). |
| krillo | S5 protect AI-judge allowance: prefer bank-known answers | REJECTED | 3 | Bank-only runs: `submitted` 30 / 29 / 30, `unique` equal to `submitted`, `duplicates=0`, `bankKnownSubmitted` 30 / 29 / 30, `speculativeSubmitted=0`, `modeledJudgeCalls` 30 / 29 / 30, `modeledRefused=0`, `drainMs` 2660 / 2570 / 2660. Speculative control: `submitted` 40 / 38 / 40, `speculativeSubmitted` 10 / 9 / 10, `modeledRefused` 10 / 9 / 10. | docs/evidence/krillo-strategy-judge-allowance.json | Not provable in this harness: allowance size, refill rate, and whether bank-known answers consume the allowance are server-side and unobservable without a live scored daily (forbidden by account risk; H5 unproven). Three measured runs confirm only the client-side half: bank-only pools submit N bank-known answers with 0 speculative/refused submissions, while a speculative control adds N wasted judge calls. This is a proxy, not proof of allowance preservation. |
| krillo | S3 hold 50ms fill / 90ms step safe cadence | PROVEN | 3 | Current: `submitted` 30 / 29 / 30, `unique` equal to `submitted`, `duplicates=0`, `fillGaps=[50]`, `stepGaps=[90]`, `drainMs` 2660 / 2570 / 2660, `within30s=true`, `stranded=0`. A/B slow 700 ms step: `drainMs` 20688.89 / 19988.89 / 20688.89. A/B fast 10/18 ms: `drainMs` 532 / 514 / 532, `modeledUnregistered` 30 / 29 / 30. | docs/evidence/krillo-strategy-safe-cadence.json | — |
| krillo | S2 rare-100 first then 85/60/30/15/10 with strict dedupe | PROVEN | 3 | `submitted` 57 / 54 / 55, `unique` equal to `submitted`, `duplicates=0`, `rareFirstN` 10 / 9 / 10, `tierOrderMonotonic=true`, `poolDrained=true`, `drainMs` 5130 / 4860 / 4950. `onPromptChange`: `leakedOldPromptAnswers=0`, `dedupeSetCleared=true`. `onInputRemount`: `newSubmissions=0`, `duplicateSubmissions=0`; control without guard re-submitted 29 / 30 / 30. | docs/evidence/krillo-strategy-rare-order-dedupe.json | — |
| krillo | S1 supply expansion (bank-backed answers per prompt) | PROVEN | 3 | Base: `submitted` 30 / 29 / 30, `points` 2700 / 2600 / 2700, `drainMs` 2660 / 2570 / 2660. Expanded: `submitted` 57 / 54 / 55, `points` 4995 / 4725 / 4825, `drainMs` 5090 / 4820 / 4910. `deltaPoints` 2295 / 2125 / 2125, `deltaAccepted` 27 / 25 / 25, `refusedRateBase=0`, `refusedRateExpanded=0`. | docs/evidence/krillo-strategy-supply-expansion.json | — |
| mp | requeue-stop-loss | PROVEN | 3 | Edge case: `matches=5`, `requeues=5`, `finalRating=1025`, `stopLossAt=null`. Stop case: `matches=3`, `requeues=2`, `stopLossAt=2`, `finalRating=983`. Cap case: `matches=4`, `requeues=3`, `capBlockedAt=4`, `finalRating=1090`. `demotions=0` and `foeRowsArchived=0` in all 3 runs; run `ms` 7.916 / 2.1 / 1.68. | docs/evidence/mp-strategy-requeue-stop-loss.json | — |
| mp | refusal-calibration | PROVEN | 3 | 5 s room, refusal at 4,900 ms: `remainingMs=100`, `retryAccepted=false`, `points=0`. 15 s room: `remainingMs=12000`, `retryAccepted=true`, `points=100`. 30 s room: `remainingMs=20000`, `points=100`. `refusalLogs=1`, `demotions=0`, `otherPlayerRowsLogged=0` in every run. | docs/evidence/mp-strategy-refusal-calibration.json | — |
| mp | rating-protection | REJECTED | 3 | Tab-rule: `clicks.ruleKey=1`, `clicks.leave=0`, event `duel-rule`. Elsewhere-versus: `clicks.claim=1`, `versusLeave=0`. Leave-before-start: `events=[]`, `leaveBeforeStartRatingChange=0`. `equalRatingLossElo=-25`, `equalRatingWinElo=25`, `pearlTabOutLossElo=-25`, `liveForfeitTested=false`, `demotions=0`. | docs/evidence/mp-strategy-rating-protection.json | The core claim (avoiding a tab-out/leave forfeit loss) cannot be proven without deliberately forfeiting a real match, which is unsafe and prohibited. Three safe harness runs measured tab-rule acceptance, elsewhere claim, versus wait and leave-before-start, plus Elo arithmetic from bundle constants; none of these is a live rating observation. |
| mp | most-populated-trap | PROVEN | 3 | `showoff` selected the argmax room in all runs (`selectedCount` 7, 30, 39); `settleMs` 2000 / 8000 / 10000; `answeredAfterSettle=true`; `ownDepthPerPrompt=1000`, `ownGradeIndependentOfPopulation=true`; `demotions=0`, `otherPlayerRowsLogged=0`. | docs/evidence/mp-strategy-most-populated-trap.json | — |
| mp | marathon-5s-50 | PROVEN | 3 | 5 s/50 room: `parsedSeconds=5`, `parsedPrompts=50`, `joined=true`, `answered=50`, `depthMetres=50000`, `depthPerMinute=12000`, `elapsedMs=250000`. 30 s counterfactual: `joined=false`, `depthPerMinute=2000`, `elapsedMs=1500000`. Cold cache: `answered=0`, `depthMetres=0`. `demotions=0`, `otherPlayerRowsLogged=0`. | docs/evidence/mp-strategy-marathon-5s-50.json | — |
| mp | long-private-rooms | PROVEN | 3 | `selectedRoom="Private 50 room"`, `joined=true` in all runs. `cumulativeDepth` at prompts 7/25/50 = 7000/25000/50000 (top), 3600/11950/23650 (god 85/60/30/10), 5950/21250/42500 (god 85); `finalDepthMetres` 50000 / 23650 / 42500; `lowScoreLogged` false / true / true; `place=null`; `demotions=0`, `otherPlayerRowsLogged=0`. | docs/evidence/mp-strategy-long-private-rooms.json | — |
| mp | duel-rare-first | PROVEN | 3 | 7 prompts, 3 s count-in: `firstSubmitTier=100`, `ownPoints=700`, `answeredPrompts=7`, `zeroRounds=0`. Rare-first `refusals=0`/`retries=0`; refuse-retry 7/7; buzzer-fallback 7/7 with `fallbackAtMs=14000`. `foeRowsRead=0`, `demotions=0`, `otherPlayerRowsLogged=0` in every run. | docs/evidence/mp-strategy-duel-rare-first.json | — |
| mp | cache-top-picks | PROVEN | 3 | Prompt "Name any one famous park": top/net and top/premap picked "Central Park" with `tierPoints=100`, `pointsPerPrompt=100`; god/net picked "nice tree" with `tierPoints=60`; `godExpectedPoints=77.538`. `groupsLoaded` 2/1/2, `bankLabelsRendered` 2/0/2, `banksSeparate=true`; `demotions=0`, `otherPlayerRowsLogged=0`. | docs/evidence/mp-strategy-cache-top-picks.json | — |

## KEEP — PROVEN strategies (grouped by mode)

**Classic (4):** `capture-banks-before-restart flywheel`, `confidence-gated retry (refusal handling)`,
`exact-100 preload fast path`, `God Gaussian pick`.

**Krillocity (3):** `S1 supply expansion (bank-backed answers per prompt)`,
`S2 rare-100 first then 85/60/30/15/10 with strict dedupe`,
`S3 hold 50ms fill / 90ms step safe cadence`.

**Multiplayer (7):** `cache-top-picks`, `duel-rare-first`, `most-populated-trap`,
`marathon-5s-50`, `long-private-rooms`, `refusal-calibration`, `requeue-stop-loss`.

Total KEEP = 14. No PROVEN strategy is "untested": each has at least 3 measured runs.

## DISCARD — REJECTED strategies (with reason)

- **classic / tier-greedy fallback / rare-first within confidence** — the 85-point tier-greedy
  pick and rare-first ordering exist only inside `raceBuildPool()` (Krillocity race path);
  Classic `answerCurrentPrompt()` never reads `state.tierPremap` for non-God picks and submitted
  nothing on the tested no-100 prompts. A Classic proof requires a userscript edit outside the
  evidence worker's file ownership. (Full verbatim reason in the table.)
- **krillo / S4 submit to buzzer + claim 2.5s verdict grace** — the deciding verdict signals are
  server-authoritative and cannot be observed without a live scored daily, which is forbidden by
  account risk; the 6 in-grace verdicts are 400 ms-latency model outputs, not observations.
- **krillo / S5 protect AI-judge allowance: prefer bank-known answers** — allowance size, refill
  rate and allowance consumption are server-side; the measured bank-only vs speculative control
  is a client-side proxy only.
- **mp / rating-protection** — proving avoidance of a tab-out/leave forfeit requires deliberately
  forfeiting a real match, which is unsafe and prohibited; `liveForfeitTested=false`.

Total DISCARD = 4. All four are rejected for unobservability or out-of-scope implementation, not
for a measured regression.

## LIVE validation verdict (2026-11-27, Edge automation profile)

Real scored play was run in the dedicated Edge profile with the shipped userscript source; see
`injection/LIVE-VALIDATION.md` and `injection/data/live_validation/*`. None of the four REJECTED
claims could be promoted; all four are **formally discarded**, now with live-backed reasons:

| Strategy | Live outcome | Verdict |
| --- | --- | --- |
| classic / tier-greedy fallback | Live Classic dives reached 7,000 m with every prompt answered 100 (`ONE IN A KRILLION`); no no-100 prompt occurred, so the fallback was never applicable. The Classic path still does not read `tierPremap`. | DISCARD (not applicable live; harness proof unchanged) |
| krillo / submit-to-buzzer + 2.5 s grace | Live race confirmed client-side rapid sends (`race answer sent`, `race: no more answers`) but no server verdict attribution or grace telemetry is exposed to the page. | DISCARD (server-authoritative, unobservable) |
| krillo / protect AI-judge allowance | Live race logged bank-known sends only; allowance size/refill/consumption are server-side and invisible. | DISCARD (server-authoritative, unobservable) |
| mp / rating-protection | Real multiplayer room `Riptide` was joined and left untouched (no forfeit, no tab-out); Elo deltas remain unobservable and a live forfeit is unsafe. | DISCARD (unsafe to test) |

Live play also found and fixed a real v1.1.5 bug: Krillocity's hidden duplicate `p.kr-prompt` made the
script miss the visible prompt; v1.1.6 selects the visible prompt and the live race then answered.

## Policy statement — field-level verification

No PROVEN strategy relies on play-score demotion, other-player logging, or alias application.
This was checked against concrete evidence fields, not by searching for the words:

- **Classic (4 PROVEN files):** top-level `policy.play_score_demotion=false` and
  `policy.other_player_rows_imported=false` (also `policy.bridge_restart=false`,
  `policy.live_game_started=false`) in each file. Run-level checks add
  `otherPlayerRowsImported=0` in all 3 capture runs, and `demotionPosts=0` plus
  `playScoreUsedForDemotion=false` in the refusal run.
- **Krillocity (3 PROVEN files):** every supply-expansion run carries
  `sourceContract="bank-backed only; no 100-point demotion; near-duplicate banks not merged"`
  with `refusedRateBase=0` and `refusedRateExpanded=0`; rare-order-dedupe and safe-cadence
  record `duplicates=0` / `duplicateSubmissions=0` in every run and contain no field recording
  an alias application or bank merge.
- **Multiplayer (7 PROVEN files):** `demotions=0` in every run of all seven;
  `otherPlayerRowsLogged=0` in refusal-calibration, most-populated-trap, marathon-5s-50,
  long-private-rooms, duel-rare-first and cache-top-picks, with `foeRowsRead=0` in
  duel-rare-first and `foeRowsArchived=0` in requeue-stop-loss instead. cache-top-picks
  records `banksSeparate=true` with `bankLabelsRendered=2` on both multi-bank runs.

A low play score is logged as evidence only (`lowScoreLogged=true` in long-private-rooms,
`refusalLogs=1` in refusal-calibration, `evidencePosts=1` in confidence-gated retry) and never
used to demote a bank. This matches `injection/DECISIONS.md` and `injection/CONTRACT-MODES.md`.

## Phase 4 input

**Classic — wire in:** exact-100 preload fast path (premap hit, zero `/api/answers` calls),
God Gaussian pick (distribution and empty-tier redistribution), confidence-gated retry
(preload wait, multi-bank pause, refusal retry), capture-banks-before-restart flywheel
(capture gate before Play-again, bounded 2,200 ms hard cap).
**Classic — do not wire:** tier-greedy fallback / rare-first within confidence (REJECTED;
requires a userscript edit and a fresh measurement before it can be claimed for Classic).

**Krillocity — wire in:** S1 supply expansion, S2 rare-100 first with strict dedupe,
S3 50 ms fill / 90 ms step cadence.
**Krillocity — do not wire:** S4 buzzer-grace verdict claim and S5 judge-allowance protection
(both REJECTED; server-authoritative signals are unobservable without a live scored daily).
The 50 ms threshold is a harness model, not a live measurement — keep it bounded, not a claim
of an exact live minimum.

**Multiplayer — wire in:** cache-top-picks, duel-rare-first, most-populated-trap,
marathon-5s-50, long-private-rooms, refusal-calibration, requeue-stop-loss.
**Multiplayer — do not wire:** rating-protection (REJECTED; live forfeit test is unsafe).
Room place must stay unmeasured and low scores evidence-only.

## Limitations — harness-only vs live-readonly evidence

**No evidence file used live-readonly interactive DOM for its runs.** All 55 runs are harness
runs; where live-readonly information appears, it is prior input, not a run observation:

- **Stubbed harness with real bridge data — the 5 `classic-*` files.** Each run has `source:
  "harness-real-bridge-data"` and the file's `harness.mode` is "vm sandbox, stubbed GM/DOM,
  virtual clock, seeded RNG; POSTs captured in memory". Inputs were fetched read-only from
  bridge `127.0.0.1:8768` (`/api/all` + `/api/all-tier`, version 5, etag
  `bb3d29fccfddba95efe746e21ca2cf2bf9269be65758c46437b9d64ee4650845`), no bridge log/database
  was written and no game was started. Their notes state live DOM observation was skipped
  because the browse relay was paired-offline.
- **Fake-timer harness with real bridge rows — the 5 `krillo-*` files.** `meta.harness` is
  `krillo-strategy-harness.js`; `meta.model` says fake timers drive the real
  `raceBurst`/`raceNextAnswer`/`raceSchedule` code and acceptance is modelled
  (bank-backed = accepted) because the game-server judge is not contacted. `meta.domNote`
  records only a static read-only fetch of `https://playdaily.org/krillocity` that confirmed
  game rules; the interactive React DOM was not available (no in-app browser tool exposed,
  browse profile offline), so selectors came from `injection/krillion-autofill.user.js`.
- **VM harness stub with injected bridge fixture — the 8 `mp-*` files.** Every run's `source`
  says "harness stub (vm, seeded RNG + fake timers); room/prompt inputs = live-readonly
  LIVE-NOTE (injection/STATES.md, STATES-MP-DUEL.md) + FAQ 2026-11-27 + bundle constants;
  bridge answers = injected fixture". Foe rating/identity was in-memory only and never
  archived; the live-readonly notes predate these runs.

Consequences for Phase 4: measured effects are client-side and deterministic-harness results
with real bridge data (Classic/Krillocity) or fixtures (MP). Server-authoritative outcomes —
live judge verdicts, judge allowance, forfeit rating loss, grace credit — remain unproven and
are exactly the four REJECTED claims. Do not present any PROVEN effect as a live-game result.

## Scoped check (row count + verdict cross-check)

Command (PowerShell, run from the worktree):

```powershell
$mdPath = 'D:\! Games\Krillion Game\.worktrees\p3-analysis\injection\STRATEGY-VERIFIED.md'
$root = 'D:\! Games\Krillion Game'
$lines = Get-Content $mdPath
$rows = @($lines | Where-Object { $_ -match '^\|\s*(classic|krillo|mp)\s*\|' })
"ROWS=$($rows.Count)"
$ok = 0; $bad = 0; $pv = 0; $pr = 0; $pu = 0
foreach ($r in $rows) {
  $c = @($r -split '\|') | ForEach-Object { $_.Trim() }
  $verdict = $c[3]; $runs = [int]$c[4]; $path = $c[6]
  $j = Get-Content (Join-Path $root $path) -Raw | ConvertFrom-Json
  $jv = [string]$j.verdict; $jr = @($j.runs).Count
  if ($verdict -ceq $jv -and $runs -eq $jr) { $ok++; "OK $path verdict=$jv runs=$jr" } else { $bad++; "MISMATCH $path md=$verdict/$runs json=$jv/$jr" }
  if ($jv -ceq 'PROVEN') { $pv++ } elseif ($jv -ceq 'REJECTED') { $pr++ } else { $pu++ }
}
"FILES=$($rows.Count) JSON_PROVEN=$pv JSON_REJECTED=$pr JSON_UNTESTED=$pu MATCH=$ok MISMATCH=$bad"
$files = @(Get-ChildItem "$root\evidence\*-strategy-*.json")
"EVIDENCE_FILES=$($files.Count)"
$totalRuns = 0
foreach ($f in $files) { $j = Get-Content $f.FullName -Raw | ConvertFrom-Json; $totalRuns += @($j.runs).Count }
"JSON_TOTAL_RUNS=$totalRuns"
```

Exact output:

```text
ROWS=18
OK docs/evidence/classic-strategy-capture-banks-before-restart.json verdict=PROVEN runs=3
OK docs/evidence/classic-strategy-confidence-gated-retry.json verdict=PROVEN runs=3
OK docs/evidence/classic-strategy-exact-100-preload.json verdict=PROVEN runs=3
OK docs/evidence/classic-strategy-god-gaussian-pick.json verdict=PROVEN runs=3
OK docs/evidence/classic-strategy-tier-greedy-fallback.json verdict=REJECTED runs=4
OK docs/evidence/krillo-strategy-buzzer-grace.json verdict=REJECTED runs=3
OK docs/evidence/krillo-strategy-judge-allowance.json verdict=REJECTED runs=3
OK docs/evidence/krillo-strategy-safe-cadence.json verdict=PROVEN runs=3
OK docs/evidence/krillo-strategy-rare-order-dedupe.json verdict=PROVEN runs=3
OK docs/evidence/krillo-strategy-supply-expansion.json verdict=PROVEN runs=3
OK docs/evidence/mp-strategy-requeue-stop-loss.json verdict=PROVEN runs=3
OK docs/evidence/mp-strategy-refusal-calibration.json verdict=PROVEN runs=3
OK docs/evidence/mp-strategy-rating-protection.json verdict=REJECTED runs=3
OK docs/evidence/mp-strategy-most-populated-trap.json verdict=PROVEN runs=3
OK docs/evidence/mp-strategy-marathon-5s-50.json verdict=PROVEN runs=3
OK docs/evidence/mp-strategy-long-private-rooms.json verdict=PROVEN runs=3
OK docs/evidence/mp-strategy-duel-rare-first.json verdict=PROVEN runs=3
OK docs/evidence/mp-strategy-cache-top-picks.json verdict=PROVEN runs=3
FILES=18 JSON_PROVEN=14 JSON_REJECTED=4 JSON_UNTESTED=0 MATCH=18 MISMATCH=0
EVIDENCE_FILES=18
JSON_TOTAL_RUNS=55
```

A second field check compared the `REJECTED reason` cell of all four rejected rows against the
top-level `reason` field in their JSON: `REASON_MATCH=4 REASON_MISMATCH=0`. No full test suite
was run.
