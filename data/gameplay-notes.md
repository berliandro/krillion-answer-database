# Krillion gameplay harvester notes (job gameplay-001)

## Investigation (2026-11-20)

Goal was to find the end-of-dive source of the 7 graded answer banks. Played one
Classic dive in Chrome (tab `krillion-gameplay`) with a fetch/XHR interceptor.

### What the game actually does
- `POST /api/krillion/deal {"mode":"classic"}` -> `{prompts:[7], tickets:{promptId:ticket}, lap}`.
  Unthrottled, ~0.3 s. A **different ticket per prompt**, all from one deal.
- `POST /api/krillion/answer` grades one guess (`{accepted,tier,points,...}`), unthrottled.
- The results screen does **not** receive one bulk payload. It fires **7 parallel**
  `GET /api/krillion/answers?prompt=<id>&ticket=<ticket>` requests; all 7 returned
  200 in 0.3 s (54/25/25/59/55/25/46 answers). This is the "bulk" behaviour.
- The limiter was a **single global ~65 s window shared by the 7 tickets of a lap**.
  A burst for one lap worked; a fresh deal immediately after got 425 for all 7.

### Measured proof
| Test | Result |
| --- | --- |
| Results screen, 7 parallel /answers | 7x200 in 0.3 s, 289 answers |
| Same ticket: 425 `wait:64956` -> sleep 66.4 s -> retry | 200, 55 answers |
| Fresh deal -> 425 `wait:65197` -> sleep 67.8 s -> burst 7 | 7x200, 350 answers (49/48/54/45/39/55/60) |
| Plain Node `fetch` from this machine | 200, no cookies/headers needed |

My conclusion was that gameplay and DOM expansion were unnecessary. The fastest loop was
`deal -> probe /answers -> on 425 sleep wait+2s -> burst all 7 -> repeat`:
~350 answers per ~68 s (~300/min), roughly 6x the old paced API harvester.

### UI-speed observations (if gameplay is ever needed)
- The fastest submit was `fill` input + `press Enter`. Enter also advanced past the verdict.
- `fill` during the "CLOCK STARTING IN" countdown hung ~20 s (input not ready);
  I skipped those prompts rather than waiting.
- The results rows are `.kr-row-head` buttons, collapsed; each expands its bank.
- Browser `browse` relay occasionally stopped answering for 20-40 s during play.

### Harvester
`scripts/harvest_game.js` implemented the burst loop. It de-duped against every
`data/answers*.jsonl`, wrote one JSON line per graded answer to
`data/answers_gameplay.jsonl` (tier 5 => `is_krillion:true`), stored restart state
in `%TEMP%\opencode\krillion-gameplay-state.json`, and notified the coordinator
every 1000 appended lines. I ran it as the single active harvester from 2026-11-20.

### Lap token round-trip (2026-11-20, coordinator finding)
A deal without `lap` keeps returning the initial lap token (`l1....AAAAAAAAA...`),
so the server keeps sampling from the same lap and dedupe drops grow. The site
client round-trips `lap` from the store into every `deal({mode,lap})` call.
Fixed: `deal(state.lap)`, persist `lap.lap` immediately after each response,
restore it on restart. Measured: control batch without lap added 241/325 answers
(5/7 fresh prompts); next batch with lap added 343/343 (7/7 fresh). New average
~313 new/batch vs ~236 before; ~1250 new per 4-batch checkpoint, ~300/min.
