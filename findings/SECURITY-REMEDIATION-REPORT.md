# Krillocity Security & Anti-Cheat Remediation Report

**Target:** `[https://playdaily.org/krillocity](https://playdaily.org/krillocity)` (and shared Krillion game endpoints)  
**Scope:** Answer Bank Protection, Anti-Bot/Velocity Controls, Username/Session Integrity, and Scoring Validation  

## Executive Summary
* **Overall Risk Posture:** High
* **Top 3 Immediate Fixes (Highest Impact, Lowest Effort):**
  1. I would add server-side per-turn plausibility enforcement: a hard answer-count ceiling scaled to the prompt clock and a maximum credible score per 30-second turn, with anomalous runs shadow-banned from leaderboards instead of silently accepted. A `too fast` rejection already exists — I would extend it with an aggregate cap rather than relying on per-request throttling alone.
  2. I would lock down display names at the write boundary: cooldown, character/similarity validation against reserved and leaderboard names, and a server-side session→name binding for the duration of a race. The client currently PUTs `{"name":...}` with only a 1.5-second debounce.
  3. I would close the graded-bank export path: authenticate and scope `GET /api/krillion/answers` to a live, server-signed round, and replace the shared 65-second `425 wait` window with per-client limits. A complete public dataset of 127,118 graded answers exists and is the direct source of the cheat payoff.

**What was already working well (I would keep it):** Krillocity does **not** ship answer banks or tier metadata to the browser — prompts arrive via a signed `/lineup` ticket and grading happens server-side; answers carry single-use-looking `stamp` tokens; the server already rejects `too fast`, `dup`, `late` and `closed` answers and can `shut` the AI fallback judge mid-prompt; realtime rooms expose public standings, not raw opponent answers; source maps are not published; room/board reads are CDN-cached and contain no bank data. These are strong foundations — my fixes below are about closing the remaining gaps without adding maintenance burden.

---

## Detailed Findings & Remediation Plan

### [FLAW-01] Graded answer bank is enumerable through the shared Krillion API
* **Severity:** High
* **Category:** OWASP API3:2023 Broken Object Level Authorization / excessive data exposure
* **Affected Endpoint / Component:** `GET /api/krillion/answers` after `POST /api/krillion/deal` (Krillion Unlimited, shared economy with Krillocity)
* **How the Cheat Works:** A client with no game session requests deals, receives seven prompts plus a ticket, then fetches each prompt's *complete* graded bank — including the 100-point "One in a Krillion" tier — and repeats in bursts. The published `wait` value on HTTP 425 is a shared window: waiting `wait + 2s` and then firing seven requests yields roughly 350 answers per cycle. This is not theoretical: this repository documents a harvest ending at 127,118 graded answers, 21,384 of them rare, using plain `fetch` with no cookies. Those answers are exactly what a Krillocity bot needs to flood a 30-second prompt with rare hits.
* **Root Cause:** The bank endpoint authorises the *request*, not the *player in an active round*, and its throttle is a coarse global window rather than a per-identity budget. The bank is a static asset reachable outside gameplay.
* **Recommended Fix (Step-by-Step):**
  * I would require a live, server-signed round ticket (the same `d/s/t/k/l/lk` structure already used by `/lineup`) on every `/answers` call, and reject tickets whose round has ended or whose `upto` exceeds the current prompt index.
  * I would return only the tier of answers the player has already legitimately earned in that round; never return the full bank to the browser.
  * I would replace the shared `425 wait` window with per-identity/per-IP token buckets and a daily export budget, and alert on any identity fetching hundreds of banks.
  * I would keep the JSON schema, `425` response shape and `wait` field so the existing clients degrade gracefully.

