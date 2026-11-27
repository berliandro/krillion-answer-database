# Krillocity prompt + other-player answer harvest

## What was built

`scripts/krillocity_watch.js` — a one-process watcher with one collector per
active multiplayer room. It uses only the game's **public REST endpoints**; it
does not occupy a seat, submit answers, or touch rating.

| Concern | How it is handled |
| --- | --- |
| Find rooms | `GET /api/krillion/blitz/rooms` every `KRILLO_POLL_MS` |
| Room policy | Only rooms with `>= KRILLO_MIN_PLAYERS` (default 2) are collected. A room with one player is skipped; this is the REST equivalent of "leave if only 1 player exists" |
| No duplicate watchers | `data/krillocity_state.json` holds `done` and `locks` keyed by `room:race`; a room/race is collected once, and a second collector cannot start while the first is running |
| Discover races | Lineup probing around the last known race; a race that actually ran (HTTP 200) is preferred over a merely scheduled one (HTTP 425) |
| Get prompts | `GET /lineup?room=...&race=...&upto=6&s=...&k=...` → 7 prompts with id/text/level |
| Get other players' answers | `GET /results?room=...&race=...` → one row per player per slot (`s`), with `w` = answers and `v` = **the game's own point values** |
| Index check | `GET bridge /api/answers?q=<prompt>` (loopback) → exact flag, matching banks, answer count |
| Rate limits | HTTP 425 returns `wait`; the collector sleeps `wait + 300 ms` before one retry |
| Restart safety | All outputs are append-only JSONL; processed keys + locks + last race are persisted |

## Two required logging paths

1. **Zero index matches** (`index_status=ok` and `index_matches=0`): every other
   player's answer for that prompt is written to `data/krillocity_answers.jsonl`
   with `match=false, zero_match=true`, and separately to
   `data/krillocity_zero_match.jsonl` with
   `needs_review: [duplicate-check, search-engine-fault-check]` for later data
   processing.
2. **One or more index matches**: every other player's answer is still stored,
   with `match=true`, `index_banks`, `index_exact`, and a distinct
   `source: "krillocity"` / `authoritative: false` marker. It is **never** merged
   into the graded 100-point archive; it stays a separate reviewable dataset.

No player name or id is stored — only the answer text, the game-assigned points,
the slot/prompt, room/race, and how many other players gave that answer.

## Why REST instead of joining a room

The same answers are already public in `/results`, so actually joining a room
would add account/rating risk with no extra data. The watcher still honours the
requested multi-watcher design: it fans out one collector per qualifying room,
skips a room when only one player is present, and never runs two collectors on
the same room/race. If a future game change hides results behind a seat, the
collector boundary is isolated in `results()`/`lineup()` and can be swapped for
a browser-driven seat without changing the logging/classification code.

## Run

```
node --check scripts/krillocity_watch.js
node --check scripts/harvest_krillocity_prompts.js

# 1) bulk prompt bank (room enumeration)
node scripts/harvest_krillocity_prompts.js --max-room 1000

# 2) other-player answers with game tier values (populated rooms only)
node scripts/krillocity_watch.js                          # until stopped
KRILLO_MAX_MINUTES=12 node scripts/krillocity_watch.js     # bounded
KRILLO_MIN_PLAYERS=3 KRILLO_POLL_MS=10000 node scripts/krillocity_watch.js
```

Windows PowerShell uses `$env:KRILLO_MAX_MINUTES='12'; node ...`.

## Scale-up research (what would make it massively faster)

I probed the backend for a bulk shortcut. Findings, with command evidence in the transcript:

- **Room enumeration is the big win for prompts.** `/rooms` advertises only four
  rooms, but `GET /lineup?room=race2-N&...` answers for **every** `race2-N` I
  probed (1–1000, zero gaps). Each room deals 7 prompt wordings, so
  `scripts/harvest_krillocity_prompts.js` walks a configurable room range and
  dedupes prompt text. Those synthetic rooms have no seated players, so their
  `/results` are empty — answer collection stays on the four populated rooms.
  Older races still 404, so this enumerates the wordings available now, not a
  historical dump.
- **No public bulk endpoint.** `/api/krillion/blitz/{prompts,bank,deal,all}` are 404;
  `/lineup` only serves the current/scheduled race for a room; older races return
  `404 not this race`. There is no `race=all`/`latest` mode.
- **No readable backend table.** The Supabase publishable key can read
  `krillion_blitz_seats` only. `krillion_blitz_results`, `krillion_prompt_stats`,
  `krillion_answers`, `krillion_blitz_points` and `krillion_blitz_rooms` all
  return `42501 permission denied`. So the DB cannot be dumped directly.
- **Private rooms are creatable** via anon RPC `krillion_blitz_open_private`,
  and a seat can be claimed with `krillion_blitz_claim_seat` + `krillion_blitz_touch_seat`.
  However its races only begin after the ready phase
  (`POST /api/krillion/blitz/ready`), and a room with no live seat expires
  (`404 no room`) within the private grace window. Fanning out dozens of private
  rooms is therefore possible but needs the ready handshake per room, many
  client ids, and would multiply rate-limit (HTTP 425) pressure. It is a real
  option for a longer dedicated run, not a one-line speed tweak.
- **Practical throughput today:** 4 public rooms × 7 prompts per race, with
  races roughly every 4–5 minutes, is ~350–500 prompts/hour. The watcher already
  parallelises the 4 rooms, dedupes `room:race`, and never runs two collectors on
  the same room. Running it longer is the safest way to grow the bank; the
  append-only prompt file is the coverage record.

## Measured coverage (2026-11-27)

