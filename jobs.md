# Orchestration job tracker

Coordinator session: `ses_e0720335cffeyCAhxPyntUehLO`
Remote: https://github.com/berliandro/krillion-answer-database.git (branch `main`, initial setup pushed)

| Job | Worker session | Status | Owns | Artifact | Evidence |
| --- | --- | --- | --- | --- | --- |
| scrape-001 | `ses_e071ce061ffeFCztEbdH7fgiyW` | running | `data/answers.jsonl`, `data/scrape-notes.md`, `scripts/harvest.js` (append/notes/harvester only) | `data/answers.jsonl` | 298 lines imported: full=298, krillion=38, search questions=6 (verified via `krillion_db.py stats`, `search pancake` → Bee Pollen, and live webapp `GET /api/search?q=pancake`) |

Notes:
- Worker uses Chrome (`browse` MCP + `chrome-browser-mcp` skill) per user request.
- API discovered: `POST /api/krillion/deal` (unthrottled, 7 prompts), `GET /api/krillion/answers?prompt=&ticket=` (HTTP 425 = retry with `wait`+250ms — the official client retries up to 4x; `harvest.js` allows 12 and refills tickets), `POST /api/krillion/answer`. Tier index 5 = "One in a Krillion" (100 pts).
- `scripts/harvest.js` is the durable harvester (180 prompts / 4h cap by default, resume state in temp dir). Run with `node scripts/harvest.js`.
- Coordinator imports JSONL into both DBs at checkpoints; worker never touches DBs.
- Webapp running at http://127.0.0.1:8765 (`python webapp/app.py`), backed only by the small search DB.

Local (coordinator-owned) work: `AGENTS.md`, `scripts/krillion_db.py`, `webapp/app.py`, `webapp/index.html`, both `.db` files, `jobs.md`.
