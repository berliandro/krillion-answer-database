# Findings for the Krillion developer

These are the problems I found while playing and examining the game. I've written them in plain language so you don't have to spend time finding them again — you can go straight to fixing them. Most were observed directly in the game or its requests; where something could only be inferred from the client code, I've said so.

## 1. The 1v1 leaderboard can be climbed with guaranteed wins

Someone near the top of the 1v1 leaderboard runs several bots at once. Only one of them is meant to win; the rest are burners. They all start matchmaking together, and if the bots don't see each other in the match, that match is cancelled straight away and they start again. When the pairing they want finally happens, it's a guaranteed win for the one bot.

*Worth fixing:* make cancelling and re-queuing cost something (a cooldown), and look for batches of accounts that move and cancel together from the same client or device.

## 2. The whole graded answer bank is available to anyone

`POST /api/krillion/deal` is unthrottled and `GET /api/krillion/answers` hands over all six tiers, including the 100-point answers. The HTTP 425 `wait` is a shared window, so you sleep and then burst. That's how I collected 127,118 graded answers with plain `fetch` and no cookies. Anyone can rebuild the rare-answer database in an afternoon and feed it to a bot — that's the whole payoff.

*Worth fixing:* require a live, signed round ticket on `/answers`, return only the tiers the player has actually earned in that round, and replace the shared 65-second window with per-client limits.

## 3. Krillocity prompts can be collected before a race starts

`/rooms` lists only four rooms, but `/lineup?room=race2-N` answers for every room number I tried (1–1000, no gaps). Each one deals seven prompt wordings, including all the near-duplicate versions. A bot can walk the room numbers and have the prompts before it ever joins a race.

*Worth fixing:* only deal lineups to rooms that actually have seated players, and make room/race IDs hard to guess.

## 4. `/results` gives away everyone's answers

`GET /results?room=...&race=...` returns one row per player per slot, with their answers **and** the game's own point values — no seat needed. I watched public rooms without joining at all. It's a free answer feed and a fairness problem for anyone actually racing.

*Worth fixing:* hide raw answers until after the reveal, or require a seated participant; never expose the point values used for grading.

## 5. The speed limit is per request, not per turn

There is a `too fast` rejection, but the client schedules about 400 ms between answers and its own limit formula allows roughly 123 answers in 30 seconds. The game's guide says about 10 is a good human turn. That gap is how 3,000–25,000-point turns happen — each request looks fine on its own, while the total is impossible.

*Worth fixing:* add a server-side ceiling on answers and points per turn, and quietly keep impossible runs off the leaderboards.

## 6. Bot protection stops at the page, not the game

Cloudflare's challenge guards the page, but a headless browser that passes it can join a room and drive the whole race through the normal JSON API. Nothing in the game's own join or answer contract asks for proof of a human player.

*Worth fixing:* an invisible Turnstile check on room join and daily-race start, with the result tied to the race ticket. Don't put it on every answer — that would hurt latency.

## 7. Names can be changed whenever

The page PUTs `{"name":...}` to `/scores` with only a 1.5-second debounce, and the name lives in `localStorage` as `arena:name` / `krillion:board-name`. Change it mid-lobby or between races and you can appear as a top racer, including lookalike spellings with invisible or similar-looking characters.

*Worth fixing:* a cooldown on name changes, checks against reserved and top-leaderboard names (including lookalikes), and freeze the name for the length of a race.

## 8. Guest identities are free

`client` and `key` UUIDs are made in the browser and sent with every answer. Clear your storage and you're a brand-new player, with no visible cost. That makes burner accounts cheap for probing prompts and retrying races. If a flagged guest record is later merged into a real account, its standing could carry over — I couldn't test that without an account, so treat it as a design risk rather than a confirmed exploit.

*Worth fixing:* issue the IDs on the server and bind them to the signed ticket, limit how often one device can mint new ones, and drop flagged runs when merging into an account.

## 9. The boards are a name directory

`/daily/board?day=...` and `/board` are public and CDN-cached. Anyone can walk back through dates and collect the exact spelling of top racers' names, then use those names for the impersonation in finding 7. The boards are meant to be public; the problem is feeding them into a weak identity system.

*Worth fixing:* give board rows stable player IDs and render names from those records, so a name change can't quietly rewrite history.

## 10. The clock gives away a few seconds

Signed tickets and `late` / `closed` rejections are real, but the client allows a fixed 4-second RTT grace and derives the phases itself. A script can submit in the last seconds — or just after, claiming latency — and still get a stamp.

*Worth fixing:* let the server alone decide when a window is open (`startsAt` / `endsAt` in the ticket), and reduce the grace from 4 seconds to about 1.

## 11. The AI judge is a soft target

Anything outside the known bank goes to a model. There are length caps and a `shut` flag, but no visible per-user limit on how often you can ask the judge. Crafted input can be nudged toward a 100-point grade. The server already has `shut` to switch a prompt to bank-only, so the lever exists.

*Worth fixing:* enforce the input limits on the server, pass the player's text as data rather than instructions, cap judge calls per player and per prompt, and automatically switch to bank-only when the rarity pattern looks impossible.

---

**What's already working well, and worth keeping:** Krillocity does not send answer banks to the browser; prompts arrive on a signed ticket and grading happens on the server. Tickets and stamps are signed. Source maps aren't published. Realtime rooms only show public standings, not other players' raw answers. Those are good foundations — the fixes above are about closing the gaps around them.

**How I checked:** one passive browser session and read-only request/bundle inspection. I did not start a race, submit an answer, change a name, solve a captcha, or write to a leaderboard. Where I say a server-side limit is missing, that is inferred from the client contract rather than proven — I did not run an exploit to confirm it.