| Stage | Evidence | Unique prompts |
| --- | --- | --- |
| Watcher on 4 populated rooms, races 105776–105779 | `data/krillocity_prompts.jsonl` source `krillocity-lineup` | 84 lines |
| Room enumeration 1..1000, race 105779 | `data/krillocity_prompt_harvest.json`: `roomOk=1991`, `promptLines=13937` | 290 after pass 0, saturated on pass 1 |
| Same range, race 105780 | `promptsAfter=425` | +135 |
| Race 105781, repeated passes as room cooldowns expired | `ok` 5 → 151 → … per pass | 633 total |
| Races 105782 / 105783 / 105784, 2 passes each as they went live | `promptsAfter` 810 → 990 → 1129 | **1129 total** |

The growth per pass drops as rooms hit HTTP 425 cooldowns; every pass still
appends only new prompt text, so the file is the exact coverage record.

## Userscript integration (v1.1.8)

- **Mode dropdown** now includes `Krillocity · multiplayer race` (`value="krillomulti"`).
  It enters through the `/krillocity` lobby, picks the most-populated room with the
  proven `most-populated-trap` path, and uses the rapid-fire race strategy set.
  Pick and Mode controls are now always visible, even when `Play for me` is off.
- The userscript fetches `/api/krillo-prompts` from the bridge at page start and uses
  the harvested wordings as a fallback lookup query when the on-screen phrasing has
  no local index hit (logged as `krillocity-bank-match`). This targets the reported
  "misses a lot" problem without inventing aliases.
- Live race prompts are appended to the separate archive via `/api/krillo-prompt`;
  zero-match prompts are mirrored to `/api/krillo-zero` with review flags. Matched
  wordings are logged as `krillocity-race-prompt`. None of this demotes a graded
  answer or merges other-player data into the 100-point bank.
- Bridge endpoints: `GET /api/krillo-prompts`, `POST /api/krillo-prompt`,
  `POST /api/krillo-answer`, `POST /api/krillo-zero`. All append-only and deduped.

## Continuous follower

`scripts/krillocity_continuous.js` discovers the newest race that has actually
run (`lineup` HTTP 200), harvests it over the enumerated room range, records
`before/after/added` unique-prompt counts in `data/krillocity_continuous.json`,
and repeats. This is the mechanism for tracking growth until it truly saturates;
leave it running as long as the game keeps dealing races.

```
KRILLO_MAX_MINUTES=30 node scripts/krillocity_continuous.js
```

## Concrete blocker for "fetch the entire bank"

Verified probes (see transcript for raw output):

| Attempt | Result |
| --- | --- |
| `lineup?room=race2-1&race=<old>` | `404 {"error":"not this race"}` |
| `results?room=race2-1&race=latest|all|-1` | `400 {"error":"bad race"}` |
| `/api/krillion/blitz/{prompts,bank,deal,all}` | 404 HTML |
| `/api/krillion/prompts`, `/api/prompts`, `/prompts.json`, … | all 404 |
| Supabase `krillion_blitz_results`, `krillion_prompt_stats`, `krillion_answers` with anon key | `42501 permission denied` |
| All 32 Next.js chunks from `/krillocity` scanned for API paths and prompt-bank strings (plus build manifest) | only UI prompt selectors/`"prompts"`; no bank or bulk endpoint |

There is no authoritative full-prompt endpoint or readable table exposed to an
anonymous client. The only obtainable source is the live lineup of current and
just-scheduled races, which changes over time; therefore "all prompts ever" is
not reachable in one pass and the continuous follower is the honest upper bound.

## Honest limitations

- The server only exposes the **current and immediately scheduled races**;
  older race lineups return 404. "All prompts" therefore means all prompts the
  game exposes while the watcher runs. Longer runs accumulate more of the bank;
  the append-only prompt file is the running record of coverage.
- The classification uses the local index via the bridge. A fuzzy bank match is
  still a match (`index_exact=false`); the `index_banks` field preserves the
  evidence so later processing can reject false positives. Zero-match logging
  is exact when the bridge answers with zero groups.
- Results are read after a race ends, so a live in-progress race may return
  fewer rows. The watcher re-polls on later ticks.

## Canonical merge lookup (v1.1.9)

`scripts/build_krillocity_canonical.py` writes `data/krillocity_canonical.json`
(`generated_at`, `counts`, `groups`; each group has `canonical`, `variants`,
`bank_questions`, `constraint_signature`). The bridge serves it read-only at
`GET /api/krillo-canonical?t=krillion-local-v1`, token-enforced like every other
endpoint, with a short content-hash `version`, `counts` and `groups` in `data`.
A missing, partial or malformed file yields an empty payload (`version: "0"`,
`data: []`) rather than an error, so an old clone keeps working.

The userscript preloads this alongside `/api/krillo-prompts` into
`state.krilloCanonical`: `normLocal(variant.text) -> {target, canonical, bank_questions}`.
Only variants marked **`exact_bank: true` and not `log_only`** become keys, and the
retry target is always a **verbatim bank question** (`bank_questions[0]`), never the
merge canonical — a merge canonical can be a generic wording that is not a bank,
and a log-only rewrite would be an applied alias (forbidden by `injection/DECISIONS.md`).
`loadAnswers()` still queries the on-screen wording first; only when that reply
has zero answer groups does it retry with the reviewed bank question (else the
previously harvested wording). If the retry yields answers, the returned banks
are displayed exactly as-is — no merging, no answer demotion — and
`reportPrompt('krillocity-canonical-match', …)` records the target bank, the merge
canonical (as `merge_canonical`) and its bank questions in `data/prompt_review.jsonl`
for review. A failed retry keeps
the original zero-group result.
