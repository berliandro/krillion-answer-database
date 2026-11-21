# AGENTS.md — Krillion Game

## Project goal
Scrape every question + answer from the Krillion game at https://playdaily.org/krillion using browser MCP, then surface answers instantly in a webapp search. The payoff is "one in a krillion" answers (worth 100+ points/round), so the search must return those fast.

## Two-tier data model (do not mix them)
- **Full DB**: every answer to every question found on the web (thousands of rows). Optimize for completeness, not speed. This is the source of truth.
- **Search DB**: small derived DB used by the webapp. Store **only 1 answer per question** (a question has ~5–10 known answers).
- The webapp searches the **Search DB only** — never the full DB. Rebuild the Search DB from the Full DB.

## Webapp
- One fast search box: type a question phrase (e.g. `Name any one famous park`) → instant matching answer(s).
- Optimize for search speed/quality over features; it is backed by the small Search DB.

## How work is organized
- This session is the **supervisor / observer / warder**. It does not scrape directly.
- Scraping is delegated to a subagent orchestrated with the `opencode-session-orchestration` skill (explicit-only — load it before starting workers).
- Supervisor duties: create workers; give each a job ID, owned files, and a result contract (see the skill); check `inbox`/`messages` at checkpoints; verify evidence before accepting a job as done; cancel stale/idle workers. Never accept "done" without evidence.
- Browser work uses browser MCP: prefer in-app `browser` tools, use `browse` only for the user's real/logged-in Chrome, Playwright MCP only as a fallback (see global AGENTS.md).

## Setup status
Repo is currently empty — no manifests, README, or code. **Build the setup first** (DB schema, import pipeline, webapp skeleton) before delegating any scraping.

## Edge autofill injection (`injection/`)
- PC-only Tampermonkey userscript + loopback helper (`injection/bridge.py`, port 8768). Read `injection/README.md` before working there.
- **Never demote a 100-point answer from a play score.** The game AI-grades unknown answers inconsistently; only the game's own dive-end graded bank is authoritative (policy in `injection/DECISIONS.md`).
- Near-duplicate prompts are shown as separate labelled banks, never merged. Aliases/rewordings are logged, never applied to matching.
- **"Process the log"** is a standing workflow request from the user: follow `injection/PROCESS-LOG.md` end to end (review logs → apply bank demotions → run `python scripts/krillion_db.py import` → rebuild static site → commit → changelog summary).
- Two sessions may be active: one optimizing the webapp UI, one refining the userscript. Keep edits inside your owned paths.
