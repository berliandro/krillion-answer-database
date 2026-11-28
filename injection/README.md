# Krillion Autofill (PC only)

I wrote a lightweight Tampermonkey userscript that showed **every known 100-point answer**
for the current Krillion prompt and fed real gameplay results back into the
local archive.

## Why two pieces

A userscript could not read or write a local SQLite database, so I split the job in two:

1. `krillion-autofill.user.js` ran in Chrome or Edge on `playdaily.org/krillion`.
2. `bridge.py` ran on my PC at `127.0.0.1:8768`, read `data/krillion_only.db`
   (21,384 rare answers, read-only) and wrote its diagnostic logs under
   `injection/data/`, plus `data/answers_injection.jsonl` for the importer.

I had the userscript talk to the bridge with `GM_xmlhttpRequest` (`@connect 127.0.0.1`);
it never embedded the data, so the script stayed small.

## Install

1. I installed Tampermonkey in Chrome or Edge.
2. I started the bridge:

   ```powershell
   cd "D:\! Games\Krillion Game"
   python injection/bridge.py
   ```

   I left that window running while I played. It bound loopback only. The token
   (`krillion-local-v1`) travelled in the URL query, not a custom header, so Edge
   did not need a CORS preflight for https → localhost requests.

3. In Tampermonkey I created a new script and pasted the entire contents of
   `injection/krillion-autofill.user.js`, then saved it.
4. I opened https://playdaily.org/krillion. A panel appeared at the top right.

## What it does

- I had it detect the exact prompt from `p.kr-prompt` and list all known 100-point answers.
- One click filled `input.kr-input` using the native value setter.
- **Auto: Off** (default): submission stayed manual — **I pressed Enter/DIVE**, as before.
- **Auto: On**: clicking an answer submitted it immediately via the form's native
  `requestSubmit()`, so the dive advanced without a keypress. The setting was
  remembered between page loads. I used the **Auto** button in the panel header to
  switch it; the button turned green while active.
- After submission it read the per-answer score from `.kr-reveal-points` in
  Classic and **logged it as evidence only**. In multiplayer/1v1 the shared
  `.kr-board-head` shows *other players'* points, so it was never scraped as our
  score — only our own submit/refusal outcomes were logged. I kept play scores out
  of demotions; only the game's own dive-end bank was authoritative (see
  `DECISIONS.md` and `STATES.md`).
- At the end of a Classic dive it clicked the "Show answers" toggle and every
  row, then imported the revealed answers. It also captured the site's own
  `/api/krillion/answers` responses so complete tiers were recorded, not just
  the ~10 answers the page rendered per tier.
- Failed writes were queued in Tampermonkey storage (cap 20) and retried next run.

## Auto-play bot

I wired the **Bot** toggle to start/stop full automatic play. While On, the script
navigated and played by itself and auto-restarted after each dive. Settings were
remembered between page loads.

- The **Pick** dropdown offered `Random 100-point answer`, `Top of list`, or `God player` — mostly 85-point answers, with a 100-point answer every 7th submission. Exact 85 answers were used where the archive had captured a graded bank; otherwise it fell back to non-100 answers from the full DB (correctly below 100, exact tier unknown).
- The **Mode** dropdown offered:
  - `Classic` — began a Classic dive.
  - `Multiplayer · 5s / 50 prompts` — joined a 5-second Marathon room (`The Marathon · 5 sec`, 50 prompts) for fast coin farming.
  - `Multiplayer · most players` — joined the room with the highest player count in the lobby.
  - `Krillocity · daily race` — followed the "Play Krillocity" link to `/krillocity`, started the daily race, and submitted multiple distinct rare answers per rapid-fire prompt (the game asks for "as many as you can").
  - `1 vs 1` — started a duel. The bot followed the real Colosseum screens: it accepted the tab rule if shown, queued, waited silently on the match-found countdown, and queued another match after a result. I kept it from clicking "Leave before it starts" or "Back to the arena".
- The bot filled and submitted answers itself (it overrode the manual Auto
  setting while playing). Scores were logged as evidence only — never demotions.
- When the requested room was not open, I had the bot wait rather than join a
  different room.

## Near-duplicate prompts (the "paraphrase" problem)

I found Krillion had genuinely distinct prompts with nearly identical wording, e.g.
`Name a Mario character` and `Name a character from Mario`, or a prompt ending in
`with a ball` versus `without a ball`. Each had its OWN graded bank.

I made sure the bridge never merged them:

- **Exact match won.** If the on-screen text matched a stored prompt (after
  trivial normalisation), only that bank was shown.
