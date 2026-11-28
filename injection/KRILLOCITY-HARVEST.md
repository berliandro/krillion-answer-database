# Krillocity prompt + other-player answer harvest

## What I built

I built `scripts/krillocity_watch.js` — a one-process watcher with one collector per
active multiplayer room. I had it use only the game's **public REST endpoints**; it
did not occupy a seat, submit answers, or touch rating.

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

## The two logging paths I required

1. **Zero index matches** (`index_status=ok` and `index_matches=0`): I wrote every other
   player's answer for that prompt to `data/krillocity_answers.jsonl`
   with `match=false, zero_match=true`, and separately to
   `data/krillocity_zero_match.jsonl` with
   `needs_review: [duplicate-check, search-engine-fault-check]` for later data
   processing.
2. **One or more index matches**: I still stored every other player's answer,
   with `match=true`, `index_banks`, `index_exact`, and a distinct
   `source: "krillocity"` / `authoritative: false` marker. I **never** merged it
   into the graded 100-point archive; it stayed a separate reviewable dataset.

I stored no player name or id — only the answer text, the game-assigned points,
the slot/prompt, room/race, and how many other players gave that answer.

## Why I used REST instead of joining a room

I found the same answers were already public in `/results`, so actually joining a room
would have added account/rating risk with no extra data. I kept the watcher honouring the
requested multi-watcher design: it fanned out one collector per qualifying room,
skipped a room when only one player was present, and never ran two collectors on
the same room/race. If a future game change hid results behind a seat, I had isolated the
collector boundary in `results()`/`lineup()` so it could be swapped for
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

On Windows PowerShell I used `$env:KRILLO_MAX_MINUTES='12'; node ...`.

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

I saw the growth per pass drop as rooms hit HTTP 425 cooldowns; every pass still
appended only new prompt text, so I treated the file as the exact coverage record.

## Userscript integration (v1.1.8)

- I added `Krillocity · multiplayer race` (`value="krillomulti"`) to the **Mode dropdown**.
  It entered through the `/krillocity` lobby, picked the most-populated room with the
  proven `most-populated-trap` path, and used the rapid-fire race strategy set.
  I made Pick and Mode controls always visible, even when `Play for me` was off.
- I had the userscript fetch `/api/krillo-prompts` from the bridge at page start and use
  the harvested wordings as a fallback lookup query when the on-screen phrasing had
  no local index hit (logged as `krillocity-bank-match`). I aimed this at the reported
  "misses a lot" problem without inventing aliases.
- I appended live race prompts to the separate archive via `/api/krillo-prompt`;
  I mirrored zero-match prompts to `/api/krillo-zero` with review flags. I logged matched
  wordings as `krillocity-race-prompt`. None of this demoted a graded
  answer or merged other-player data into the 100-point bank.
- Bridge endpoints: `GET /api/krillo-prompts`, `POST /api/krillo-prompt`,
  `POST /api/krillo-answer`, `POST /api/krillo-zero`. All append-only and deduped.

## Continuous follower

I used `scripts/krillocity_continuous.js` to discover the newest race that had actually
run (`lineup` HTTP 200), harvest it over the enumerated room range, record
`before/after/added` unique-prompt counts in `data/krillocity_continuous.json`,
and repeat. This was the mechanism I used for tracking growth until it truly saturated;
I left it running as long as the game kept dealing races.

```
KRILLO_MAX_MINUTES=30 node scripts/krillocity_continuous.js
```

## Concrete blocker I hit for "fetch the entire bank"

I ran verified probes (see transcript for raw output):

| Attempt | Result |
| --- | --- |
| `lineup?room=race2-1&race=<old>` | `404 {"error":"not this race"}` |
| `results?room=race2-1&race=latest|all|-1` | `400 {"error":"bad race"}` |
| `/api/krillion/blitz/{prompts,bank,deal,all}` | 404 HTML |
| `/api/krillion/prompts`, `/api/prompts`, `/prompts.json`, … | all 404 |
| Supabase `krillion_blitz_results`, `krillion_prompt_stats`, `krillion_answers` with anon key | `42501 permission denied` |
| All 32 Next.js chunks from `/krillocity` scanned for API paths and prompt-bank strings (plus build manifest) | only UI prompt selectors/`"prompts"`; no bank or bulk endpoint |

I found no authoritative full-prompt endpoint or readable table exposed to an
anonymous client. The only obtainable source was the live lineup of current and
just-scheduled races, which changed over time; I therefore concluded "all prompts ever" was
not reachable in one pass and the continuous follower was the honest upper bound.

## Honest limitations

- I found the server only exposed the **current and immediately scheduled races**;
  older race lineups returned 404. I therefore took "All prompts" to mean all prompts the
  game exposed while the watcher ran. Longer runs accumulated more of the bank;
  I treated the append-only prompt file as the running record of coverage.
- I based classification on the local index via the bridge. A fuzzy bank match was
  still a match (`index_exact=false`); the `index_banks` field preserved the
  evidence so later processing could reject false positives. Zero-match logging
  was exact when the bridge answered with zero groups.
- I read results after a race ended, so a live in-progress race could return
  fewer rows. The watcher re-polled on later ticks.

## Canonical merge lookup (v1.1.9)

I had `scripts/build_krillocity_canonical.py` write `data/krillocity_canonical.json`
(`generated_at`, `counts`, `groups`; each group has `canonical`, `variants`,
`bank_questions`, `constraint_signature`). I had the bridge serve it read-only at
`GET /api/krillo-canonical?t=krillion-local-v1`, token-enforced like every other
endpoint, with a short content-hash `version`, `counts` and `groups` in `data`.
I made a missing, partial or malformed file yield an empty payload (`version: "0"`,
`data: []`) rather than an error, so an old clone kept working.

I had the userscript preload this alongside `/api/krillo-prompts` into
`state.krilloCanonical`: `normLocal(variant.text) -> {target, canonical, bank_questions}`.
I made only variants marked **`exact_bank: true` and not `log_only`** become keys, and the
retry target was always a **verbatim bank question** (`bank_questions[0]`), never the
merge canonical — a merge canonical could be a generic wording that is not a bank,
and a log-only rewrite would have been an applied alias (forbidden by `injection/DECISIONS.md`).
I kept `loadAnswers()` querying the on-screen wording first; only when that reply
had zero answer groups did it retry with the reviewed bank question (else the
previously harvested wording). If the retry yielded answers, I had the returned banks
displayed exactly as-is — no merging, no answer demotion — and
`reportPrompt('krillocity-canonical-match', …)` recorded the target bank, the merge
canonical (as `merge_canonical`) and its bank questions in `data/prompt_review.jsonl`
for review. A failed retry kept
the original zero-group result.
