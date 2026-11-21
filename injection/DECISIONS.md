# Answer-panel decisions: how play should improve the database

Design note, written 2026-11-21. **Not yet implemented.** This document proposes
the policy; the current shipped script is described under "Current behaviour".

## Current behaviour (the problem)

`checkVerdict()` reads the points after a submission and calls
`POST /api/correction` with the bank question stored on the clicked chip
(`data-q`). The bridge demotes `(question, answer)` whenever `points < 100`.

It does **not** know:

- which of several candidate banks the user chose,
- whether the match was exact or a guess,
- whether the on-screen wording differs from the stored prompt,
- whether the answer was refused or merely timed out.

So clicking an 80%-match bank that is the *wrong* prompt and getting 85 points
will demote a correct 100-point answer. That is the bug the user reported.

## Core principle

**Evidence first, mutations second.** The script records what happened; a
reviewer turns repeated, consistent evidence into database changes. Only signals
that are *authoritative* may change the rare tier immediately.

Confidence levels:

| Level | Meaning | Action |
| --- | --- | --- |
| **Authoritative** | Exact prompt match, or the game's own graded bank at dive end | Demote immediately, log |
| **Corroborated** | 2+ independent low scores for the same (bank, answer), or a low tier confirmed in bank data | Demote after review |
| **Ambiguous** | Low score while several banks were shown, or while the wording was a fuzzy guess | Record evidence only; never demote |
| **No signal** | Refused answer, timeout, pass | Record outcome only |

## Scenario matrix

Let `P` = prompt on screen, `G` = bank the user clicked, `a` = answer, `p` = points.

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

### The two questions the user raised

1. *"I clicked a 70% bank and got 85 — don't demote it."* Correct: scenario D.
   No demotion; the answer may be perfectly rare for the real prompt and simply
   wrong for the one whose bank we clicked.
2. *"I clicked a bank and got 100 — that's a new phrasing."* Correct: scenarios
   B/C/D. Record `P → G` as an **alias candidate**, with the answer as evidence.
   Promote it to a real alias only after 2 distinct answers from G score 100 on
   P and no other bank scores 100 on P. Then future exact `P` maps straight to
   `G`, removing the ambiguity entirely.

## Proposed data structures (all under `injection/data/`)

- `evidence.jsonl` — every attempt:
  `{at, screen_prompt, chosen_bank, answer, points|null, outcome, tier, mode,
   exact, group_count, group_scores, auto}`
- `aliases.jsonl` — `{alias, canonical, confidence, evidence_ids, status}`
- `unresolved.jsonl` — prompts with no confident bank, plus what was tried
- `corrections.jsonl` — unchanged; only authoritative demotions land here

The bridge applies aliases as a **pre-match rewrite** (alias text → canonical
text) before calling the shared matcher, so the optimizer's matcher file is
never modified.

## Proposed flow

1. Chip click → remember the full context (screen prompt, chosen bank, score of
   that bank, how many banks were shown, auto on/off).
2. Verdict → `POST /api/evidence` with that context. Bridge decides:
   - authoritative → apply demotion + changelog,
   - ambiguous → store evidence only,
   - 100 → store alias evidence.
3. `/api/review` (manual or scheduled) promotes corroborated evidence into
   aliases or demotions and writes a summary to `CHANGELOG.md`.
4. Dive end → bank import additionally compares every graded tier against the
   rare list; tier < 100 for a rare answer is an authoritative demotion (F).

## Decisions made (2026-11-21)

1. **Never demote from play.** Only the game's own dive-end graded bank may
   change the rare tier. The game grades unknown answers with AI, so the same
   answer can be 100 once and 30 or 85 the next time. A low play score is
   evidence only.
2. **Never pin aliases.** Record the on-screen wording and which bank scored
   100, but do not add it to the matcher. Aliases stay as log data only.
3. **Fetch missing prompts: yes.** When a prompt has no bank, the PC helper may
   download that prompt's real graded bank from `playdaily.org`, respecting the
   ~65s cooldown and de-duplicating before writing. The user can disable it
   with `KRILLION_NO_FETCH=1`.
4. **Auto-enter is paused when several banks match.** A wrong-bank auto pick
   would produce misleading evidence.
5. **Never record other players' answers.** In multiplayer/1v1 the site AI-grades
   arbitrary user answers inconsistently (100 once, 60 or 85 later). Bank capture
   keeps only our own rows (`.kr-line[data-me]`, `source: own`) and the game's own
   graded banks (`source: api`). Past `dom` rows were quarantined to
   `data/other_users_quarantine.jsonl`.

### "Process the log"

When the user says **"process the log" in any session on this project**, it
means: follow `injection/PROCESS-LOG.md` end to end — review evidence/aliases/
unresolved prompts, apply authoritative bank demotions, import new answers,
rebuild derived databases, and write the changelog.
