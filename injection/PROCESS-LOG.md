# "Process the log" — the standing workflow

When the user says **"process the log"** in this project (in any session), do
the whole job below. Do not stop at one step and do not ask which part they
meant unless a step is genuinely blocked.

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

1. **Read** all logs above. Report counts and any anomalies (e.g. many
   `no-match`, repeated unreachable events, fetch failures).
2. **Review `prompt_review.jsonl` and `evidence.jsonl`.** This is the AI-judgement
   step the user asked for: read the real on-screen wording, group repeated
   `ambiguous` / `low-score` / `no-match` entries, and decide what is wrong —
   a missing phrase in the bridge's query rewrites, a near-duplicate bank we
   keep confusing, a prompt not in the archive, or genuinely inconsistent AI
   grading. Propose a concrete fix (usually a rewrite rule in `bridge.py`,
   never an alias pinned into the matcher from one observation). Remember:
   play scores never demote.
3. **Apply authoritative demotions:** these are already in `corrections.jsonl`
   from bank data. Verify each record has `mode: "bank"`. If any older play-
   based correction exists there, remove it.
4. **Run the importer:**
   ```powershell
   cd "D:\! Games\Krillion Game"
   python scripts/krillion_db.py import
   ```
   This inserts new answers, applies corrections, rebuilds the search DB and
   `krillion_only.db`. Confirm the `demoted=` and `inserted=` counts.
5. **Rebuild the public snapshots** so both webapps reflect the new data:
   ```powershell
   python scripts/build_static.py
   python scripts/build_krillion_site.py
   ```
   `build_static.py` regenerates `index.html` / `search-data.json` (the `lookup`
   webapp); `build_krillion_site.py` regenerates `krillion/index.html` and
   `krillion/krillion-data.json`, which the bridge's `/api/all` reads. Both must
   run — rebuilding only `build_static.py` leaves `/api/all` serving stale data.

   > **Note:** `scripts/build.py all` (described in the root `README.md`) runs
   > ingest/derive/emit/verify/publish but does NOT invoke either site builder,
   > so it leaves these same snapshots stale. The two commands above are still
   > required after `build.py all`.
6. **Commit and push** the changed data + generated site, with a short message
   naming the counts. Make sure the regenerated `krillion/krillion-data.json`
   from step 5 is included, e.g.:
   ```powershell
   git add data injection/data index.html search-data.json krillion/index.html krillion/krillion-data.json webapp/index.html
   git commit -m "Process log: +N answers, -M demotions"
   ```
7. **Append a summary** to `injection/CHANGELOG.md`: what was processed,
   inserted, demoted, still unresolved, and any follow-up needed.
8. **Rotate the diagnostic logs** so the repository does not grow forever:
   ```powershell
   python injection/rotate_logs.py            # dry run — show what would happen
   python injection/rotate_logs.py --apply    # actually archive + trim
   ```
   Only `evidence.jsonl`, `prompt_review.jsonl`, `bot_log.jsonl`, and
   `failed_prompts.jsonl` are rotated. The full old content is compressed to
   `injection/data/archive/*.jsonl.gz` before the active file is trimmed, so
   nothing is lost. `corrections.jsonl`, `learned.jsonl`,
   `answers_injection.jsonl`, and `fetch_queue.jsonl` are NEVER rotated — they
   feed the database. Include the rotation counts in the report.
9. **Commit and push** the archives and trimmed logs together with the rest of
   the processed data.
10. **Report back** to the user with the same numbers, rotation counts, and any
    recommendation.

## Never do

- Demote an answer because of a play score (`points < 100` in evidence).
- Add an alias to the matcher from a single 100-point observation.
- Edit files owned by the webapp optimizer session while it is active
  (`README.md`, `index.html`, `scripts/krillion_db.py`, site templates, etc.)
  except by running its documented commands.
- Delete log entries without telling the user.
