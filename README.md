# Krillion Answer Database

> Every graded Krillion answer, searchable instantly — including the rare 100-point ones.

[![status](https://img.shields.io/badge/status-complete-green)](#final-tally)
[![demo](https://img.shields.io/badge/demo-live-blue)](https://berliandro.github.io/krillion-answer-database/)

This repo collects every graded answer from [Krillion Unlimited](https://playdaily.org/krillion) so you can find one while you play. Answers fall into six tiers, from Plankton (10 points) up to **One in a Krillion** (100 points); only the top tier carries the `is_krillion: true` flag.

It began as a way to help a friend chase a high score. The scrape ran until the prompt bank was exhausted, leaving a complete answer archive with a small, fast search index on top. This is an unofficial project and is not affiliated with Daily Games.

![Animated pixel-art underwater ruin with a drifting diver statue and seaweed](assets/krillion-underwater.gif)

---

## Quick start

The [public search](https://berliandro.github.io/krillion-answer-database/) works in any browser with no setup. To run a local copy:

```powershell
python scripts/krillion_db.py init
python scripts/krillion_db.py import
python webapp/app.py
# open http://127.0.0.1:8765
```

During `import`, the tool also reads `injection/data/corrections.jsonl`, an append-only list of demotions from the gameplay bridge. Any `(question, answer)` pair listed there gets `is_krillion = 0` before the indexes are rebuilt, so a demoted answer disappears from the rare-answers site. The injection bridge only reads the rare-answers database and never writes to it.

Search from the command line with `python scripts/krillion_db.py search "fictional bear"`. Rebuild the Search DB with `python scripts/krillion_db.py rebuild`. To build the krillion-only database and its second website:

```powershell
python scripts/krillion_db.py krillion-only
python scripts/build_krillion_site.py
```

The public site is fully static: `index.html` loads `search-data.json` and searches in the browser. To refresh the snapshot after importing answers:

```powershell
python scripts/build_static.py
python scripts/build_krillion_site.py
python scripts/build_webapp.py
git add site-template.html index.html search-data.json krillion/index.html krillion/krillion-data.json webapp/index.html
git commit -m "Refresh static search index"
git push
```

GitHub Pages rebuilds from `main` within about a minute. The snapshot is about 358 KB raw (~93 KB gzipped) at 6,142 questions.

---

## How the data is organized

| Store | Contains | Purpose |
| --- | --- | --- |
| Full DB | Every answer to every prompt, with tier and source | Source of truth |
| Search DB | One answer per question | What the all-answers site reads |
| Krillion-only DB | Only the 21,384 One-in-a-Krillion answers | Source for the second site |

The Search DB keeps the "One in a Krillion" answer when one exists; otherwise it keeps the shortest answer. It is rebuilt from the Full DB after every import.

## One template, three sites

`site-template.html` is the single source of truth for layout, palette, typography, motion, matte finish, responsive rules, and the shared search/copy/onboarding code. All three built pages differ only by a small config and a page-specific CSS string in the builder scripts:

| Built page | Site | Builder | Mode |
| --- | --- | --- | --- |
| `index.html` | all-answers search (one answer per question) | `scripts/build_static.py` | `lookup` |
| `krillion/index.html` | all One-in-a-Krillion answers, grouped by prompt | `scripts/build_krillion_site.py` | `vault` |
| `webapp/index.html` | local webapp shell (uses `/api/search`) | `scripts/build_webapp.py` | `local` |

Edit the template, then run all three builders. The two public sites stay separate pages with separate data files; they share only the design and code from this one HTML file. Page-specific CSS lives in a small `VAULT_CSS` string in its builder.

The switch button on both public pages swaps between the two datasets without a page load: each dataset is fetched once and cached in memory, the URL changes with `history.pushState`, and Back/Forward works without a reload. Revisiting a view renders from cache with no network request.

## Search that handles paraphrases

Krillion's bank treats near-duplicate prompts as separate games — `Name a Mario character` and `Name a character from Mario` are both stored — and players often type a different wording than the bank (`Name any one famous park` versus the stored `Name a famous park`). The old search matched literal substrings, so those inputs could return nothing or the wrong answer; the site's own placeholder was one such failing query. Because the game shows its prompt text verbatim, the fix belongs in the search layer.

Search now compares *meaning-bearing tokens* rather than raw characters, without asking the player to reword anything:

- The same normalisation on both sides (case, punctuation, contractions, hyphenation, curly quotes);
- A small question-language synonym map (`give/list/state → name`, `movie → film`, `well-known → famous`, …) and a domain stop-word list (`a`, `any`, `one`, `of`, …);
- IDF-weighted token overlap, so rare words (`park`) count and boilerplate (`name`) does not;
- Character-trigram Dice for typos, quote-aware matching for `Name a word that can follow "star"`, and a negation guard for `with` versus `without`;
- A relative cut-off that shows the best match and true aliases, not loosely related questions.

The static site (`scripts/build_static.py` → `index.html`) and the local webapp (`webapp/app.py`) use the same algorithm. `scripts/paraphrase_match.py` is the dependency-free reference implementation and evaluation harness:

```powershell
python scripts/paraphrase_match.py
```

On `data/paraphrase_tests.json` (36 paraphrases and hard negatives), the old literal scorer gets 26/36 top-1 hits and the new matcher gets 36/36. Verified in Chrome: typing `Name any one famous park` now returns the single result `Name a famous park → Tsavo`.

## Two search sites

| Site | Source | Contents |
| --- | --- | --- |
| `/` ([public search](https://berliandro.github.io/krillion-answer-database/)) | Search DB (one answer per question) | fast answer lookup while playing |
| `/krillion/` (built by `build_krillion_site.py`) | Krillion-only DB | all 21,384 One-in-a-Krillion answers, grouped by prompt (5,801 groups), browsable and searchable |

Answers wrap to their content: short answers stay dense, long ones get room, and the column count follows the viewport. On the krillion site, every answer to a prompt stays in one group.

Both sites share one design: a matte graphite palette with fine paper grain, semantic OKLCH tokens with hex fallbacks (`DESIGN.md`), one brass accent for focus, rare answers, and actions, and a muted sage for copy success. Type is one family on a fixed scale — 30.4px/650 display, 16.96px input, 16px/600 answers, 16px/650 prompt headings, 12.8px metadata with tabular numerals — with `text-wrap: balance` and `text-wrap: pretty`, plus controls that inherit the family. Copy uses the same vocabulary on both sites ("question", "100-point answers"); empty and error states name the problem and next step.

- **Motion and feedback**: the one authored moment is copying — a short icon pulse and text-to-green sweep, a "Copied" state that updates the button's accessible name, and a green answer with a checkmark. Newly appended prompt groups stagger, capped at 108 ms; `prefers-reduced-motion` drops the spatial movement but keeps the color feedback. A paraphrase match adds a quiet "matched by meaning" note — no sound, celebration, or delay. Copy works by tapping the answer text or clicking the SVG icon, with a hidden-textarea fallback where the Clipboard API is unavailable; it also works in the local webapp at `http://127.0.0.1:8765`.

- **Robustness**: inputs capped at 200 characters and exposed as labelled search fields; CJK, RTL, and emoji-only queries fall back to literal substring matching; answer text uses `unicode-bidi: plaintext` and breaks unbroken strings without overflowing. Result counts and empty/error states are announced politely, every fetch failure offers "Try again", colors have hex fallbacks behind `@supports (color: oklch(...))`, and the rare-answers site has a keyboard skip link.

- **First use**: a dismissible "Try:" row offers two real example searches that run on tap and hide after the first search; it is remembered per site in `localStorage`, so returning users never see it again. No tour.

- **Performance**: an inverted index cut measured search time from 2.74 ms to 0.14 ms per query. The loader no longer holds the page behind a 620 ms timer (input unlocks about 22 ms before the overlay clears). The rare site renders 40 prompt groups instead of 60 — 1,892 DOM nodes instead of 2,894 — with offscreen groups marked `content-visibility: auto`. Both keep the same 36/36 paraphrase accuracy and copy behavior.

- **Responsive**: `minmax(0, 1fr)` grid tracks keep long answers from widening the page (no overflow at 320 px); coarse-pointer targets are at least 44 px and safe-area insets are reserved; the rare-answers list uses two reading columns from 768 px and a wider container from 1024 px. Verified at 320, 390, 768, 1024, 1200, and 1440 px with touch emulation in Chromium, with no horizontal overflow and no console errors.

## Edge autofill (PC only)

On PC, a Tampermonkey userscript plus a small loopback helper (`injection/bridge.py`, port 8768) shows every known 100-point answer for the current prompt. It has an auto-fill toggle and a bot with Pick and Mode dropdowns. It records what it sees as evidence but never demotes an answer from gameplay scores — only the game's own graded bank is authoritative — and logs uncertain or rejected answers (with the game's refusal text) for later review. Every log event is tagged with the game and input state it happened in; the full state inventory and per-state log/no-log decisions are in `injection/STATES.md`. Play scores from multiplayer/1v1 never enter the archive — the shared board shows other players' points. Setup and details are in `injection/README.md`.

## How we collected the data

The answers are not in the page HTML. We found the game's own JSON API in its Next.js bundles and harvested it from Chrome:

1. Dealt prompts through `POST /api/krillion/deal` (seven prompts and one ticket per call, unthrottled), then fetched each graded bank with `GET /api/krillion/answers`.

2. Worked around the rate limit: HTTP 425 returns a `wait` value for a shared ~65-second window. Probing one prompt, sleeping `wait + 2s`, then fetching all seven in a burst yields about 350 answers per cycle — roughly six times faster than pacing requests.

3. Round-tripped the `lap` token on every deal so the server would not re-deal the same lap and pile up duplicates.

4. Appended every answer to JSONL files. Import removes duplicates by `(question, answer)` and rebuilds the Search DB.

`POST /api/krillion/answer` grades a single guess; it was not used for bulk harvesting.

---

## Tools used

| Tool | Role |
| --- | --- |
| OpenCode (Hy4 Flash Free) | The only AI assistant used. Built the databases, import pipeline, harvesters, webapp, and this repo. |
| In-app browser and `browse` MCP | Inspected the game, its network requests, and its JS bundles in real Chrome. |
| Node.js | Harvesters using plain `fetch`, with no cookies or headers. |
| Python 3 and SQLite (FTS5) | Schema, import, de-duplication, and full-text search. |
| GitHub Pages | Hosts the static search site. |

## Repository layout

```text
data/       raw JSONL, Full DB, Search DB, Krillion-only DB, notes
assets/     animated banner, static frame, final stats chart
scripts/    harvesters, krillion_db.py, site_builder.py, build_static.py, build_krillion_site.py, build_webapp.py
webapp/     local search server and UI
injection/  PC-only autofill userscript + loopback bridge; README.md, DECISIONS.md, STATES.md, PROCESS-LOG.md, data/ logs
site-template.html   the one HTML file to edit (palette, layout, shared code)
index.html, search-data.json   static all-answers Pages site
krillion/   second static site: every 100-point answer, krillion-only database snapshot
jobs.md, AGENTS.md             job tracker and project rules
```

---

## Final tally

| Metric | Count after the harvest | Count after the 24-hour play session |
| --- | ---: | ---: |
| Graded answers | 123,241 | **127,118** |
| One in a Krillion answers | 17,876 | **21,384** |
| Distinct prompts | 2,512 | **6,142** |
| Duplicate answer pairs | 0 | **0** |

The harvest ended on 21 Nov 2026 when the game stopped dealing new prompts. A later 24-hour automated play session captured 3,877 more answers through the injection bridge, including prompts the harvest had not reached. Some of those banks are partial (a few answers per prompt), but every row is an answer the game itself accepted. The databases and all three static sites were rebuilt after the session. Both the [public search](https://berliandro.github.io/krillion-answer-database/) and the local webapp remain live.

The dive is over. The answers remain.

## Credits

Animated pixel art: [Underwater Fantasy Pixel Art Environment](https://ansimuz.itch.io/underwater-fantasy-pixel-art-environment) by ansimuz, CC BY 4.0. A [static frame](assets/krillion-underwater.png) is provided for renderers that don't animate GIFs.
