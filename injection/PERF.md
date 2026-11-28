# Bridge lookup performance — evidence and verdict

I scoped this to `injection/bridge.py` only. I made no schema, data, DB, or userscript changes.

## What I found was slow

I saw `/api/answers` take ~6.4 s and `/api/answers-tier` ~1–4 s, so prompts
were missed in the 5-second room. My profiling separated the cost into three
in-process problems, none of which was "the DB is too big":

| Work | Before (parent run) | Before (this machine) |
|---|---|---|
| `resolve_question` exact: `SELECT DISTINCT` + `normalise()` on all 5,801 questions | ~670 ms | 361.5 ms |
| `Matcher.search()` cold fuzzy call | ~10.6 s | 1.24 s (1.40 s bare search) |
| `tier_answers`: `read_jsonl(LEARNED)` (826 KB, 4,920 rows) | ~234 ms | 28.3 ms |
| `tier_answers`: FULL_DB fallback, planner picks `idx_answers_krillion` + temp B-tree | up to 1,786 ms cold / 96 ms warm | 337.9 ms |

I ran `EXPLAIN QUERY PLAN` for the old fallback and it confirmed the bad plan:

```
SEARCH answers USING INDEX idx_answers_krillion (is_krillion=?)
USE TEMP B-TREE FOR ORDER BY
```

I found exact lookups on the 21,384-row derived DB were already ~0 ms, and
`SELECT DISTINCT question` was ~7.7 ms — so the repeated `normalise()` loop and
the JSONL re-parse, not SQLite I/O, dominated.

## Changes I made

1. I built **`NORM_TO_QUESTION`** once at startup by calling `normalise()` once
   per stored question (5,801 entries). Exact and rewritten-exact detection became
   O(1) dict lookups. I used `ORDER BY question` with `setdefault`, so
   first-wins collision behaviour matched the matcher. I found in fact **no**
   collisions (5,801 norms for 5,801 questions), so matching behaviour was
   unchanged.
2. I added **`RESOLVE_CACHE`** — a bounded LRU (512), keyed by normalised query, holding
   only `(is_exact, ((question, score), ...))`. I rebuilt Answers with fresh
   `removed_pairs()` on every call, so game-bank demotions still applied to cached
   matches. I preserved all rules: distinct labelled banks (never merged),
   kind/type variants, rewritten-exact detection, and the `best * 0.90`
   relative cut-off. The single-flight lock meant two concurrent identical
   prompts never both paid the cold search.
3. I added **`cached_learned()`** — mirroring `_ALL_CACHE`: keyed by `st_mtime_ns` +
   `st_size`. `add_bank()` still wrote and read the file directly, so new rows
   invalidated the cache immediately.
4. I changed the **FULL_DB fallback** to `INDEXED BY idx_answers_question`. New plan:
   ```
   SEARCH answers USING INDEX idx_answers_question (question=?)
   USE TEMP B-TREE FOR ORDER BY
   ```
   The remaining temp B-tree sorted only the (≤20) rows for one prompt.
5. I added **`/api/perf`** — a token-protected GET; it reports cache sizes, hit/miss counters,
   normalised-prompt count and matcher size. I left Token check, CORS and response
   shapes of all existing endpoints unchanged.

## Measurements I took after the change (same machine, standalone harness importing bridge.py)

| Operation | Before | After |
|---|---|---|
| Exact resolve | 361.5 ms | **1.03 ms cold / 0.92 ms warm** |
| Fuzzy resolve (perturbed prompt with real hits) | 1.40 s bare search | 1.65 s cold (one-time) / **2.44 ms warm** |
| Fuzzy resolve via HTTP | ~6.4 s reported | 1,054.77 ms cold / **13.90 ms warm** |
| Tier lookup | 28.3 ms JSONL + 337.9 ms query | **2.18 ms warm** (80.1 ms first call incl. cache load) |
| Tier lookup via HTTP | ~1–4 s reported | 37.99 ms cold / **24.50 ms warm** |
| FULL_DB fallback query | 337.9 ms | **1.47 ms** (median of 5) |
| Learned JSONL parse | 28.3 ms every call | 28.3 ms **once**, then 0 |

I measured Startup cost as 3.6 s one-time (matcher index + normalised map). Repeated prompts
never re-ran the fuzzy search: a 3-bank fuzzy result stayed distinct
(`Name a 3D shape` 0.9387 / 10 answers, `Name any 3D shape` 0.9311 / 1 answer,
`Name any one 3D shape` 0.9271 / 1 answer).

I observed `/api/perf` after warm-up:

```json
{"ok": true,
 "resolve_cache": {"size": 2, "max": 512, "hits": 1, "misses": 2},
 "learned_cache": {"rows": 4920, "hits": 1, "misses": 1},
 "all_cache": {"items": 0, "hits": 0, "misses": 0},
 "normalised_prompts": 5801, "matcher_questions": 5801}
```

I found the absolute cold-search number varies by CPU: an earlier run measured 10.6 s,
this machine measured 1–2 s. The fix removed that cost from all repeat calls in
either case, which was what the room needed (one prompt is seen many times across
players and rounds).

## My verdict on splitting the answers into multiple DB files with a pointer/index? **NO.**

I found the bottleneck was never DB size or lookup I/O. Exact answer lookup on a single
21,384-row DB was already sub-millisecond, and the full fallback was ~1.5 ms once
the planner used `idx_answers_question`. The 6.4 s came from normalising 5,801
questions in Python on every request and from the fuzzy matcher scoring all
5,801 stored prompts in memory; an 826 KB JSONL was also re-parsed every call.
Splitting into several DB files would not have reduced any of that in-process work —
the matcher still held every distinct question in memory — while adding a
pointer/index indirection, a rebuild path, and new failure modes across the two
data tiers. I found caching the resolution, building the normalised map once, caching
the learned file by mtime/size, and forcing the correct index delivered the same
goal with no new files and no data-model risk. I would revisit only if the DB grew by
orders of magnitude and exact probes became I/O bound; at 21k/127k rows with
proper indexes they were not.

## Verification

```
python -m py_compile injection/bridge.py     # passes
```

I ran an Endpoint smoke test on an isolated port (8768 was already in use by the running
bridge): 403 without token on `/api/perf`, 200 with token; `/api/answers` exact
and fuzzy; `/api/answers-tier` with `alt`; counters advanced as expected.
