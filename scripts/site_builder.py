#!/usr/bin/env python3
"""Build all sites from the single HTML source of truth: site-template.html.

Edit site-template.html to change layout, colour, type, motion, or shared JS.
The two published sites stay separate pages and data sets; the switcher swaps
views client-side and caches each dataset in memory after its first load.
"""
import html as html_lib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "site-template.html"


def examples_html(items: list[str]) -> str:
    buttons = "".join(
        f'\n    <button class="example" type="button" data-q="{q}">{q}</button>'
        for q in items
    )
    return (
        '<span class="examples-label">Try:</span>' + buttons +
        '\n    <button class="examples-dismiss" type="button" aria-label="Hide examples">Hide</button>'
    )


VIEWS = {
    "lookup": {
        "title": "Krillion Answer Search",
        "h1": '<h1><span class="rare-word">Krillion</span> Answer Search</h1>',
        "sub": "Type a question from the game to find an answer. "
               '<span id="count">—</span> questions ready.',
        "examples": ["Name any one famous park", "fictional bear"],
        "switchLabel": "See all 100-point answers",
        "storageKey": "krillion-all-examples:v1",
    },
    "vault": {
        "title": "Krillion — All 100-Point Answers",
        "h1": '<h1>One in a <span class="rare-word">Krillion</span> Answers</h1>',
        "sub": "All <span id=\"count\">—</span> 100-point answers to "
               '<span id="prompts">—</span> questions.',
        "examples": ["Name a famous park", "Name a Mario character"],
        "switchLabel": "Back to one-answer search",
        "storageKey": "krillion-rare-examples:v1",
    },
}


def render_page(*, title: str, mode: str, h1: str, sub: str, examples: list[str],
                loader: str = "", more: str = "", extra_css: str = "", extra_js: str = "",
                views: bool = False) -> str:
    html = TEMPLATE.read_text(encoding="utf-8")
    values = {
        "{{TITLE}}": title,
        "{{MODE}}": mode,
        "{{H1}}": h1,
        "{{SUB}}": sub,
        "{{EXAMPLES}}": examples_html(examples),
        "{{LOADER}}": loader,
        "{{MORE}}": more,
        "{{EXTRA_CSS}}": extra_css,
        "{{EXTRA_JS}}": extra_js,
        "{{VIEWS_JSON}}": html_lib.escape(json.dumps(VIEWS if views else None), quote=True),
        "{{SWITCH_LABEL}}": (
            VIEWS[mode]["switchLabel"] if views and mode in VIEWS else ""
        ),
    }
    for key, value in values.items():
        html = html.replace(key, value)
    return html


LOADER_HTML = """
<div id="loader" role="status" aria-live="polite">
  <div class="load-inner">
    <div class="spinner-wrap">
      <div class="spinner" id="spinner"></div>
      <div class="ready-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path pathLength="1" d="M5 13l4.5 4.5L19 7" /></svg>
      </div>
    </div>
    <div class="load-title" id="load-title">Loading answers…</div>
    <div class="bar"><div class="fill" id="fill"></div></div>
    <div class="load-status" id="load-status">Fetching answers…</div>
    <button class="retry" id="retry" type="button">Try again</button>
  </div>
</div>
"""

MORE_HTML = '<button class="more" id="more" type="button" hidden>Show more questions</button>'
