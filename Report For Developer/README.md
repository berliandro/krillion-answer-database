# Report For Developer

A short, plain-language write-up of what this project is, what I found while tidying it, and what I changed. Nothing was deleted.

## What this project actually is

It's an answer archive for the Krillion trivia game, with a few layers on top:

- A big database of graded answers (the full history) and a small search database (one answer per question).
- A fast static search site that finds an answer while you play, including the rare 100-point ones.
- A PC-only Tampermonkey userscript plus a small local helper that can autofill answers.
- A lot of notes: strategy write-ups, a roadmap, a process log, and a security audit.

The README at the repo root already explains all of this well, so I left it alone.

## What I found

Most of the project was already in good shape. The folders have sensible lowercase names, code and data live in predictable places, and the site, tests, and build scripts are where you'd expect them. I did not want to churn working code just to make the tree look different.

Two documentation folders were the odd ones out:

- `FINDINGS` was uppercase while every other top-level folder was lowercase.
- `Active Goals` had uppercase letters and a space, unlike the kebab-case style used elsewhere.

Both are referred to only by other Markdown files, never by code, so renaming them was safe.

## What I changed

| Before | After | Why |
| --- | --- | --- |
| `FINDINGS/` | `findings/` | lowercase to match its sibling folders |
| `Active Goals/` | `active-goals/` | kebab-case to match its sibling folders |
| — | `Report For Developer/README.md` | this report (added, not moved) |

I also fixed the six links that pointed at the old folder names:

- `active-goals/KRILLOCITY-SECURITY-ANTICHEAT-AUDIT.md` — two links to the remediation report.
- `findings/SECURITY-REMEDIATION-REPORT.md` — one link to the audit evidence.
- `injection/ROADMAP-FINAL-REPORT.md` — one link to the roadmap.
- `injection/ROADMAP-EVIDENCE.md` — two links to the roadmap / folder.

Every path I changed still resolves to a real file.

## What I deliberately left alone

- `data/`, `scripts/`, `webapp/`, `krillion/`, `shared/`, `injection/`, `assets/`, `tests/`, `docs/`, and `evidence/`. Their paths are hardcoded in `scripts/config.py`, the site HTML, and the build manifest. Moving them would break the build for no real gain.
- The root site files (`index.html`, `site-template.html`, `search-data*.json`, `krillion-data.v2.json`). The public site fetches these by name.
- `favicon.ico` was already deleted before I started; that change is in the checkpoint commit too.
- `__pycache__`, `*.pyc`, `.worktrees/`, and `.git/` — caches, worktrees, and repository internals are off-limits.

I also looked at near-duplicates such as `search-data.json` alongside `search-data.v2.json`. Both are live: the site tries v2 first and falls back to the older file, so I kept both. Empty `.jsonl` files are append-only logs that happen to be empty right now, so those stay too.

## The security findings, in plain language

These are weaknesses in the game itself (documented in `findings/`), not bugs in this repo. The short version:

1. The graded answer bank is handed to anyone who asks, so a bot can rebuild our rare-answer list in an afternoon.
2. Krillocity room prompts can be enumerated, so a bot can collect them before a race even starts.
3. The results screen exposes everyone's answers and the game's own point values.
4. The speed limit is per request, not per turn, which allows huge single-turn scores.
5. Player names can be changed mid-lobby with only a tiny delay.
6. Guest identities are free — clear your storage and you're a new player.
7. The AI judge has no visible per-user quota, so crafted answers can be pushed toward 100 points.
8. The clock has a wide grace window, so late answers still score.
9. Public leaderboards hand cheaters the exact spelling of top players' names.

The full write-up with evidence is in `findings/SECURITY-REMEDIATION-REPORT.md`, the raw observations in `findings/SECURITY-AUDIT-EVIDENCE.md`, and our rule about never demoting an answer based on play scores is in `injection/DECISIONS.md`.

## Checks I ran

- Full test suite: 10 checks passed, 0 failed.
- Old folder names no longer appear anywhere in the project.
- File count is unchanged (200 files before the report, plus this new README).
- Checksums: only the four files whose links I edited changed; the renamed files kept their exact contents.

## How to undo

Everything is in a checkpoint commit, so rolling back is clean:

```powershell
git reset --hard 325b0eb
git branch -D pre-reorg-checkpoint-20261128
```

That returns the tree to its pre-reorg state. (`git reset --hard` is only safe here because the checkpoint captured the full working state; don't use it casually.)

## Suggestions for later, not done now

- If you want a stricter convention, move `evidence/*.json` under `docs/evidence/`, but that means updating about 30 report links first.
- Consider adding a one-paragraph "where to put new files" section to the root README so the next person keeps the lowercase convention going.