### [FLAW-02] No published per-turn plausibility ceiling — velocity control is per-request only
* **Severity:** High
* **Category:** OWASP API4:2023 Unrestricted Resource Consumption / business-logic flaw
* **Affected Endpoint / Component:** `POST /api/krillion/blitz/answer` (and the shared `/api/krillion/answer`)
* **How the Cheat Works:** The client schedules submissions about 400 ms apart and its per-prompt limit formula (`ceil(seconds/250)+3`) allows up to ~123 answers in a 30-second prompt, while the game's own guide says a strong human manages about 10. A script can therefore sit just inside the per-request `too fast` threshold and submit dozens of rare answers, producing 3,000–25,000-point turns. Accepted answers return a `stamp`, so the run looks legitimate request-by-request even though the aggregate is impossible.
* **Root Cause:** Enforcement is local to each submission (a `too fast` reason with no stamp). There is no server-side aggregate answer-count or score bound per prompt/turn, and no cross-request pattern scoring. The client-side `limit` and `400 ms` scheduler are advisory only — anything can call the endpoint directly.
* **Recommended Fix (Step-by-Step):**
  * I would enforce a server-side per-turn answer ceiling derived from the signed clock: e.g. `min(24, 8 + floor(seconds/5))` accepted answers for a 30-second prompt (≈14), and reject or drop further submissions with `reason: "limit"` rather than trusting the client's count.
  * I would add a per-turn score cap consistent with that ceiling (e.g. ≤1,500 points/30 s in public races) and a per-prompt maximum number of 85/100-tier accepts, so a bot cannot win on a single lucky rarity streak.
  * I would track a lightweight anomaly score per turn (answers/second, rarity distribution, inter-arrival variance, duplicate-normalised answers). Above threshold, I would shadow-ban: keep the player's UI normal but exclude the run from Daily Race and public leaderboards and from token payouts.
  * I would reuse the existing response fields (`accepted`, `stamp`, `shut`, `reason`) so no client change is required to roll this out.

### [FLAW-03] Bot attestation relies on the edge only; no game-layer proof of humanity
* **Severity:** Medium
* **Category:** OWASP API4:2023 / WSTG-BUSL — insufficient anti-automation
* **Affected Endpoint / Component:** room join, `/api/krillion/blitz/ready`, answer submission
* **How the Cheat Works:** A headless browser that passes the Cloudflare edge challenge can join a room and drive the whole race through the normal JSON API; nothing in the game's own join/answer contract asks for a bot-management token or behavioural proof. The repository's own 24-hour automated session demonstrates the pattern works from an ordinary browser.
* **Root Cause:** Cloudflare's challenge protects the page, not the game API. The API trusts any correctly shaped request carrying the client-generated `client` and `key` UUIDs.
* **Recommended Fix (Step-by-Step):**
  * I would add Cloudflare Turnstile (invisible mode) to room join and daily-race start only — not to every answer, to avoid harming latency — and verify the token in the Worker before issuing a race ticket.
  * I would bind the resulting ticket to the verified client ID so the same token cannot be reused across many rooms.
  * I would keep a manual fallbacks path for users who cannot complete the challenge; I would log verification failures rather than silently blocking.
  * I would **not** add keystroke dynamics or heavy fingerprinting yet: they are high-maintenance and provide little extra value once FLAW-02 and FLAW-04 are fixed.

### [FLAW-04] Display name can be changed with no server-side cooldown, similarity check, or match binding
* **Severity:** High
* **Category:** OWASP API1:2023 Broken Access Control / API2:2023 Identification and Auth Failures
* **Affected Endpoint / Component:** `PUT /api/krillion/scores` with body `{"name":...}`; localStorage keys `arena:name`, `krillion:board-name`
* **How the Cheat Works:** On load the browser automatically PUTs the client-chosen name with only a `content-type` header for a guest. A script can change the name repeatedly mid-lobby or between races, adopt a top-racer's exact spelling or a homoglyph/invisible-character variant, and appear on public boards as that player. Because the name lives in `localStorage` and is echoed to the server, nothing in the client prevents cycling or impersonation; server-side policy is not visible from client assets and must be assumed absent until proven otherwise.
* **Root Cause:** The display name is treated as client-owned presentation data, while leaderboards and room standings treat it as identity. There is no uniqueness, reserved-name, Unicode-confusable, or session-binding step at the write boundary.
* **Recommended Fix (Step-by-Step):**
  * I would apply a cooldown (e.g. one change per 24 h for guests, 30 days for accounts) and a lifetime change counter; reject faster requests with `429` and a `retry_after` header.
  * I would validate server-side: NFC normalisation, reject zero-width/invisible characters, cap length (25 chars matches the current client), and compare against a reserved-name list plus the top 100 leaderboard names using a confusable-aware similarity check (homoglyph folding).
  * I would freeze the name at race start: store the authoritative name in the signed race ticket/session and render standings from it; ignore later `PUT /scores` writes until the race ends.
  * I would keep the existing `{name}` body and 200/204 response shape so the shipped client continues to work unchanged.

