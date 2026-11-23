# Restructure contract (coordinator-owned, frozen for this restructure)

All workers implement to THIS document. Do not change it. If you need a change,
report a blocker; the coordinator edits it once between phases.

## Non-negotiable rules for every worker
- Edit ONLY the files you own (listed per job). Do not touch any other file.
- Do NOT run any git command (no add/commit/checkout/stash/reset/clean/pull/push).
  The coordinator commits between phases.
- Do NOT restart the bridge or kill any process. It is running on port 8768.
- Re-read your own file immediately before each edit; edit tools match exact text.
- Preserve behaviour: near-duplicate prompts stay as SEPARATE labelled `groups[]`;
  play scores never demote; only the game's graded bank demotes; other players'
  answers are never recorded; IDs in the userscript stay unchanged.

## Data contracts

### `data/manifest.json` (owned by build worker; read by bridge + clients)
```json
{
  "schema_version": 2,
  "data_version": 1,
  "etag": "<sha256-of-derived-inputs>",
  "built_at": "<ISO8601 UTC>",
  "counts": {"full": 0, "search": 0, "krillion": 0, "prompts": 0},
  "artifacts": {"search-data.json": "<sha256>", "krillion/krillion-data.json": "<sha256>"}
}
```
- `data_version` is a monotonic integer; bump it on every derived rebuild.
- `etag` is the sha256 of the concatenation of source answer JSONLs + corrections.
- If absent, consumers must fall back to old behaviour (no version checking).

### `/api/all` response (owned by bridge worker; consumed by userscript)
Keep `data` as objects for backward compatibility; ADD fields:
```json
{"ok": true, "version": <int from manifest.data_version>, "etag": "<manifest.etag>",
 "data": [{"q": "<stored question>", "nq": "<normalised+rewritten key>", "answers": ["..."]}]}
```
- `nq` = `rewrite_query(normalise(q))` (the bridge's own strict pipeline). Clients use
  `nq` when present and fall back to local `normLocal` when absent. This removes the
  duplicated client normaliser from the hot path without breaking old userscript copies.

### `/api/answers`, `/api/answers-tier`, `/api/perf` — shapes UNCHANGED.
`/api/answers` must still return `groups[]` with separate labelled banks.

### Prefetch (owned by userscript worker)
`watchApi()` already captures `/deal` prompts. For each captured prompt, warm
`state.netCache` with `request('/api/answers?q=...')` (cap concurrency <=3). Key by
`normLocal(prompt)`. Never log prefetch failures as misses; the normal lookup path
still owns miss logging.

### Generated normaliser (owned by build worker; consumed by sites only)
`shared/norm.generated.js` exposes:
```js
window.KrillionNorm = {
  norm: function (q) { /* == paraphrase_match.normalise */ },
  rewrite: function (q) { /* == bridge.rewrite_query */ }
};
```
The userscript does NOT depend on this file (it uses `nq` from `/api/all`).

## Ownership map (phase 2, parallel — disjoint files)
- Bridge worker: `injection/bridge.py` ONLY.
- Build worker: `scripts/build.py`, `scripts/config.py`, `scripts/ingest.py`,
  `scripts/derive.py`, `scripts/emit.py`, `scripts/verify.py`, `scripts/publish.py`,
  `data/manifest.json`, `shared/norm.generated.js`. Thin legacy aliases in
  `scripts/krillion_db.py`, `scripts/build_static.py`, `scripts/build_krillion_site.py`,
  `scripts/build_webapp.py` may be edited by this worker ONLY as wrappers.
- Userscript worker: `injection/krillion-autofill.user.js` ONLY.
- Site worker (separate session, webapp-optimizer): `site-template.html`,
  `index.html`, `webapp/*`, `krillion/*` — assigned in a later phase.

## Verification each worker must report
- Exact command run and result (tests / syntax check / byte counts).
- Confirmation no other file was touched (`git status --short` shows only owned paths).
- One result-contract message, no progress chatter.
