# Answer-panel decisions: how play should improve the database

I wrote this design note on 2026-11-21 and updated it on 2026-11-23. **Implemented.** I enforced the policy
below in the shipped userscript and bridge; "Current behaviour"
records the original bug I replaced, and "Decisions made" lists the rules I put
in force.

## Current behaviour (the problem)

`checkVerdict()` read the points after a submission and called
`POST /api/correction` with the bank question stored on the clicked chip
(`data-q`). The bridge demoted `(question, answer)` whenever `points < 100`.

It did **not** know:

- which of several candidate banks I had chosen,
- whether the match was exact or a guess,
- whether the on-screen wording differed from the stored prompt,
- whether the answer was refused or merely timed out.

So clicking an 80%-match bank that was the *wrong* prompt and getting 85 points
would demote a correct 100-point answer. That was the bug I set out to fix.

## Core principle

**Evidence first, mutations second.** I had the script record what happened; I, as reviewer, turned repeated, consistent evidence into database changes. Only signals
that were *authoritative* could change the rare tier immediately.

I used these confidence levels:

| Level | Meaning | Action |
| --- | --- | --- |
| **Authoritative** | Exact prompt match, or the game's own graded bank at dive end | Demote immediately, log |
| **Corroborated** | 2+ independent low scores for the same (bank, answer), or a low tier confirmed in bank data | Demote after review |
| **Ambiguous** | Low score while several banks were shown, or while the wording was a fuzzy guess | Record evidence only; never demote |
| **No signal** | Refused answer, timeout, pass | Record outcome only |

## Scenario matrix

I wrote the matrix with `P` = prompt on screen, `G` = bank I clicked, `a` = answer, `p` = points.

