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

   Leave that window running while you play. It binds loopback only. The token
   (`krillion-local-v1`) travels in the URL query, not a custom header, so Edge
   does not need a CORS preflight for https → localhost requests.

3. In Tampermonkey, create a new script and paste the entire contents of
   `injection/krillion-autofill.user.js`. Save.
4. Open https://playdaily.org/krillion. A panel appears at the top right.

## What it does

- Detects the exact prompt from `p.kr-prompt` and lists all known 100-point answers.
- One click fills `input.kr-input` using the native value setter.
- **Auto: Off** (default): **you press Enter/DIVE** to submit, as before.
- **Auto: On**: clicking an answer submits it immediately via the form's native
  `requestSubmit()`, so the dive advances without a keypress. The setting is
  remembered between page loads. Use the **Auto** button in the panel header to
  switch it; the button turns green while active.
- After submission it reads the score from `.kr-reveal-points` (solo) or
  `.kr-board-head` (multiplayer/1v1). If a known 100-point answer scores less
  than 100, the bridge removes it from the rare list and appends a dated entry
  to `CHANGELOG.md`.
- At the end of a Classic dive it clicks the "Show answers" toggle and every
  row, then imports the revealed answers. It also captures the site's own
  `/api/krillion/answers` responses so complete tiers are recorded, not just
  the ~10 answers the page renders per tier.
- Failed writes are queued in Tampermonkey storage (cap 20) and retried next run.

## Near-duplicate prompts (the "paraphrase" problem)

Krillion has genuinely distinct prompts with nearly identical wording, e.g.
`Name a Mario character` and `Name a character from Mario`, or a prompt ending in
`with a ball` versus `without a ball`. Each has its OWN graded bank.

The bridge never merges them:

- **Exact match wins.** If the on-screen text matches a stored prompt (after
  trivial normalisation), only that bank is shown.
- **Fuzzy fallback keeps groups separate.** If the wording differs, the bridge
  uses the repository's `scripts/paraphrase_match.py` matcher and returns up to
  five *separately labelled* candidate prompts. The panel shows each bank under
  its own heading with a match percentage; answer lists are never combined.
- **Strict cut-off.** Only candidates scoring ≥90% of the best match survive, so
  a `song` bank does not tag along on a `film` query. Negation words (`with` vs
  `without`) are high-signal tokens.
- **Corrections keep the right key.** Filling a chip remembers which *stored*
  prompt it came from, so a later mismatch is recorded against that prompt —
  not against the paraphrased text shown on screen.

## Files written by the bridge

- `injection/data/corrections.jsonl` — answers demoted from the 100-point tier
- `injection/data/learned.jsonl` — answers observed during play
- `injection/CHANGELOG.md` — timestamped log of every change

No existing database or file owned by the webapp optimizer is modified.

## Health check / diagnosing a failed prompt

Open this in Edge's address bar — if it returns JSON, the bridge is reachable
from Edge itself:

```
http://127.0.0.1:8768/api/health?t=krillion-local-v1
```

Prompts that cannot be answered, or requests that fail, are logged to
`injection/data/failed_prompts.jsonl`. Read them from the browser at:

```
http://127.0.0.1:8768/api/failed?t=krillion-local-v1
```

Every submitted answer is logged to `injection/data/evidence.jsonl` (view at
`/api/evidence?t=krillion-local-v1`). **Play scores never demote an answer** —
the game AI-grades unknown answers inconsistently. Only the dive-end graded bank
can change the rare tier; the policy is in `DECISIONS.md`.

When a prompt has no bank, the helper can fetch that prompt's real graded bank
from `playdaily.org`, respecting the cooldown and de-duplicating. Disable with
`KRILLION_NO_FETCH=1`. Queue: `/api/fetch-queue?t=krillion-local-v1`.

The userscript retries each failed request up to 3 times with a 12-second
timeout before showing an error. **"Process the log"** is a standing workflow —
see `PROCESS-LOG.md`.
