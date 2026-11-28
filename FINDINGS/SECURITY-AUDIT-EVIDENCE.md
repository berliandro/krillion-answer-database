# Krillocity security audit — evidence ledger

**Audit date:** 2026-11-28
**Method:** passive observation only — one in-app-browser tab loaded `https://playdaily.org/krillocity`; network capture read; client JS bundles fetched read-only with same-origin `fetch`; `localStorage`/cookies read. No answer submission, no race start, no username change, no replay, no flood, no captcha solving, no leaderboard write.
**Git baseline:** `c55da836d2907d949588fa6632a74b27c4d26bae`, branch `main`, `origin` = `berliandro/krillion-answer-database`.
**Pre-existing changes left untouched:** deleted `favicon.ico`, modified `injection/data/prompt_review.jsonl`, untracked `scripts/apply_norm_dedupe.py`, `scripts/audit_paraphrase.py`.

## Evidence legend
- **[LIVE]** captured from the live browser session (network payload/header, DOM, storage).
- **[BUNDLE]** read from loaded, same-origin `_next/static/immutable/chunks/*.js` assets.
- **[DOC]** first-party documentation in this repository describing live API behaviour.
- **[UNVERIFIED]** inference; explicitly not treated as a finding of fact.

---

## Phase A — Information exposure & answer leakage

| ID | Observation | Class |
| --- | --- | --- |
| A1 | `GET /api/krillion/blitz/daily/board?day=2026-11-28` → 200, `cache-control: public, s-maxage=30, stale-while-revalidate=60`, `cf-cache-status: HIT`, headers `x-daily-api: worker`, `x-daily-db: pg`, `x-daily-front: edge`. Body: `{day, of:511, top:[{name,look,points}×10], buckets, curveBuckets, at}`. Public CDN cache, date-only key. | [LIVE] |
| A2 | `GET /api/krillion/blitz/rooms` → 200, `s-maxage=2`; polled by the client roughly every 5 s (timestamps 1795829487389 → 9517443); body `{rooms:{"race2-1":7,"race2-2":15,"race2-3":5,"~private":23},at}`. | [LIVE] |
| A3 | `GET /api/krillion/shop?client=<uuid>` → 200, `no-store`; body includes `account:false`, `equipped`, `badge`, and a P-256 public JWK (`key:{kty:"EC",crv:"P-256",x,y}`). | [LIVE] |
| A4 | `GET /api/time` → 200, `no-store`, body `{"t":1795829481756}` — server clock source, called 3× during load. | [LIVE] |
| A5 | Loaded 32 first-party JS chunks (~2.94 MB). **No `sourceMappingURL` found in any chunk** — exposed `.map` source maps: none observed. | [LIVE/BUNDLE] |
| A6 | Krillocity prompt delivery: `GET /api/krillion/blitz/lineup?room=<id>&race=<n>&upto=<n>&s=<shift>&k=<key>` → `{prompts:[...]}`; client retries up to 6 times; HTTP 425 returns `wait` (clamped 50–5000 ms). No answer list or tier metadata in this route's client handling. | [BUNDLE] |
| A7 | **No `/deal` or `/answers` route appears in the Krillocity bundles.** Answer banks are not sent to the Krillocity client during play — a genuine strength. | [BUNDLE] |
| A8 | Repository README documents the *Krillion Unlimited* bank harvest: `POST /api/krillion/deal` (7 prompts + ticket, "unthrottled") then `GET /api/krillion/answers` (full graded tiers); HTTP 425 supplies a `wait` for a shared ~65 s window; sleeping `wait+2s` then bursting 7 requests yielded ~350 answers/cycle; final tally 127,118 graded answers / 21,384 rare / 6,142 prompts. Plain Node `fetch`, no cookies or headers. | [DOC] |
| A9 | Post-round endpoints observed/identified are score/standing data only (`/daily/board`, `/board?from&period&window`, `/scores?period&cursor`, `/daily/finish`); no global bank exposure seen in their client handling. | [LIVE/BUNDLE] |

## Phase B — Anti-bot, rate limiting, plausibility

| ID | Observation | Class |
| --- | --- | --- |
| B1 | Answer submission is `POST /api/krillion/blitz/answer` with JSON `{scoring:3,room,race,slot,shift?,client,key,answer,stamps,offer}`. Server response validated client-side: `accepted`, `answer`, `tier∈{plankton,tooclever,schooler,rare,deepcut,krillion,miss}`, `points`, `stamp` (`/^[A-Za-z0-9_-]{22}$/`), `dup`, `shut`, `suggest`, `reason`. | [BUNDLE] |
| B2 | **A server-side velocity control exists:** refused answers whose `reason.startsWith("too fast")` and which carry no `stamp` are treated specially; client retries such submissions up to 3 times after a wait. Exact server threshold is not visible client-side. | [BUNDLE] |
| B3 | Per-prompt answer limit exists client-side: `limit = Kb(seconds) = ceil(seconds/250)+3`; refusals `again` ("You said that one already") and `full` ("That prompt has reached its answer limit"). With the 30 s default (`Kn=30000`) the formula yields up to 123 answers per prompt. Whether the server independently enforces this cap is **not verified**. | [BUNDLE] / [UNVERIFIED server side] |
| B4 | Client scheduling: `e$ = nX + 150 = 250+150 = 400 ms` minimum between submissions, at most `em=3` outstanding answers, and a 2500 ms (`vT`) "out" timeout. | [BUNDLE] |
| B5 | Server can set `shut:true`: client then shows "Only listed answers count for the rest of this prompt" — i.e. the AI fallback judge can be disabled mid-prompt by the server. | [BUNDLE] |
| B6 | Honest-human baseline published by the game's own guide: "5 Plankton + 2 Too Clever + 1 Schooler + 1 Rare + 1 Deep Cut = 10 answers in 30 seconds." | [LIVE — page FAQ table] |
| B7 | Cloudflare bot-management is present: `/cdn-cgi/challenge-platform/scripts/jsd/main.js`, `/cdn-cgi/challenge-platform/h/g/jsd/oneshot/...` POST, `cf-ray`, `server: cloudflare`. No Turnstile widget observed on the landing page. | [LIVE] |
| B8 | Local repository documents a 24-hour **automated** play session adding 3,877 answers via the injection bridge, with a Krillocity bot mode that "submits multiple distinct rare answers per rapid-fire prompt" — evidence that scripted rapid submission is practically achievable from a normal browser. | [DOC] |
| B9 | No proof-of-work, keystroke-dynamics, focus telemetry, TLS/JA3 binding, or visible/invisible CAPTCHA token observed in the game's own answer-submission path. | [LIVE/BUNDLE] |

