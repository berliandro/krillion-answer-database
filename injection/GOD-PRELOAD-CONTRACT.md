# God-mode low-tier preload contract (coordinator-owned, frozen)

Goal: make God mode's 10-85pt answers as instant as the already-preloaded 100pt answers, and stop it stalling on prompts that have low-tier data. No behaviour change to scoring/demotion/policy.

## Problem (measured 2026-11-23)
- `/api/all` preloads 21,384 100pt answers into `state.premap` → instant.
- God mode calls `/api/answers-tier` per prompt and gates on `state.deepcut.length` + the 500ms bot tick.
- Coverage: 24 prompts have exact DEEP CUT in learned.jsonl; 2,879 prompts have non-krillion answers in the FULL DB; 2,538/5,801 archive prompts have any low-tier answer.

## Data contract

### `data/tier-data.json` (owned by build worker; generated, not hand-edited)
Compact snapshot of low-tier answers per prompt, mirroring the CURRENT `bridge.tier_answers()` fallback exactly (so behaviour is unchanged):
```json
{"schema": 1, "version": <int>, "rows": [["<question>", ["answer", "answer", ...]], ...]}
```
- For each question in the FULL DB with `is_krillion=0`, take up to 20 answers `ORDER BY answer COLLATE NOCASE` (identical to the current SQL). Merge exact DEEP CUT answers from learned.jsonl (tierIndex 4 / tier "DEEP CUT" / points 85) first, deduped, cap 20.
- Deterministic: `ORDER BY question`, stable JSON separators.
- `version` bumps on every rebuild. Store the file's byte length/sha in `data/manifest.json` under an `artifacts["tier-data.json"]` key (build worker owns manifest for this key only in this phase).

### `/api/all-tier` (owned by bridge worker; consumed by userscript)
GET, token-protected like every endpoint (`?t=` or `X-Krillion-Token`). Response:
```json
{"ok": true, "version": <int>, "etag": "<sha>", "data": [["<question>", ["answer", ...]], ...]}
```
- Serve `data/tier-data.json` if present and valid (cache by mtime_ns+size, microsecond-safe), returning its `version`/`rows`.
- If the file is missing/corrupt, FALL BACK to computing the same rows on demand from the FULL DB + learned (reuse `tier_answers`-style logic), so old clones still work; report `version: 0`.
- Keep `/api/answers-tier` unchanged (backward compatibility for old userscripts).
- Do NOT change any demotion/write policy.

### Userscript (owned by userscript worker)
- Extend `preloadAnswers()` to fetch `/api/all-tier` in PARALLEL with `/api/all` (do not block one on the other). Build `state.tierPremap = Map(keyFor(q) -> [answers])` from the rows using the SAME `keyFor` source as the rare premap.
- In `answerCurrentPrompt()` God branch: if `state.tierPremap` is ready, set `state.deepcut` SYNCHRONOUSLY from the map for the prompt's key (no HTTP, no 500ms gate). Only fall back to the existing async `/api/answers-tier` request when the premap is not yet ready.
- If the map has NO low-tier entry for a prompt, use the rare (100pt) list instead of stalling — prefer answering over showing "loading 85-point answers" forever. Keep the 1-in-7 rare cadence where possible.
- Trigger one immediate `botTick()` when the tier preload resolves (so the bot answers without waiting for the next 500ms tick). Do not spam.
- Preserve ALL 16 IDs, credit/self-update header, policy guards, forever retry, and every existing behaviour. Do NOT edit bridge.py, build scripts, or docs.

## Verification each worker must report
- Exact command + result. No git commands (coordinator commits). No bridge restart (8768).
- Only your owned files changed (pre-existing data logs are expected).
