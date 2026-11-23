# Bridge lookup performance — evidence and verdict

Scope: `injection/bridge.py` only. No schema, data, DB, or userscript changes.

## What was slow

The user saw `/api/answers` take ~6.4 s and `/api/answers-tier` ~1–4 s, so prompts
were missed in the 5-second room. Profiling separates the cost into three
in-process problems, none of which are "the DB is too big":

| Work | Before (parent run) | Before (this machine) |
|---|---|---|
| `resolve_question` exact: `SELECT DISTINCT` + `normalise()` on all 5,801 questions | ~670 ms | 361.5 ms |
| `Matcher.search()` cold fuzzy call | ~10.6 s | 1.24 s (1.40 s bare search) |
| `tier_answers`: `read_jsonl(LEARNED)` (826 KB, 4,920 rows) | ~234 ms | 28.3 ms |
| `tier_answers`: FULL_DB fallback, planner picks `idx_answers_krillion` + temp B-tree | up to 1,786 ms cold / 96 ms warm | 337.9 ms |

`EXPLAIN QUERY PLAN` for the old fallback confirmed the bad plan:

```
SEARCH answers USING INDEX idx_answers_krillion (is_krillion=?)
USE TEMP B-TREE FOR ORDER BY
```

Exact lookups on the 21,384-row derived DB were already ~0 ms, and
`SELECT DISTINCT question` was ~7.7 ms — so the repeated `normalise()` loop and
the JSONL re-parse, not SQLite I/O, dominated.

## Changes made

1. **`NORM_TO_QUESTION`** — built once at startup by calling `normalise()` once
   per stored question (5,801 entries). Exact and rewritten-exact detection are
   now O(1) dict lookups. The query is `ORDER BY question` with `setdefault`, so
   first-wins collision behaviour matches the matcher. There are in fact **no**
   collisions (5,801 norms for 5,801 questions), so matching behaviour is
   unchanged.
2. **`RESOLVE_CACHE`** — bounded LRU (512), keyed by normalised query, holding
   only `(is_exact, ((question, score), ...))`. Answers are rebuilt with fresh
   `removed_pairs()` on every call, so game-bank demotions still apply to cached
   matches. All rules are preserved: distinct labelled banks (never merged),
   kind/type variants, rewritten-exact detection, and the `best * 0.90`
   relative cut-off. The single-flight lock means two concurrent identical
   prompts never both pay the cold search.
3. **`cached_learned()`** — mirrors `_ALL_CACHE`: keyed by `st_mtime_ns` +
   `st_size`. `add_bank()` still writes and reads the file directly, so new rows
   invalidate the cache immediately.
4. **FULL_DB fallback** — `INDEXED BY idx_answers_question`. New plan:
   ```
   SEARCH answers USING INDEX idx_answers_question (question=?)
   USE TEMP B-TREE FOR ORDER BY
   ```
   The remaining temp B-tree sorts only the (≤20) rows for one prompt.
5. **`/api/perf`** — token-protected GET; reports cache sizes, hit/miss counters,
   normalised-prompt count and matcher size. Token check, CORS and response
   shapes of all existing endpoints are unchanged.

## After measurements (same machine, standalone harness importing bridge.py)

| Operation | Before | After |
|---|---|---|
| Exact resolve | 361.5 ms | **1.03 ms cold / 0.92 ms warm** |
| Fuzzy resolve (perturbed prompt with real hits) | 1.40 s bare search | 1.65 s cold (one-time) / **2.44 ms warm** |
| Fuzzy resolve via HTTP | ~6.4 s reported | 1,054.77 ms cold / **13.90 ms warm** |
| Tier lookup | 28.3 ms JSONL + 337.9 ms query | **2.18 ms warm** (80.1 ms first call incl. cache load) |
| Tier lookup via HTTP | ~1–4 s reported | 37.99 ms cold / **24.50 ms warm** |
| FULL_DB fallback query | 337.9 ms | **1.47 ms** (median of 5) |
| Learned JSONL parse | 28.3 ms every call | 28.3 ms **once**, then 0 |

Startup cost is 3.6 s one-time (matcher index + normalised map). Repeated prompts
never re-run the fuzzy search: a 3-bank fuzzy result stayed distinct
(`Name a 3D shape` 0.9387 / 10 answers, `Name any 3D shape` 0.9311 / 1 answer,
`Name any one 3D shape` 0.9271 / 1 answer).

Observed `/api/perf` after warm-up:

```json
{"ok": true,
 "resolve_cache": {"size": 2, "max": 512, "hits": 1, "misses": 2},
 "learned_cache": {"rows": 4920, "hits": 1, "misses": 1},
 "all_cache": {"items": 0, "hits": 0, "misses": 0},
 "normalised_prompts": 5801, "matcher_questions": 5801}
```

The absolute cold-search number varies by CPU: an earlier run measured 10.6 s,
this machine measures 1–2 s. The fix removes that cost from all repeat calls in
either case, which is what the room needs (one prompt is seen many times across
players and rounds).

## Verdict: split the answers into multiple DB files with a pointer/index? **NO.**

The bottleneck was never DB size or lookup I/O. Exact answer lookup on a single
21,384-row DB is already sub-millisecond, and the full fallback is ~1.5 ms once
the planner uses `idx_answers_question`. The 6.4 s came from normalising 5,801
questions in Python on every request and from the fuzzy matcher scoring all
5,801 stored prompts in memory; an 826 KB JSONL was also re-parsed every call.
Splitting into several DB files would not reduce any of that in-process work —
the matcher still holds every distinct question in memory — while adding a
pointer/index indirection, a rebuild path, and new failure modes across the two
data tiers. Caching the resolution, building the normalised map once, caching
the learned file by mtime/size, and forcing the correct index deliver the same
goal with no new files and no data-model risk. Revisit only if the DB grows by
orders of magnitude and exact probes become I/O bound; at 21k/127k rows with
proper indexes they are not.

## Verification

```
python -m py_compile injection/bridge.py     # passes
```

Endpoint smoke test on an isolated port (8768 was already in use by the running
bridge): 403 without token on `/api/perf`, 200 with token; `/api/answers` exact
and fuzzy; `/api/answers-tier` with `alt`; counters advanced as expected.