- **Fuzzy fallback kept groups separate.** If the wording differed, the bridge
  used the repository's `scripts/paraphrase_match.py` matcher and returned up to
  five *separately labelled* candidate prompts. The panel showed each bank under
  its own heading with a match percentage; answer lists were never combined.
- **Strict cut-off.** Only candidates scoring ≥90% of the best match survived, so
  a `song` bank did not tag along on a `film` query. Negation words (`with` vs
  `without`) were high-signal tokens.
- **Corrections kept the right key.** Filling a chip remembered which *stored*
  prompt it came from, so a later mismatch was recorded against that prompt —
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

No existing database or webapp-owned source file was modified; I opened the
rare-answers database read-only.

## Health check / diagnosing a failed prompt

I opened this in the address bar of the browser where I played — if it returned JSON,
the bridge was reachable from that browser:

```
http://127.0.0.1:8768/api/health?t=krillion-local-v1
```

Prompts that could not be answered, or requests that failed, were logged to
`injection/data/failed_prompts.jsonl`. I read them from the browser at:

```
http://127.0.0.1:8768/api/failed?t=krillion-local-v1
```

Every submitted answer was logged to `injection/data/evidence.jsonl` (view at
`/api/evidence?t=krillion-local-v1`). Whenever the script was unsure which prompt
it was looking at — two banks with percentages, no match, or a score under 100 —
it also recorded the **exact prompt shown by the game** and the candidate banks in
`injection/data/prompt_review.jsonl` (view at
`/api/prompt-review?t=krillion-local-v1`). That log was what I used with "process the log"
to improve the matching logic over time.

The bot also recorded which mode it started and which lobby room it actually
chose (with the full room list) in `injection/data/bot_log.jsonl`, viewable at
`/api/bot-log?t=krillion-local-v1`. I used it when the 5-second room selection
looked wrong. I kept play scores out of demotions —
the game AI-grades unknown answers inconsistently. Only the dive-end graded bank
could change the rare tier; the policy is in `DECISIONS.md`.

Every log event (`evidence.jsonl`, `prompt_review.jsonl`, `bot_log.jsonl`)
carried `game_state` (the screen on screen — e.g. `prompt-reveal` before the
input mounts, `answering` once it did), `input_state` (whether the answer box was
present, visible and enabled) and `mode`. The full live-mapped inventory —
including the slow-loading shell and the 6-second / 50-prompt Marathon room —
and the log / no-log decision for each state is in **`STATES.md`**.

When a prompt had no bank, I let the helper fetch that prompt's real graded bank
from `playdaily.org`, respecting the cooldown and de-duplicating. I could disable it with
`KRILLION_NO_FETCH=1`. Queue: `/api/fetch-queue?t=krillion-local-v1`.

The userscript made up to 3 attempts (2 retries) for writes/POSTs with a
12-second timeout before queuing failed writes for the next run. Answer-lookup
GETs were different — see "Performance & retries" below.

### Performance & retries

- **Cached lookups, infinite retries.** I cached answer lookups. A lookup GET
  that failed retried indefinitely with capped exponential backoff, using a
  shorter timeout so a 5-second room was not missed. After 3 failed attempts it
  logged once to `failed_prompts.jsonl`, then kept retrying rather than showing an
  error. POSTs and queued writes I left unchanged: failed writes stayed queued
  for the next run.
- **One indexed DB, on purpose.** I kept `data/krillion_only.db` as a single file with
  an index on `question` — exact lookups ran at ~0ms (21,384 answers / 5,801
  prompts). The old slowness came from in-process normalisation/fuzzy matching
  and re-reading `learned.jsonl`, not from SQLite, so splitting the DB would have added
  complexity without helping. Full benchmark evidence is in `PERF.md`.
- **Cold vs warm bridge.** The first lookup after the bridge started could be slower
  while caches warmed; later lookups should have been fast. A prompt that still took many
  seconds to resolve meant the bridge was running without the caching fix. I checked
  `/api/perf?t=krillion-local-v1` (if available) for lookup timings.

**I kept other players out of the archive.** In multiplayer/1v1 only our own answers
(`source: own`) and the game's own graded banks (`source: api`) entered the archive.
I quarantined past rows from other players in
`injection/data/other_users_quarantine.jsonl`. I kept **"Process the log"** as a
standing workflow — see `PROCESS-LOG.md`.

I kept log files from growing forever: `python injection/rotate_logs.py --apply`
archived the full diagnostic logs to `injection/data/archive/*.jsonl.gz` and
kept only the recent lines active. I never rotated database-feeding files.
The "process the log" workflow always ran this step.
