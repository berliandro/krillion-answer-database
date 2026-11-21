# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing static site (generated HTML + JSON) plus a small Python stdlib webapp. Inferred from repository: `scripts/build_static.py`, `scripts/build_krillion_site.py`, `webapp/app.py`.

## Users

Krillion players (inferred) who see a question during play and need a valid answer quickly, often mid-game on a phone or desktop.

## Product Purpose

Surface a graded answer for a Krillion question fast, prioritizing the rare "One in a Krillion" (100-point) answers. Success is finding a copyable answer in one search.

## Positioning

The search tolerates user-typed paraphrases and near-duplicate prompt variants, so the exact wording shown by the game still resolves to an answer. This is the mechanism no neighboring answer list provides.

## Operating Context

Play happens in Krillion at `playdaily.org/krillion`; the archive is complete (123,241 graded answers, 17,876 rare answers, 2,512 prompts). Used alongside the game, so latency and copy speed matter more than feature breadth.

## Capabilities and Constraints

Static GitHub Pages deployment for both sites; no backend for the public sites. Two datasets: a full answer DB, a small one-answer-per-question search DB, and a krillion-only DB. Search and copy must work without Javascript frameworks. All product facts above are inferred from repository files, not from a user interview.

## Brand Commitments

Name "Krillion"; the rare tier is called "One in a Krillion" / "100-point answers". No user-supplied visual commitments; the user explicitly delegated palette choice in this request.

## Evidence on Hand

`README.md`, `AGENTS.md`, `data/krillion_full.db`, `data/krillion_search.db`, `data/krillion_only.db`, `krillion/krillion-data.json`, `search-data.json`.

## Product Principles

- Answer speed and copy speed outrank features.
- Never require the player to reword the question.
- The rare tier is the payoff; keep it legible without shouting.
- Both sites stay static, dependency-free, and fast.

## Accessibility & Inclusion

Keyboard activation, visible focus, labelled controls, announced result counts, reduced-motion path; inferred as required from existing implementation.
