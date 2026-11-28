# Krillocity — Security & Anti-Cheat Assessment Goal

**Status:** APPROVED — awaiting execution
**Created:** 2026-11-28
**Owner:** Supervisor session; passive/observational audit only — no live flooding, no leaderboard contamination. Analyze locally and from a single normal user session; delegate nothing that submits traffic to `playdaily.org`.
**Source:** user directive, verbatim intent preserved below. This is a white-hat architectural audit whose output is a developer remediation report, not an exploit kit.

---

## 0. Read first (do not skip, do not skim)

1. `AGENTS.md` — project rules, two-tier data model, browser hierarchy, known collaborator sessions.
2. `injection/STATES.md`, `injection/DECISIONS.md`, `injection/README.md` — how the game/client behaves and the standing non-demotion / bank-authority policy.
3. `injection/PROCESS-LOG.md` — context for how the public answer dataset is maintained.
4. `scripts/ingest.py`, `scripts/derive.py` — how answer banks and rarity tiers flow into the local dataset (relevant to Phase A of this audit).
5. `README.md`, `PRODUCT.md`, `DESIGN.md` — game/economy context and scope.

Report understanding in ≤10 lines before starting, including:
- **Full DB** = every answer to every question; source of truth; completeness-optimized.
- **Search DB** = derived, **one answer per question**; the webapp searches this only; rebuilt from Full DB.
- This audit is **external** (target: `https://playdaily.org/krillocity` and shared Krillion endpoints); local files are context only and must not be edited as part of the audit.

Run `git status` before changing anything. Do not touch webapp-optimizer-owned files or the userscript.

---

## 1. Mission Objective

Conduct a comprehensive, **non-destructive white-hat** security and architectural audit of **Krillocity** (`https://playdaily.org/krillocity`) and its shared **Krillion** backend/economy. Identify every client-side, API, session, and business-logic flaw that enables cheating, specifically:

1. **Answer Bank & Rarity Exposure:** Unauthorized retrieval or enumeration of prompt answer banks and rarity tiers (e.g., how public datasets like `krillion-answer-database` are extracted).
2. **Automated High-Velocity Answer Injection:** Lack of anti-bot, rate-limiting, and human-plausibility checks allowing scripts to submit dozens of rare answers per 30-second prompt and achieve impossible single-turn scores (3,000 to 25,000+ points/meters).
3. **Unrestricted Identity & Username Spoofing:** Flaws allowing players to change their display name infinitely at any moment, impersonate legitimate top racers, or bypass room/leaderboard accountability.
4. **Client-Side Trust & Real-Time Sync Weaknesses:** Desynchronization or missing server-side enforcement across the 2-second count-in, 30-second prompt clock, WebSocket/realtime multiplayer streams, and AI fallback judge.

### Out of Scope
- Denial-of-Service (DoS/DDoS)
- Infrastructure/hosting penetration testing
- Payment/unrelated Daily Games titles
- Any form of automated data scraping or leaderboard pollution on live production servers

---

## 2. Rules of Engagement (Strict White-Hat Constraints) — HARD RULES

- **Passive & Local Observation Only:** Inspect client-side assets, browser storage, and network traffic strictly within a single, normal user session (or an authorized local/staging build).
- **Zero Automated Flooding:** Never run automated answer-submission scripts, brute-force prompt enumerators, or high-frequency API loops against `playdaily.org`.
- **No Leaderboard Contamination:** Do not submit illegitimate scores to the Daily Race or public multiplayer leaderboards.
- **Actionable Defense Focus:** Every finding must map directly to a concrete server-side architectural patch that reduces developer maintenance burden.
- **Browser hierarchy:** in-app `browser` first → `browse` only for the user's real Chrome → Playwright MCP as fallback. Never solve captchas. Never click real-money or destructive controls.
- **No stalling:** If a fact is unknown (e.g., an undocumented endpoint), research it from the game's own public bundles/docs before reporting blocked. Report knowledge gaps honestly as `UNVERIFIED`, never as fact.
- **Evidence before acceptance:** Every finding must cite a concrete observation (payload shape, bundle asset, storage key, timing measurement) — inference alone is labelled as such.

---

## 3. White-Hat Audit Checklist & Methodology

