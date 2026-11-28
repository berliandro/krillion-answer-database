# Findings

I'm the one who built this repo. I harvested the answer bank with `scripts/harvest.js` and `scripts/harvest_game.js`, walked Krillocity room IDs with `scripts/harvest_krillocity_prompts.js`, watched public rooms with `scripts/krillocity_watch.js`, and wrote the userscript in `injection/krillion-autofill.user.js` that plays Classic, multiplayer, 1v1 and Krillocity for me. State scanning is in `injection/STATES.md`, `STATES-KRILLO.md`, `STATES-MP-DUEL.md` and `INTERACTIONS.md`. The flaws below are things I hit while doing that, not theory. The security pass itself was read-only — I didn't start a new flood or write scores while checking them.

**1. The graded bank is there for anyone.** `POST /api/krillion/deal` is unthrottled and `GET /api/krillion/answers` hands over all six tiers, including 100-point answers. The 425 `wait` is a shared window, so you sleep and burst. `data/answers.jsonl`, `answers_gameplay.jsonl` and `data/krillion_full.db` are the proof. *Why fix:* anyone can rebuild our rare-answer database in an afternoon and feed it to a bot. That's the whole payoff.

**2. Krillocity prompts can be enumerated.** `harvest_krillocity_prompts.js` found that `/lineup` answers for any `race2-N`, not just the four rooms `/rooms` lists. Every near-duplicate wording drops out too — the reason `scripts/paraphrase_match.py` and `data/paraphrase_tests.json` exist. *Why fix:* a bot can collect all prompts before a race starts without ever joining.

**3. `/results` gives away everyone's answers.** `krillocity_watch.js` reads each player's answers plus the game's own point values with no seat. Details in `injection/KRILLOCITY-HARVEST.md`. *Why fix:* free answer feed, and a fairness problem for anyone actually racing.

**4. The speed limit is per request, not per turn.** There is a `too fast` rejection, but the client schedules ~400 ms between answers and its own limit formula allows roughly 123 answers in 30 seconds. The game's guide says about 10 is a good human turn. *Why fix:* this is how 3,000–25,000-point turns happen.

**5. Names can be changed whenever.** The page PUTs `{"name":...}` to `/scores` with only a 1.5-second debounce; the name sits in `localStorage` as `arena:name` / `krillion:board-name`. *Why fix:* change your name mid-lobby and you're a top racer.

**6. Guest identities are free.** `client` and `key` UUIDs are made in the browser and sent with every answer (`injection/bridge.py` mirrors this). Clear storage, get a new identity. *Why fix:* burner accounts to probe prompts and retry races.

**7. The AI judge is a soft target.** Off-bank answers go to a model; there are length caps and a `shut` flag, but no visible per-user quota. *Why fix:* crafted input can be pushed toward a 100-point grade.

**8. The clock gives away a few seconds.** Signed tickets and `late`/`closed` rejections are real, but `clockRttMs: 4000` and client-derived phases leave a wide grace. *Why fix:* late answers still score.

**9. The boards are a name directory.** `/daily/board?day=...` and `/board` are public and CDN-cached. *Why fix:* feeds flaw 5 with the exact spelling of top racers.

**10. The 1v1 rating ladder can be farmed with burner bots.** I found that a single account at the top of the 1v1 leaderboard can be propped up by a stable of bots that all enter matchmaking at once. One bot is the designated winner; the burners deliberately lose to it. If any of them gets paired with a real opponent instead, it leaves before the match starts and queues again. The cycle repeats until the bots draw each other, so the chosen account collects a stream of guaranteed wins and climbs the rating while the burners absorb the losses. *Why fix:* leaving before a match starts costs nothing, so the farm is cheap to run; a cooldown on abandoning a queue, plus a check for groups of accounts that repeatedly queue and cancel together from the same client, would take away the free retries. Full write-up: `SECURITY-REMEDIATION-REPORT.md` (FLAW-09).

To be fair: Krillocity does *not* send answer banks to the browser, tickets and stamps are signed, source maps aren't published, and realtime rooms only show public standings. Those parts are fine. It's the export paths, the missing per-turn limits and the loose identity handling that let cheaters flood.

Full write-up with evidence: `SECURITY-REMEDIATION-REPORT.md`. Raw observations: `SECURITY-AUDIT-EVIDENCE.md`. Our data policy (why we never demote from play scores) is in `../injection/DECISIONS.md`.
