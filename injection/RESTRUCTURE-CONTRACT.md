# Restructure contract (coordinator-owned, frozen for this restructure)

I had all workers implement to THIS document. I told them not to change it. If they needed a change,
they reported a blocker; I, as coordinator, edited it once between phases.

## Non-negotiable rules I set for every worker
- I had them edit ONLY the files they owned (listed per job). I told them not to touch any other file.
- I told them NOT to run any git command (no add/commit/checkout/stash/reset/clean/pull/push).
  I, as coordinator, committed between phases.
- I told them NOT to restart the bridge or kill any process. I had it running on port 8768.
- I had them re-read their own file immediately before each edit; edit tools matched exact text.
- I required them to preserve behaviour: near-duplicate prompts stay as SEPARATE labelled `groups[]`;
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
- I made `data_version` a monotonic integer; I bumped it on every derived rebuild.
- `etag` is the sha256 of the concatenation of source answer JSONLs + corrections.
- If absent, I required consumers to fall back to old behaviour (no version checking).

### `/api/all` response (owned by bridge worker; consumed by userscript)
I had them keep `data` as objects for backward compatibility; I had them ADD fields:
```json
{"ok": true, "version": <int from manifest.data_version>, "etag": "<manifest.etag>",
 "data": [{"q": "<stored question>", "nq": "<normalised+rewritten key>", "answers": ["..."]}]}
```
- I defined `nq` = `rewrite_query(normalise(q))` (the bridge's own strict pipeline). I had clients use
  `nq` when present and fall back to local `normLocal` when absent. This removed the
  duplicated client normaliser from the hot path without breaking old userscript copies.

### `/api/answers`, `/api/answers-tier`, `/api/perf` — shapes UNCHANGED.
I required `/api/answers` to still return `groups[]` with separate labelled banks.

### Prefetch (owned by userscript worker)
I noted `watchApi()` already captured `/deal` prompts. For each captured prompt, I had them warm
`state.netCache` with `request('/api/answers?q=...')` (cap concurrency <=3). I keyed by
`normLocal(prompt)`. I kept prefetch failures out of miss logs; the normal lookup path
still owned miss logging.

### Generated normaliser (owned by build worker; consumed by sites only)
I had `shared/norm.generated.js` expose:
```js
window.KrillionNorm = {
  norm: function (q) { /* == paraphrase_match.normalise */ },
  rewrite: function (q) { /* == bridge.rewrite_query */ }
};
```
I kept the userscript independent of this file (it used `nq` from `/api/all`).

## Ownership map I set (phase 2, parallel — disjoint files)
- Bridge worker: `injection/bridge.py` ONLY.
- Build worker: `scripts/build.py`, `scripts/config.py`, `scripts/ingest.py`,
  `scripts/derive.py`, `scripts/emit.py`, `scripts/verify.py`, `scripts/publish.py`,
  `data/manifest.json`, `shared/norm.generated.js`. Thin legacy aliases in
  `scripts/krillion_db.py`, `scripts/build_static.py`, `scripts/build_krillion_site.py`,
  `scripts/build_webapp.py` may be edited by this worker ONLY as wrappers.
- Userscript worker: `injection/krillion-autofill.user.js` ONLY.
- Site worker (separate session, webapp-optimizer): `site-template.html`,
  `index.html`, `webapp/*`, `krillion/*` — assigned in a later phase.

## Verification I required each worker to report
- I required exact command run and result (tests / syntax check / byte counts).
- I required confirmation no other file was touched (`git status --short` showed only owned paths).
- I required one result-contract message, no progress chatter.
