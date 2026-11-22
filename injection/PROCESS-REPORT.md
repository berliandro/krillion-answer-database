# Process-the-log report — 2026-11-22

Mode: **read-only / deferred**. A 24-hour Krillion run is active in Microsoft Edge
and the bridge on `127.0.0.1:8768` is in use. No database, active log, browser
tab, or bridge process was modified or restarted.

## Counts (live files, read only)

| File | Lines |
| --- | --- |
| `evidence.jsonl` | 2,477 |
| `prompt_review.jsonl` | 2,227 |
| `bot_log.jsonl` | 14 |
| `failed_prompts.jsonl` | 33 |
| `fetch_queue.jsonl` | 0 |
| `corrections.jsonl` | 0 |
| `learned.jsonl` | 3,227 (own 2,184 / api 1,043) |
| `answers_injection.jsonl` | 3,227 |
| `other_users_quarantine.jsonl` | 2,536 |

Bridge health at review: OK, 17,876 base answers, 0 corrections, 3,227 learned,
33 misses. Listener PID unchanged.

## Findings

1. **Scoring is good.** 2,469 of 2,477 evidence events scored 100; only 8 were
   below 100. Play scores are evidence only — no demotions.
2. **Log-growth root cause found.** `prompt_review.jsonl` has 2,194 `ambiguous`
   events for 2,193 unique prompts. The userscript logs *every* non-exact match,
   even a single bank at 0.98 confidence. That is why the file grew to ~2,200
   lines in one run. Fix (next run): log `ambiguous` only when more than one bank
   is shown, or the best score is below ~0.90.
3. **Duel bot bug found.** `bot_log` shows `duel-start` clicking
   **“Leave before it starts”** — the generic start-button regex matches the word
   *starts* in a *leave* button. Fix (next run): exclude buttons matching
   `/leave|cancel|quit|back/i` from the duel start candidates.
4. **Paraphrase rewrites validated offline.** Applying these to the on-screen
   text before matching turns several near-matches into exact matches:
   - `name one ` → `name a `
   - `name any one ` → `name a `
   - `name any ` → `name a `
   - `what is an example of a/an ` → `name a/an `
   - `beginning with` → `starting with` (already present)
   Also needed: `kind ↔ type` synonym handling for prompts like
   “Name any one type of hat” → stored “Name a kind of hat”.
5. **No-match prompts** are mostly “kind/type” variants; 4 earlier events were
   `unreachable: bridge offline`. Fetch queue is empty.
6. `prompt_review` contains 2 synthetic `__PROMPT__` records from testing —
   remove them after the run.
7. Bot log confirms `marathon5` selected “The Marathon · 5 sec / 50 prompts” —
   the room selector is working.

## Deferred until the 24-hour run ends

- `python scripts/krillion_db.py import` — rebuilds `krillion_only.db`, which the
  live bridge reads.
- `python scripts/build_static.py` — generated-site refresh.
- `python injection/rotate_logs.py --apply` — rewrites active logs the bridge appends to.
- Committing the dirty data/log files (they are still being appended to).
- Applying the code fixes above (source edits are safe, but a Tampermonkey
  re-paste/bridge restart would disturb the run, so they are documented only).

No authoritative demotions were pending (`corrections.jsonl` is empty).
