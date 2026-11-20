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

ROOT = Path(__file__).resolve().parent.parent
SEARCH_DB = ROOT / "data" / "krillion_search.db"
OUT_HTML = ROOT / "index.html"
OUT_DATA = ROOT / "search-data.json"

with sqlite3.connect(SEARCH_DB) as c:
    rows = c.execute("SELECT question, answer FROM search_answers ORDER BY question").fetchall()

data = [{"q": q, "a": a} for q, a in rows]
payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
OUT_DATA.write_text(payload, encoding="utf-8", newline="\n")

HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Krillion Answer Search</title>
<script>document.documentElement.classList.add('js');</script>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  ::selection { background: #5b7cfa55; color: #f4f7ff; }
  html { scrollbar-color: #2a3350 #0b0f1a; scrollbar-width: thin; }
  ::-webkit-scrollbar { width: 10px; }
  ::-webkit-scrollbar-track { background: #0b0f1a; }
  ::-webkit-scrollbar-thumb { background: #2a3350; border-radius: 99px; border: 2px solid #0b0f1a; }
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
    outline: none; caret-color: #8fa6ff;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  input::placeholder { color: #8b95ab; opacity: 1; }
  input:focus-visible { border-color: #5b7cfa; box-shadow: 0 0 0 3px #5b7cfa22; }
  .meta { color: #8b95ab; font-size: .82rem; margin: 14px 2px 10px; }
  .results { display: grid; gap: 10px; }
  .card {
    background: #151b2b; border: 1px solid #2a3350; border-radius: 12px;
    padding: 14px 16px; display: flex; gap: 14px; align-items: flex-start;
    box-shadow: 0 8px 24px rgba(0, 0, 0, .22);
  }
  .card .q { color: #9fb0d8; font-size: .82rem; margin-bottom: 4px; }
  .card .a { font-size: 1.05rem; font-weight: 600; }
  .copy {
    margin-left: auto; flex: none; background: #222b45; color: #cdd7f0;
    border: 1px solid #36426a; border-radius: 8px; padding: 6px 11px;
    cursor: pointer; font-size: .8rem;
    transition: background .12s ease, border-color .12s ease;
  }
  .copy:hover { background: #2d3859; border-color: #4a5a8f; }
  .copy:focus-visible { outline: 2px solid #8fa6ff; outline-offset: 2px; }
  .empty { color: #8b95ab; text-align: center; padding: 40px 0; }

  /* --- Loading: one authored moment --- */
  #loader {
    display: none; position: fixed; inset: 0; z-index: 50;
    align-items: center; justify-content: center;
    background: #0b0f1a;
    opacity: 1;
    transition: opacity .34s cubic-bezier(.16, 1, .3, 1);
  }
  .js #loader { display: flex; }
  #loader.done { opacity: 0; pointer-events: none; }

  .load-inner {
    display: flex; flex-direction: column; align-items: center; gap: 15px;
    width: min(360px, 82vw);
    transition: transform .34s cubic-bezier(.16, 1, .3, 1);
  }
  #loader.done .load-inner { transform: scale(.97); }

  .spinner {
    width: 44px; height: 44px; border-radius: 50%;
    border: 3px solid #2a3350; border-top-color: #8fa6ff;
    animation: spin .9s linear infinite;
    transition: opacity .2s ease, transform .34s cubic-bezier(.16, 1, .3, 1);
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .ready-mark {
    position: absolute; top: 0; left: 0; width: 44px; height: 44px;
    display: grid; place-items: center;
    opacity: 0; transform: scale(.7);
    transition: opacity .22s ease .06s, transform .34s cubic-bezier(.16, 1, .3, 1) .06s;
  }
  .spinner-wrap { position: relative; width: 44px; height: 44px; }
  #loader.ready .spinner { opacity: 0; transform: scale(.7); animation: none; }
  #loader.ready .ready-mark { opacity: 1; transform: scale(1); }
  .ready-mark svg { width: 30px; height: 30px; }
  .ready-mark path {
    stroke: #7ee2a8; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round;
    fill: none; stroke-dasharray: 1; stroke-dashoffset: 1;
  }
  #loader.ready .ready-mark path { animation: draw .42s cubic-bezier(.16, 1, .3, 1) forwards; }
  @keyframes draw { to { stroke-dashoffset: 0; } }

  .load-title { font-size: 1rem; font-weight: 600; text-align: center; }
  .bar {
    width: 100%; height: 5px; background: #1a2236;
    border-radius: 99px; overflow: hidden;
  }
  .fill {
    height: 100%; width: 100%; border-radius: 99px;
    background: linear-gradient(90deg, #5b7cfa, #9b7bff);
    transform: scaleX(0); transform-origin: left center;
    transition: transform .26s cubic-bezier(.16, 1, .3, 1);
    will-change: transform;
  }
  #loader.ready .fill { transition: transform .42s cubic-bezier(.16, 1, .3, 1); }
  .load-status {
    color: #8b95ab; font-size: .8rem; font-variant-numeric: tabular-nums;
    text-align: center; min-height: 1.2em;
    transition: color .2s ease;
  }
  .load-status.ready { color: #7ee2a8; }
  .retry {
    background: #222b45; color: #cdd7f0; border: 1px solid #36426a;
    border-radius: 8px; padding: 8px 14px; cursor: pointer; display: none;
  }
  .retry:focus-visible { outline: 2px solid #8fa6ff; outline-offset: 2px; }

  @media (prefers-reduced-motion: reduce) {
    .spinner { animation-duration: 2.4s; }
    #loader, .load-inner, .fill, .spinner, .ready-mark, #loader.ready .ready-mark path {
      transition-duration: .01ms !important;
      animation-duration: .01ms !important;
    }
    #loader.ready .ready-mark path { stroke-dashoffset: 0; }
  }
</style>
</head>
<body>

<div id="loader" role="status" aria-live="polite">
  <div class="load-inner">
    <div class="spinner-wrap">
      <div class="spinner" id="spinner"></div>
      <div class="ready-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path pathLength="1" d="M5 13l4.5 4.5L19 7" /></svg>
      </div>
    </div>
    <div class="load-title" id="load-title">Loading answer database…</div>
    <div class="bar"><div class="fill" id="fill"></div></div>
    <div class="load-status" id="load-status">Connecting…</div>
    <button class="retry" id="retry" type="button">Retry</button>
  </div>
</div>

<div class="wrap">
  <h1>Krillion Answer Search</h1>
  <p class="sub">Type a question and get the answer instantly. <span id="count">—</span> questions indexed.</p>
  <input id="q" type="search" autocomplete="off" autofocus placeholder="Name any one famous park">
  <div class="meta" id="meta"></div>
  <div class="results" id="results"></div>
</div>

<script>
const DATA = [];
const $ = id => document.getElementById(id);
const loader = $('loader'), fill = $('fill'), status = $('load-status'), title = $('load-title');
const input = $('q');

// The loader only owns the page while JS is actively fetching.
if (document.documentElement.classList.contains('js')) input.disabled = true;
$('retry').addEventListener('click', () => location.reload());

function escape(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function fmt(n) { return (n / 1024).toFixed(0) + ' KB'; }

function setProgress(fraction) {
  fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, fraction)) + ')';
}

async function loadDatabase() {
  const res = await fetch('search-data.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;

  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) {
        setProgress(received / total);
        status.textContent = fmt(received) + ' / ' + fmt(total);
      } else {
        status.textContent = fmt(received) + ' loaded';
      }
    }
    const bytes = new Uint8Array(received);
    let pos = 0;
    for (const c of chunks) { bytes.set(c, pos); pos += c.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  return await res.json();
}

function score(item, q) {
  const question = item.q.toLowerCase();
  const answer = item.a.toLowerCase();
  if (question === q) return 100;
  if (question.startsWith(q)) return 80;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.every(w => question.includes(w))) return 60;
  if (question.includes(q)) return 50;
  if (words.every(w => answer.includes(w))) return 30;
  if (answer.includes(q)) return 20;
  return 0;
}

function render(query) {
  const q = query.trim().toLowerCase();
  if (!q) { $('results').innerHTML = ''; $('meta').textContent = ''; return; }
  const hits = DATA.map(it => ({ it, s: score(it, q) })).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.it.q.localeCompare(b.it.q)).slice(0, 20);
  $('meta').textContent = hits.length
    ? hits.length + ' result' + (hits.length === 1 ? '' : 's') : '';
  if (!hits.length) {
    $('results').innerHTML = '<div class="empty">No matching answer in the index yet.</div>';
    return;
  }
  $('results').innerHTML = hits.map(h => `
    <div class="card">
      <div><div class="q">${escape(h.it.q)}</div><div class="a">${escape(h.it.a)}</div></div>
      <button class="copy" type="button">Copy</button>
    </div>`).join('');
  const buttons = $('results').querySelectorAll('.copy');
  buttons.forEach((btn, i) => {
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(hits[i].it.a); btn.textContent = 'Copied'; }
      catch (e) { btn.textContent = 'Select text'; }
      setTimeout(() => btn.textContent = 'Copy', 1200);
    });
  });
}

function fail(e) {
  title.textContent = 'Could not load database';
  status.textContent = String(e && e.message || e);
  $('spinner').style.display = 'none';
  $('retry').style.display = 'inline-block';
}

async function init() {
  try {
    const data = await loadDatabase();
    DATA.push(...data);

    // The authored moment: bar completes, check draws, then the loader dissolves.
    setProgress(1);
    loader.classList.add('ready');
    status.textContent = '✓ ' + data.length.toLocaleString() + ' questions ready';
    status.classList.add('ready');
    title.textContent = 'Ready';
    $('count').textContent = data.length.toLocaleString();

    input.disabled = false;
    input.addEventListener('input', e => render(e.target.value));

    setTimeout(() => {
      loader.classList.add('done');
      fill.style.willChange = 'auto';
      input.focus();
    }, 620);
  } catch (e) {
    fail(e);
  }
}
init();
</script>
</body>
</html>
"""

OUT_HTML.write_text(HTML, encoding="utf-8")
print(
    f"wrote {OUT_HTML.name} + {OUT_DATA.name}: "
    f"{len(data)} questions, {OUT_DATA.stat().st_size} bytes of data"
)
