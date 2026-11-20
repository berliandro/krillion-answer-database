# Orchestration job tracker

Coordinator session: `ses_e0720335cffeyCAhxPyntUehLO`
Remote: https://github.com/berliandro/krillion-answer-database.git (branch `main`, initial setup pushed)

| Job | Worker session | Status | Owns | Artifact | Evidence |
| --- | --- | --- | --- | --- | --- |
| scrape-001 | `ses_e071ce061ffeFCztEbdH7fgiyW` | running | `data/answers.jsonl`, `data/scrape-notes.md` (append/notes only) | `data/answers.jsonl` | 114 lines imported: full=114, krillion=19, search questions=2 (verified via `krillion_db.py stats` + `search animal`) |

Notes:
- Worker uses Chrome (`browse` MCP + `chrome-browser-mcp` skill) per user request.
- API discovered: `POST /api/krillion/deal` (unthrottled, 7 prompts), `GET /api/krillion/answers?prompt=&ticket=` (HTTP 425 = retry with `wait`+250ms, up to 4 attempts — the official client does this), `POST /api/krillion/answer`. Deal accepts a `lap` token the client round-trips. Other endpoints: blitz, duel, spread.
- Coordinator imports JSONL into both DBs at checkpoints; worker never touches DBs.

Local (coordinator-owned) work: `AGENTS.md`, `scripts/krillion_db.py`, `webapp/app.py`, `webapp/index.html`, both `.db` files, `jobs.md`.
