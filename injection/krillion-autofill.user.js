// ==UserScript==
// @name         Krillion Autofill — rare answers + self-correcting archive
// @namespace    https://github.com/berliandro/krillion-answer-database
// @version      1.0.0
// @description  Shows every known 100-point answer for the current Krillion prompt and records scoring mismatches back to the local archive. PC only; requires injection/bridge.py running.
// @match        https://playdaily.org/krillion*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const BRIDGE = 'http://127.0.0.1:8768';
  const TOKEN = 'krillion-local-v1';
  // All DOM hooks live here so a site tweak only needs one edit.
  const SEL = {
    prompt: 'p.kr-prompt',
    intro: '.kr-intro',
    input: 'input.kr-input',
    reveal: '.kr-reveal[role="status"]',
    revealTier: '.kr-reveal-tier',
    revealPoints: '.kr-reveal-points b',
    board: '.kr-board-head',
    haul: 'button.kr-haul-toggle',
    row: '.kr-row',
    rowHead: '.kr-row-head[aria-expanded="false"]',
    rowPrompt: '.kr-row-prompt',
    line: '.kr-line',
    lineAnswer: '.kr-line-answer',
    lineTier: '.kr-line-tier',
    linePoints: '.kr-line-pts',
  };
  const state = {
    question: '',
    answers: [],
    lastFilled: '',
    scored: new Set(),
    bankSent: '',
    collapsed: false,
  };
  const seenDeals = {};   // promptId -> exact question text
  const seenBanks = [];   // full graded banks observed from the site's own API

  // The site shows only ~10 answers per tier. Capture the real bank responses
  // it fetches at the end of a dive so the archive gets the complete tiers.
  (function watchApi() {
    try {
      const w = unsafeWindow;
      const original = w.fetch;
      if (!original || original.__krillionWrapped) return;
      const wrapped = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        return original.apply(this, arguments).then(async (res) => {
          if (/\/api\/krillion\/(deal|answers)(\?|$)/.test(url)) {
            try {
              const data = await res.clone().json();
              if (url.indexOf('/deal') !== -1 && data.prompts) {
                data.prompts.forEach((p) => { if (p && p.id && p.text) seenDeals[p.id] = p.text; });
              } else if (url.indexOf('/answers') !== -1 && data.answers) {
                const m = url.match(/prompt=([^&]+)/);
                const id = m ? decodeURIComponent(m[1]) : '';
                seenBanks.push({ id, question: seenDeals[id] || '', answers: data.answers });
              }
            } catch (e) { /* response was not JSON or was already consumed */ }
          }
          return res;
        });
      };
      wrapped.__krillionWrapped = true;
      w.fetch = wrapped;
    } catch (e) { /* unsafeWindow unavailable — DOM capture still works */ }
  })();

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const details = {
        method: options.method || 'GET',
        url: BRIDGE + path,
        timeout: 4000,
        headers: {
          'Content-Type': 'application/json',
          'X-Krillion-Token': TOKEN,
        },
        data: options.body ? JSON.stringify(options.body) : undefined,
        onload: (r) => {
          try { resolve(JSON.parse(r.responseText)); }
          catch (e) { reject(new Error('bridge returned non-JSON')); }
        },
        onerror: () => reject(new Error('bridge offline')),
        ontimeout: () => reject(new Error('bridge timeout')),
      };
      GM_xmlhttpRequest(details);
    });
  }

  // ---- panel -------------------------------------------------------------
  GM_addStyle(`
    #ka-root{
      position:fixed; top:18px; right:18px; z-index:2147483000; width:312px;
      max-height:min(74vh,640px); display:flex; flex-direction:column;
      background:#111725; border:1px solid #2c3857; border-radius:14px;
      box-shadow:0 14px 40px rgba(0,0,0,.38);
      color:#e9eefb; font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
      font-variant-numeric:tabular-nums; overflow:hidden;
      opacity:1; transform:translateY(0);
      animation:ka-in .42s cubic-bezier(.16,1,.3,1) both;
    }
    @keyframes ka-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
    #ka-root ::selection{background:#4d6bff55;color:#fff}
    #ka-root *{scrollbar-color:#35426a #111725;scrollbar-width:thin}
    #ka-root *::-webkit-scrollbar{width:8px}
    #ka-root *::-webkit-scrollbar-thumb{background:#35426a;border-radius:99px}
    #ka-head{
      display:flex; align-items:center; gap:10px; padding:12px 14px;
      border-bottom:1px solid #222d48; flex:none;
    }
    #ka-title{font-size:14px;font-weight:650;letter-spacing:-.01em;margin:0;flex:1}
    #ka-count{color:#9aabcf;font-size:12px;font-weight:500}
    #ka-toggle{
      appearance:none; background:#1b2540; color:#c9d6f5; border:1px solid #35426a;
      border-radius:8px; padding:4px 9px; font:inherit; font-size:12px; cursor:pointer;
    }
    #ka-toggle:hover{background:#263357}
    #ka-toggle:focus-visible{outline:2px solid #90a6ff;outline-offset:2px}
    #ka-body{padding:10px 12px 12px;overflow:auto;display:grid;gap:9px}
    #ka-root[data-collapsed="true"] #ka-body{display:none}
    #ka-status{
      margin:0; color:#9aabcf; font-size:12px; min-height:1.3em;
    }
    #ka-status[data-kind="error"]{color:#ff9a9a}
    #ka-status[data-kind="ok"]{color:#7ee2a8}
    #ka-list{display:grid;gap:6px;margin:0;padding:0;list-style:none}
    .ka-chip{
      appearance:none; width:100%; text-align:left; cursor:pointer;
      background:#192136; color:#eef3ff; border:1px solid #2b3859;
      border-radius:9px; padding:8px 11px; font:inherit; font-size:13px;
      transition:background .12s ease,border-color .12s ease;
    }
    .ka-chip:hover{background:#222e4d;border-color:#3e5083}
    .ka-chip:focus-visible{outline:2px solid #90a6ff;outline-offset:2px}
    .ka-chip[data-filled="true"]{border-color:#4b7f63;color:#bff0d3}
    .ka-empty{color:#9aabcf;font-size:12px;text-align:center;padding:12px 0;margin:0}
    #ka-foot{
      border-top:1px solid #222d48; padding:8px 14px; color:#8496bd;
      font-size:11px; flex:none;
    }
    @media (prefers-reduced-motion: reduce){
      #ka-root{animation:none}
      .ka-chip{transition:none}
    }
  `);

  const root = document.createElement('div');
  root.id = 'ka-root';
  root.dataset.collapsed = 'false';
  root.innerHTML =
    '<div id="ka-head">' +
      '<p id="ka-title">Krillion rare answers</p>' +
      '<span id="ka-count"></span>' +
      '<button id="ka-toggle" type="button">Hide</button>' +
    '</div>' +
    '<div id="ka-body">' +
      '<p id="ka-status" role="status" aria-live="polite">Connecting to local bridge…</p>' +
      '<ul id="ka-list"></ul>' +
    '</div>' +
    '<div id="ka-foot">Click an answer to fill it. Press Enter to dive.</div>';
  document.body.appendChild(root);

  const $ = (id) => root.querySelector('#' + id);
  const statusEl = $('ka-status');
  const listEl = $('ka-list');
  const countEl = $('ka-count');

  $('ka-toggle').addEventListener('click', () => {
    state.collapsed = !state.collapsed;
    root.dataset.collapsed = String(state.collapsed);
    $('ka-toggle').textContent = state.collapsed ? 'Show' : 'Hide';
  });

  function status(text, kind = '') {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
  }

  function render() {
    countEl.textContent = state.answers.length ? String(state.answers.length) : '';
    if (!state.answers.length) {
      listEl.innerHTML = '<li class="ka-empty">No rare answers indexed for this prompt.</li>';
      return;
    }
    listEl.innerHTML = state.answers.map((a, i) =>
      `<li><button class="ka-chip" type="button" data-i="${i}">${escapeHtml(a)}</button></li>`
    ).join('');
    listEl.querySelectorAll('.ka-chip').forEach((btn) => {
      btn.addEventListener('click', () => fill(btn.dataset.i, btn));
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fill(index, btn) {
    const answer = state.answers[Number(index)];
    const input = document.querySelector(SEL.input);
    if (!input || !answer) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, answer);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    state.lastFilled = answer;
    listEl.querySelectorAll('.ka-chip').forEach((b) => { b.dataset.filled = 'false'; });
    btn.dataset.filled = 'true';
    status(`Filled “${answer}” — press Enter to dive.`, 'ok');
  }

  // ---- prompt + scoring --------------------------------------------------
  async function loadAnswers(question) {
    state.question = question;
    state.answers = [];
    state.lastFilled = '';
    render();
    status('Loading rare answers…');
    try {
      const data = await request('/api/answers?q=' + encodeURIComponent(question));
      state.answers = data.answers || [];
      render();
      status(state.answers.length
        ? `${state.answers.length} known 100-point answer${state.answers.length === 1 ? '' : 's'}.`
        : 'No rare answers for this prompt in the archive.', state.answers.length ? '' : 'error');
    } catch (e) {
      status('Local bridge offline — start injection/bridge.py.', 'error');
    }
  }

  function isVisible(sel) {
    const el = document.querySelector(sel);
    return !!(el && (el.offsetParent !== null || el.getClientRects().length > 0));
  }

  function promptText() {
    // The intro stays in the DOM after a dive begins, just hidden. Only a
    // visible intro means we are still on the start screen.
    if (isVisible(SEL.intro)) return '';
    const el = document.querySelector(SEL.prompt);
    return el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : '';
  }

  function mode() {
    // The intro keeps "Play multiplayer" buttons in the DOM while hidden, so
    // only count a visible multiplayer board / 1v1 surface.
    if (isVisible('.kr-board-rows') || isVisible('.kr-over-multi')) return 'multiplayer';
    if (isVisible('.kr-duel-board') || /duel/i.test(location.hash)) return '1v1';
    return 'classic';
  }

  async function reportScore(question, answer, points, tier) {
    const key = question + '\u0000' + answer + '\u0000' + points;
    if (state.scored.has(key)) return;
    state.scored.add(key);
    status(`Scored ${points} for “${answer}” — recording…`);
    try {
      const r = await request('/api/correction', {
        method: 'POST',
        body: { question, answer, points, tier, mode: mode() },
      });
      if (r.action === 'removed') {
        status(`${answer} scored ${points} — removed from the 100-point list.`, 'ok');
      } else if (r.action === 'verified') {
        status(`${answer} confirmed at 100 points.`, 'ok');
      } else {
        status('Score recorded.', 'ok');
      }
    } catch (e) {
      status('Could not record score — bridge offline.', 'error');
    }
  }

  function checkVerdict() {
    if (!state.question || !state.lastFilled) return;
    const q = state.question;
    const answer = state.lastFilled;

    const solo = document.querySelector(SEL.revealPoints);
    const board = document.querySelector(SEL.board);
    if (!solo && !board) return;

    let points = null;
    let tier = '';
    if (solo) {
      const m = (solo.textContent || '').match(/\+(\d+)\s*PTS/i);
      if (m) points = Number(m[1]);
      tier = (document.querySelector(SEL.revealTier)?.textContent || '').trim();
    } else {
      const text = (board.textContent || '').replace(/\s+/g, ' ');
      const m = text.match(/\+(\d+)\s*$/);
      if (m) points = Number(m[1]);
      tier = text;
    }
    if (points === null) return;
    reportScore(q, answer, points, tier);
    state.lastFilled = '';
  }

  // ---- resilient posting -------------------------------------------------
  const QUEUE_KEY = 'krillion.pending.v1';
  function queuePost(path, body) {
    try {
      const q = GM_getValue(QUEUE_KEY, []);
      if (q.length < 20) {
        q.push({ path, body, at: Date.now() });
        GM_setValue(QUEUE_KEY, q);
      }
    } catch (e) { /* storage unavailable */ }
  }
  async function flushQueue() {
    let q = [];
    try { q = GM_getValue(QUEUE_KEY, []); } catch (e) { return; }
    if (!q.length) return;
    const left = [];
    for (const item of q) {
      try { await request(item.path, { method: 'POST', body: item.body }); }
      catch (e) { left.push(item); }
    }
    try { GM_setValue(QUEUE_KEY, left); } catch (e) { /* ignore */ }
  }

  // ---- end-of-dive bank capture ------------------------------------------
  async function captureBanks() {
    const rows = [...document.querySelectorAll(SEL.row)];
    if (!rows.length) return;
    const signature = rows.length + ':' + rows.map((r) => r.querySelector(SEL.rowPrompt)?.textContent || '').join('|');
    if (state.bankSent === signature) return;

    // The site hides the answer section behind a toggle; open it first.
    const haul = document.querySelector(SEL.haul);
    if (haul && haul.getAttribute('aria-expanded') === 'false') haul.click();
    await new Promise((r) => setTimeout(r, 120));
    rows.forEach((row) => {
      const btn = row.querySelector(SEL.rowHead);
      if (btn) btn.click();
    });
    await new Promise((r) => setTimeout(r, 260));

    const learned = [];
    rows.forEach((row) => {
      const question = (row.querySelector(SEL.rowPrompt)?.textContent || '').trim().replace(/\s+/g, ' ');
      row.querySelectorAll(SEL.line).forEach((line) => {
        const a = (line.querySelector(SEL.lineAnswer)?.textContent || '').trim();
        const t = (line.querySelector(SEL.lineTier)?.textContent || '').trim();
        const p = Number((line.querySelector(SEL.linePoints)?.textContent || '0').trim()) || 0;
        if (question && a) learned.push({ question, answer: a, tier: t, points: p, source: 'dom' });
      });
    });

    // Full banks captured from the site's own API responses (DOM shows ~10/tier).
    seenBanks.splice(0).forEach((bank) => {
      const question = bank.question || seenDeals[bank.id] || '';
      (bank.answers || []).forEach((row) => {
        const tierIndex = Array.isArray(row) ? Number(row[0]) : Number(row && row.tier);
        const answer = String((Array.isArray(row) ? row[1] : (row && (row.answer || row.name))) || '').trim();
        if (question && answer) {
          learned.push({ question, answer, tierIndex, points: tierIndex === 5 ? 100 : 0, source: 'api' });
        }
      });
    });

    if (!learned.length) return;
    state.bankSent = signature;
    try {
      const r = await request('/api/bank', { method: 'POST', body: { rows: learned } });
      status(`Imported ${r.added || 0} answer(s) from the end-of-dive bank.`, 'ok');
    } catch (e) {
      queuePost('/api/bank', { rows: learned });
      status('Bridge offline — bank queued for the next dive.', 'error');
    }
  }

  // ---- watch the game ----------------------------------------------------
  let lastPrompt = '';
  let timer = null;
  const observer = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      // Re-query on every tick: React remounts nodes and element refs go stale.
      const q = promptText();
      if (q && q !== lastPrompt) {
        lastPrompt = q;
        loadAnswers(q);
      }
      checkVerdict();
      if (document.querySelector(SEL.haul) || document.querySelector(SEL.row)) captureBanks();
    }, 150);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  const initial = promptText();
  if (initial) loadAnswers(initial);
  else status('Waiting for a prompt to appear…');
  flushQueue();
})();
