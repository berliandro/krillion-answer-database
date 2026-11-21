#!/usr/bin/env python3
"""Build the "all krillion answers" site from site-template.html.

Data: data/krillion_only.db -> krillion/krillion-data.json (grouped by prompt).
Layout/palette/code: site-template.html (the single file to edit).
"""
import json
import sqlite3
from collections import defaultdict
from pathlib import Path

from site_builder import MORE_HTML, render_page

ROOT = Path(__file__).resolve().parent.parent
ONLY_DB = ROOT / "data" / "krillion_only.db"
OUT_DIR = ROOT / "krillion"
OUT_DATA = OUT_DIR / "krillion-data.json"
OUT_HTML = OUT_DIR / "index.html"

VAULT_CSS = r"""
  .results { display: grid; grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .group {
    min-width: 0;
    background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
    padding: 16px 18px 18px;
    box-shadow: 0 5px 18px oklch(0 0 0 / 0.16);
    content-visibility: auto; contain-intrinsic-size: auto 320px;
  }
  .group-q {
    color: var(--rare); font-size: var(--type-answer); font-weight: var(--weight-label);
    letter-spacing: .01em; line-height: 1.3; text-wrap: balance;
    margin: 0 0 12px; padding-bottom: 10px; border-bottom: 1px solid var(--line);
  }
  .answers { display: flex; flex-wrap: wrap; gap: 8px; align-items: stretch; }
  .answer-row {
    flex: 1 1 clamp(140px, var(--basis, 18ch), 100%);
    min-width: 0; max-width: 100%;
    display: flex; align-items: center; gap: 8px;
    padding: 8px 9px 8px 11px; border-radius: 9px;
    background: var(--surface); border: 1px solid var(--line);
    transition: background .12s ease, border-color .12s ease;
  }
  .answer-row:hover, .answer-row:focus-within { background: var(--surface-2); border-color: var(--line-strong); }
  .answer-row .a {
    flex: 1; min-width: 0; font-size: var(--type-answer); font-weight: var(--weight-answer);
    line-height: 1.35; overflow-wrap: anywhere; cursor: pointer; border-radius: 4px;
    transition: color .12s ease;
  }
  .answer-row .a:hover { color: var(--text-strong); }
  .answer-row .a:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
  .answer-row .copy-icon { width: 26px; height: 26px; opacity: .75; }
  .answer-row:hover .copy-icon, .answer-row .copy-icon:focus-visible,
  .answer-row.copied .copy-icon { opacity: 1; }
  .more {
    display: block; margin: 28px auto 0; padding: 11px 20px;
    background: var(--surface-2); color: var(--text); border: 1px solid var(--line-strong);
    border-radius: 10px; cursor: pointer; font-family: inherit;
    font-size: .85rem; font-weight: 600;
  }
  .more:hover { background: var(--surface-2-hover); }
  .more:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .skip {
    position: absolute; left: -9999px; top: 0; z-index: 10;
    padding: 8px 12px; background: var(--surface-2); color: var(--text);
    border: 1px solid var(--line-strong); border-radius: 8px;
  }
  .skip:focus { left: 20px; top: 12px; }
  @media (max-width: 560px) {
    .group { padding: 14px 14px 16px; }
    .answers { gap: 7px; }
    .answer-row { padding: 7px 8px 7px 10px; }
    .answer-row .a { font-size: var(--type-answer); }
  }
  @media (min-width: 768px) {
    .results { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (min-width: 1024px) {
    .wrap { max-width: 1080px; }
  }
"""

VAULT_JS = ""


with sqlite3.connect(ONLY_DB) as c:
    rows = c.execute("SELECT question, answer FROM answers ORDER BY question, answer").fetchall()

grouped = defaultdict(list)
for question, answer in rows:
    grouped[question].append(answer)
data = [{"q": q, "answers": answers} for q, answers in sorted(grouped.items())]

OUT_DIR.mkdir(exist_ok=True)
OUT_DATA.write_text(
    json.dumps(data, ensure_ascii=False, separators=(",", ":")),
    encoding="utf-8", newline="\n",
)

HTML = render_page(
    title="Krillion — All 100-Point Answers",
    mode="vault",
    h1='<h1>One in a <span class="rare-word">Krillion</span> Answers</h1>',
    sub=('All <span id="count">—</span> 100-point answers to '
         '<span id="prompts">—</span> questions.'),
    examples=["Name a famous park", "Name a Mario character"],
    more=MORE_HTML,
    extra_css=VAULT_CSS,
    views=True,
)
OUT_HTML.write_text(HTML, encoding="utf-8", newline="\n")
print(
    f"wrote {OUT_HTML.relative_to(ROOT)} + {OUT_DATA.relative_to(ROOT)}: "
    f"{len(data)} prompts, {len(rows)} krillion answers, {OUT_DATA.stat().st_size} bytes of data"
)
