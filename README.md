# Krillion answer archive — notes from an experiment

> I probed a trivia game's public endpoints, pulled its graded answer banks, and built a handful of small tools to see where the matching and scoring actually break. This is a record of that experiment, not an invitation to use anything.

[![status](https://img.shields.io/badge/status-complete-green)](#final-tally)
[![demo](https://img.shields.io/badge/demo-live-blue)](https://berliandro.github.io/krillion-answer-database/)

This repo is what was left after I took apart [Krillion Unlimited](https://playdaily.org/krillion). Its prompts each carry a bank of graded answers across six tiers, from Plankton (10 points) up to **One in a Krillion** (100 points); only the top tier gets the `is_krillion: true` flag. I started because a friend was chasing a high score, then kept going because the game turned out to expose far more than its UI shows. It is an unofficial experiment and is not affiliated with Daily Games.

![Animated pixel-art underwater ruin with a drifting diver statue and seaweed](assets/krillion-underwater.gif)

---

## What I was actually testing

Two questions drove this:

1. **Can the graded banks be read directly?** The answers are not in the page HTML. I found the game's own JSON API in its Next.js bundles and checked it from real Chrome.
2. **Can a search handle the way people actually type?** Krillion renders its prompt text verbatim, so a literal substring search fails on ordinary paraphrases — the site's own example query, `Name any one famous park`, returned nothing against the stored `Name a famous park`.

The archive is the evidence for the first question. The matcher and the three generated pages are what I built to answer the second. The autofill tooling came later, as a way to watch real play and see which answers the game accepts or refuses.

## How the bank came apart

The short version of the endpoint work:

1. `POST /api/krillion/deal` deals seven prompts and one ticket per prompt, unthrottled.
2. `GET /api/krillion/answers?prompt=&ticket=` returns the graded bank, all six tiers included.
3. The limiter is a shared ~65-second window. HTTP 425 returns a `wait` value. Probing one prompt, sleeping `wait + 2s`, then fetching all seven in a burst yielded about 350 answers per cycle — roughly six times faster than pacing requests.
4. The `lap` token has to be round-tripped on every deal; without it the server re-deals the same lap and duplicates pile up.
5. `POST /api/krillion/answer` grades a single guess. I used it to check behaviour, not for bulk harvesting.

Everything went to append-only JSONL files; the importer de-duplicates by `(question, answer)` and rebuilds the derived databases. The security consequences of these exposed paths are written up in [`findings/README.md`](findings/README.md).

## The data model I settled on

I kept two tiers deliberately separate, because completeness and speed pull in opposite directions:

| Store | Contains | Why I kept it |
| --- | --- | --- |
| Full DB | Every answer to every prompt, with tier and source | The source of truth; optimized for completeness |
| Search DB | One answer per question | What the small search site reads |
| Krillion-only DB | Only the One-in-a-Krillion answers | Source for the second, rare-answers site |

The Search DB keeps the rare answer when one exists, otherwise the shortest answer, and is rebuilt from the Full DB after each import. During import the tool also reads `injection/data/corrections.jsonl`, an append-only list of demotions gathered from the bridge. A `(question, answer)` pair listed there gets `is_krillion = 0` before the indexes are rebuilt, so it disappears from the rare-answers site. The bridge itself only reads the rare-answers database; it never writes to it. Play scores never demote an answer — the game's AI grading is inconsistent, so only its own dive-end graded bank is authoritative.

## Three pages from one template

`site-template.html` became the single source of truth for layout, palette, typography, motion, matte finish, responsive rules, and the shared search/copy code. The generated pages differ only by a small config and a page-specific CSS string:

| Generated page | What it shows | Builder | Mode |
| --- | --- | --- | --- |
| `index.html` | all answers, one per question | `scripts/build_static.py` | `lookup` |
| `krillion/index.html` | every One-in-a-Krillion answer, grouped by prompt (5,801 groups) | `scripts/build_krillion_site.py` | `vault` |
| `webapp/index.html` | local webapp shell (uses `/api/search`) | `scripts/build_webapp.py` | `local` |

Both public sites are fully static: the page loads a JSON snapshot and searches in the browser. The switch button swaps between the two datasets without a page load — each is fetched once and cached in memory, the URL changes with `history.pushState`, and Back/Forward works without a reload. Page-specific CSS lives in a small `VAULT_CSS` string in its builder.

## The paraphrase problem and what I did about it

Krillion treats near-duplicate prompts as separate games — `Name a Mario character` and `Name a character from Mario` are both stored with their own banks — and players type variants the bank never contains. My first search matched literal substrings, so those inputs returned nothing or the wrong bank; the site's own placeholder was one such failing query. Because the game shows its prompt text verbatim, the fix had to live in the search layer rather than in the data.

The matcher I wrote compares *meaning-bearing tokens* rather than raw characters, with no rewording by hand:

- the same normalisation on both sides (case, punctuation, contractions, hyphenation, curly quotes);
- a small question-language synonym map (`give/list/state → name`, `movie → film`, `well-known → famous`, …) and a domain stop-word list (`a`, `any`, `one`, `of`, …);
- IDF-weighted token overlap, so rare words (`park`) count and boilerplate (`name`) does not;
- character-trigram Dice for typos, quote-aware matching for `Name a word that can follow "star"`, and a negation guard for `with` versus `without`;
- a relative cut-off that keeps the best match and true aliases, not loosely related questions.

`scripts/paraphrase_match.py` is the dependency-free reference implementation and evaluation harness:

```powershell
python scripts/paraphrase_match.py
```

On `data/paraphrase_tests.json` (36 paraphrases and hard negatives), the old literal scorer got 26/36 top-1 hits and the new matcher got 36/36. I confirmed in Chrome that `Name any one famous park` resolves to the single result `Name a famous park → Tsavo`. The full investigation, including the options I rejected, is in [`docs/PARAPHRASE-SOLUTION.md`](docs/PARAPHRASE-SOLUTION.md).

## The autofill experiment (PC only)

On PC I wired a Tampermonkey userscript to a small loopback helper (`injection/bridge.py`, port 8768). The script shows every known 100-point answer for the current prompt, fills one on click, and has an auto-submit toggle plus a bot with Pick and Mode dropdowns. It watches what the game does and records it, but it does not let a play score demote an answer; uncertain and refused answers are logged with the game's own refusal text for later review. Each log event is tagged with the game and input state it occurred in; the state inventory and per-state log/no-log decisions are in `injection/STATES.md`. Multiplayer and 1v1 scores never enter the archive because the shared board shows other players' points.

Two things I was careful about:

- Near-duplicate prompts stay as separate labelled banks; aliases and rewordings are logged, never merged into matching.
- Other players' answers were quarantined in `injection/data/other_users_quarantine.jsonl` and never imported.

The userscript self-updates from GitHub via `@updateURL`/`@downloadURL`; its header and panel footer carry the author credit and repo link. Setup notes, the policy decisions, and the log-processing workflow are in [`injection/README.md`](injection/README.md), `injection/DECISIONS.md`, and `injection/PROCESS-LOG.md`. By **berliandro** — <https://github.com/berliandro/krillion-answer-database>.

## What I measured while polishing

These are observations from the experiment, not requirements:

- **Search quality:** 36/36 on the paraphrase set with the new matcher; an inverted index cut measured search time from 2.74 ms to 0.14 ms per query. I verified the result in both the static site and the local webapp.
- **Loading:** the loader no longer holds the page behind a 620 ms timer; input unlocks about 22 ms before the overlay clears.
- **Rendering:** the rare-answers site renders 40 prompt groups instead of 60 — 1,892 DOM nodes instead of 2,894 — with offscreen groups marked `content-visibility: auto`.
- **Responsive:** `minmax(0, 1fr)` grid tracks keep long answers from widening the page. I checked 320, 390, 768, 1024, 1200, and 1440 px with touch emulation in Chromium; no horizontal overflow and no console errors.
- **Motion and feedback:** the one authored moment is copying — a short icon pulse and text-to-green sweep, a "Copied" state that updates the button's accessible name, and a green answer with a checkmark. `prefers-reduced-motion` drops the spatial movement but keeps the color feedback. A paraphrase match adds a quiet "matched by meaning" note.
- **Robustness:** inputs are capped at 200 characters and exposed as labelled search fields; CJK, RTL, and emoji-only queries fall back to literal substring matching; answer text uses `unicode-bidi: plaintext` and breaks unbroken strings without overflowing. Result counts and empty/error states are announced politely, every fetch failure offers "Try again", colors have hex fallbacks behind `@supports (color: oklch(...))`, and the rare-answers site has a keyboard skip link.
- **Shared design:** a matte graphite palette with fine paper grain, semantic OKLCH tokens with hex fallbacks (`DESIGN.md`), one brass accent for focus, rare answers, and actions, and a muted sage for copy success. Copy uses the same vocabulary on both sites; empty and error states name the problem and next step. The first-use "Try:" row is dismissible and remembered per site in `localStorage`.

## Tools I used for this

| Tool | What I used it for |
| --- | --- |
| OpenCode (Hy4 Flash Free) | The only AI assistant in the loop; it built the databases, import pipeline, harvesters, webapp, and this repo. |
| In-app browser and `browse` MCP | Reading the game, its network requests, and its JS bundles in real Chrome. |
| Node.js | Harvesters using plain `fetch`, with no cookies or headers. |
| Python 3 and SQLite (FTS5) | Schema, import, de-duplication, and full-text search. |
| GitHub Pages | Hosting the static snapshot. |

## Checks I ran

`python tests/run_all.py` runs the dependency-free suite I wrote (matcher parity, persisted-index parity, build invariants, isolated bridge endpoints, userscript static checks, site JS syntax, and policy/demotion guards) and exits non-zero on any failure. No extra packages needed. The coverage of each check is described in [`tests/README.md`](tests/README.md).

## Commands from the build

The databases are generated, not committed. These are the commands I used; `python scripts/build.py all` is the single reproducible pipeline.

```powershell
python scripts/bootstrap.py --apply   # builds any missing/derived DBs, manifest, index, snapshots
python webapp/app.py
# http://127.0.0.1:8765
```

`python scripts/bootstrap.py --check` reports OK / MISSING / STALE without writing anything. The underlying `init`, `import`, `rebuild`, and `krillion-only` commands still work individually. I searched the CLI with `python scripts/krillion_db.py search "fictional bear"` and rebuilt the derived index with `python scripts/krillion_db.py rebuild`.

To generate the rare-answers database and its second site:

```powershell
python scripts/krillion_db.py krillion-only
python scripts/build_krillion_site.py
```

After an import, refreshing the static snapshots was a matter of running the three builders and committing the outputs:

```powershell
python scripts/build_static.py
python scripts/build_krillion_site.py
python scripts/build_webapp.py
git add site-template.html index.html search-data.json krillion/index.html krillion/krillion-data.json webapp/index.html
git commit -m "Refresh static search index"
git push
```

GitHub Pages rebuilt from `main` within about a minute. The snapshot is about 358 KB raw (~93 KB gzipped) at 6,142 questions.

## Repository layout

```text
data/       raw JSONL, Full DB, Search DB, Krillion-only DB, manifest.json, matcher index, notes
assets/     animated banner, static frame, final stats chart
scripts/    build.py + config/ingest/derive/emit/verify/publish, bootstrap.py, krillion_db.py,
            build_static.py, build_krillion_site.py, build_webapp.py, paraphrase_match.py, harvesters
shared/     norm.generated.js — generated normaliser shared by the sites
tests/      dependency-free regression suite (run_all.py + test_*.py)
webapp/     local search server and UI
injection/  PC-only autofill userscript + loopback bridge; README.md, DECISIONS.md, STATES.md,
            PERF.md, PROCESS-LOG.md, RESTRUCTURE-CONTRACT.md, data/ logs
site-template.html   the one HTML file I edited (palette, layout, shared code)
index.html, search-data.json   static all-answer Pages site
krillion/   second static site: every 100-point answer, krillion-only database snapshot
jobs.md, AGENTS.md             job tracker and project rules
```

I kept folder names lowercase with hyphens for multi-word names. Generated code went in `scripts/` or `webapp/`, raw data and databases in `data/`, tests in `tests/`, and notes in `docs/`. Strategy run results live in `docs/evidence/`, audit findings in `findings/`, and working docs in `active-goals/`. Site outputs (`index.html`, `krillion/`, `webapp/index.html`) and their JSON snapshots stay at the root because the pages fetch them by name: they are build artifacts, not hand-edited sources.

## Final tally

| Metric | Count after the harvest | Count after the 24-hour play session |
| --- | ---: | ---: |
| Graded answers | 123,241 | **127,118** |
| One in a Krillion answers | 17,876 | **21,384** |
| Distinct prompts | 2,512 | **6,142** |
| Duplicate answer pairs | 0 | **0** |

The harvest ended on 21 Nov 2026 when the game stopped dealing new prompts. A later 24-hour automated play session captured 3,877 more answers through the injection bridge, including prompts the harvest had not reached. Some of those banks are partial (a few answers per prompt), but every row is an answer the game itself accepted. The databases and all three static sites were rebuilt afterwards; both the [public search](https://berliandro.github.io/krillion-answer-database/) and the local webapp are still live.

That is the experiment in one line: I read what the game exposed, kept the parts that were reproducible, and used the leftovers to look for flaws in its matching and scoring.

## Credits

Animated pixel art: [Underwater Fantasy Pixel Art Environment](https://ansimuz.itch.io/underwater-fantasy-pixel-art-environment) by ansimuz, CC BY 4.0. A [static frame](assets/krillion-underwater.png) is provided for renderers that don't animate GIFs.
