# Krillion Autofill (PC only)

A lightweight Tampermonkey userscript that shows **every known 100-point answer**
for the current Krillion prompt and feeds real gameplay results back into the
local archive.

## Why two pieces

A userscript cannot read or write a local SQLite database. So:

1. `krillion-autofill.user.js` runs in Chrome or Edge on `playdaily.org/krillion`.
2. `bridge.py` runs on your PC at `127.0.0.1:8768`, reads `data/krillion_only.db`
   (21,384 rare answers, read-only) and writes its diagnostic logs under
   `injection/data/`, plus `data/answers_injection.jsonl` for the importer.

The userscript talks to the bridge with `GM_xmlhttpRequest` (`@connect 127.0.0.1`);
it never embeds the data, so the script stays small.

## Install

1. Install Tampermonkey in Chrome or Edge.
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
- After submission it reads the per-answer score from `.kr-reveal-points` in
  Classic and **logs it as evidence only**. In multiplayer/1v1 the shared
  `.kr-board-head` shows *other players'* points, so it is never scraped as our
  score — only our own submit/refusal outcomes are logged. Play scores never
  demote an answer; only the game's own dive-end bank is authoritative (see
  `DECISIONS.md` and `STATES.md`).
- At the end of a Classic dive it clicks the "Show answers" toggle and every
  row, then imports the revealed answers. It also captures the site's own
  `/api/krillion/answers` responses so complete tiers are recorded, not just
  the ~10 answers the page renders per tier.
- Failed writes are queued in Tampermonkey storage (cap 20) and retried next run.

## Auto-play bot

The **Bot** toggle starts/stops full automatic play. While On, the script
navigates and plays by itself and auto-restarts after each dive. Settings are
remembered between page loads.

- **Pick** dropdown: `Random 100-point answer`, `Top of list`, or `God player` — mostly 85-point answers, with a 100-point answer every 7th submission. Exact 85 answers are used where the archive captured a graded bank; otherwise it falls back to non-100 answers from the full DB (correctly below 100, exact tier unknown).
- **Mode** dropdown:
  - `Classic` — begin a Classic dive.
  - `Multiplayer · 5s / 50 prompts` — joins a 5-second Marathon room (`The Marathon · 5 sec`, 50 prompts) for fast coin farming.
  - `Multiplayer · most players` — joins the room with the highest player count in the lobby.
  - `Krillocity · daily race` — follows the "Play Krillocity" link to `/krillocity`, starts the daily race, and submits multiple distinct rare answers per rapid-fire prompt (the game asks you to "name as many as you can").
  - `1 vs 1` — starts a duel. The bot follows the real Colosseum screens: accepts the tab rule if shown, queues, waits silently on the match-found countdown, and queues another match after a result. It never clicks "Leave before it starts" or "Back to the arena".
- The bot fills and submits answers itself (it overrides the manual Auto
  setting while playing). Scores are logged as evidence only — never demotions.
- If the requested room is not open, the bot waits rather than joining a
  different room.

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

