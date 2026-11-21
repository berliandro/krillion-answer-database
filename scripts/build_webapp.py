#!/usr/bin/env python3
"""Build the local webapp UI from site-template.html.

The local server keeps its own API route; only the page shell is shared.
Run: python scripts/build_webapp.py
"""
from pathlib import Path

from site_builder import render_page

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "webapp" / "index.html"

LOCAL_JS = r"""
let seq = 0, timer = null;
function renderLocal(items, q) {
  if (!items.length) {
    $('meta').textContent = 'No results';
    results.innerHTML = '<div class="empty" role="status">No answer found. Try a shorter phrase — even one distinctive word will do.</div>';
    return;
  }
  $('meta').textContent = items.length + ' result' + (items.length === 1 ? '' : 's');
  if (matchedByMeaning(q, items.map(i => ({ it: { norm: String(i.question).toLowerCase(), q: i.question } })))) {
    $('meta').insertAdjacentHTML('beforeend', ' <span class="match-note">matched by meaning</span>');
  }
  results.innerHTML = items.map(it => `
    <div class="card" data-answer="${escape(it.answer)}">
      <div><div class="q">${escape(it.question)}</div><div class="a" role="button" tabindex="0" title="Tap to copy">${escape(it.answer)}</div></div>
      <button class="copy-icon" type="button" aria-label="Copy answer" title="Copy answer">${COPY_SVG}</button>
    </div>`).join('');
  bindCopy(results);
}
async function run(q) {
  const mine = ++seq;
  $('meta').textContent = 'Searching…';
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    const data = await res.json();
    if (mine !== seq) return;
    renderLocal(data.results, q);
  } catch (e) {
    if (mine === seq) {
      $('meta').textContent = 'Search unavailable';
      results.innerHTML = '<div class="empty" role="alert">Search unavailable. Check your connection, then try again.' +
        '<br><button class="copy" id="retry-search" type="button">Try again</button></div>';
      $('retry-search').addEventListener('click', () => run(q));
    }
  }
}
async function initLocal() {
  initExamples(input, 'krillion-local-examples:v1');
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { results.innerHTML = ''; $('meta').textContent = ''; return; }
    timer = setTimeout(() => run(q), 120);
  });
}
"""

HTML = render_page(
    title="Krillion Answer Search",
    mode="local",
    h1="<h1>Krillion Answer Search</h1>",
    sub="<p class=\"sub\">Type a question from the game to find an answer.</p>",
    examples=["Name any one famous park", "fictional bear"],
    extra_js=LOCAL_JS,
)
OUT.write_text(HTML, encoding="utf-8", newline="\n")
print(f"wrote {OUT.relative_to(ROOT)} from site-template.html")
