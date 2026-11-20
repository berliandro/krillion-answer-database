#!/usr/bin/env python3
"""Build a fully static, shareable search page for GitHub Pages.

Reads the small FTS search DB and emits a single self-contained index.html
with all Q&A embedded as JSON and client-side search. No server needed.

Run: python scripts/build_static.py
"""
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEARCH_DB = ROOT / "data" / "krillion_search.db"
OUT = ROOT / "index.html"

with sqlite3.connect(SEARCH_DB) as c:
    rows = c.execute("SELECT question, answer FROM search_answers ORDER BY question").fetchall()

data = [{"q": q, "a": a} for q, a in rows]
payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
# Prevent the embedded JSON from closing the script tag.
payload = payload.replace("</", "<\\/")

HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Krillion Answer Search</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; background: #0b0f1a; color: #e8ecf5;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 10vh 20px 60px; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; letter-spacing: -.02em; }
  .sub { color: #8b95ab; margin: 0 0 24px; font-size: .9rem; }
  input {
    width: 100%; padding: 16px 18px; font-size: 1.1rem; color: #e8ecf5;
    background: #151b2b; border: 1px solid #2a3350; border-radius: 12px;
    outline: none; transition: border-color .15s, box-shadow .15s;
  }
  input:focus { border-color: #5b7cfa; box-shadow: 0 0 0 3px #5b7cfa22; }
  .meta { color: #8b95ab; font-size: .82rem; margin: 14px 2px 10px; }
  .results { display: grid; gap: 10px; }
  .card {
    background: #151b2b; border: 1px solid #2a3350; border-radius: 12px;
    padding: 14px 16px; display: flex; gap: 14px; align-items: flex-start;
  }
  .card .q { color: #9fb0d8; font-size: .82rem; margin-bottom: 4px; }
  .card .a { font-size: 1.05rem; font-weight: 600; }
  .copy {
    margin-left: auto; flex: none; background: #222b45; color: #cdd7f0;
    border: 1px solid #36426a; border-radius: 8px; padding: 6px 11px;
    cursor: pointer; font-size: .8rem;
  }
  .copy:hover { background: #2d3859; }
  .empty { color: #8b95ab; text-align: center; padding: 40px 0; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Krillion Answer Search</h1>
  <p class="sub">Type a question and get the answer instantly. __COUNT__ questions indexed.</p>
  <input id="q" type="search" autocomplete="off" autofocus placeholder="Name any one famous park">
  <div class="meta" id="meta"></div>
  <div class="results" id="results"></div>
</div>
<script>
const DATA = __PAYLOAD__;
const input = document.getElementById('q');
const results = document.getElementById('results');
const meta = document.getElementById('meta');

function escape(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function score(item, q) {
  const question = item.q.toLowerCase();
  const answer = item.a.toLowerCase();
  if (question === q) return 100;
  if (question.startsWith(q)) return 80;
  const words = q.split(/\\s+/).filter(Boolean);
  if (words.every(w => question.includes(w))) return 60;
  if (question.includes(q)) return 50;
  if (words.every(w => answer.includes(w))) return 30;
  if (answer.includes(q)) return 20;
  return 0;
}

function render(query) {
  const q = query.trim().toLowerCase();
  if (!q) { results.innerHTML = ''; meta.textContent = ''; return; }
  const hits = DATA.map(it => ({it, s: score(it, q)})).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.it.q.localeCompare(b.it.q)).slice(0, 20);
  meta.textContent = hits.length ? hits.length + ' result' + (hits.length === 1 ? '' : 's') : '';
  if (!hits.length) {
    results.innerHTML = '<div class="empty">No matching answer in the index yet.</div>';
    return;
  }
  results.innerHTML = hits.map((h, i) => `
    <div class="card">
      <div><div class="q">${escape(h.it.q)}</div><div class="a">${escape(h.it.a)}</div></div>
      <button class="copy" data-i="${i}">Copy</button>
    </div>`).join('');
  results.querySelectorAll('.copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const it = hits[Number(btn.dataset.i)].it;
      try { await navigator.clipboard.writeText(it.a); btn.textContent = 'Copied'; }
      catch (e) { btn.textContent = 'Select text'; }
      setTimeout(() => btn.textContent = 'Copy', 1200);
    });
  });
}

input.addEventListener('input', () => render(input.value));
</script>
</body>
</html>
"""

HTML = HTML.replace("__PAYLOAD__", payload).replace("__COUNT__", str(len(data)))
OUT.write_text(HTML, encoding="utf-8")
print(f"wrote {OUT} with {len(data)} questions ({OUT.stat().st_size} bytes)")
