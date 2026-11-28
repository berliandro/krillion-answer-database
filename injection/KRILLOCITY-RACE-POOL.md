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
4. `tier_answers()` full-DB low tiers were never included in the race pool.
5. Exact banks often have only 1 answer while a near-duplicate sibling wording
   holds the full low-tier set (e.g. `What's an example of a holiday celebrated
   in winter?` -> `Name a holiday celebrated in winter`, 45 low-tier rows).
6. `loadAnswers()` returned early on a premap/netCache hit, before the race-pool
   fetch — any Krillocity prompt that is also a preloaded bank would never get
   a race pool at all.

## Fix (userscript v1.2.3)
- `injection/bridge.py` `GET /api/krillocity-race-pool?q=<on-screen prompt>`:
  - resolves exact -> alias -> fuzzy, includes the literal on-screen wording;
  - merges graded 100s, learned tiers with real `tierIndex` points, harvested
    other-player answers, full-DB low tiers, and near-duplicate low tiers;
  - dedupes and sorts **100 -> 85 -> 60 -> 30 -> 15 -> 10**;
  - logs every served prompt to `data/krillocity_pool_use.jsonl` with a source
    breakdown and the other-player answers used.
- Near-duplicate expansion pools **low tiers only** — their 100-point banks are
  never merged into matching, display or the search DB (policy preserved).
- `raceBuildPool()` uses the bridge pool as the primary ordered answer list;
  `loadAnswers()` now fetches it on **every** prompt, including fast paths.
- `captureRivalAnswers()` reads the game's own signed results URLs, resolves
  slot -> prompt from its lineup, and POSTs other players' answers and the
  game's own points to `/api/krillo-answer` (separate archive only).
- `scripts/harvest_krillocity_others.js` is the offline equivalent for bulk
  harvesting public race results.
- No play-score demotions; aliases remain log-only; other-player answers never
  reach the graded 100-point bank.

## Live scored validation (Edge automation profile, real multiplayer room, autoplay on)
Shipped source injected with a GM stub that relays bridge calls and records each
`submitAnswer()`. Test build only — the shipped source is unchanged.

### All six tiers, descending — "What's an example of a dish made with beef?"
- Bridge pool: 55 answers — `{100:10, 85:10, 60:10, 30:10, 15:10, 10:5}`
  (10 bank + 45 learned with real tierIndex points).
- Submitted: all 55 in exact descending point sequence:
  `100 x10, 85 x10, 60 x10, 30 x10, 15 x10, 10 x5`.
- Unmapped submissions: 0. `descending = true`.
- First: Beef Hachée, Beef Idiyappam, … (100); then Beef Biryani, Beef
  Cannelloni, Beef Keema Matar, Beef Laab, Beef Larb (85); … last: Beef Stew,
  Beef Tacos, Hamburger, Meatloaf, Steak (10).

### Five-tier descending order — "Name one pastry filled with meat"
- Bridge pool: 46 answers — `{100:10, 60:3, 30:10, 15:4, 10:19}`.
- Submitted: all 46, exact descending point sequence:
  `100 x10, 60 x3, 30 x10, 15 x4, 10 x19`.
- Unmapped submissions: 0. `descending = true`.
- First answers: Banh Pate So, Bedfordshire Clanger, Epok-epok, Kibinai,
  Killie Pie, Klobasnek, Natchitoches Meat Pie, Pastechi, Su Boregi, Talas
  Boregi (all 100); then Eel Pie, Siopao, Siopao... (60), then the 30/15/10
  tiers.

### Two-tier descending order — "What's something that gives off steam?"
- Bridge pool: 28 answers — 8 x 100 (bank), 20 x 10 (full-db-low).
- Submitted: all 28, sequence `100 x8, 10 x20`. Unmapped: 0. `descending = true`.

### Other players' answers recorded by the userscript itself (live)
The game's own lineup/results responses are observed in `watchApi()` — no extra
rate-limited requests. From a real live room (`race2-1`, race `106020`, slot 0):
- `data/krillocity_answers.jsonl`: 58 new rows for the on-screen prompt
  **"Name any one food you dip in sauce"**, game points
  `{85:5, 60:13, 30:11, 15:16, 10:13}` (e.g. Raccoon Meat = 85, Cat Meat = 60).
- `injection/data/bot_log.jsonl`: `krillocity-rivals-captured` events with
  `room`, `detail` (race) and `count`.

### All-six-tier pool served live (not submitted before the round ended)
- "Name a thing people buy at a music shop": 67 answers
  `{100:1, 85:1, 60:10, 30:10, 15:17, 10:28}` loaded by the live userscript.

Other live prompts with ranked pools: "Name a kind of bicycle" (100:10, 10:20),
"Name a animal that is very big" (100:2, 10:19), "Name one thing with a hook"
(100:5, 85:3, 60:9, 30:17, 15:15, 10:20 via the bridge endpoint).

The earlier five-tier run also covered 60/30/15/10; the six-tier run above is
the definitive live proof that all six tiers are entered highest-first.

## Endpoint evidence
```
GET /api/krillocity-race-pool?q=Name%20any%20one%20ice%20cream%20flavor
answers 90  points {100:10, 85:5, 60:30, 30:21, 15:6, 10:18}

GET /api/krillocity-race-pool?q=Name%20an%20example%20of%20a%20video%20game%20from%20the%202020s
answers 75  points {100:10, 60:5, 30:9, 15:13, 10:38}
```

## Data / verification
- `data/krillocity_answers.jsonl`: 3,249 -> 6,727 other-player answer rows,
  including 58 live userscript-captured rows for "Name any one food you dip in
  sauce" (race2-1/106020 slot 0) with points 85/60/30/15/10.
- `injection/data/bot_log.jsonl`: `krillocity-rivals-captured` events.
- `data/krillocity_pool_use.jsonl`: 13 -> 85+ served-prompt audit rows.
- `python tests/run_all.py` -> 10 passed, 0 failed.
- `python scripts/build.py verify` -> RESULT: PASS.
- Raw GitHub userscript URL -> `@version 1.2.5`.
