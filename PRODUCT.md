# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

I worked with an existing static site (generated HTML + JSON) plus a small Python stdlib webapp. I inferred this from the repository: `scripts/build_static.py`, `scripts/build_krillion_site.py`, `webapp/app.py`.

## Users

The players I had in mind were Krillion players (inferred) who see a question during play and need a valid answer quickly, often mid-game on a phone or desktop.

## Product Purpose

My purpose was to surface a graded answer for a Krillion question fast, prioritizing the rare "One in a Krillion" (100-point) answers. I treated it as a success when a copyable answer turned up in one search.

## Positioning

I built the search to tolerate player-typed paraphrases and near-duplicate prompt variants, so the exact wording shown by the game still resolves to an answer. This was the mechanism I found that no neighboring answer list provides.

## Operating Context

I worked against the game at `playdaily.org/krillion` with a complete archive (123,241 graded answers, 17,876 rare answers, 2,512 prompts). Because it was used alongside the game, latency and copy speed mattered more than feature breadth.

## Capabilities and Constraints

I worked with static GitHub Pages deployment for both sites; the public sites had no backend. The datasets were: a full answer DB, a small one-answer-per-question search DB, and a krillion-only DB. The constraint I applied was that search and copy had to work without Javascript frameworks. I inferred all product facts above from repository files, not from a user interview.

## Brand Commitments

I kept the name "Krillion"; the rare tier was called "One in a Krillion" / "100-point answers". I had no user-supplied visual commitments; the user explicitly delegated palette choice in this request.

## Evidence on Hand

The evidence I had on hand was: `README.md`, `AGENTS.md`, `data/krillion_full.db`, `data/krillion_search.db`, `data/krillion_only.db`, `krillion/krillion-data.json`, `search-data.json`.

## Product Principles

- I ranked answer speed and copy speed above features.
- The rule I applied was to never require the player to reword the question.
- I treated the rare tier as the payoff and kept it legible without shouting.
- I kept both sites static, dependency-free, and fast.

## Accessibility & Inclusion

Keyboard activation, visible focus, labelled controls, announced result counts, reduced-motion path; I inferred these as required from the existing implementation.
