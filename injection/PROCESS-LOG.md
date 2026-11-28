# "Process the log" — the standing workflow

When I say **"process the log"** in this project (in any session), I treat it as
a request to do the whole job below. I would not stop at one step or ask which
part was meant unless a step was genuinely blocked.

## What the logs mean

| File | Contents |
| --- | --- |
| `injection/data/evidence.jsonl` | Every submitted answer: on-screen prompt, bank chosen, answer, points, mode, whether the match was exact, how many banks were shown, auto on/off |
| `injection/data/prompt_review.jsonl` | The **actual prompt shown by the game** when matching was ambiguous (`ambiguous`), nothing was found (`no-match`), a score was below 100 (`low-score`), or an answer was **rejected** (`refused`), with the candidate banks, scores, and the refusal text |
| `injection/data/bot_log.jsonl` | Bot mode starts and lobby room choices, including the full room list seen at that moment — use it to verify 5-second room selection |
| `injection/data/aliases.jsonl` | Potential rewordings of a prompt (log only — never applied to matching) |
| `injection/data/failed_prompts.jsonl` | Prompts that had no bank, and unreachable-bridge events |
| `injection/data/fetch_queue.jsonl` | Missing prompts whose banks are being/were fetched |
| `injection/data/corrections.jsonl` | Authoritative demotions (only from dive-end bank data) |
| `injection/data/learned.jsonl` | Answers from dive-end banks — only our own (`source: own`) and the game's graded banks (`source: api`) |
| `injection/data/other_users_quarantine.jsonl` | Other players' answers removed from the archive; never import these |
| `data/answers_injection.jsonl` | New answer rows in the importer's format |

## Steps

1. **I read** all logs above and reported counts and any anomalies (e.g. many
   `no-match`, repeated unreachable events, fetch failures).
2. **I reviewed `prompt_review.jsonl` and `evidence.jsonl`.** This was the AI-judgement
   step I had been asked for: I read the real on-screen wording, grouped repeated
   `ambiguous` / `low-score` / `no-match` entries, and decided what was wrong —
   a missing phrase in the bridge's query rewrites, a near-duplicate bank I
   kept confusing, a prompt not in the archive, or genuinely inconsistent AI
   grading. I proposed a concrete fix (usually a rewrite rule in `bridge.py`,
   never an alias pinned into the matcher from one observation). I kept in mind:
   play scores never demote.
3. **I applied authoritative demotions:** these were already in `corrections.jsonl`
   from bank data. I verified each record has `mode: "bank"`. If any older play-
   based correction existed there, I removed it.
4. **I ran the importer:**
   ```powershell
   cd "D:\! Games\Krillion Game"
   python scripts/krillion_db.py import
   ```
   That inserted new answers, applied corrections, rebuilt the search DB and
   `krillion_only.db`. I confirmed the `demoted=` and `inserted=` counts.
5. **I rebuilt the public snapshots** so both webapps reflected the new data:
   ```powershell
   python scripts/build_static.py
   python scripts/build_krillion_site.py
   ```
   `build_static.py` regenerated `index.html` / `search-data.json` (the `lookup`
   webapp); `build_krillion_site.py` regenerated `krillion/index.html` and
   `krillion/krillion-data.json`, which the bridge's `/api/all` reads. Both had to
   run — rebuilding only `build_static.py` left `/api/all` serving stale data.

   > **Note:** I found that `scripts/build.py all` (described in the root `README.md`) ran
   > ingest/derive/emit/verify/publish but did NOT invoke either site builder,
   > so it left these same snapshots stale. The two commands above were still
   > required after `build.py all`.
6. **I committed and pushed** the changed data + generated site, with a short message
   naming the counts. I made sure the regenerated `krillion/krillion-data.json`
   from step 5 was included, e.g.:
   ```powershell
   git add data injection/data index.html search-data.json krillion/index.html krillion/krillion-data.json webapp/index.html
   git commit -m "Process log: +N answers, -M demotions"
   ```
7. **I appended a summary** to `injection/CHANGELOG.md`: what was processed,
   inserted, demoted, still unresolved, and any follow-up needed.
8. **I rotated the diagnostic logs** so the repository did not grow forever:
   ```powershell
   python injection/rotate_logs.py            # dry run — show what would happen
   python injection/rotate_logs.py --apply    # actually archive + trim
   ```
   I rotated only `evidence.jsonl`, `prompt_review.jsonl`, `bot_log.jsonl`, and
   `failed_prompts.jsonl`. The full old content was compressed to
   `injection/data/archive/*.jsonl.gz` before the active file was trimmed, so
   nothing was lost. I never rotated `corrections.jsonl`, `learned.jsonl`,
   `answers_injection.jsonl`, or `fetch_queue.jsonl` — they
   feed the database. I included the rotation counts in the report.
9. **I committed and pushed** the archives and trimmed logs together with the rest of
   the processed data.
10. **I reported back** with the same numbers, rotation counts, and any
    recommendation.

## Rules I kept

- I did not demote an answer because of a play score (`points < 100` in evidence).
- I did not add an alias to the matcher from a single 100-point observation.
- I did not edit files owned by the webapp optimizer session while it was active
  (`README.md`, `index.html`, `scripts/krillion_db.py`, site templates, etc.)
  except by running its documented commands.
- I did not delete log entries without reporting it.