- `injection/data/evidence.jsonl` — every submitted answer, tagged with `game_state` / `input_state`
- `injection/data/prompt_review.jsonl` — uncertain prompts, no-matches and refusals, with the exact on-screen wording
- `injection/data/bot_log.jsonl` — bot mode starts and lobby room choices
- `injection/data/failed_prompts.jsonl` — prompts with no bank and unreachable-bridge events
- `injection/data/fetch_queue.jsonl` — missing prompts queued for bank fetch
- `injection/data/corrections.jsonl` — answers demoted from the 100-point tier (authoritative bank data only)
- `injection/data/learned.jsonl` — answers observed at dive end (own rows and the game's graded banks)
- `data/answers_injection.jsonl` — new answer rows in the importer's format, mirrored outside `injection/` so the normal import can ingest them
- `injection/CHANGELOG.md` — timestamped log of every change

No existing database or webapp-owned source file is modified; the rare-answers
database is opened read-only.

## Health check / diagnosing a failed prompt

Open this in the address bar of the browser where you play — if it returns JSON,
the bridge is reachable from that browser:

```
http://127.0.0.1:8768/api/health?t=krillion-local-v1
```

Prompts that cannot be answered, or requests that fail, are logged to
`injection/data/failed_prompts.jsonl`. Read them from the browser at:

```
http://127.0.0.1:8768/api/failed?t=krillion-local-v1
```

Every submitted answer is logged to `injection/data/evidence.jsonl` (view at
`/api/evidence?t=krillion-local-v1`). Whenever the script is unsure which prompt
it is looking at — two banks with percentages, no match, or a score under 100 —
it also records the **exact prompt shown by the game** and the candidate banks in
`injection/data/prompt_review.jsonl` (view at
`/api/prompt-review?t=krillion-local-v1`). That log is what "process the log"
uses to improve the matching logic over time.

The bot also records which mode it started and which lobby room it actually
chose (with the full room list) in `injection/data/bot_log.jsonl`, viewable at
`/api/bot-log?t=krillion-local-v1`. Use it if the 5-second room selection ever
looks wrong. **Play scores never demote an answer** —
the game AI-grades unknown answers inconsistently. Only the dive-end graded bank
can change the rare tier; the policy is in `DECISIONS.md`.

Every log event (`evidence.jsonl`, `prompt_review.jsonl`, `bot_log.jsonl`)
carries `game_state` (the screen on screen — e.g. `prompt-reveal` before the
input mounts, `answering` once it does), `input_state` (was the answer box
present, visible and enabled) and `mode`. The full live-mapped inventory —
including the slow-loading shell and the 6-second / 50-prompt Marathon room —
and the log / no-log decision for each state is in **`STATES.md`**.

When a prompt has no bank, the helper can fetch that prompt's real graded bank
from `playdaily.org`, respecting the cooldown and de-duplicating. Disable with
`KRILLION_NO_FETCH=1`. Queue: `/api/fetch-queue?t=krillion-local-v1`.

The userscript makes up to 3 attempts (2 retries) for writes/POSTs with a
12-second timeout before queuing failed writes for the next run. Answer-lookup
GETs are different — see "Performance & retries" below.

### Performance & retries

- **Cached lookups, infinite retries.** Answer lookups are cached. A lookup GET
  that fails retries indefinitely with capped exponential backoff, using a
  shorter timeout so a 5-second room is not missed. After 3 failed attempts it
  logs once to `failed_prompts.jsonl`, then keeps retrying rather than showing an
  error. POSTs and queued writes are unchanged: failed writes are still queued
  for the next run.
- **One indexed DB, on purpose.** `data/krillion_only.db` stays a single file with
  an index on `question` — exact lookups are ~0ms (21,384 answers / 5,801
  prompts). The old slowness came from in-process normalisation/fuzzy matching
  and re-reading `learned.jsonl`, not from SQLite, so splitting the DB would add
  complexity without helping. Full benchmark evidence is in `PERF.md`.
- **Cold vs warm bridge.** The first lookup after the bridge starts can be slower
  while caches warm; later lookups should be fast. A prompt that still takes many
  seconds to resolve means the bridge is running without the caching fix. Check
  `/api/perf?t=krillion-local-v1` (if available) for lookup timings.

**Other players are never recorded.** In multiplayer/1v1 only our own answers
(`source: own`) and the game's own graded banks (`source: api`) enter the archive.
Past rows from other players were quarantined in
`injection/data/other_users_quarantine.jsonl`. **"Process the log"** is a
standing workflow — see `PROCESS-LOG.md`.

Log files do not grow forever: `python injection/rotate_logs.py --apply`
archives the full diagnostic logs to `injection/data/archive/*.jsonl.gz` and
keeps only the recent lines active. Database-feeding files are never rotated.
The "process the log" workflow always runs this step.
