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
    next: 'button.kr-next',
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
    exact: false,
    premap: null,
    netCache: new Map(),
    refusedAnswers: new Set(),
    refusalKey: '',
  };
  const AUTO_KEY = 'krillion.autoEnter.v1';
  const seenDeals = {};   // promptId -> exact question text
  const seenTickets = {}; // promptId -> ticket from the same deal
  const seenBanks = [];   // full graded banks observed from the site's own API
  const bankByPrompt = {}; // exact prompt text -> promptId
  const ticketByPrompt = {}; // exact prompt text -> ticket

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
                data.prompts.forEach((p) => {
                  if (p && p.id && p.text) {
                    seenDeals[p.id] = p.text;
                    bankByPrompt[p.text] = p.id;
                  }
                });
                Object.entries(data.tickets || {}).forEach(([id, ticket]) => {
                  seenTickets[id] = ticket;
                  if (seenDeals[id]) ticketByPrompt[seenDeals[id]] = ticket;
                });
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
    #ka-botbar{
      border-top:1px solid var(--ka-line); padding:10px 14px 12px; flex:none;
      display:grid; gap:8px; background:var(--ka-surface-2);
    }
    #ka-botbar[hidden]{display:none}
    .ka-botrow{display:flex;align-items:center;gap:8px}
    .ka-botrow label{color:var(--ka-muted);font-size:11px;flex:none}
    .ka-botrow select{
      flex:1; min-width:0; appearance:none; background:var(--ka-surface);
      color:var(--ka-text); border:1px solid var(--ka-line-strong);
      border-radius:7px; padding:5px 7px; font:inherit; font-size:12px;
    }
    .ka-botrow select:focus-visible{outline:2px solid var(--ka-accent);outline-offset:1px}
    #ka-bot[aria-pressed="true"]{background:#2c3a30;border-color:var(--ka-success);color:var(--ka-success)}
    @media (pointer: coarse){
      .ka-botrow select{min-height:44px}
      #ka-bot{min-height:44px}
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
    '<div id="ka-botbar">' +
      '<div class="ka-botrow">' +
        '<button id="ka-bot" type="button" aria-pressed="false" title="Start or stop automatic play">Bot: Off</button>' +
        '<span id="ka-botstate">idle</span>' +
      '</div>' +
      '<div class="ka-botrow"><label for="ka-pick">Pick</label>' +
        '<select id="ka-pick">' +
          '<option value="random">Random 100-point answer</option>' +
          '<option value="top">Top of list</option>' +
        '</select></div>' +
      '<div class="ka-botrow"><label for="ka-mode">Mode</label>' +
        '<select id="ka-mode">' +
          '<option value="classic">Classic</option>' +
          '<option value="marathon5">Multiplayer · 5s / 50 prompts</option>' +
          '<option value="showoff">Multiplayer · most players</option>' +
          '<option value="duel">1 vs 1</option>' +
        '</select></div>' +
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
    if (state.autoEnter && state.groups.length > 1) {
      status('Several banks match — choose manually. Auto-enter paused for this prompt.', 'error');
      return;
    }
    if (state.autoEnter) {
      status(`Auto-diving with “${answer}”…`, 'ok');
      setTimeout(submitAnswer, 220);
    } else {
      status(`Filled “${answer}” — press Enter to dive.`, 'ok');
    }
  }

  // ---- prompt + scoring --------------------------------------------------
  function normLocal(text) {
    let q = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const rewrites = [
      [/^what is an example of an /, 'name an '],
      [/^what is an example of a /, 'name a '],
      [/^what is one /, 'name a '],
      [/^name any one /, 'name a '],
      [/^name any /, 'name a '],
      [/^name one /, 'name a '],
    ];
    for (const [re, to] of rewrites) {
      const changed = q.replace(re, to);
      if (changed !== q) { q = changed; break; }
    }
    return q.replace(/\bbeginning\s+with\b/g, 'starting with');
  }

  function applyResult(data, question) {
    state.groups = data.groups || [{ question, score: 1, answers: data.answers || [] }];
    state.exact = !!data.exact;
    state.answers = state.groups.reduce((all, g) => all.concat(g.answers), []);
    render();
    const total = state.answers.length;
    if (!total) {
      reportMiss(question, 'no-match', {
        promptId: bankByPrompt[question] || '',
        ticket: ticketByPrompt[question] || '',
      });
      reportPrompt('no-match', question, {
        candidates: candidateInfo(), mode: mode(), auto: state.autoEnter,
      });
      status('No 100-point answers recorded for this prompt.', 'error');
    } else if (!data.exact && state.groups.length > 1) {
      status(`Closest prompt: ${state.groups[0].question} — ${total} answers in ${state.groups.length} separate banks.`);
    } else if (!data.exact) {
      status(`Matched “${state.groups[0].question}” — ${total} rare answers.`);
    } else {
      status(`${total} known 100-point answer${total === 1 ? '' : 's'}.`, 'ok');
    }
    const best = state.groups.length ? Number(state.groups[0].score || 0) : 0;
    if (state.groups.length > 1 || (!data.exact && best < 0.90)) {
      reportPrompt('ambiguous', question, {
        candidates: candidateInfo(), mode: mode(), auto: state.autoEnter,
      });
    }
  }

  async function loadAnswers(question) {
    state.question = question;
    state.loadedPrompt = question;
    state.answers = [];
    state.groups = [];
    state.lastFilled = '';
    render();

    // The first prompt can appear before preloading finishes — wait for it.
    if (!state.premap && state.preloadPromise) {
      try { await state.preloadPromise; } catch (e) { /* continue with network */ }
    }

    // Fast path: the whole rare-answer archive was loaded once at page start.
    const key = normLocal(question);
    if (state.premap && state.premap.has(key)) {
      const item = state.premap.get(key);
      applyResult({
        exact: true,
        groups: [{ question: item.q, score: 1, answers: item.answers }],
      }, question);
      return;
    }
    if (state.netCache.has(key)) {
      applyResult(state.netCache.get(key), question);
      return;
    }

    status('Loading 100-point answers…', 'loading');
    try {
      const data = await request('/api/answers?q=' + encodeURIComponent(question));
      state.netCache.set(key, data);
      applyResult(data, question);
    } catch (e) {
      reportMiss(question, 'unreachable: ' + (e && e.message || e));
      status(e && /timeout/.test(e.message)
        ? 'The local archive took too long to answer — retrying on the next prompt.'
        : 'Can’t reach the local archive. Start injection/bridge.py.', 'error');
    }
  }

  async function preloadAnswers() {
    try {
      const data = await request('/api/all');
      const map = new Map();
      (data.data || []).forEach((item) => {
        if (item && item.q) map.set(normLocal(item.q), { q: item.q, answers: item.answers || [] });
      });
      state.premap = map;
      if (state.question && map.has(normLocal(state.question))) {
        const item = map.get(normLocal(state.question));
        applyResult({
          exact: true,
          groups: [{ question: item.q, score: 1, answers: item.answers }],
        }, state.question);
      }
    } catch (e) {
      state.premap = new Map();
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
    status(`Scored ${points} for “${answer}” — logging…`);
    try {
      await request('/api/evidence', {
        method: 'POST',
        body: {
          screen_prompt: state.question,
          chosen_bank: question,
          answer,
          points,
          outcome: points >= 100 ? 'ok' : 'below-100',
          tier,
          mode: mode(),
          exact: !!state.exact,
          group_count: state.groups.length,
          group_scores: state.groups.map((g) => Number(g.score || 0)),
          auto: state.autoEnter,
        },
      });
      status(points >= 100
        ? `${answer} scored 100 — logged.`
        : `${answer} scored ${points} — prompt + answer logged for review.`, 'ok');
      if (points < 100) {
        // The prompt may be the problem, not the answer: a near-duplicate bank
        // can make us show slightly wrong answers that only score 85.
        reportPrompt('low-score', state.question, {
          candidates: candidateInfo(),
          chosen_bank: question,
          answer, points, tier,
          mode: mode(), exact: state.exact, auto: state.autoEnter,
        });
      }
    } catch (e) {
      status('Could not log score — bridge offline.', 'error');
    }
  }

  function checkRefusal() {
    if (!state.question || !state.lastFilled) return false;
    const el = document.querySelector('.kr-refusal');
    const line = el ? (el.textContent || '').trim() : '';
    if (!line) return false;
    const answer = state.lastFilled;
    const bank = state.answerQuestion[answer] || state.question;
    const key = state.question + '\u0000' + answer + '\u0000' + line;
    if (state.refusalKey !== key) {
      state.refusalKey = key;
      state.refusedAnswers.add(state.question + '\u0000' + answer);
      reportPrompt('refused', state.question, {
        candidates: candidateInfo(), chosen_bank: bank, answer,
        refusal: line.slice(0, 200), mode: mode(),
        exact: state.exact, auto: state.autoEnter,
      });
      request('/api/evidence', {
        method: 'POST',
        body: {
          screen_prompt: state.question, chosen_bank: bank, answer,
          outcome: 'refused', refusal: line.slice(0, 200),
          mode: mode(), exact: state.exact,
          group_count: state.groups.length, auto: state.autoEnter,
        },
      }).catch(() => queuePost('/api/evidence', {
        screen_prompt: state.question, chosen_bank: bank, answer,
        outcome: 'refused', refusal: line.slice(0, 200), mode: mode(),
      }));
      status(`“${answer}” was refused — logged for review.`, 'error');
    }
    state.lastFilled = '';
    bot.answeredPrompt = '';
    return true;
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

    // Classic shows a per-prompt verdict with a NEXT button. Without this the
    // bot stops after the first answer, and Auto mode leaves the user stuck.
    const advanceKey = q + '\u0000' + answer + '\u0000' + points;
    if ((state.autoEnter || bot.on) && state.advancedFor !== advanceKey) {
      state.advancedFor = advanceKey;
      setTimeout(() => {
        const next = document.querySelector(SEL.next);
        if (next && (next.offsetParent !== null || next.getClientRects().length > 0)) {
          next.click();
        }
      }, 180);
    }
  }

  // ---- resilient posting -------------------------------------------------
  const QUEUE_KEY = 'krillion.pending.v1';
  function reportBot(event, extra) {
    const body = Object.assign({ event, mode: bot.mode }, extra || {});
    request('/api/bot-log', { method: 'POST', body, retries: 1 })
      .catch(() => queuePost('/api/bot-log', body));
  }

  function reportPrompt(kind, prompt, extra) {
    const body = Object.assign({ kind, screen_prompt: prompt }, extra || {});
    request('/api/prompt-review', {
      method: 'POST', body, retries: 1,
    }).catch(() => queuePost('/api/prompt-review', body));
  }

  function candidateInfo() {
    return state.groups.map((g) => ({
      question: g.question,
      score: Number(g.score || 0),
      answer_count: (g.answers || []).length,
    }));
  }

  function reportMiss(prompt, reason, extra) {
    const body = Object.assign({ prompt, reason }, extra || {});
    request('/api/miss', {
      method: 'POST', body, retries: 1,
    }).catch(() => queuePost('/api/miss', body));
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
      // IMPORTANT: only OUR answers are reliable. Other players' answers are
      // graded by the site's AI and can be 100 once and 60 the next time.
      row.querySelectorAll(SEL.line).forEach((line) => {
        if (!line.hasAttribute('data-me')) return;
        const a = (line.querySelector(SEL.lineAnswer)?.textContent || '').trim();
        const t = (line.querySelector(SEL.lineTier)?.textContent || '').trim();
        const p = Number((line.querySelector(SEL.linePoints)?.textContent || '0').trim()) || 0;
        if (question && a) learned.push({ question, answer: a, tier: t, points: p, source: 'own' });
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

  // ---- auto-play engine --------------------------------------------------
  const BOT_KEY = 'krillion.bot.v1';
  const PICK_KEY = 'krillion.bot.pick.v1';
  const MODE_KEY = 'krillion.bot.mode.v1';
  const bot = {
    on: false, pick: 'random', mode: 'classic',
    timer: null, busy: false, answered: new Set(), lastAction: '', state: 'idle',
  };

  function botStatus(text) {
    bot.state = text;
    const el = document.getElementById('ka-botstate');
    if (el) el.textContent = text;
  }

  function setBot(on) {
    bot.on = !!on;
    try { GM_setValue(BOT_KEY, bot.on); } catch (e) { /* no storage */ }
    const btn = document.getElementById('ka-bot');
    btn.setAttribute('aria-pressed', String(bot.on));
    btn.textContent = bot.on ? 'Bot: On' : 'Bot: Off';
    if (bot.on) {
      botStatus('starting…');
      reportBot('bot-start', { note: bot.mode + ' / ' + bot.pick });
      bot.timer = setInterval(botTick, 500);
      botTick();
    } else {
      if (bot.timer) clearInterval(bot.timer);
      bot.timer = null;
      botStatus('idle');
    }
  }

  function visible(sel) {
    const el = document.querySelector(sel);
    return !!(el && (el.offsetParent !== null || el.getClientRects().length > 0));
  }

  function pickAnswer(list) {
    if (!list || !list.length) return '';
    return bot.pick === 'top' ? list[0] : list[Math.floor(Math.random() * list.length)];
  }

  function answerCurrentPrompt() {
    const prompt = promptText();
    const input = document.querySelector(SEL.input);
    if (!prompt || !input || bot.answeredPrompt === prompt) return false;
    if (state.loadedPrompt !== prompt) { botStatus('loading answers'); return false; }
    const groups = state.groups.length ? state.groups : [{ answers: state.answers || [] }];
    const list = (groups[0].answers || []).filter(
      (a) => !state.refusedAnswers.has(prompt + '\u0000' + a)
    );
    const answer = pickAnswer(list);
    if (!answer) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, answer);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    state.lastFilled = answer;
    state.answerQuestion[answer] = groups[0].question || prompt;
    bot.answeredPrompt = prompt;
    botStatus('answered');
    setTimeout(submitAnswer, 120);
    return true;
  }

  function joinLobbyRoom() {
    const rows = [...document.querySelectorAll('.kr-room-row')].filter(
      (r) => !/kr-room-make/.test(r.className) && r.offsetParent !== null
    );
    const info = rows.map((r) => ({
      row: r,
      name: (r.querySelector('.kr-room-name')?.textContent || '').trim(),
      detail: (r.querySelector('.kr-room-detail')?.textContent || '').trim(),
      count: parseInt((r.querySelector('.kr-room-count')?.textContent || '').trim(), 10) || 0,
    }));
    let target = null;
    let reason = '';

    if (bot.mode === 'marathon5') {
      // Parse "50 prompts, 5s each" numerically instead of guessing by text.
      const parsed = info.map((x) => {
        const m = x.detail.toLowerCase().match(/(\d+)\s*prompts?\s*,\s*(\d+)\s*s(?:ec)?/);
        return Object.assign({}, x, { prompts: m ? Number(m[1]) : 0, seconds: m ? Number(m[2]) : 0 });
      });
      target = parsed.find((x) => x.seconds === 5 && x.prompts >= 50)
        || parsed.find((x) => x.seconds === 5 && x.prompts >= 15);
      reason = target ? 'matched 5-second room' : 'no 5-second room available';
    } else if (bot.mode === 'showoff') {
      let best = -1;
      info.forEach((x) => { if (x.count > best) { best = x.count; target = x; } });
      reason = target ? 'most populated room' : 'no rooms';
    } else {
      reason = 'mode does not join rooms';
    }

    const sig = (target ? target.name : '') + '|' + reason;
    if (sig !== bot.lastRoomLog) {
      bot.lastRoomLog = sig;
      reportBot('room-select', {
        reason,
        room: target ? target.name : '',
        detail: target ? target.detail : '',
        count: target ? target.count : 0,
        rooms: info.map((x) => `${x.name} | ${x.detail} | ${x.count}`).slice(0, 20),
      });
    }
    if (!target) {
      botStatus('waiting: ' + reason);
      return false;
    }
    target.row.click();
    botStatus('joining ' + target.name);
    return true;
  }

  function startMode() {
    const begin = document.querySelector('button.kr-begin');
    const online = [...document.querySelectorAll('button.kr-online')];
    if (bot.mode === 'classic') {
      const classic = [...document.querySelectorAll('button.kr-mode')]
        .find((b) => /classic/i.test(b.innerText));
      if (classic && !/selected|active/i.test(classic.className)) classic.click();
      if (begin && begin.offsetParent !== null) { begin.click(); botStatus('classic start'); return true; }
      return false;
    }
    const wanted = bot.mode === 'duel' ? /1\s*vs\s*1/i : /multiplayer/i;
    const btn = online.find((b) => wanted.test(b.innerText) && b.offsetParent !== null);
    if (btn) { btn.click(); botStatus(bot.mode === 'duel' ? 'finding opponent' : 'opening lobby'); return true; }
    return false;
  }

  function restartFromResults() {
    const btns = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
    const again = btns.find((b) => /play again|dive again|restart|next|continue/i.test(b.innerText));
    if (again && again !== bot.lastAction) {
      bot.lastAction = again;
      again.click();
      botStatus('restarting');
      return true;
    }
    return false;
  }

  function duelClick(selector, event, note) {
    const btn = document.querySelector(selector);
    if (!btn || btn.disabled || btn === bot.lastDuelAction) return;
    bot.lastDuelAction = btn;
    reportBot(event, { note: note || (btn.innerText || '').trim().slice(0, 80) });
    btn.click();
    botStatus(note || event);
  }

  function duelTick() {
    // State-aware handling of the real Colosseum screens. Never click the
    // "Leave before it starts" or "Back to the arena" buttons.
    if (visible('.kd-versus')) { botStatus('match found — waiting for first prompt'); return; }
    if (visible('.kd-tab-rule')) { duelClick('.kd-tab-rule-key', 'duel-rule', 'accepted tab rule'); return; }
    if (visible('.kd-elsewhere')) { duelClick('.kd-elsewhere-key', 'duel-claim', 'claimed queue here'); return; }
    if (visible('.kd-result-keys')) { duelClick('.kd-again', 'duel-requeue', 'queued another match'); return; }
    if (visible('.kd-play')) { duelClick('.kd-play', 'duel-queue', 'finding a match'); return; }
    botStatus('waiting for duel lobby');
  }

  function botTick() {
    if (!bot.on || bot.busy) return;
    bot.busy = true;
    try {
      const p = promptText();
      if (p && p !== bot.lastPrompt) { bot.lastPrompt = p; bot.answeredPrompt = ''; }
      if (p && visible(SEL.prompt) && visible(SEL.input)) {
        answerCurrentPrompt();
      } else if (visible('.kr-lobby-tab') || visible('.kr-room-row')) {
        joinLobbyRoom();
      } else if (visible('.kr-over') || visible('.kr-over-next')) {
        restartFromResults();
      } else if (visible('.kr-intro') || visible('button.kr-begin')) {
        startMode();
      } else if (bot.mode === 'duel') {
        duelTick();
      } else {
        botStatus('waiting');
      }
    } catch (e) {
      botStatus('error: ' + (e && e.message || e));
    } finally {
      bot.busy = false;
    }
  }

  try { bot.pick = GM_getValue(PICK_KEY, 'random'); } catch (e) { /* ignore */ }
  try { bot.mode = GM_getValue(MODE_KEY, 'classic'); } catch (e) { /* ignore */ }
  document.getElementById('ka-pick').value = bot.pick;
  document.getElementById('ka-mode').value = bot.mode;
  document.getElementById('ka-pick').addEventListener('change', (e) => {
    bot.pick = e.target.value;
    try { GM_setValue(PICK_KEY, bot.pick); } catch (err) { /* ignore */ }
  });
  document.getElementById('ka-mode').addEventListener('change', (e) => {
    bot.mode = e.target.value;
    try { GM_setValue(MODE_KEY, bot.mode); } catch (err) { /* ignore */ }
    reportBot('mode-change', { note: bot.mode });
  });
  document.getElementById('ka-bot').addEventListener('click', () => setBot(!bot.on));
  try {
    if (GM_getValue(BOT_KEY, false)) setBot(true);
  } catch (e) { /* ignore */ }

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
      if (checkRefusal()) return;
      checkVerdict();
      if (document.querySelector(SEL.haul) || document.querySelector(SEL.row)) captureBanks();
    }, 150);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  const initial = promptText();
  if (initial) loadAnswers(initial);
  else status('Waiting for the next prompt…', 'loading');
  flushQueue();
  state.preloadPromise = preloadAnswers();
})();