| # | Situation | `p = 100` | `p < 100` | refused / timeout |
| --- | --- | --- | --- | --- |
| A | Exact match, one bank | Confirm; no change | **Authoritative demotion** | Log only |
| B | One fuzzy bank, score ≥ 0.95 | Confirm + weak alias evidence `P → G` | **Ambiguous** — evidence only; needs 2 independent low scores or bank confirmation | Log only |
| C | One fuzzy bank, score 0.62–0.95 | Confirm + alias evidence, promote alias after **2 distinct answers** from G score 100 on P | **Ambiguous** — no demotion | Log only |
| D | Several banks shown | Strong alias evidence for chosen G; next identical P prefers G; show "correct bank was …" feedback | **Ambiguous and likely wrong bank** — no demotion; record which bank was tried. If another bank scores 100 on the same P, mark G as *rejected for P* | Log only |
| E | No bank found | — | — | Record `unresolved` prompt; optionally fetch its real bank from the site API (needs user consent — rate-limited) |
| F | Dive-end bank shows tier < 100 for an answer we list as 100 | — | **Authoritative demotion** (the game's own graded bank is the source of truth) | — |
| G | Dive-end bank shows a new tier-5 answer | Add to rare list via `data/answers_injection.jsonl` | — | — |
| H | Auto-enter ON with several banks | **Do not auto-pick** — require a manual choice; otherwise a wrong bank causes false demotions | — | — |
| I | Same answer exists in several banks | Alias evidence only if **distinct** answers from the same bank also score 100; otherwise an overlapping answer proves nothing | No demotion without bank-level consensus | Log only |

### The two questions I raised

1. *"I clicked a 70% bank and got 85 — don't demote it."* I agreed: scenario D.
   No demotion; the answer may be perfectly rare for the real prompt and simply
   wrong for the one whose bank I had clicked.
2. *"I clicked a bank and got 100 — that's a new phrasing."* I agreed: scenarios
   B/C/D. I recorded `P → G` as an **alias candidate**, with the answer as evidence.
   I promoted it to a real alias only after 2 distinct answers from G scored 100 on
   P and no other bank scored 100 on P. Then future exact `P` mapped straight to
   `G`, removing the ambiguity entirely.

## Proposed data structures (all under `injection/data/`)

- `evidence.jsonl` — every attempt:
  `{at, screen_prompt, chosen_bank, answer, points|null, outcome, tier, mode,
   exact, group_count, group_scores, auto}`
- `aliases.jsonl` — `{alias, canonical, confidence, evidence_ids, status}`
- `unresolved.jsonl` — prompts with no confident bank, plus what was tried
- `corrections.jsonl` — unchanged; only authoritative demotions land here

I had the bridge apply aliases as a **pre-match rewrite** (alias text → canonical
text) before calling the shared matcher, so I never modified the optimizer's matcher file.

## Proposed flow

1. A chip click remembered the full context (screen prompt, chosen bank, score of
   that bank, how many banks were shown, auto on/off).
2. A verdict posted `POST /api/evidence` with that context. The bridge decided:
   - authoritative → applied demotion + changelog,
   - ambiguous → stored evidence only,
   - 100 → stored alias evidence.
3. I used `/api/review` (manual or scheduled) to promote corroborated evidence into
   aliases or demotions, and it wrote a summary to `CHANGELOG.md`.
4. At dive end, bank import additionally compared every graded tier against the
   rare list; tier < 100 for a rare answer was an authoritative demotion (F).

## Decisions made (2026-11-21)

1. **I kept play scores out of demotions.** I let only the game's own dive-end graded bank
   change the rare tier. The game grades unknown answers with AI, so the same
   answer can be 100 once and 30 or 85 the next time. I treated a low play score as
   evidence only.
2. **I never pinned aliases.** I recorded the on-screen wording and which bank scored
   100, but I did not add it to the matcher. Aliases stayed as log data only.
3. **I allowed fetching missing prompts.** When a prompt had no bank, I let the PC helper
   download that prompt's real graded bank from `playdaily.org`, respecting the
   ~65s cooldown and de-duplicating before writing. I could disable it
   with `KRILLION_NO_FETCH=1`.
4. **I paused auto-enter when several banks matched.** A wrong-bank auto pick
   would have produced misleading evidence.
5. **I kept other players' answers out of the archive.** In multiplayer/1v1 the site AI-grades
   arbitrary user answers inconsistently (100 once, 60 or 85 later). Bank capture
   kept only our own rows (`.kr-line[data-me]`, `source: own`) and the game's own
   graded banks (`source: api`). I quarantined past `dom` rows to
   `data/other_users_quarantine.jsonl`.

6. **I logged by state, not by frame.** I mapped every game screen live on
   2026-11-23 (including the slow-loading shell and a real 6-second / 50-prompt
   Marathon room). Only decision-grade states were logged: answers (`answering`,
   `verdict`, `refusal`), uncertain prompts (`prompt-reveal`), dive-end banks
   (`results`), and bot choices (`lobby`, `duel`). Idle/transient frames
   (`loading-shell`, `intro`, `create-room`, `arena-wait`) were not logged. The
   full inventory and per-state rationale is in `STATES.md`; every event then
   carried `game_state` + `input_state`.
7. **I kept the shared board head out of our score.** Live play showed the
   multiplayer board head shows OTHER players' points ("X went deepest:
   SCHOOLER (+30)"). I had `checkVerdict()` parse `.kr-board-head` only in
   classic mode; in multiplayer/1v1 only our own refusal/submit outcomes were
   logged, never a scraped opponent score. I made `mode()` detect the persistent
   arena container (`.kr-stage-multi`), because `.kr-board-rows` exists only
   between rounds and mis-reported the mode while answering.
8. **I kept one indexed DB and fixed speed with caching, not sharding.** Parent
   benchmarks showed the slowdown was in-process: `resolve_question()` normalised
   all 5,801 prompts on every call and ran a ~10.6s fuzzy `Matcher.search()` on
   non-exact prompts, and `tier_answers()` re-read the 826KB / 4,920-row
   `learned.jsonl` (~234ms) on every call. SQLite was not the bottleneck —
   `data/krillion_only.db` (21,384 answers / 5,801 prompts, indexed on `question`)
   answered exact lookups in ~0ms. Splitting answers into multiple files with a
   pointer added complexity without fixing the matcher/IO cost. I fixed it with caching,
   an O(1) exact lookup and a single read of `learned.jsonl`; full evidence in
   `PERF.md`.
9. **I made answer-lookup GETs retry forever.** Lookup GETs used a shorter timeout so a
   5-second room was not missed. On failure they retried indefinitely with capped
   exponential backoff; after 3 failed attempts the script logged once, then kept
   retrying instead of showing an error. POST/queue behaviour I left unchanged —
   failed writes stayed queued in Tampermonkey storage for the next run.

### "Process the log"

When I say **"process the log" in any session on this project**, I mean: follow `injection/PROCESS-LOG.md` end to end — review evidence/aliases/
unresolved prompts, apply authoritative bank demotions, import new answers,
rebuild derived databases, and write the changelog.
