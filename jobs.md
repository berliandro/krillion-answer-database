# Orchestration job tracker

Coordinator session: `ses_e0720335cffeyCAhxPyntUehLO`
Remote: https://github.com/berliandro/krillion-answer-database.git (branch `main`, initial setup pushed)

| Job | Worker session | Status | Owns | Artifact | Evidence |
| --- | --- | --- | --- | --- | --- |
| scrape-001 | `ses_e071ce061ffeFCztEbdH7fgiyW` | running | `data/answers.jsonl`, `data/scrape-notes.md`, `scripts/harvest.js` (append/notes/harvester only) | `data/answers.jsonl` | API path ~683+ lines; see combined stats below |
| gameplay-001 | `ses_e06f05a44ffeywiGB4J3PET0Fq` | running | `data/answers_gameplay.jsonl`, `scripts/harvest_game.js`, `data/gameplay-notes.md` | `data/answers_gameplay.jsonl` | Manually parsed user's first game: 307 answers / 39 krillion / 7 prompts (committed `0b19b15`); worker now automating + hunting a bulk source |

Combined DB stats at last checkpoint: full=1510, krillion=207, search questions=31, jsonl_lines=1510 (verified via `krillion_db.py stats`, `search "fictional bear"` → Gentle Ben, `search "blue"` → Cap).

Notes:
- Worker uses Chrome (`browse` MCP + `chrome-browser-mcp` skill) per user request.
- API discovered: `POST /api/krillion/deal` (unthrottled, 7 prompts), `GET /api/krillion/answers?prompt=&ticket=` (HTTP 425 = retry with `wait`+250ms — the official client retries up to 4x; `harvest.js` allows 12 and refills tickets), `POST /api/krillion/answer`. Tier index 5 = "One in a Krillion" (100 pts).
- `scripts/harvest.js` is the durable harvester (180 prompts / 4h cap by default, resume state in temp dir). Run with `node scripts/harvest.js`.
- Coordinator imports JSONL into both DBs at checkpoints; worker never touches DBs.
- Webapp running at http://127.0.0.1:8765 (`python webapp/app.py`), backed only by the small search DB.
- **Objective: harvest ALL answers from ALL prompts**, not just the first batch. `harvest.js` defaults to 180 prompts / 4 h, which is only a first tranche of the site's "thousands" of prompts. After the current run completes, relaunch with higher `KRILLION_MAX_PROMPTS` / `KRILLION_MAX_MS` (resume state is in the temp dir) until the prompt bank is exhausted, importing and committing at each checkpoint.
- **Gameplay is ~3x faster than the API path.** User played one Classic dive in <2 min and got 7 complete graded banks (~307 answers, 39 krillion) ≈ 150 answers/min vs API's ~45-50/min. This proves the game does NOT hit the 65s cooldown per bank, so a bulk/results source likely exists. `gameplay-001` is investigating network traffic first, then automating dives as fallback.
- The user's 7-prompt game result was parsed into `data/answers_gameplay.jsonl` (307 rows). `krillion_db.py import` now reads ALL `data/answers*.jsonl` files, so the two workers can append independently without write conflicts.
- Start button XPath (if needed): `/html/body/div[3]/main/div[2]/div/div/div[5]/div[3]/button[1]`.
- Do not interrupt either worker; both paths run in parallel intentionally.

Local (coordinator-owned) work: `AGENTS.md`, `scripts/krillion_db.py`, `webapp/app.py`, `webapp/index.html`, both `.db` files, `jobs.md`.