## Phase C — Identity, session, username

| ID | Observation | Class |
| --- | --- | --- |
| C1 | `localStorage` on load contains `arena:name = "DownbeatCrane76"`, `arena:key` (64-hex), `krillion:board-name = "DownbeatCrane76"`, `krillion:look = "krill"`. | [LIVE] |
| C2 | Cookie `gamera_user_id=2ae5c739-b392-410b-93cc-d4f317a928c8`. Shop response reports `account:false` — guest session. | [LIVE] |
| C3 | On page load the client fired `PUT /api/krillion/scores` with body exactly `{"name":"DownbeatCrane76"}`; request headers: `content-type: application/json` only (no auth header for a guest). Response 200, `no-store`. | [LIVE] |
| C4 | Name-sync module: debounces 1500 ms, PUTs `{name}` to `${api}/scores` with optional auth-header provider for signed-in users, then caches the name into localStorage. No client-side cooldown, uniqueness check, reserved-name list, homoglyph/invisible-character filter, or match-scoped name lock. | [BUNDLE] |
| C5 | Client identity is generated/stored locally: UUID regex `/^[0-9a-f]{8}-...$/i`, keys `arena:name`, `arena:key`; every answer POST includes `client: client()` and `key: key()`. Chat uses an 86-char base64url signing key and a signed string `krillion-chat|v1|<room>|<id>|<d>|<t>` verified client-side against a public key. | [BUNDLE] |
| C6 | Guest-to-account merge path exists in shared code (`daily:acct:`, `daily:progress:user`, auth-token cookie listeners). Whether anomalous guest standings can be transferred was **not tested** (would require an account). | [BUNDLE] / [UNVERIFIED] |
| C7 | Server-side name-change rate limit / cooldown / reserved-name policy / session-to-name binding: **not observable** from client assets. Absence is not proven. | [UNVERIFIED] |

## Phase D — Clock authority, multiplayer sync, AI judge

| ID | Observation | Class |
| --- | --- | --- |
| D1 | Server-signed race ticket object validated client-side: `{d,s,t,k,l,lk}` where `k`,`lk` match `/^[A-Za-z0-9_-]{22}$/`, `l` is exactly 7 unique prompt IDs (`/^[a-z0-9]{6,16}$/`). Answer submissions echo ticket `shift`/`k`; mismatched ticket (`ticket.t !== response.t`) is ignored. | [BUNDLE] |
| D2 | Phase derivation: `raceStartedAt = anchor + race*LY`, count-in `j1=2000 ms`, answer window `Kn=30000 ms`, 7 prompts, reveal phase between. Classic config: `roundSeconds:25`, `answerTimeoutMs:20000`, `clockRttMs:4000`, `closeMarginMs:250`. | [BUNDLE] |
| D3 | Server can refuse answers as `late` or `closed`; client also stops submitting when its local clock says the window ended. A **4-second RTT grace** (`clockRttMs`) is allowed in the shared timing helper. | [BUNDLE] |
| D4 | Realtime transport is Supabase Realtime: channel `krillion-blitz:<roomId>`, plus `GET /api/krillion/blitz/ready`, `POST /api/krillion/blitz/chat`, `GET /api/realtime/joins`. Room capacity 16. | [BUNDLE/LIVE] |
| D5 | Opponent data rendered by the client is public progress only: `score`, `played`, `wins`, `streak`, `best`, tier/status labels; a `known` flag gates visibility of standings. No raw opponent answer strings were found in the realtime render path before the reveal board. Server-side payload filtering not independently verified. | [BUNDLE] / [UNVERIFIED server side] |
| D6 | AI fallback judge is documented by the game FAQ: "anything outside [the bank] goes to an AI model that judges whether it fits and how rare it is." Client normalises answers (NFD, strip diacritics, lowercase, quotes/dashes, articles, trailing please/maybe) before submit. | [LIVE/BUNDLE] |
| D7 | Judge response is schema-checked client-side: answer length bounded by `er(answer, 2*z.g)`, `reason` bounded to 160 chars, `suggest` allowlisted, `stamp` required shape; `shut` can force bank-only mode. | [BUNDLE] |
| D8 | Krillocity answer character cap `nX=250`; classic `answerCharacters:160`. Server-side enforcement of these caps is **not verified**. | [BUNDLE] / [UNVERIFIED server side] |

---

## Limitations
- No race was started and no answer was submitted, so live timing thresholds (`too fast`, answer limit, `shut` trigger, 4 s grace) could not be measured end-to-end; only their client contract is proven.
- No authenticated account was used; account-merge and stored-account standings were not exercised.
- No staging build was available; server-side enforcement is inferred only where the client surfaces explicit server responses (`too fast`, `dup`, `late`, `closed`, `shut`, `stamp`, 425 `wait`).
- All network observations came from one normal guest session behind Cloudflare; a different egress IP/region may see different challenge behaviour.
