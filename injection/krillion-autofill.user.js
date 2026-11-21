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
    form: 'form.kr-bar',
    input: 'input.kr-input',
    send: 'button.kr-send',
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
    groups: [],
    answerQuestion: {},
    lastFilled: '',
    scored: new Set(),
    bankSent: '',
    collapsed: false,
    autoEnter: false,
  };
  const AUTO_KEY = 'krillion.autoEnter.v1';
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
    let left = options.retries === undefined ? 2 : options.retries;
    return new Promise((resolve, reject) => {
      const retry = (err) => {
        if (left-- > 0) setTimeout(go, 400);
        else reject(err);
      };
      const go = () => {
        GM_xmlhttpRequest({
          method: options.method || 'GET',
          // Token in the URL, not a custom header: custom headers force a CORS
          // preflight that Edge/Tampermonkey can abort on https -> loopback.
          url: BRIDGE + path + (path.indexOf('?') === -1 ? '?' : '&') + 't=' + encodeURIComponent(TOKEN),
          timeout: 12000,
          headers: {},
          data: options.body ? JSON.stringify(options.body) : undefined,
          onload: (r) => {
            try { resolve(JSON.parse(r.responseText)); }
            catch (e) { reject(new Error('bridge returned non-JSON')); }
          },
          onerror: () => retry(new Error('bridge offline')),
          ontimeout: () => retry(new Error('bridge timeout')),
        });
      };
      go();
    });
  }

  // ---- panel -------------------------------------------------------------
  GM_addStyle(`
    #ka-root{
      --ka-surface:#1d2228; --ka-surface-2:#262d34;
      --ka-raised:#313a43; --ka-text:#eceee9; --ka-muted:#b4bcc0;
      --ka-accent:#e0ae6a; --ka-success:#9fc6a8; --ka-error:#e6a19a;
      --ka-line:#343c44; --ka-line-strong:#4d5a63;
      position:fixed; top:18px; right:18px; z-index:2147483000;
      width:min(312px, calc(100vw - 24px));
      max-height:min(74vh,640px); display:flex; flex-direction:column;
      background:var(--ka-surface); border:1px solid var(--ka-line); border-radius:14px;
      box-shadow:0 14px 40px rgba(0,0,0,.34), 0 2px 8px rgba(0,0,0,.16);
      color:var(--ka-text); font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
      font-variant-numeric:tabular-nums; overflow:hidden; overflow-wrap:anywhere;
      caret-color:var(--ka-accent);
      animation:ka-in .28s cubic-bezier(.16,1,.3,1) both;
    }
    @supports (color: oklch(0.24 0.012 250)){
      #ka-root{
        --ka-surface:oklch(0.29 0.014 250);
        --ka-surface-2:oklch(0.35 0.016 250); --ka-raised:oklch(0.41 0.018 250);
        --ka-text:oklch(0.94 0.01 90); --ka-muted:oklch(0.78 0.018 250);
        --ka-accent:oklch(0.82 0.10 75); --ka-success:oklch(0.84 0.07 155);
        --ka-line:oklch(0.38 0.014 250); --ka-line-strong:oklch(0.49 0.016 250);
      }
    }
    @keyframes ka-in{from{opacity:0;transform:translate3d(8px,-6px,0) scale(.985)}to{opacity:1;transform:none}}
    @keyframes ka-in-quiet{from{opacity:0}to{opacity:1}}
    #ka-root::before{
      content:""; position:absolute; inset:0; border-radius:inherit; pointer-events:none;
      background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      opacity:.055; mix-blend-mode:soft-light;
    }
    #ka-root ::selection{background:rgba(224,174,106,.30);color:var(--ka-text)}
    #ka-root *{scrollbar-color:var(--ka-line-strong) var(--ka-surface);scrollbar-width:thin}
    #ka-root *::-webkit-scrollbar{width:8px;height:8px}
    #ka-root *::-webkit-scrollbar-track{background:var(--ka-surface)}
    #ka-root *::-webkit-scrollbar-thumb{background:var(--ka-line-strong);border-radius:99px;border:2px solid var(--ka-surface)}
    #ka-head{
      display:flex; align-items:center; gap:10px; padding:12px 14px;
      border-bottom:1px solid var(--ka-line); flex:none; min-width:0;
    }
    #ka-title{
      font-size:14px; font-weight:650; letter-spacing:-.01em; line-height:1.25;
      margin:0; flex:1; min-width:0; text-wrap:balance; color:var(--ka-text);
    }
    #ka-count{
      color:var(--ka-accent); background:var(--ka-surface-2);
      border:1px solid var(--ka-line); border-radius:999px;
      padding:3px 8px; font-size:11px; font-weight:650; line-height:1.2; flex:none;
    }
    #ka-count[hidden]{display:none}
    #ka-toggle,#ka-auto{
      appearance:none; background:var(--ka-surface-2); color:var(--ka-text);
      border:1px solid var(--ka-line-strong); border-radius:8px;
      padding:5px 10px; font:inherit; font-size:12px; line-height:1.2; cursor:pointer;
      transition:background-color .12s ease,border-color .12s ease;
    }
    #ka-toggle:hover,#ka-auto:hover{background:var(--ka-raised);border-color:var(--ka-accent)}
    #ka-toggle:active,#ka-auto:active{background:var(--ka-surface)}
    #ka-toggle:focus-visible,#ka-auto:focus-visible{outline:2px solid var(--ka-accent);outline-offset:2px}
    #ka-auto[aria-pressed="true"]{
      background:#2c3a30; border-color:var(--ka-success); color:var(--ka-success);
    }
    #ka-body{padding:12px;overflow:auto;display:grid;gap:10px;min-height:0}
    #ka-root[data-collapsed="true"] #ka-body{display:none}
    #ka-status{
      margin:0; color:var(--ka-muted); font-size:12px; line-height:1.45;
      min-height:1.45em; display:flex; gap:8px; align-items:flex-start; text-wrap:pretty;
    }
    #ka-status::before{
      content:""; width:6px; height:6px; border-radius:50%;
      background:currentColor; flex:none; margin-top:6px; opacity:.85;
    }
    #ka-status[data-kind="ok"]{color:var(--ka-success)}
    #ka-status[data-kind="error"]{color:var(--ka-error)}
    #ka-list{display:grid;gap:2px;margin:0;padding:0;list-style:none;min-width:0}
    #ka-list>li{min-width:0}
    .ka-group{
      display:flex; justify-content:space-between; gap:8px; align-items:baseline;
      color:var(--ka-muted); font-size:11px; line-height:1.35; letter-spacing:.01em;
      border-bottom:1px solid var(--ka-line); padding:8px 2px 6px; margin-top:6px;
      text-wrap:balance;
    }
    .ka-group:first-child{margin-top:0}
    .ka-group .ka-group-name{color:var(--ka-muted);min-width:0}
    .ka-group .ka-match{color:var(--ka-accent);font-weight:650;flex:none}
    .ka-chip{
      position:relative; appearance:none; display:flex; align-items:center;
      width:100%; min-height:38px; text-align:start; cursor:pointer;
      background:transparent; color:var(--ka-text); border:1px solid transparent;
      border-radius:8px; padding:8px 10px 8px 12px; font:inherit; font-size:13px;
      line-height:1.35; transition:background-color .12s ease,color .12s ease,border-color .12s ease;
    }
    .ka-chip::before{
      content:""; position:absolute; inset-inline-start:0; top:50%;
      width:3px; height:18px; transform:translateY(-50%);
      border-radius:2px; background:transparent; transition:background-color .12s ease;
    }
    .ka-chip:hover{background:var(--ka-surface-2);border-color:var(--ka-line)}
    .ka-chip:active{background:var(--ka-raised)}
    .ka-chip:focus-visible{outline:2px solid var(--ka-accent);outline-offset:2px}
    .ka-chip[data-filled="true"]{color:var(--ka-success);border-color:var(--ka-line-strong)}
    .ka-chip[data-filled="true"]::before{background:var(--ka-accent)}
    .ka-empty{color:var(--ka-muted);font-size:12px;text-align:center;padding:18px 10px;margin:0;text-wrap:pretty}
    #ka-foot{
      border-top:1px solid var(--ka-line); padding:9px 14px; color:var(--ka-muted);
      font-size:11px; line-height:1.4; flex:none; text-wrap:pretty;
    }
    @media (pointer: coarse){
      .ka-chip{min-height:44px}
      #ka-toggle,#ka-auto{min-height:44px;padding-inline:12px}
    }
    @media (max-width: 560px){
      #ka-root{
        top:max(10px, env(safe-area-inset-top));
        right:max(10px, env(safe-area-inset-right));
        width:min(312px, calc(100vw - 20px));
        max-height:min(78vh,600px);
      }
    }
    @media (forced-colors: active){
      #ka-root,#ka-toggle,#ka-auto,.ka-chip{border:1px solid CanvasText}
      .ka-chip[data-filled="true"]::before{background:Highlight}
      #ka-toggle:focus-visible,#ka-auto:focus-visible,.ka-chip:focus-visible{outline:2px solid Highlight}
    }
    @media (prefers-reduced-motion: reduce){
      #ka-root{animation:ka-in-quiet .16s ease-out both}
      .ka-chip,.ka-chip::before{transition:background-color .12s ease,color .12s ease}
    }
  `);

  const root = document.createElement('div');
  root.id = 'ka-root';
  root.dataset.collapsed = 'false';
  root.innerHTML =
    '<div id="ka-head">' +
      '<h2 id="ka-title">Krillion rare answers</h2>' +
      '<span id="ka-count" hidden></span>' +
      '<button id="ka-auto" type="button" aria-pressed="false" title="When on, the script submits the answer after filling it">Auto: Off</button>' +
      '<button id="ka-toggle" type="button" aria-controls="ka-body" aria-expanded="true">Hide</button>' +
    '</div>' +
    '<div id="ka-body">' +
      '<p id="ka-status" role="status" aria-live="polite" aria-atomic="true" data-kind="loading">Connecting to local bridge…</p>' +
      '<ul id="ka-list"></ul>' +
    '</div>' +
    '<div id="ka-foot">Click an answer to fill the box. You press Enter to dive.</div>';
  document.body.appendChild(root);

  const $ = (id) => root.querySelector('#' + id);
  const statusEl = $('ka-status');
  const listEl = $('ka-list');
  const countEl = $('ka-count');

  $('ka-toggle').addEventListener('click', () => {
    state.collapsed = !state.collapsed;
    root.dataset.collapsed = String(state.collapsed);
    $('ka-toggle').textContent = state.collapsed ? 'Show' : 'Hide';
    $('ka-toggle').setAttribute('aria-expanded', String(!state.collapsed));
  });

  function setAuto(on) {
    state.autoEnter = !!on;
    try { GM_setValue(AUTO_KEY, state.autoEnter); } catch (e) { /* no storage */ }
    const btn = $('ka-auto');
    btn.setAttribute('aria-pressed', String(state.autoEnter));
    btn.textContent = state.autoEnter ? 'Auto: On' : 'Auto: Off';
    $('ka-foot').textContent = state.autoEnter
      ? 'Auto-enter is ON — clicking an answer dives immediately.'
      : 'Click an answer to fill the box. You press Enter to dive.';
    status(state.autoEnter
      ? 'Auto-enter on — clicking an answer will dive.'
      : 'Auto-enter off — you press Enter.', state.autoEnter ? 'ok' : '');
  }

  try { state.autoEnter = !!GM_getValue(AUTO_KEY, false); } catch (e) { /* no storage */ }
  setAuto(state.autoEnter);
  $('ka-auto').addEventListener('click', () => setAuto(!state.autoEnter));

  function status(text, kind = '') {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
  }

  function render() {
    const total = state.groups.reduce((n, g) => n + g.answers.length, 0);
    countEl.textContent = total ? String(total) : '';
    countEl.hidden = !total;
    if (!total) {
      listEl.innerHTML = '<li class="ka-empty">No 100-point answers recorded for this prompt yet.</li>';
      return;
    }
    const multi = state.groups.length > 1;
    let html = '';
    state.groups.forEach((g) => {
      // Near-duplicate prompts stay as distinct, labelled banks — never merged.
      if (multi) {
        const pct = Math.round((g.score || 0) * 100);
        html += `<li class="ka-group" role="presentation" aria-label="Bank: ${escapeHtml(g.question)} — ${pct}% match">` +
                `<span class="ka-group-name">${escapeHtml(g.question)}</span>` +
                `<span class="ka-match">${pct}%</span></li>`;
      }
      g.answers.forEach((a) => {
        html += `<li><button class="ka-chip" type="button" data-a="${escapeHtml(a)}" data-q="${escapeHtml(g.question)}">${escapeHtml(a)}</button></li>`;
      });
    });
    listEl.innerHTML = html;
    listEl.querySelectorAll('.ka-chip').forEach((btn) => {
      btn.addEventListener('click', () => fill(btn.dataset.a, btn));
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function submitAnswer() {
    // requestSubmit fires a native submit React can see, unlike a synthetic
    // keydown. Fall back to Enter, then the DIVE button.
    const form = document.querySelector(SEL.form);
    if (form && typeof form.requestSubmit === 'function') {
      try { form.requestSubmit(); return true; } catch (e) { /* try fallback */ }
    }
    const input = document.querySelector(SEL.input);
    if (input) {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
      }));
    }
    const send = document.querySelector(SEL.send);
    if (send) { send.click(); return true; }
    return false;
  }

  function fill(answer, btn) {
    const input = document.querySelector(SEL.input);
    if (!input || !answer) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, answer);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    state.lastFilled = answer;
    state.answerQuestion[answer] = btn.dataset.q || state.question;
    listEl.querySelectorAll('.ka-chip').forEach((b) => { b.dataset.filled = 'false'; });
    btn.dataset.filled = 'true';
    if (state.autoEnter) {
      status(`Auto-diving with “${answer}”…`, 'ok');
      setTimeout(submitAnswer, 220);
    } else {
      status(`Filled “${answer}” — press Enter to dive.`, 'ok');
    }
  }

  // ---- prompt + scoring --------------------------------------------------
  async function loadAnswers(question) {
    state.question = question;
    state.answers = [];
    state.groups = [];
    state.lastFilled = '';
    render();
    status('Loading 100-point answers…', 'loading');
    try {
      const data = await request('/api/answers?q=' + encodeURIComponent(question));
      state.groups = data.groups || [{ question, score: 1, answers: data.answers || [] }];
      state.answers = state.groups.reduce((all, g) => all.concat(g.answers), []);
      render();
      const total = state.answers.length;
      if (!total) {
        reportMiss(question, 'no-match');
        status('No 100-point answers recorded for this prompt.', 'error');
      } else if (!data.exact && state.groups.length > 1) {
        status(`Closest prompt: ${state.groups[0].question} — ${total} answers in ${state.groups.length} separate banks.`);
      } else if (!data.exact) {
        status(`Matched “${state.groups[0].question}” — ${total} rare answers.`);
      } else {
        status(`${total} known 100-point answer${total === 1 ? '' : 's'}.`, 'ok');
      }
    } catch (e) {
      reportMiss(question, 'unreachable: ' + (e && e.message || e));
      status(e && /timeout/.test(e.message)
        ? 'The local archive took too long to answer — retrying on the next prompt.'
        : 'Can’t reach the local archive. Start injection/bridge.py.', 'error');
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
    const answer = state.lastFilled;
    // Use the matched DB prompt, not the paraphrased text on screen, so a
    // correction removes the right row from the rare-answer list.
    const q = state.answerQuestion[answer] || state.question;

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
  function reportMiss(prompt, reason) {
    request('/api/miss', {
      method: 'POST', body: { prompt, reason }, retries: 1,
    }).catch(() => queuePost('/api/miss', { prompt, reason }));
  }

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
  else status('Waiting for the next prompt…', 'loading');
  flushQueue();
})();
