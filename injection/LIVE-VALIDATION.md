# Live scored validation — Edge automation profile (2026-11-27)

**Browser:** dedicated Edge automation profile `edge-this-computer-2` via `browse` MCP, agent tab `krillion-live`.
**Transport note:** the paired profile has no Tampermonkey, and the HTTPS game page cannot open a
subresource connection to `http://127.0.0.1:8768` (fetch and XHR both hang with 0 TCP connect;
top-level navigation works). To exercise the **real shipped userscript source**, the agent injected
the actual `@version` source fetched from the raw GitHub URL with GM-compatible stubs, fed the real
`/api/all` (5,801 rows) and `/api/all-tier` (2,879 rows) bridge snapshots into the page, and relayed
the script's own requests to the real bridge. All scoring/refusal/timing/state tags below come from
the real game DOM and the real bridge logs, not from a harness.

## Environment evidence
```
browse.status: connected=true, browsers=[edge-this-computer-2], activeTargets=1
bridge /api/health: ok=true base_answers=21384, log_lines evidence=3829 prompt_review=4096 bot_log=127
raw URL @version: 1.1.5 at start -> 1.1.6 after live bug fix
```

## Classic (PROVEN live)
- Real Classic dives driven by `Play for me` in the Edge page.
- Game reached **BEST CLASSIC: 7,000 m** (perfect 7/7 prompts) and a live dive showed `PROMPT 3 OF 7` at `2,040 m`.
- Bridge delta (classic-before → classic-mid): `evidence.jsonl +6`, `prompt_review.jsonl +5`, `bot_log.jsonl +2`, `failed_prompts.jsonl +2`.
- Live 100-point `ONE IN A KRILLION` answers written to `evidence.jsonl` (all `outcome=ok`, `points=100`):
  Kinkajou, Mentaiko, Blue Lobster, Cetinje, Mutoscope, Catjang, Rink Bandy, Business Decal,
  Boab nut, Slab Lifter, Saint Pierre and Miquelon, Maureen Connolly, Mundan.
- Refusal/ambiguous handling logged live in `prompt_review.jsonl` (`kind=ambiguous`, multiple near-duplicate banks kept separate).
- End-of-dive bank capture logged live (`classic-bank-capture`, `game_state=results`).
- Snapshots: `injection/data/live_validation/classic-before.json`, `classic-mid.json`, `classic-dive-1-diff.json`.

## Krillocity (live race / multiplayer room)
- Today's daily race (No. 33) had already been spent before validation (`View results`, next in ~11 h), so
  the rapid-fire path was validated in a **live Krillocity multiplayer race** (room `Riptide`, 7 prompts / 30 s each).
- **Real bug found in v1.1.5:** Krillocity keeps a hidden `p.kr-prompt` in the wait card ahead of the
  visible prompt. `document.querySelector()` returned the hidden empty node, so the panel stayed
  `Waiting for the next prompt…` and the bot never answered. Evidence:
  `injection/data/live_validation/krillo-prompt-selector-bug.json`.
- Fixed in **v1.1.6** by `promptEl()` (first visible, non-empty `p.kr-prompt`) used by `promptText()`,
  `isVisible()` and `visible()`. All suites green after fix: suite 9/9, state matrix 58 PASS/0 FAIL,
  faults 23/23 + 13/13. Pushed as `db09473`.
- With v1.1.6 the live race showed panel `5 known 100-point answers`, botState `race answer sent`,
  then `race: no more answers` — rapid-fire sends confirmed. Bridge delta: `bot_log.jsonl +7`
  including `room-select`, `mode-change=krillocity`, `bot-start=krillocity`.
- No other-player answers were logged: only room name/count metadata from the site lobby.
- Snapshots: `krillo-before.json`, `krillo-after.json`, `krillo-diff.json`.

## Multiplayer / duel
- Joined real multiplayer room `Riptide` (5–6 racing) on Krillocity; `bot_log` recorded `room-select`
  with room names and counts only. No other-player answer data captured, no forfeit, no rating change tested.

## Honest limitations
- No server-authoritative verdict telemetry (2.5 s grace, AI-judge allowance, Elo deltas) was available;
  those three strategy claims remain unprovable by automation and are formally discarded below.
- The Classic tier-greedy fallback never had an applicable no-100 prompt in the live dives (every live
  answer scored 100), so live play could not promote it; it remains discarded.
- The userscript was executed from its real source with GM stubs rather than via an installed Tampermonkey,
  because the dedicated automation profile has no userscript manager and loopback subresources are blocked.
