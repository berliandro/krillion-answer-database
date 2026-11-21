# Krillion Autofill (PC only)

A lightweight Tampermonkey userscript that shows **every known 100-point answer**
for the current Krillion prompt and feeds real gameplay results back into the
local archive.

## Why two pieces

A userscript cannot read or write a local SQLite database. So:

1. `krillion-autofill.user.js` runs in Chrome on `playdaily.org/krillion`.
2. `bridge.py` runs on your PC at `127.0.0.1:8768`, reads `data/krillion_only.db`
   (17,876 rare answers, read-only) and writes only inside `injection/`.

The userscript talks to the bridge with `GM_xmlhttpRequest` (`@connect 127.0.0.1`);
it never embeds the data, so the script stays small.

## Install

1. Install Tampermonkey in Chrome.
2. Start the bridge:

   ```powershell
   cd "D:\! Games\Krillion Game"
   python injection/bridge.py
   ```

   Leave that window running while you play. It binds loopback only and requires
   the header token `krillion-local-v1` (hard-coded in both files).

3. In Tampermonkey, create a new script and paste the entire contents of
   `injection/krillion-autofill.user.js`. Save.
4. Open https://playdaily.org/krillion. A panel appears at the top right.

## What it does

- Detects the exact prompt from `p.kr-prompt` and lists all known 100-point answers.
- One click fills `input.kr-input` using the native value setter; **you press
  Enter/DIVE** to submit.
- After submission it reads the score from `.kr-reveal-points` (solo) or
  `.kr-board-head` (multiplayer/1v1). If a known 100-point answer scores less
  than 100, the bridge removes it from the rare list and appends a dated entry
  to `CHANGELOG.md`.
- At the end of a Classic dive it clicks the "Show answers" toggle and every
  row, then imports the revealed answers. It also captures the site's own
  `/api/krillion/answers` responses so complete tiers are recorded, not just
  the ~10 answers the page renders per tier.
- Failed writes are queued in Tampermonkey storage (cap 20) and retried next run.

## Files written by the bridge

- `injection/data/corrections.jsonl` — answers demoted from the 100-point tier
- `injection/data/learned.jsonl` — answers observed during play
- `injection/CHANGELOG.md` — timestamped log of every change

No existing database or file owned by the webapp optimizer is modified.

## Health check

```powershell
curl.exe -H "X-Krillion-Token: krillion-local-v1" http://127.0.0.1:8768/api/health
```
