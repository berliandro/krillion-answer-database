# God-mode low-tier preload contract (coordinator-owned, frozen)

I set the goal of making God mode's 10-85pt answers as instant as the already-preloaded 100pt answers, and stopping it stalling on prompts that had low-tier data. I made no behaviour change to scoring/demotion/policy.

## Problem (I measured this 2026-11-23)
- I had `/api/all` preload 21,384 100pt answers into `state.premap` → instant.
- God mode called `/api/answers-tier` per prompt and gated on `state.deepcut.length` + the 500ms bot tick.
- I measured coverage: 24 prompts had exact DEEP CUT in learned.jsonl; 2,879 prompts had non-krillion answers in the FULL DB; 2,538/5,801 archive prompts had any low-tier answer.

## Data contract

### `data/tier-data.json` (owned by build worker; generated, not hand-edited)
I defined a compact snapshot of low-tier answers per prompt, mirroring the CURRENT `bridge.tier_answers()` fallback exactly (so behaviour was unchanged):
```json
{"schema": 1, "version": <int>, "rows": [["<question>", ["answer", "answer", ...]], ...]}
```
- For each question in the FULL DB with `is_krillion=0`, I took up to 20 answers `ORDER BY answer COLLATE NOCASE` (identical to the current SQL). I merged exact DEEP CUT answers from learned.jsonl (tierIndex 4 / tier "DEEP CUT" / points 85) first, deduped, cap 20.
- I kept it deterministic: `ORDER BY question`, stable JSON separators.
- I bumped `version` on every rebuild. I stored the file's byte length/sha in `data/manifest.json` under an `artifacts["tier-data.json"]` key (I gave the build worker ownership of the manifest for this key only in this phase).

### `/api/all-tier` (owned by bridge worker; consumed by userscript)
I defined GET, token-protected like every endpoint (`?t=` or `X-Krillion-Token`). Response:
```json
{"ok": true, "version": <int>, "etag": "<sha>", "data": [["<question>", ["answer", ...]], ...]}
```
- I had it serve `data/tier-data.json` if present and valid (cached by mtime_ns+size, microsecond-safe), returning its `version`/`rows`.
- If the file was missing/corrupt, I had it FALL BACK to computing the same rows on demand from the FULL DB + learned (reusing `tier_answers`-style logic), so old clones still worked; report `version: 0`.
- I kept `/api/answers-tier` unchanged (backward compatibility for old userscripts).
- I did NOT change any demotion/write policy.

### Userscript (owned by userscript worker)
- I had the userscript worker extend `preloadAnswers()` to fetch `/api/all-tier` in PARALLEL with `/api/all` (not blocking one on the other). I had them build `state.tierPremap = Map(keyFor(q) -> [answers])` from the rows using the SAME `keyFor` source as the rare premap.
- In the `answerCurrentPrompt()` God branch: if `state.tierPremap` was ready, I had it set `state.deepcut` SYNCHRONOUSLY from the map for the prompt's key (no HTTP, no 500ms gate). It fell back to the existing async `/api/answers-tier` request only when the premap was not yet ready.
- If the map had NO low-tier entry for a prompt, I had it use the rare (100pt) list instead of stalling — I preferred answering over showing "loading 85-point answers" forever. I kept the 1-in-7 rare cadence where possible.
- I triggered one immediate `botTick()` when the tier preload resolved (so the bot answered without waiting for the next 500ms tick). I did not spam.
- I required them to preserve ALL 16 IDs, credit/self-update header, policy guards, forever retry, and every existing behaviour. I did NOT let them edit bridge.py, build scripts, or docs.

## Verification I required each worker to report
- I required exact command + result. I allowed no git commands (I, as coordinator, committed). No bridge restart (8768).
- I required only their owned files changed (pre-existing data logs were expected).