### [FLAW-05] Guest identities are client-minted; account merge can inherit unvetted standings
* **Severity:** Medium
* **Category:** OWASP API2:2023 / WSTG-SESS — session management
* **Affected Endpoint / Component:** `arena:key` / `arena:name` localStorage, `client`/`key` fields on every answer, guest→account merge (`daily:acct:*`, `daily:progress:user`)
* **How the Cheat Works:** Identity is a pair of UUIDs generated and stored in the browser and replayed in every request. Clearing storage mints a fresh identity with no observable server-side cost, which lets a bad actor probe prompts, retry races, or abandon a flagged session and continue. If a guest record with anomalous scores is later merged into a signed-in Daily Games account, the tainted standing could be laundered into a permanent profile. Merge behaviour was not live-tested (no account was available) — this is a design-level risk, not a reproduced exploit.
* **Root Cause:** Guest identity is entirely client-held and there is no visible device/IP issuance limit or trust tier separating guest-created standings from account-created ones.
* **Recommended Fix (Step-by-Step):**
  * I would issue the guest `client`/`key` server-side when a ticket is minted; treat client-supplied values as untrusted hints and bind them to the signed ticket.
  * I would rate-limit identity issuance per IP/device fingerprint (generous enough for shared NAT — e.g. 20/hour) and keep a "flagged" bit on identities with anomalous runs.
  * On guest→account merge, I would transfer only verified standings and drop flagged or shadow-banned runs; log the merge with both identity IDs for audit.

### [FLAW-06] Predictable, publicly cached board endpoints enable name reconnaissance
* **Severity:** Medium
* **Category:** OWASP API3:2023 — information exposure
* **Affected Endpoint / Component:** `GET /api/krillion/blitz/daily/board?day=YYYY-MM-DD`, `GET /api/krillion/blitz/board?from&period&window`, `GET /api/krillion/scores?period&cursor`
* **How the Cheat Works:** The daily board is a public CDN cache hit keyed only by a date, and returns names, looks and points for the top ten plus a distribution. An attacker can enumerate dates for months to harvest the exact spelling of top racers, then feed those names into FLAW-04 to impersonate them. This is reconnaissance, not the scoring exploit itself, which is why it is ranked below the hotfixes.
* **Root Cause:** Board data is intentionally public, but it is also the input to a weak identity system; caching and predictability make bulk collection trivial.
* **Recommended Fix (Step-by-Step):**
  * Once FLAW-04 is fixed, most of this risk disappears — I would prioritise that first.
  * I would add stable public player IDs to board rows and render names from the ID record, so a display name change cannot silently rewrite history.
  * I would keep the 30-second CDN cache (good for performance), but apply the same reserved-name/confusable check to historical display names when they are served, and avoid exposing email-like or account identifiers.

### [FLAW-07] Clock authority is good but the grace window is generous
* **Severity:** Medium
* **Category:** OWASP API6:2023 Server-Side Request Forgery / WSTG-INPV — client-side clock trust
* **Affected Endpoint / Component:** `/api/time`, signed ticket `t`, client phase derivation (`j1=2000`, `Kn=30000`, `clockRttMs=4000`, `closeMarginMs=250`)
* **How the Cheat Works:** The client derives the count-in, answer window and reveal from a server anchor plus a fixed 4-second RTT allowance. A script can submit in the last seconds of the window — or just after it, while claiming latency — and still receive a `stamp`. The server does reject `late`/`closed` answers, so this is a bounded residual, not an open door; tightening it improves fairness at the margins.
* **Root Cause:** The latency grace is a fixed constant rather than a measured value, and the client is allowed to decide when a window is open.
* **Recommended Fix (Step-by-Step):**
  * I would make the server the sole authority on phase: include `startsAt`/`endsAt` in the signed ticket and reject any submission whose server receive-time is outside `[startsAt, endsAt + grace]`.
  * I would derive `grace` from observed p99 client→worker RTT (e.g. 500–800 ms) with a hard 1-second ceiling, replacing the current 4-second allowance; keep a small `closeMarginMs` so slow clients are not unfairly cut off.
  * I would keep `/api/time` for display synchronisation only; never use the client's computed phase for validation.

