#!/usr/bin/env python3
"""Build a fully static, shareable search page for GitHub Pages.

Reads the small FTS search DB and emits:
  index.html       - single self-contained UI
  search-data.json - compact Q&A array, fetched with a real progress bar

Run: python scripts/build_static.py
"""
import json
import sqlite3
from pathlib import Path

from site_builder import LOADER_HTML, render_page


ROOT = Path(__file__).resolve().parent.parent
SEARCH_DB = ROOT / "data" / "krillion_search.db"
OUT_HTML = ROOT / "index.html"
OUT_DATA = ROOT / "search-data.json"

with sqlite3.connect(SEARCH_DB) as c:
    rows = c.execute("SELECT question, answer FROM search_answers ORDER BY question").fetchall()

data = [{"q": q, "a": a} for q, a in rows]
payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
OUT_DATA.write_text(payload, encoding="utf-8", newline="\n")

HTML = render_page(
    title="Krillion Answer Search",
    mode="lookup",
    h1='<h1><span class="rare-word">Krillion</span> Answer Search</h1>',
    sub=('Type a question from the game to find an answer. '
         '<span id="count">—</span> questions ready.'),
    examples=["Name any one famous park", "fictional bear"],
    loader=LOADER_HTML,
    views=True,
)

OUT_HTML.write_text(HTML, encoding="utf-8", newline="\n")
print(
    f"wrote {OUT_HTML.name} + {OUT_DATA.name}: "
    f"{len(data)} questions, {OUT_DATA.stat().st_size} bytes of data"
)