### Phase A — Information Exposure & Answer Leakage (OWASP API3 / WSTG-INFO)
Investigate how prompt data, known answer banks, and rarity tiers (`Plankton` 10 pts/100 m through `One in a Krillion` 100 pts/1,000 m) are transmitted and stored:
- **Network Payload Inspection:** Capture normal gameplay HTTP/WebSocket frames during prompt initialization (`READY, 3, 2, 1, GO`). Check whether the server sends candidate answer lists, hashes, regex patterns, or tier metadata to the client before the 30-second round ends.
- **Client Bundle & Source Map Audit:** Inspect loaded JavaScript bundles, static JSON assets, and exposed `.map` source maps for hardcoded prompt catalogs, fallback dictionaries, or internal API route definitions.
- **Prompt & Round Enumeration:** Check if prompt IDs or Daily Race endpoints (`00:00 UTC` rotation) use sequential/predictable identifiers that allow unauthenticated querying of historical or upcoming prompts without an active server-signed round state.
- **Post-Round Summary Exposure:** Verify whether end-of-round recap endpoints expose more of the global answer bank than the specific answers submitted by players in that room.

### Phase B — Anti-Bot, Rate Limiting & Plausibility Checks (OWASP API4 / WSTG-BUSL)
Analyze why automated bots can submit massive volumes of valid answers within a single 30-second prompt:
- **Submission Throughput & Velocity:** Measure the minimum interval accepted between consecutive answer submissions on a single prompt. Determine if the server enforces a realistic human typing/submission cooldown (e.g., minimum milliseconds per character/submission).
- **Statistical & Score Anomaly Bounds:** Evaluate server-side sanity checks per 30-second prompt. A legitimate human rarely exceeds ~10–15 answers in 30 seconds; scoring 3,000–25,000 points in one turn requires dozens of high-tier (`60–100` pt) submissions within seconds. Check if the backend flags, throttles, or invalidates statistically impossible answer bursts.
- **Client Attestation & Bot Detection:** Check for proof-of-work challenges, invisible CAPTCHA/bot-management tokens (e.g., Cloudflare Turnstile), TLS/browser fingerprinting, or behavioral telemetry (keystroke dynamics, focus events) on room join and answer submission endpoints.
- **Replay & Idempotency:** Test whether intercepted answer-submission requests carry a single-use nonce/sequence ID, or if identical/batched HTTP/WebSocket packets can be replayed concurrently. (Inspect structure only — do not replay against live servers.)

### Phase C — Identity, Session & Username Integrity (OWASP API1 / API2 / WSTG-SESS)
Audit how anonymous guest sessions and Daily Games accounts manage player identity:
- **Infinite Username Mutation:** Inspect the endpoint or WebSocket event responsible for updating a player's display name. Check for:
  - Missing rate limits or cooldowns (allowing rapid name cycling mid-lobby or between races).
  - Missing uniqueness, reserved-name, or homoglyph/invisible-character validation (allowing impersonation of top leaderboard players or developers).
  - Lack of server-side binding between a session ID and its display name during an active match.
- **Anonymous Session & Token Generation:** Inspect how guest wallets/sessions are initialized in browser storage (`localStorage`/cookies). Check if new guest identities can be minted infinitely without rate limits or device/IP throttling to farm or probe prompts.
- **Account Merge Integrity:** Review the flow where a guest browser wallet merges into a signed-in Daily Games account to ensure tainted or anomalous guest sessions cannot transfer illegitimate standings. (Inspect flow locally; do not execute a tainted merge on production.)

### Phase D — Clock Authority, Multiplayer Sync & AI Judge Hardening (OWASP API6 / WSTG-INPV)
Examine the real-time game loop and grading pipeline:
- **Count-In & Clock Boundary Enforcement:** Verify whether the server strictly rejects answers submitted during the 2-second count-in window (`READY, 3, 2, 1`) or after the 30-second server timestamp expires (accounting only for bounded network latency grace periods).
- **Multiplayer Room Isolation:** Inspect real-time room messages (WebSocket/SSE) to ensure players only receive opponents' public progress/overtake deltas and cannot read other lanes' raw inputs before the between-prompt reveal board.
- **AI Fallback Judge Abuse:** Since answers outside the known bank are routed to an AI model to judge validity and rarity, check for input length caps, character allowlists, prompt-injection sanitization, and per-user AI-judge rate limits (preventing attackers from tricking the AI judge into awarding `One in a Krillion` tiers to crafted strings). (Analyze the request/response contract only — do not send crafted prompts to the live judge.)