### [FLAW-08] AI fallback judge lacks visible input caps, injection sanitisation, and per-user quota
* **Severity:** High
* **Category:** OWASP API8:2023 Injection / WSTG-INPV — AI/LLM abuse
* **Affected Endpoint / Component:** `POST /api/krillion/blitz/answer` when the answer is outside the known bank; `shut` response flag
* **How the Cheat Works:** Anything outside the bank is judged by an AI model. If the judge can be prompted with crafted strings, an attacker may coax it into returning `krillion` (100 points) for nonsense input. The client applies length caps (250 chars for Krillocity, 160 for classic) and answer normalisation, and the response schema is checked, but none of that is proof of *server-side* enforcement, and no per-user judge quota is visible. The good news: the server already has a `shut` flag that switches a prompt to bank-only mode — use it as the mitigation lever.
* **Root Cause:** The judge is an LLM-based oracle on the critical scoring path, with client-side sanitisation as the only visible guardrail.
* **Recommended Fix (Step-by-Step):**
  * I would enforce server-side input limits: NFC-normalise, strip control/zero-width characters, cap at 120 characters for the judge path, and apply a strict character allowlist appropriate to the prompt language. Reject rather than truncate.
  * I would never interpolate user text into the judge instruction as instructions; I would pass it as a quoted, delimited data field with an explicit system prompt that forbids tier assignment for off-topic or instruction-like text.
  * I would cap judge calls per user per turn (e.g. 6) and per prompt globally; after the cap, return `shut:true` and grade only against the known bank.
  * I would automatically set `shut:true` for a prompt whose judge-accepted rarity distribution is statistically impossible, and surface a concise reason to the client using the existing `reason` field.

---

## Prioritized Implementation Roadmap for the Developer
| Priority | Flaw ID | Fix Summary | Estimated Effort | Impact on Cheating |
| :--- | :--- | :--- | :--- | :--- |
| **P0 (Hotfix)** | FLAW-02 | Server-side per-turn answer ceiling + score cap + shadow-ban of impossible runs | Low (~1–2 hours) | Blocks 3,000–25,000 pt bot turns immediately |
| **P0 (Hotfix)** | FLAW-04 | Name cooldown + confusable/reserved validation + race-scoped session binding | Low (~1 hour) | Stops infinite name cycling and top-racer impersonation |
| **P1 (Short-Term)** | FLAW-01 | Require live signed round ticket on bank API; replace shared 65s window with per-identity budgets | Medium (~3–4 hours) | Stops bulk answer-database scraping / rare-answer extraction |
| **P1 (Short-Term)** | FLAW-03 | Invisible Turnstile on join/daily start, token bound to ticket | Medium (~2–3 hours) | Raises cost of headless-browser farming without touching answer latency |
| **P1 (Short-Term)** | FLAW-05 | Server-issued guest IDs, issuance throttling, clean guest→account merge | Medium (~3–4 hours) | Prevents identity recycling and laundering of flagged standings |
| **P1 (Short-Term)** | FLAW-08 | Server-side judge input caps, sandbox-style prompt, per-user judge quota, auto `shut` | Medium (~4–6 hours) | Prevents judge prompt-injection and crafted 100-point awards |
| **P2 (Hardening)** | FLAW-07 | Server-authoritative `startsAt`/`endsAt`; grace reduced from 4s to ≤1s | Low (~1–2 hours) | Closes late-submission and count-in boundary abuse |
| **P2 (Hardening)** | FLAW-06 | Stable public player IDs and historical-name hygiene on cached boards | Low (~1 hour) | Removes the reconnaissance input for impersonation |

---

## Appendix A — Evidence and limitations

Full observations, request URLs, response headers/bodies and bundle excerpts are in `findings/SECURITY-AUDIT-EVIDENCE.md`. Method: one passive browser session, no race start, no answer submission, no username change, no replay, no flood, no captcha solving, no leaderboard write.

- **Live-verified:** public API payloads and cache headers; Cloudflare challenge assets; client storage keys; the automatic `PUT /scores {"name":...}`; the game's own FAQ rules and tier table; absence of published source maps.
- **Bundle-verified:** signed ticket/stamp schema; `too fast`, `dup`, `late`, `closed`, `shut`, `suggest` response handling; 2 s count-in and 30 s clock; 400 ms client scheduler; answer-limit formula; AI-judge response validation; Supabase realtime channel and standings-only rendering.
- **First-party documented:** the 127,118-answer harvest via `/deal` + `/answers`, the 425 `wait` window, and the 24-hour automated play session.
- **Unverified (stated honestly):** exact server thresholds for `too fast`, the answer-limit default `bq`, server-side enforcement of character caps, name-change cooldown policy, account-merge behaviour, and server-side realtime payload filtering. No exploit was executed to resolve these, in line with the rules of engagement.
