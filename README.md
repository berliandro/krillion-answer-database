# Krillion Answer Database

Scrape every question/answer from https://playdaily.org/krillion and make answers instantly searchable.

## Layout
- `data/answers.jsonl` — raw scraped answers, one JSON object per line. Source of truth (committed).
- `data/krillion_full.db` — full DB, all answers (generated, gitignored).
- `data/krillion_search.db` — small FTS5 search DB, one answer per question (generated, gitignored).
- `scripts/krillion_db.py` — `init` / `import` / `rebuild` / `search` / `stats`.
- `webapp/app.py` — local search webapp; `webapp/index.html` — UI.
- `jobs.md` — orchestration job tracker.

## Answer record format
```json
{"question": "...", "answer": "...", "is_krillion": true, "source_url": "..."}
```
`is_krillion` is true only for the 100+ point "one in a krillion" answer.

## Run
```powershell
python scripts/krillion_db.py init
python scripts/krillion_db.py import
python webapp/app.py
# open http://127.0.0.1:8765
```

The webapp searches only the small Search DB. Rebuild it any time with `python scripts/krillion_db.py rebuild`.

## Public shareable site (GitHub Pages)
https://berliandro.github.io/krillion-answer-database/

This is a fully static page — `index.html` fetches `search-data.json` on load with a streaming progress bar and loading animation, then searches entirely client-side. No server needed. It is a **snapshot**, so regenerate it after importing new answers:

```powershell
python scripts/build_static.py
git add index.html search-data.json
git commit -m "Refresh static search index"
git push
```

At ~3,000 questions the search data is only ~155 KB (~52 KB gzipped), which is fine on a phone.

GitHub Pages rebuilds automatically from `main` (usually within ~1 minute). The local webapp at http://127.0.0.1:8765 always reads the live DB and needs no rebuild.