### Phase E — Synthesize & Write the Developer Remediation Report
Convert every finding into the exact template in §4, prioritized with quick-win server-side patches first so the developer can stabilize the game with minimal effort.

---

## 4. Final Output Requirement — Developer Remediation Report (exact template)

Upon completing the audit, **you MUST generate a comprehensive, empathetic, and actionable report in Markdown format** addressed to the developer, following the exact template below. Prioritize quick-win server-side patches first.

```markdown
# Krillocity Security & Anti-Cheat Remediation Report

**Target:** `[https://playdaily.org/krillocity](https://playdaily.org/krillocity)` (and shared Krillion game endpoints)  
**Scope:** Answer Bank Protection, Anti-Bot/Velocity Controls, Username/Session Integrity, and Scoring Validation  

## Executive Summary
* **Overall Risk Posture:** [Critical / High / Medium]
* **Top 3 Immediate Fixes (Highest Impact, Lowest Effort):**
  1. [e.g., Enforce server-side per-prompt answer rate limits & maximum score-per-turn caps]
  2. [e.g., Strip answer/tier metadata from client responses and lock down prompt enumeration]
  3. [e.g., Add username change cooldowns, sanitization, and session binding]

---

## Detailed Findings & Remediation Plan

### [FLAW-01] <Vulnerability & Answer Caps Missing Plausibility Submission Title, Unthrottled e.g.,>
* **Severity:** [Critical / High / Medium]
* **Category:** [e.g., OWASP API4:2023 Unrestricted Resource Consumption / Business Logic Flaw]
* **Affected Endpoint / Component:** [e.g., `POST /api/...` or WebSocket `submit_answer` event]
* **How the Cheat Works:** [Clear, non-weaponized explanation of how cheaters exploit this flaw to reach 3,000–25,000+ points in a single 30-second turn]
* **Root Cause:** [Why the current architecture permits it]
* **Recommended Fix (Step-by-Step):**
  * [Concrete server-side validation rule, algorithm, or middleware change]
  * [Recommended threshold values, e.g., minimum inter-submission delay, max answers per 30s turn, shadow-banning anomalous runs from leaderboards]

*(Repeat `[FLAW-XX]` block for every identified vulnerability across Answer Leakage, Infinite Username Changes, Anti-Bot/Attestation, Clock/Count-In Enforcement, and AI Judge Hardening)*

---

## Prioritized Implementation Roadmap for the Developer
| Priority | Flaw ID | Fix Summary | Estimated Effort | Impact on Cheating |
| :--- | :--- | :--- | :--- | :--- |
| **P0 (Hotfix)** | FLAW-01 | Server-side submission rate limiter & max plausible turn score cap | Low (~1–2 hours) | Blocks 3,000–25,000 pt bot runs immediately |
| **P0 (Hotfix)** | FLAW-02 | Username change cooldown + session lock + character sanitization | Low (~1 hour) | Stops infinite name cycling & impersonation |
| **P1 (Short-Term)** | FLAW-03 | Remove pre-round answer/tier data from client payloads & lock prompt IDs | Medium (~3–4 hours) | Stops API answer-database scraping |
| **P2 (Hardening)** | FLAW-04 | Add lightweight bot attestation (e.g., Turnstile) & AI judge input hardening | Medium (~4–6 hours) | Prevents headless browser farming & judge abuse |
```

Write the finished report to `findings/SECURITY-REMEDIATION-REPORT.md` (audit artifact — does not overwrite any collaborator-owned file).

---

## 5. Completion criteria

- All four audit phases (A–D) have at least one recorded concrete observation each; findings with no evidence are explicitly labelled `UNVERIFIED`/`hypothesis`.
- Zero rules-of-engagement violations: no automated flooding, no live leaderboard submissions, no DoS, no scraping, no captcha solving, no destructive controls.
- Every finding is mapped to a concrete server-side patch with effort estimate and anti-cheat impact.
- The report in §4 is produced verbatim in structure (Executive Summary, Detailed Findings `[FLAW-XX]`, Prioritized Roadmap table), written to `findings/SECURITY-REMEDIATION-REPORT.md`.
- Honest limitations section: live-verified vs bundle-inferred vs unverified; any endpoints that could not be observed are named.
- `git status` shows only the new report/artifact files added by this audit; no collaborator-owned or userscript files modified.
