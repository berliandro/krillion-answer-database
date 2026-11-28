# Krillocity race pool — all tiers, highest points first

## Symptom
In multiplayer Krillocity with autoplay on, the script entered only 100-point
("Krillion") answers. 10/15/30/60/85-point answers were never entered, and
other players' answers from the same prompt were not reused on similar prompts.

## Root causes
1. On-screen Krillocity wordings frequently missed the local tier map
   (127/225 real prompts measured against `injection/data/prompt_review.jsonl`).
2. `data/tier-data.json` rows carry `null` points; `parseTierAnswers(null)`
   maps them to 85, so low tiers never ranked correctly.
3. `data/krillocity_answers.jsonl` held other players' game-graded answers,
   but nothing served them into the race pool.
4. `/api/answers` resolves an exact bank first. Several exact banks carry only
   a 100-point answer while a near-duplicate sibling wording holds the full
   low-tier set (e.g. `What's an example of a holiday celebrated in winter?`
   -> `Name a holiday celebrated in winter`, 45 low-tier rows).
5. The full DB's non-krillion answers were never included in the race pool.

## Fix
- `injection/bridge.py` `GET /api/krillocity-race-pool?q=<on-screen prompt>`:
  - resolves exact -> alias -> fuzzy, and includes the literal on-screen wording;
  - merges graded 100-point banks, learned tiers with real `tierIndex` points,
    harvested other-player answers, full-DB low tiers, and near-duplicate low
    tiers; dedupes and sorts **100 -> 85 -> 60 -> 30 -> 15 -> 10**;
  - logs every served prompt to `data/krillocity_pool_use.jsonl` with a source
    breakdown and the other-player answers used.
- Near-duplicate expansion pools **low tiers only** — their 100-point banks are
  never merged into matching, display or the search DB (policy preserved).
- `injection/krillion-autofill.user.js` v1.2.0 fetches and caches that pool per
  prompt, and `raceBuildPool()` uses it as the primary ordered answer list.
- `scripts/harvest_krillocity_others.js` records other players' game-graded
  answers from public race results into `data/krillocity_answers.jsonl`.
- No play-score demotions; aliases remain log-only; other-player answers go to
  the separate Krillocity archive, never the graded 100-point bank.

## Live scored validation (Edge automation profile, real multiplayer room, autoplay on)
Shipped v1.2.0 source injected with a GM stub that relays bridge calls and
records each `submitAnswer()` (answer + on-screen prompt). A test build only —
the shipped source is unchanged.

Prompt: **"What's something that gives off steam?"**
- Bridge pool: 28 answers — 8 x 100 (bank), 20 x 10 (full-db-low).
- Submitted: all 28, exact descending point sequence:
  `100,100,100,100,100,100,100,100,10,10,...` (20x `10`)
- Unmapped submissions: 0. `descending = true`.
- First 8: Chawanmushi, Modak, Puto, Puttu, Steam Donkey Engine, Steam Fissure,
  Steam Jet Ejector, Steam-Jacketed Kettle (all 100).
- Next: Black Tea, Boiling Water, Boiling Water Dispenser, ... (all 10).

Other live prompts captured with ranked pools after the coverage fix:
- "Name a kind of bicycle" — 30 answers (100:10, 10:20)
- "Name a animal that is very big" — 21 answers (100:2, 10:19)
- "What's one thing people use to make jewelry?" — 81 answers
  (100:1, 85:2, 60:7, 30:29, 15:16, 10:26) from the bridge endpoint

## Endpoint evidence
```
GET /api/krillocity-race-pool?q=Name%20any%20one%20ice%20cream%20flavor
answers 90  points {100:10, 85:5, 60:30, 30:21, 15:6, 10:18}
sources {bank:10, krillocity-other:67, full-db-low:13}

GET /api/krillocity-race-pool?q=Name%20an%20example%20of%20a%20video%20game%20from%20the%202020s
answers 75  points {100:10, 60:5, 30:9, 15:13, 10:38}
```

## Data / verification
- `data/krillocity_answers.jsonl`: 3,249 -> 6,356 other-player answer rows,
  153 prompts, 19 prompts with all six tiers, 147 with >= 3 tiers.
- `data/krillocity_pool_use.jsonl`: 13 -> 59 served-prompt audit rows.
- `python tests/run_all.py` -> 10 passed, 0 failed.
- `python scripts/build.py verify` -> RESULT: PASS.
- Raw GitHub userscript URL -> `@version 1.2.0`.
