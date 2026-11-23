// ==UserScript==
// @name         Krillion Autofill — rare answers + self-correcting archive
// @namespace    https://github.com/berliandro/krillion-answer-database
// @author       berliandro — https://github.com/berliandro
// @homepage     https://github.com/berliandro/krillion-answer-database
// @version      1.1.1
// @description  Shows every known 100-point answer for the current Krillion prompt and records scoring mismatches back to the local archive. PC only; requires injection/bridge.py running. By berliandro — https://github.com/berliandro/krillion-answer-database
// @downloadURL https://raw.githubusercontent.com/berliandro/krillion-answer-database/main/injection/krillion-autofill.user.js
// @updateURL  https://raw.githubusercontent.com/berliandro/krillion-answer-database/main/injection/krillion-autofill.user.js
// @match        https://playdaily.org/krillion*
// @match        https://playdaily.org/krillocity*
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
// Credit / source: berliandro — https://github.com/berliandro/krillion-answer-database
// Tampermonkey will now auto-update this script from the raw GitHub URL above.
// Bump @version on every future change, otherwise Tampermonkey won't fetch the update.

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
    deepcut: [],
    deepcutExact: false,
    deepcutPrompt: '',
    premap: null,
    tierPremap: null,     // null until /api/all-tier resolves; Map afterwards
    netCache: new Map(),
    bankCapturing: false, // guards the 50ms-debounced end-of-dive capture
    refusedAnswers: new Set(),
    refusalKey: '',
    refusalActive: false,
    prefetchQueue: [],   // prompts captured from /deal, waiting to warm netCache
    prefetchActive: 0,   // in-flight prefetches (never exceeds PREFETCH_CONCURRENCY)
    prefetchCount: 0,    // total issued prefetches (never exceeds PREFETCH_MAX)
    prefetchSeen: new Set(), // dedupe queue entries by cache key
  };
  let botActive = false; // mirrors bot.on, declared later; used by the header control
  const AUTO_KEY = 'krillion.autoEnter.v1';
  const SNAPSHOT_META_KEY = 'krillion.snapshot.v2';       // {version, etag}
  const SNAPSHOT_DATA_KEY = 'krillion.snapshot.data.v2';  // cached parsed /api/all data
  const SNAPSHOT_MAX_CHARS = 1500000; // only cache a "reasonably sized" snapshot
  const PREFETCH_MAX = 60;            // never spam more than this many prefetches
  const PREFETCH_CONCURRENCY = 3;
  const MO_DEBOUNCE_MS = 50;          // coalesce React remounts; safer than rAF
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
                    // Warm netCache ahead of the user: a source /deal response
                    // is the earliest reliable signal for the next prompts.
                    enqueuePrefetch(p.text);
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
    const configuredRetries = options.retries === undefined ? 2 : options.retries;
    let left = configuredRetries;
    const timeout = options.timeout === undefined ? 12000 : options.timeout;
    const forever = !!options.forever;
    let backoffMs = 1000; // bounded exponential backoff: 1s,2s,4s,8s,16s,30s cap
    let loggedFinalFail = false;
    let settled = false;

    return new Promise((resolve, reject) => {
      const isStale = () => !!(options.isStale && options.isStale());
      const settleReject = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const retry = (err) => {
        if (settled) return;
        // Drop retries for a prompt the user has already moved past.
        if (isStale()) { settleReject(new Error('stale request')); return; }
        if (left > 0) {
          left--;
          setTimeout(go, 400);
          return;
        }
        if (!forever) { settleReject(err); return; }

        // Normal attempts (default 3) are exhausted. Log the outage ONCE for
        // this request, then keep trying in the background until it succeeds.
        if (!loggedFinalFail) {
          loggedFinalFail = true;
          try {
            if (typeof options.onFinalFail === 'function') {
              options.onFinalFail({
                path,
                reason: (err && err.message) || String(err),
                attempts: configuredRetries + 1,
              });
            }
          } catch (e) { /* logging must never break the retry chain */ }
        }
        setTimeout(go, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30000);
      };

      const go = () => {
        if (settled) return;
        if (isStale()) { settleReject(new Error('stale request')); return; }
        GM_xmlhttpRequest({
          method: options.method || 'GET',
          // Token in the URL, not a custom header: custom headers force a CORS
          // preflight that Edge/Tampermonkey can abort on https -> loopback.
          url: BRIDGE + path + (path.indexOf('?') === -1 ? '?' : '&') + 't=' + encodeURIComponent(TOKEN),
          timeout,
          headers: {},
          data: options.body ? JSON.stringify(options.body) : undefined,
          onload: (r) => {
            if (settled) return;
            let parsed;
            try { parsed = JSON.parse(r.responseText); }
            catch (e) {
              // A transient non-JSON reply should not kill a forever lookup.
              // POSTs (no `forever`) keep the original immediate-reject behavior.
              if (forever) retry(new Error('bridge returned non-JSON'));
              else settleReject(new Error('bridge returned non-JSON'));
              return;
            }
            if (isStale()) { settleReject(new Error('stale request')); return; }
            settled = true;
            resolve(parsed);
          },
          onerror: () => retry(new Error('bridge offline')),
          ontimeout: () => retry(new Error('bridge timeout')),
        });
      };
      go();
    });
  }

  // Answer-lookup GETs need a short timeout so a dead bridge is detected
  // inside a fast (5s) prompt. POSTs keep the original 12000ms timeout.
  const LOOKUP_TIMEOUT = 2500;
  const FAIL_LOG_COOLDOWN = 30000;
  let lastFailLogAt = -Infinity;

  // One "bridge down" episode produces one miss record even when several
  // prompts fail together. Any successful lookup closes the episode.
  function logLookupFailure(question, info) {
    const now = Date.now();
    if (now - lastFailLogAt < FAIL_LOG_COOLDOWN) return;
    lastFailLogAt = now;
    reportMiss(question,
      'unreachable: ' + info.reason + ' after ' + info.attempts + ' attempts',
      { lookup_path: info.path, attempts: info.attempts });
  }
  function clearLookupFailure() { lastFailLogAt = -Infinity; }

  // ---- prefetch -----------------------------------------------------------
  // A /deal response names the next prompts before they are shown. Warming
  // netCache here turns the user's normal lookup into a synchronous hit.
  // Prefetch failures are silent on purpose: miss logging belongs to the
  // normal lookup path in loadAnswers(), not to this speculative warm-up.
  function enqueuePrefetch(prompt) {
    if (!prompt) return;
    if (state.prefetchCount >= PREFETCH_MAX) {
      state.prefetchQueue.length = 0; // a large /deal batch must not build a backlog
      return;
    }
    const key = keyFor(prompt);
    if (!key || state.prefetchSeen.has(key)) return;
    if (state.netCache.has(key)) return; // already warm
    state.prefetchSeen.add(key);
    state.prefetchQueue.push({ prompt, key });
    drainPrefetch();
  }

  function drainPrefetch() {
    // Enforce the cap here too: a single /deal response can enqueue far more
    // prompts than the cap before any of the in-flight slots free up.
    while (state.prefetchActive < PREFETCH_CONCURRENCY
           && state.prefetchCount < PREFETCH_MAX
           && state.prefetchQueue.length) {
      const job = state.prefetchQueue.shift();
      if (!job) continue;
      if (state.netCache.has(job.key)) continue; // warmed while queued
      state.prefetchActive++;
      state.prefetchCount++;
      request('/api/answers?q=' + encodeURIComponent(job.prompt), {
        timeout: LOOKUP_TIMEOUT,
        retries: 1, // one retry max — never hammer the bridge for a guess
      }).then((data) => {
        // Only successful lookups are cached. If the user's own lookup won the
        // race, do not overwrite its (fresher) result.
        if (!state.netCache.has(job.key)) state.netCache.set(job.key, data);
      }).catch(() => {
        // Silent by design: no reportMiss / logLookupFailure here.
      }).then(() => {
        state.prefetchActive--;
        drainPrefetch();
      });
    }
    if (state.prefetchCount >= PREFETCH_MAX) state.prefetchQueue.length = 0;
  }

  // ---- panel -------------------------------------------------------------
  GM_addStyle(`
    #ka-root{
      /* Reference skin: a white card lifted off the dark game, with a soft
         lavender→peach accent. All values are CSS variables for easy recall. */
      --ka-ink:#302c3c;          /* bold dark titles */
      --ka-ink-2:#6d6979;        /* muted grey secondary */
      --ka-ink-3:#928da0;        /* quiet metadata */
      --ka-surface:#ffffff;      /* card surfaces */
      --ka-surface-2:#f5f4f8;    /* light grey tracks / grouped blocks */
      --ka-surface-3:#fbfaff;
      --ka-line:#ebe9f1;
      --ka-line-strong:#ddd9e8;
      --ka-accent:#8a6cc0;       /* lavender-violet */
      --ka-accent-deep:#6547a3;  /* text-safe accent */
      --ka-accent-soft:#f2edfb;
      --ka-grad-a:#cdb1e6;
      --ka-grad-b:#f7d9c9;
      --ka-success:#2f7d5b;
      --ka-success-soft:#e8f6ef;
      --ka-error:#b04a4a;
      --ka-error-soft:#fdeeee;
      --ka-shadow:0 12px 32px rgba(52,38,78,.18), 0 2px 8px rgba(52,38,78,.08);
      --ka-shadow-sm:0 2px 7px rgba(52,38,78,.10);
      position:fixed; top:18px; right:18px; z-index:2147483000;
      width:min(312px, calc(100vw - 24px));
      max-height:min(74vh,640px); display:flex; flex-direction:column;
      background:var(--ka-surface); border:1px solid var(--ka-line); border-radius:18px;
      box-shadow:var(--ka-shadow);
      color:var(--ka-ink); font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
      font-variant-numeric:tabular-nums; overflow:hidden; overflow-wrap:anywhere;
      caret-color:var(--ka-accent-deep);
      animation:ka-in .24s cubic-bezier(.16,1,.3,1) both;
    }
    @keyframes ka-in{from{opacity:0;transform:translate3d(0,-6px,0) scale(.99)}to{opacity:1;transform:none}}
    @keyframes ka-in-quiet{from{opacity:0}to{opacity:1}}
    @keyframes ka-pulse{0%,100%{opacity:.35}50%{opacity:1}}
    #ka-root ::selection{background:rgba(138,108,192,.22);color:var(--ka-ink)}
    #ka-root *{scrollbar-color:var(--ka-line-strong) transparent;scrollbar-width:thin}
    #ka-root *::-webkit-scrollbar{width:8px;height:8px}
    #ka-root *::-webkit-scrollbar-track{background:transparent}
    #ka-root *::-webkit-scrollbar-thumb{background:var(--ka-line-strong);border-radius:99px;border:2px solid var(--ka-surface)}
    /* Header: brand glyph + bold title / muted subtitle, count pill, quiet hide. */
    #ka-head{
      display:flex; align-items:flex-start; gap:9px; padding:14px 14px 13px;
      flex:none; min-width:0; border-bottom:1px solid var(--ka-line);
      background:linear-gradient(120deg, rgba(205,177,230,.20), rgba(247,217,201,.16));
    }
    .ka-brand{
      flex:none; width:30px; height:30px; border-radius:10px;
      display:grid; place-items:center; color:var(--ka-accent-deep);
      background:linear-gradient(135deg,var(--ka-grad-a),var(--ka-grad-b));
      box-shadow:var(--ka-shadow-sm);
    }
    .ka-ico{width:13px;height:13px;flex:none;color:var(--ka-accent-deep)}
    .ka-ico-brand{width:17px;height:17px}
    .ka-heading{flex:1;min-width:0}
    #ka-title{
      margin:0; font-size:14.5px; font-weight:700; letter-spacing:-.018em;
      line-height:1.3; color:var(--ka-ink); text-wrap:balance;
    }
    .ka-subtitle{
      margin:2px 0 0; font-size:11.5px; font-weight:450; line-height:1.35;
      color:var(--ka-ink-2); text-wrap:pretty;
    }
    #ka-count{
      flex:none; align-self:flex-start; display:inline-flex; align-items:center; gap:4px;
      background:linear-gradient(135deg,var(--ka-grad-a),var(--ka-grad-b));
      color:#3b2b52; border:1px solid rgba(255,255,255,.8); border-radius:999px;
      padding:3px 8px; font-size:11px; font-weight:700; line-height:1.2;
      box-shadow:var(--ka-shadow-sm);
    }
    #ka-count::before{
      content:""; width:10px; height:10px; flex:none; border-radius:50%;
      background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 1.6 9.8 6.2 14.4 8 9.8 9.8 8 14.4 6.2 9.8 1.6 8 6.2 6.2z' fill='%233b2b52'/%3E%3C/svg%3E") center/contain no-repeat;
    }
    #ka-count[hidden]{display:none}
    #ka-toggle{
      appearance:none; flex:none; align-self:flex-start; cursor:pointer; font:inherit;
      background:rgba(255,255,255,.85); color:var(--ka-ink-2);
      border:1px solid var(--ka-line); border-radius:999px;
      padding:4px 9px; font-size:11px; font-weight:600; line-height:1.3;
      box-shadow:var(--ka-shadow-sm);
      transition:background-color .16s ease,color .16s ease,border-color .16s ease;
    }
    /* Toggles are white raised pills that sit on a light grey track. */
    #ka-auto,#ka-bot{
      appearance:none; cursor:pointer; font:inherit; font-size:12px; font-weight:650;
      line-height:1.3; white-space:nowrap; color:var(--ka-ink);
      background-color:#fff; background-repeat:no-repeat;
      background-position:10px center; background-size:13px 13px;
      border:1px solid var(--ka-line); border-radius:9px;
      padding:7px 10px 7px 29px; box-shadow:var(--ka-shadow-sm);
      transition:background-color .16s ease,border-color .16s ease,color .16s ease,box-shadow .16s ease;
    }
    #ka-auto{
      background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236d6979' stroke-width='1.8' stroke-linejoin='round'%3E%3Cpath d='M5.5 3.5 18.3 11.6l-5.6 1.1-2.4 5.5z'/%3E%3C/svg%3E");
      flex:none; min-width:132px;
    }
    #ka-bot{
      background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236547a3' stroke-width='1.8' stroke-linejoin='round'%3E%3Cpath d='M8 5.5 18 12 8 18.5z'/%3E%3C/svg%3E");
      flex:none; min-width:128px; color:var(--ka-accent-deep); border-color:#dcd0ef;
    }
    .ka-autorow{
      display:flex; flex-wrap:wrap; align-items:center; gap:7px; min-width:0;
      background:var(--ka-surface-2); border:1px solid var(--ka-line);
      border-radius:12px; padding:5px 6px;
    }
    .ka-autolabel{flex:none;min-width:52px;color:var(--ka-ink-2);font-size:10.5px;font-weight:600;line-height:1.25}
    #ka-auto:disabled{opacity:.55;cursor:not-allowed;background-color:var(--ka-surface-2)}
    #ka-toggle:hover{background:#fff;color:var(--ka-ink)}
    #ka-auto:hover:not(:disabled),#ka-bot:hover{background-color:var(--ka-surface-3);border-color:#cdbdea}
    #ka-toggle:active,#ka-auto:active,#ka-bot:active{background-color:var(--ka-accent-soft)}
    #ka-toggle:focus-visible,#ka-auto:focus-visible,#ka-bot:focus-visible{outline:2px solid var(--ka-accent);outline-offset:2px}
    #ka-auto[aria-pressed="true"],#ka-bot[aria-pressed="true"]{
      background-color:var(--ka-accent-soft); color:var(--ka-accent-deep);
      border-color:#cdbdea; font-weight:700;
    }
    /* Body: each grouped block is a quiet, inset panel — not a nested card. */
    #ka-body{padding:12px;overflow:auto;display:grid;gap:12px;min-height:0;background:var(--ka-surface)}
    #ka-root[data-collapsed="true"] #ka-body{display:none}
    .ka-card{
      background:var(--ka-surface-3); border:1px solid var(--ka-line);
      border-radius:13px; padding:11px;
    }
    .ka-status-card{
      background:linear-gradient(120deg, rgba(242,237,251,.92), rgba(252,244,238,.78));
      border-color:#e7dff3;
    }
    .ka-section-head{
      display:flex; align-items:center; gap:6px; margin:0 0 8px;
      color:var(--ka-ink-2); font-size:11px; font-weight:650; line-height:1.3;
      letter-spacing:.005em;
    }
    #ka-status{
      margin:0; color:var(--ka-ink-2); font-size:12px; line-height:1.45;
      font-weight:500; min-height:1.45em; display:flex; gap:8px;
      align-items:flex-start; text-wrap:pretty;
    }
    #ka-status::before{
      content:""; width:9px; height:9px; border-radius:50%;
      background:var(--ka-accent); flex:none; margin-top:4px;
      box-shadow:0 0 0 3px var(--ka-accent-soft);
    }
    #ka-status[data-kind="loading"]{color:var(--ka-accent-deep)}
    #ka-status[data-kind="loading"]::before{animation:ka-pulse 1.3s ease-in-out infinite}
    #ka-status[data-kind="ok"]{color:var(--ka-success);font-weight:650}
    #ka-status[data-kind="ok"]::before{background:var(--ka-success);box-shadow:0 0 0 3px var(--ka-success-soft)}
    #ka-status[data-kind="error"]{color:var(--ka-error);font-weight:650}
    #ka-status[data-kind="error"]::before{background:var(--ka-error);box-shadow:0 0 0 3px var(--ka-error-soft)}
    /* Chip field: a wrapping flex row, not a one-answer-per-line list.
       Short answers share a line; long answers claim the full row. */
    #ka-list{
      display:flex; flex-wrap:wrap; align-items:stretch; gap:6px;
      margin:0; padding:0; list-style:none; min-width:0;
    }
    #ka-list>li{min-width:0;max-width:100%}
    .ka-group{
      /* Bank labels span their own row and stay put while the list scrolls,
         so the user never loses which near-duplicate prompt an answer belongs to. */
      flex:0 0 100%;
      position:sticky; top:0; z-index:2;
      display:flex; justify-content:space-between; gap:8px; align-items:center;
      color:var(--ka-ink-2); font-size:11px; line-height:1.35; letter-spacing:.01em;
      background:var(--ka-surface); border-bottom:1px solid var(--ka-line);
      padding:6px 2px; margin-top:4px; text-wrap:balance;
    }
    .ka-group:first-child{margin-top:0}
    .ka-group .ka-group-name{color:var(--ka-ink-2);min-width:0}
    .ka-group .ka-match{
      color:var(--ka-accent-deep); background:var(--ka-accent-soft);
      border-radius:999px; padding:2px 7px; font-weight:700; flex:none;
    }
    /* Every chip takes at least half a row, so two short answers pack together. */
    #ka-list>li:not(.ka-group):not(.ka-empty){flex:1 1 auto;min-width:calc(50% - 3px)}
    /* Long answers opt out of pairing and read cleanly across the whole panel. */
    #ka-list>li.ka-wide{flex-basis:100%}
    .ka-chip{
      position:relative; appearance:none; display:flex; align-items:center;
      width:100%; height:100%; min-width:0; min-height:36px; text-align:start; cursor:pointer;
      background-color:#fff; color:var(--ka-ink); border:1px solid var(--ka-line);
      border-radius:10px; padding:7px 10px; font:inherit; font-size:12.5px;
      line-height:1.35; overflow-wrap:anywhere; box-shadow:0 1px 2px rgba(52,38,78,.05);
      transition:background-color .16s ease,border-color .16s ease,color .16s ease,box-shadow .16s ease;
    }
    .ka-chip::after{
      content:""; position:absolute; inset-inline-end:8px; top:50%;
      width:12px; height:12px; transform:translateY(-50%) scale(.6); opacity:0;
      background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3 8.5 6.2 11.7 13 5' fill='none' stroke='%236547a3' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/contain no-repeat;
      transition:opacity .16s ease,transform .16s ease;
    }
    .ka-chip:hover{background-color:var(--ka-surface-3);border-color:#cdbdea;box-shadow:var(--ka-shadow-sm)}
    .ka-chip:active{background-color:var(--ka-accent-soft)}
    .ka-chip:focus-visible{outline:2px solid var(--ka-accent);outline-offset:2px}
    .ka-chip[data-filled="true"]{
      background-color:var(--ka-accent-soft); color:var(--ka-accent-deep);
      border-color:#cdbdea; font-weight:650; padding-inline-end:24px;
    }
    .ka-chip[data-filled="true"]::after{opacity:1;transform:translateY(-50%) scale(1)}
    .ka-empty{
      flex:0 0 100%;
      color:var(--ka-ink-2); font-size:12px; line-height:1.5; text-align:center;
      padding:20px 14px; margin:0; text-wrap:pretty;
      background:var(--ka-surface-2); border:1px dashed var(--ka-line-strong);
      border-radius:12px;
    }
    #ka-botbar{
      flex:none; margin:0 12px 8px; padding:11px; display:grid; gap:10px;
      background:linear-gradient(180deg, #f7f6fa, #fbfaff);
      border:1px solid var(--ka-line); border-radius:13px;
    }
    #ka-botbar[hidden]{display:none}
    #ka-botdeps{display:grid;gap:8px;border-top:1px solid var(--ka-line);padding-top:9px;margin-top:1px}
    #ka-botdeps[hidden]{display:none}
    .ka-botnote{margin:0;color:var(--ka-ink-2);font-size:10.5px;line-height:1.4;text-wrap:pretty}
    .ka-botrow{display:flex;align-items:center;gap:8px}
    .ka-botrow label{
      display:inline-flex; align-items:center; gap:5px; flex:none; min-width:56px;
      color:var(--ka-ink-2); font-size:11px; font-weight:600;
    }
    .ka-botrow select{
      flex:1; min-width:0; appearance:none; cursor:pointer;
      /* appearance:none removes the native arrow — draw a quiet chevron. */
      background-color:#fff;
      background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.6 6 6.4 11 1.6' fill='none' stroke='%238a8496' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      background-repeat:no-repeat; background-position:right 9px center; background-size:12px 8px;
      color:var(--ka-ink); border:1px solid var(--ka-line-strong); border-radius:9px;
      padding:7px 26px 7px 9px; font:inherit; font-size:11.5px; line-height:1.3;
      box-shadow:0 1px 2px rgba(52,38,78,.05);
    }
    .ka-botrow select:hover{border-color:#cdbdea}
    .ka-botrow select:focus-visible{outline:2px solid var(--ka-accent);outline-offset:1px}
    #ka-botstate{
      flex:1 1 100%; min-width:0; display:inline-flex; align-items:center; gap:6px;
      color:var(--ka-ink-2); font-size:11px; line-height:1.35;
      padding:2px 2px 0; overflow-wrap:anywhere; text-wrap:pretty;
    }
    #ka-botstate::before{
      content:""; width:6px; height:6px; border-radius:50%;
      background:var(--ka-ink-3); flex:none;
    }
    #ka-bot[aria-pressed="true"] ~ #ka-botstate::before{
      background:var(--ka-success); box-shadow:0 0 0 3px var(--ka-success-soft);
    }
    #ka-foot{
      flex:none; padding:2px 14px 12px; color:var(--ka-ink-3);
      font-size:10.5px; line-height:1.4; text-align:center; text-wrap:pretty;
    }
    #ka-foot a{color:var(--ka-accent-deep);text-decoration:none;font-weight:650}
    #ka-foot a:hover,#ka-foot a:focus-visible{text-decoration:underline}
    #ka-foot a:focus-visible{outline:2px solid var(--ka-accent);outline-offset:2px;border-radius:3px}
    @media (pointer: coarse){
      .ka-botrow select{min-height:44px}
      .ka-chip,#ka-toggle,#ka-auto,#ka-bot{min-height:44px}
      #ka-toggle,#ka-auto,#ka-bot{padding-inline:12px}
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
      #ka-root,#ka-toggle,#ka-auto,#ka-bot,.ka-chip,.ka-autorow,.ka-botrow select{border:1px solid CanvasText}
      #ka-status::before,
      #ka-bot[aria-pressed="true"] ~ #ka-botstate::before{background:Highlight}
      #ka-toggle:focus-visible,#ka-auto:focus-visible,#ka-bot:focus-visible,.ka-chip:focus-visible{outline:2px solid Highlight}
    }
    @media (prefers-reduced-motion: reduce){
      #ka-root{animation:ka-in-quiet .12s ease-out both}
      #ka-status[data-kind="loading"]::before{animation:none;opacity:1}
      /* Keep all color feedback instant; drop every scripted transition. */
      #ka-toggle,#ka-auto,#ka-bot,.ka-chip,.ka-chip::after,.ka-botrow select{transition:none}
    }
  `);

  const root = document.createElement('div');
  root.id = 'ka-root';
  root.dataset.collapsed = 'false';
  // Small monochrome icons, drawn once and reused. They inherit currentColor
  // so they recolor with state (no images, no CDN, no extra dependencies).
  const ICON = {
    brand: '<svg class="ka-ico ka-ico-brand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/><path d="M19 2.5v3M17.5 4h3"/></svg>',
    list: '<svg class="ka-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 14h8M8 17h5"/></svg>',
    sliders: '<svg class="ka-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>',
    cursor: '<svg class="ka-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 3.5 18.3 11.6l-5.6 1.1-2.4 5.5z"/></svg>',
    play: '<svg class="ka-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M8 5.5 18 12 8 18.5z"/></svg>',
    pick: '<svg class="ka-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h11M4 18h7"/></svg>',
    mode: '<svg class="ka-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>',
  };

  root.innerHTML =
    '<div id="ka-head">' +
      '<span class="ka-brand" aria-hidden="true">' + ICON.brand + '</span>' +
      '<div class="ka-heading">' +
        '<h2 id="ka-title">Krillion rare answers</h2>' +
        '<p class="ka-subtitle">100-point answers</p>' +
      '</div>' +
      '<span id="ka-count" hidden></span>' +
      '<button id="ka-toggle" type="button" aria-controls="ka-body" aria-expanded="true">Hide</button>' +
    '</div>' +
    '<div id="ka-body">' +
      '<div class="ka-card ka-status-card">' +
        '<p id="ka-status" role="status" aria-live="polite" aria-atomic="true" data-kind="loading">Connecting to local bridge…</p>' +
      '</div>' +
      '<div class="ka-answers">' +
        '<div class="ka-section-head">' + ICON.list + '<span>Known answers</span></div>' +
        '<ul id="ka-list"></ul>' +
      '</div>' +
    '</div>' +
    '<div id="ka-botbar">' +
      '<div class="ka-section-head">' + ICON.sliders + '<span>Playback</span></div>' +
      '<div class="ka-autorow">' + ICON.cursor +
        '<span class="ka-autolabel">Manual</span>' +
        '<button id="ka-auto" type="button" aria-pressed="false" title="When on, clicking an answer also submits it — no Enter needed.">Dive on click: Off</button>' +
      '</div>' +
      '<div class="ka-autorow">' + ICON.play +
        '<span class="ka-autolabel">Auto-play</span>' +
        '<button id="ka-bot" type="button" aria-pressed="false" aria-describedby="ka-botnote" title="Plays whole dives for you: picks an answer, fills it and submits it. Use Pick and Mode to choose how.">Play for me: Off</button>' +
        '<span id="ka-botstate" title="Play for me is off — you answer prompts yourself.">Off · you are playing</span>' +
      '</div>' +
      '<p class="ka-botnote" id="ka-botnote">While Play for me is on, it drives the dive and pauses Dive on click.</p>' +
      '<div id="ka-botdeps" hidden>' +
        '<div class="ka-botrow"><label for="ka-pick">' + ICON.pick + 'Pick</label>' +
          '<select id="ka-pick">' +
            '<option value="random">Random 100-point answer</option>' +
            '<option value="top">Top of list</option>' +
            '<option value="god">God player · Gaussian mix, peak at 85</option>' +
          '</select></div>' +
        '<div class="ka-botrow"><label for="ka-mode">' + ICON.mode + 'Mode</label>' +
          '<select id="ka-mode">' +
            '<option value="classic">Classic</option>' +
            '<option value="krillocity">Krillocity · daily race</option>' +
            '<option value="marathon5">Multiplayer · 5s / 50 prompts</option>' +
            '<option value="showoff">Multiplayer · most players</option>' +
            '<option value="duel">1 vs 1</option>' +
          '</select></div>' +
      '</div>' +
    '</div>' +
    '<div id="ka-foot">Krillion rare answers · local archive · <a href="https://github.com/berliandro/krillion-answer-database" target="_blank" rel="noopener noreferrer">by berliandro · GitHub</a></div>';

  const $ = (id) => root.querySelector('#' + id);
  const statusEl = $('ka-status');
  const listEl = $('ka-list');
  const countEl = $('ka-count');

  function renderAuto() {
    const btn = $('ka-auto');
    btn.setAttribute('aria-pressed', String(state.autoEnter));
    btn.textContent = state.autoEnter ? 'Dive on click: On' : 'Dive on click: Off';
    btn.disabled = botActive;
    btn.setAttribute('aria-disabled', String(botActive));
    btn.title = botActive
      ? 'Unavailable while Play for me is on — it already submits answers for you.'
      : 'When on, clicking an answer also submits it — no Enter needed.';
  }
  function setAuto(on) {
    state.autoEnter = !!on;
    try { GM_setValue(AUTO_KEY, state.autoEnter); } catch (e) { /* no storage */ }
    renderAuto();
    if (!botActive) {
      status(state.autoEnter
        ? 'Dive on click on — clicking an answer will submit it.'
        : 'Dive on click off — you press Enter.', state.autoEnter ? 'ok' : '');
    }
  }

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
        html += `<li class="ka-group" aria-label="Bank: ${escapeHtml(g.question)} — ${pct}% match">` +
                `<span class="ka-group-name">${escapeHtml(g.question)}</span>` +
                `<span class="ka-match">${pct}%</span></li>`;
      }
      g.answers.forEach((a) => {
        // Short answers pair up in the wrapping chip field; long ones get a
        // full row so the text reads without cramped wrapping.
        const wide = String(a).length > 18 ? ' class="ka-wide"' : '';
        html += `<li${wide}><button class="ka-chip" type="button" data-a="${escapeHtml(a)}" data-q="${escapeHtml(g.question)}">${escapeHtml(a)}</button></li>`;
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
      // Fallbacks are mutually exclusive: after Enter, never also click DIVE.
      return true;
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
    // A fresh selection closes the lingering-refusal tag for the old answer.
    // refusalKey is left intact so the stale line is not logged again.
    state.refusalActive = false;
    state.answerQuestion[answer] = btn.dataset.q || state.question;
    listEl.querySelectorAll('.ka-chip').forEach((b) => { b.dataset.filled = 'false'; });
    btn.dataset.filled = 'true';
    if (state.autoEnter && state.groups.length > 1) {
      status('Several banks match — choose manually. Dive on click is paused for this prompt.', 'error');
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

  // ONE key source for premap, netCache, prefetch and lookup. The bridge's
  // precomputed `nq` (rewrite_query(normalise(q))) is authoritative when
  // present; normLocal is only the legacy fallback for old bridges. Calling
  // normLocal no longer happens for every row of /api/all — the hot path just
  // reads item.nq.
  function keyFor(itemOrText) {
    if (itemOrText && typeof itemOrText === 'object') {
      if (itemOrText.nq) return itemOrText.nq;
      return normLocal(itemOrText.q);
    }
    return normLocal(itemOrText);
  }

  function buildPremap(data) {
    const map = new Map();
    (data || []).forEach((item) => {
      if (item && item.q) map.set(keyFor(item), { q: item.q, answers: item.answers || [] });
    });
    return map;
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
    state.loadToken = (state.loadToken || 0) + 1;
    const loadToken = state.loadToken;
    // A request token as well as the prompt text: a repeated prompt must not
    // let an older retry apply its result on top of a newer load.
    const isStale = () => state.question !== question || state.loadToken !== loadToken;
    state.answers = [];
    state.groups = [];
    state.lastFilled = '';
    state.refusalActive = false;
    render();

    // The first prompt can appear before preloading finishes — wait briefly,
    // but never let a forever-retrying /api/all block this prompt's lookup.
    if (!state.premap && state.preloadPromise) {
      try {
        await Promise.race([
          state.preloadPromise,
          new Promise((r) => setTimeout(r, LOOKUP_TIMEOUT)),
        ]);
      } catch (e) { /* continue with network */ }
    }
    if (isStale()) return;

    // Fast path: the whole rare-answer archive was loaded once at page start.
    // Same key source as premap/prefetch/netCache (nq when the bridge supplies
    // one, normLocal otherwise) so the first prompt stays a cache hit.
    const key = keyFor(question);
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
      const data = await request('/api/answers?q=' + encodeURIComponent(question), {
        timeout: LOOKUP_TIMEOUT,
        forever: true,
        isStale,
        onFinalFail: (info) => logLookupFailure(question, info),
      });
      if (isStale()) return; // a newer prompt won while we were retrying
      clearLookupFailure();
      state.netCache.set(key, data); // only successful lookups are cached
      applyResult(data, question);
    } catch (e) {
      // Stale requests are cancelled on purpose — never log them as misses.
      if (isStale()) return;
      reportMiss(question, 'unreachable: ' + (e && e.message || e));
      status(e && /timeout/.test(e.message)
        ? 'The local archive took too long to answer — retrying on the next prompt.'
        : 'Can’t reach the local archive. Start injection/bridge.py.', 'error');
    }
  }

  function storageGet(key, fallback) {
    try { return GM_getValue(key, fallback); } catch (e) { return fallback; }
  }
  function storageSet(key, value) {
    try { GM_setValue(key, value); } catch (e) { /* no storage available */ }
  }

  async function preloadAnswers() {
    // Start the 10–85pt snapshot BEFORE awaiting /api/all so the two downloads
    // overlap. It is intentionally independent: a missing/old bridge (404 on
    // /api/all-tier) must never delay or break the 100pt fast path.
    request('/api/all-tier', { timeout: LOOKUP_TIMEOUT, retries: 1 })
      .then((d) => {
        const map = new Map();
        const rows = (d && d.data) || [];
        rows.forEach((row) => {
          if (!row) return;
          const q = Array.isArray(row) ? row[0] : row.q;
          const answers = Array.isArray(row) ? row[1] : row.answers;
          if (!q) return;
          // Same key source as the rare premap (keyFor -> bridge nq / normLocal).
          // Keep each answer WITH its point value for the God group draw.
          map.set(keyFor(q), parseTierAnswers(answers));
        });
        state.tierPremap = map;
      })
      .catch(() => {
        // No /api/all-tier on an old bridge, or any transient failure: ready but
        // empty. God mode then uses the rare list — no crash, no error log.
        state.tierPremap = new Map();
      })
      .then(() => {
        if (!bot.on) return;
        // If a God fallback was started while the premap was pending, let this
        // one tick re-read the current prompt from the now-ready map.
        if (state.question) state.deepcutPrompt = '';
        setTimeout(botTick, 0); // exactly one immediate tick; no second timer
      });

    const cachedMeta = storageGet(SNAPSHOT_META_KEY, null);
    const cachedData = storageGet(SNAPSHOT_DATA_KEY, null);
    const hasCache = !!(cachedMeta && Array.isArray(cachedData));
    const hasMetaVersion = hasCache &&
      (cachedMeta.version !== undefined || cachedMeta.etag !== undefined);

    // A version-aware bridge may answer a conditional /api/all with no
    // payload. Unknown query params are ignored by the current bridge, so this
    // is harmless today and enables "no re-download" when the bridge supports
    // it. The first-prompt fast path never depends on the conditional reply.
    let path = '/api/all';
    if (hasMetaVersion) {
      path += '?v=' + encodeURIComponent(String(cachedMeta.version))
           + '&etag=' + encodeURIComponent(String(cachedMeta.etag || ''));
    }

    try {
      const data = await request(path, {
        timeout: LOOKUP_TIMEOUT,
        forever: true,
        onFinalFail: (info) => logLookupFailure(state.question || '(preload)', info),
      });
      clearLookupFailure();

      const hasVersion = data && (data.version !== undefined || data.etag !== undefined);
      let source = data && data.data;

      if (hasVersion) {
        const meta = { version: data.version, etag: data.etag };
        const same = hasCache && cachedMeta.version === meta.version
                     && cachedMeta.etag === meta.etag;
        if (!Array.isArray(source) && same) {
          // "Unchanged" conditional reply with no payload: reuse the cached
          // parsed snapshot rather than downloading/re-parsing it again.
          source = cachedData;
        } else if (Array.isArray(source)) {
          // Cache the parsed snapshot only when it is reasonably sized.
          let chars = 0;
          try { chars = JSON.stringify(source).length; } catch (e) { chars = Infinity; }
          if (chars <= SNAPSHOT_MAX_CHARS) {
            storageSet(SNAPSHOT_META_KEY, meta);
            storageSet(SNAPSHOT_DATA_KEY, source);
          }
        }
      }
      // No version/etag (old bridge): behave exactly as today — use data.data
      // and never touch snapshot storage.

      const map = buildPremap(source || []);
      state.premap = map;
      if (state.question) {
        const key = keyFor(state.question);
        if (map.has(key)) {
          const item = map.get(key);
          applyResult({
            exact: true,
            groups: [{ question: item.q, score: 1, answers: item.answers }],
          }, state.question);
        }
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
    if (/^\/krillocity\/?$/.test(location.pathname)) return 'krillocity';
    // Live-verified: the multiplayer board (.kr-board-rows) exists only between
    // rounds, so it cannot identify the mode while a prompt is being answered.
    // The arena stage / main container is present for the whole room. The intro
    // keeps "Play multiplayer" buttons hidden in the DOM, so never trust those.
    if (isVisible('.kr-stage-multi') || isVisible('.kr-arena-main')
        || isVisible('.kr-board-rows') || isVisible('.kr-over-multi')) return 'multiplayer';
    if (isVisible('.kr-duel-board') || /duel/i.test(location.hash)) return '1v1';
    return 'classic';
  }

  // Every observable game state, mapped from live play on 2026-11-23 (including
  // the custom 6-second/50-prompt Marathon room). Order matters: the most
  // specific / active states are checked first. See injection/STATES.md for the
  // log / no-log decision attached to each state.
  function gameState() {
    if (visible('.kr-duel-board, .kd-play, .kd-versus, .kd-tab-rule, .kd-result-keys')) return 'duel';
    if (isVisible('.kr-over') || isVisible('.kr-over-multi') || isVisible(SEL.row)) return 'results';
    if (visible('.kr-guess-range, .kr-make-go')) return 'create-room';
    if (visible('.kr-lobby-tab, .kr-room-row')) return 'lobby';
    if (state.refusalActive) return 'refusal';
    if (isVisible(SEL.prompt)) {
      // In fast rooms the prompt appears ~3s BEFORE the input is mounted.
      return visible(SEL.input) ? 'answering' : 'prompt-reveal';
    }
    if (visible('.kr-stage-multi, .kr-wait, .kr-board-head')) return 'arena-wait';
    if (isVisible(SEL.intro) || visible('button.kr-begin')) return 'intro';
    return 'loading-shell'; // cold load: article shell painted, game not mounted
  }

  // Snapshot of the answer input at the moment of a log event. This is the
  // "state of the inputs" the archive needs to interpret an outcome.
  function inputState() {
    const el = document.querySelector(SEL.input);
    if (!el) return { present: false, visible: false, disabled: null, readOnly: null, placeholder: '' };
    return {
      present: true,
      visible: el.offsetParent !== null || el.getClientRects().length > 0,
      disabled: !!el.disabled,
      readOnly: !!el.readOnly,
      placeholder: el.placeholder || '',
    };
  }

  // Attach the observed game state + input state to every archive event so a
  // reviewer can judge each outcome against the situation it happened in.
  function ctx() {
    return { game_state: gameState(), input_state: inputState(), mode: mode() };
  }

  async function reportScore(question, answer, points, tier) {
    const key = question + '\u0000' + answer + '\u0000' + points;
    if (state.scored.has(key)) return;
    state.scored.add(key);
    status(`Scored ${points} for “${answer}” — logging…`);
    try {
      await request('/api/evidence', {
        method: 'POST',
        body: Object.assign(ctx(), {
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
        }),
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
      state.refusalActive = true;
      state.refusedAnswers.add(state.question + '\u0000' + answer);
      reportPrompt('refused', state.question, {
        candidates: candidateInfo(), chosen_bank: bank, answer,
        refusal: line.slice(0, 200), mode: mode(),
        exact: state.exact, auto: state.autoEnter,
      });
      request('/api/evidence', {
        method: 'POST',
        body: Object.assign(ctx(), {
          screen_prompt: state.question, chosen_bank: bank, answer,
          outcome: 'refused', refusal: line.slice(0, 200),
          exact: state.exact,
          group_count: state.groups.length, auto: state.autoEnter,
        }),
      }).catch(() => queuePost('/api/evidence', Object.assign(ctx(), {
        screen_prompt: state.question, chosen_bank: bank, answer,
        outcome: 'refused', refusal: line.slice(0, 200),
      })));
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
    // The shared multiplayer board head shows OTHER players' scores (live-
    // verified in the 5s/6s Marathon rooms). Parsing it as our verdict would
    // attribute a stranger's points to our answer — forbidden by policy. Only
    // the solo/classic reveal is authoritative for a per-answer score.
    const board = mode() === 'classic' ? document.querySelector(SEL.board) : null;
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
    // A scored verdict closes this round. Clear per-answer state so a repeated
    // prompt (same text, new round) gets answered instead of being skipped.
    resetBotRound(true);

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
    const body = Object.assign(ctx(), { event, mode: bot.mode }, extra || {});
    request('/api/bot-log', { method: 'POST', body, retries: 1 })
      .catch(() => queuePost('/api/bot-log', body));
  }

  function reportPrompt(kind, prompt, extra) {
    const body = Object.assign(ctx(), { kind, screen_prompt: prompt }, extra || {});
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
    const body = Object.assign(ctx(), { prompt, reason }, extra || {});
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
    // The observer is debounced to 50ms, so a second tick can land while this
    // one is mid-await. Without a guard the two passes click each other's row
    // heads and leave the bank collapsed/expanded in an inconsistent state.
    if (state.bankCapturing) return;
    state.bankCapturing = true;
    try {
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
          // Keep unparseable/missing points as null ("no signal"), NOT 0. The
          // bridge must not demote a correct answer just because a selector
          // drifted or the site formatted the tier text unexpectedly.
          const ptsRaw = (line.querySelector(SEL.linePoints)?.textContent || '').trim();
          const p = ptsRaw && isFinite(Number(ptsRaw)) ? Number(ptsRaw) : null;
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
    } finally {
      state.bankCapturing = false;
    }
  }

  // ---- auto-play engine --------------------------------------------------
  const BOT_KEY = 'krillion.bot.v1';
  const PICK_KEY = 'krillion.bot.pick.v1';
  const MODE_KEY = 'krillion.bot.mode.v1';
  const bot = {
    on: false, pick: 'random', mode: 'classic',
    timer: null, busy: false, answered: new Set(), lastAction: '', state: 'idle',
    submittedForPrompt: new Set(), lastSubmitAt: 0, answerCount: 0,
    roundClosed: false, answeredInput: null,
  };

  // A round ends on a verdict/results transition, not necessarily on a prompt
  // TEXT change — a Marathon can show the same prompt again later. Clear the
  // per-round answer state there so the repeated prompt is still answered.
  // `closed` also records that the current round is over, so the bot cannot
  // re-answer the still-open question while its verdict is on screen.
  function resetBotRound(closed) {
    bot.answeredPrompt = '';
    bot.submittedForPrompt.clear();
    bot.roundClosed = !!closed;
  }

  function botStatus(text) {
    bot.state = text;
    const el = document.getElementById('ka-botstate');
    if (el) el.textContent = text;
  }

  function setBot(on) {
    bot.on = !!on;
    botActive = bot.on;
    const deps = document.getElementById('ka-botdeps');
    if (deps) deps.hidden = !bot.on;
    try { GM_setValue(BOT_KEY, bot.on); } catch (e) { /* no storage */ }
    const btn = document.getElementById('ka-bot');
    btn.setAttribute('aria-pressed', String(bot.on));
    btn.textContent = bot.on ? 'Play for me: On' : 'Play for me: Off';
    btn.title = bot.on
      ? 'Playing dives for you. Click again to stop and take control.'
      : 'Plays whole dives for you: picks an answer, fills it and submits it.';
    renderAuto();
    if (bot.on) {
      botStatus('starting…');
      reportBot('bot-start', { note: bot.mode + ' / ' + bot.pick });
      bot.timer = setInterval(botTick, 500);
      botTick();
    } else {
      if (bot.timer) clearInterval(bot.timer);
      bot.timer = null;
      botStatus('Off · you are playing');
    }
  }

  function visible(sel) {
    const el = document.querySelector(sel);
    return !!(el && (el.offsetParent !== null || el.getClientRects().length > 0));
  }

  // God mode draws a point GROUP, not a fixed cadence. Gaussian w(i) =
  // exp(-(i-4)^2 / (2*1.1^2)) over tier indices 4..9 (10..100), normalised to
  // 100%: 10=0.05%, 15=0.95%, 30=7.54%, 60=26.04%, 85=39.37%, 100=26.04%.
  const GOD_TIER_POINTS = [10, 15, 30, 60, 85, 100];
  const GOD_TIER_CHANCE = { 10: 0.05, 15: 0.95, 30: 7.54, 60: 26.04, 85: 39.37, 100: 26.04 };
  const GOD_TIER_TEXT_POINTS = {
    PLANKTON: 10, 'TOO CLEVER': 15, SCHOOLER: 30, RARE: 60,
    'DEEP CUT': 85, 'ONE IN A KRILLION': 100,
  };

  // Unknown / null / bare-string points land in the 85pt Deep Cut bucket —
  // exactly the old "deepcut" pool, now the mode of the distribution.
  function tierPointsOf(value) {
    if (value === null || value === undefined || value === '') return 85;
    if (typeof value === 'string') {
      const text = value.trim().toUpperCase();
      if (GOD_TIER_TEXT_POINTS[text]) return GOD_TIER_TEXT_POINTS[text];
    }
    const n = Number(value);
    if (GOD_TIER_POINTS.indexOf(n) !== -1) return n;
    if (Number.isInteger(n) && n >= 0 && n <= 5) return GOD_TIER_POINTS[n]; // tierIndex
    return 85;
  }

  // /api/all-tier schema 2 rows hold [answer, points|null] pairs; an old bridge
  // sends bare answer strings. Both become {answer, points} for the premap.
  function parseTierAnswers(answers) {
    const out = [];
    (answers || []).forEach((entry) => {
      if (entry === null || entry === undefined) return;
      let answer, points;
      if (Array.isArray(entry)) {
        answer = entry[0];
        points = entry[1];
      } else if (typeof entry === 'object') {
        answer = entry.answer;
        points = entry.points;
      } else {
        answer = entry; // legacy bare string
      }
      answer = String(answer == null ? '' : answer).trim();
      if (answer) out.push({ answer, points: tierPointsOf(points) });
    });
    return out;
  }

  // Empty groups hand their chance to the nearest populated group; ties favour
  // the high-value anchors 85, then 60, then 100.
  function nearestGodGroup(points, available) {
    let bestDist = Infinity;
    let candidates = [];
    available.forEach((p) => {
      const d = Math.abs(p - points);
      if (d < bestDist) { bestDist = d; candidates = [p]; }
      else if (d === bestDist) candidates.push(p);
    });
    const preferred = [85, 60, 100];
    for (let i = 0; i < preferred.length; i++) {
      if (candidates.indexOf(preferred[i]) !== -1) return preferred[i];
    }
    return candidates.length ? candidates[0] : null;
  }

  function pickAnswer(list) {
    if (!list || !list.length) return '';
    return bot.pick === 'top' ? list[0] : list[Math.floor(Math.random() * list.length)];
  }

  function pickGodAnswer(prompt, rareList, isRace) {
    const groups = {};
    GOD_TIER_POINTS.forEach((p) => { groups[p] = []; });
    (state.deepcut || []).forEach((entry) => {
      const item = (entry && typeof entry === 'object' && !Array.isArray(entry))
        ? entry : parseTierAnswers([entry])[0];
      if (item && item.answer && groups[item.points]) groups[item.points].push(item.answer);
    });
    (rareList || []).forEach((value) => {
      const a = String(value == null ? '' : value).trim();
      if (a && groups[100].indexOf(a) === -1) groups[100].push(a);
    });
    GOD_TIER_POINTS.forEach((p) => {
      groups[p] = groups[p].filter((a) =>
        !state.refusedAnswers.has(prompt + '\u0000' + a)
        && !(isRace && bot.submittedForPrompt.has(prompt + '\u0000' + a)));
    });

    const available = GOD_TIER_POINTS.filter((p) => groups[p].length);
    if (!available.length) return '';
    const chance = {};
    // Base chances first: an empty group's mass must not be added to a bucket
    // whose own base chance is assigned later in the tier order.
    GOD_TIER_POINTS.forEach((p) => { chance[p] = groups[p].length ? GOD_TIER_CHANCE[p] : 0; });
    GOD_TIER_POINTS.forEach((p) => {
      if (groups[p].length) return;
      const target = nearestGodGroup(p, available);
      if (target !== null) chance[target] += GOD_TIER_CHANCE[p];
    });

    const draw = Math.random() * 100; // uniform in [0,100)
    let acc = 0;
    let chosen = null;
    for (let i = 0; i < GOD_TIER_POINTS.length; i++) {
      const p = GOD_TIER_POINTS[i];
      if (!chance[p]) continue; // never select from an empty group
      acc += chance[p];
      if (draw < acc) { chosen = p; break; }
    }
    if (chosen === null) {
      // Rounding guard: cumulative bands can end a hair under 100.
      for (let i = GOD_TIER_POINTS.length - 1; i >= 0; i--) {
        if (chance[GOD_TIER_POINTS[i]]) { chosen = GOD_TIER_POINTS[i]; break; }
      }
    }
    const list = groups[chosen];
    return list && list.length ? pickAnswer(list) : '';
  }

  function answerCurrentPrompt() {
    const prompt = promptText();
    const input = document.querySelector(SEL.input);
    const isRace = mode() === 'krillocity';
    if (!prompt || !input) return false;
    // A verdict/results screen is open for this round — never re-answer it.
    if (bot.roundClosed) return false;
    if (!isRace && bot.answeredPrompt === prompt) return false;
    if (isRace && Date.now() - bot.lastSubmitAt < 700) return false;
    if (state.loadedPrompt !== prompt) { botStatus('loading answers'); return false; }
    const groups = state.groups.length ? state.groups : [{ answers: state.answers || [] }];
    const rareList = groups[0].answers || [];
    if (bot.pick === 'god' && state.deepcutPrompt !== prompt) {
      state.deepcutPrompt = prompt;
      state.deepcut = [];
      const bank = (state.answerQuestion[rareList[0]] || groups[0].question || prompt);
      if (state.tierPremap !== null) {
        // Premap ready: synchronous lookup, no HTTP and no 500ms gate. Try the
        // on-screen prompt first, then the matched bank's stored question.
        const tier = state.tierPremap.get(keyFor(prompt))
          || state.tierPremap.get(keyFor(bank));
        if (tier && tier.length) state.deepcut = parseTierAnswers(tier);
      } else {
        // Premap still pending: the original async fallback stays intact, with
        // its forever retry, backoff and stale-prompt guards.
        request('/api/answers-tier?q=' + encodeURIComponent(bank)
          + '&alt=' + encodeURIComponent(prompt), {
            timeout: LOOKUP_TIMEOUT,
            forever: true,
            isStale: () => state.question !== prompt,
            onFinalFail: (info) => logLookupFailure(prompt, info),
          })
          .then((d) => {
            if (state.question !== prompt) return; // stale tier response
            if (state.tierPremap !== null) return; // premap won — ignore late reply
            clearLookupFailure();
            // Old endpoint still returns bare strings; tag them as Deep Cut.
            state.deepcut = parseTierAnswers(d.deepcut);
            state.deepcutExact = !!d.deepcut_exact;
          })
          .catch(() => { /* stale/cancelled — krillion answers remain usable */ });
      }
    }
    const noTierAnswers = bot.pick === 'god' && !state.deepcut.length;
    if (noTierAnswers && state.tierPremap === null) {
      // Premap not ready and no async result yet: keep the original gate.
      botStatus('loading 85-point answers');
      return false;
    }
    let answer;
    if (bot.pick === 'god') {
      // Gaussian point-group draw. The 100pt rare list is one of the groups,
      // so a prompt with no low-tier data still answers instead of stalling.
      answer = pickGodAnswer(prompt, rareList, isRace);
    } else {
      // Non-God picks are untouched: random/top from the 100-point list.
      const list = rareList.filter(
        (a) => !state.refusedAnswers.has(prompt + '\u0000' + a)
          && !(isRace && bot.submittedForPrompt.has(prompt + '\u0000' + a))
      );
      answer = pickAnswer(list);
    }
    if (!answer) return false;
    if (bot.pick === 'god') bot.answerCount++;
    if (isRace) {
      bot.submittedForPrompt.add(prompt + '\u0000' + answer);
      bot.lastSubmitAt = Date.now();
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, answer);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    state.lastFilled = answer;
    // Retrying with a new answer clears the lingering-refusal tag; refusalKey
    // stays put so the stale refusal line is not logged a second time.
    state.refusalActive = false;
    state.answerQuestion[answer] = groups[0].question || prompt;
    if (!isRace) bot.answeredPrompt = prompt;
    bot.answeredInput = input;
    botStatus(isRace ? 'race answer sent' : 'answered');
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
    if (bot.mode === 'krillocity') {
      if (!/^\/krillocity\/?$/.test(location.pathname)) {
        const link = document.querySelector('a.kr-peek');
        if (link && link.offsetParent !== null) {
          reportBot('krillocity-open', { note: 'Play Krillocity' });
          link.click();
          botStatus('opening Krillocity');
          return true;
        }
        return false;
      }
      if (begin && begin.offsetParent !== null) {
        reportBot('krillocity-start', { note: 'START DAILY' });
        begin.click();
        botStatus('starting daily race');
        return true;
      }
      return false;
    }
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
      if (p && p !== bot.lastPrompt) {
        bot.lastPrompt = p;
        resetBotRound(false);
      }
      // React may reuse the prompt text across rounds; a fresh input element
      // is another reliable per-round boundary signal.
      const input = document.querySelector(SEL.input);
      if (input && bot.answeredInput && input !== bot.answeredInput) {
        resetBotRound(false);
        bot.answeredInput = null;
      }
      // Verdict / results transition (edge-triggered). Reset per-round answer
      // state here, not only on a text change, so a repeated Marathon prompt
      // can still be answered. `roundClosed` stops us answering the same,
      // still-open question again while its verdict is on screen.
      const roundClosed = isVisible(SEL.reveal)
        || visible('.kr-over, .kr-over-next, .kr-board-head, .kr-board-rows, .kr-row');
      if (roundClosed && !bot.roundClosed) resetBotRound(true);
      bot.roundClosed = roundClosed;
      if (roundClosed) {
        if (visible('.kr-over') || visible('.kr-over-next')) restartFromResults();
        else if (bot.mode === 'duel') duelTick();
        else botStatus('waiting for the next round');
      } else if (p && visible(SEL.prompt) && visible(SEL.input)) {
        answerCurrentPrompt();
      } else if (visible('.kr-lobby-tab') || visible('.kr-room-row')) {
        joinLobbyRoom();
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

  // ---- mount -------------------------------------------------------------
  // @run-at document-start fires before <body> exists, so appending the panel
  // and attaching listeners must wait for the DOM. The fetch wrapper installed
  // above stays at document-start so no /deal response is ever missed.
  function mount() {
    document.body.appendChild(root);

    $('ka-toggle').addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      root.dataset.collapsed = String(state.collapsed);
      $('ka-toggle').textContent = state.collapsed ? 'Show' : 'Hide';
      $('ka-toggle').setAttribute('aria-expanded', String(!state.collapsed));
    });

    try { state.autoEnter = !!GM_getValue(AUTO_KEY, false); } catch (e) { /* no storage */ }
    setAuto(state.autoEnter);
    $('ka-auto').addEventListener('click', () => setAuto(!state.autoEnter));

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

    // ---- watch the game --------------------------------------------------
    let lastPrompt = '';
    let timer = null;
    const observer = new MutationObserver(() => {
      // clearTimeout is the coalescing guard: a burst of React remounts within
      // MO_DEBOUNCE_MS collapses into one pass instead of one pass per mutation.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // Re-query on every tick: React remounts nodes and element refs go stale.
        const q = promptText();
        if (q && q !== lastPrompt) {
          lastPrompt = q;
          loadAnswers(q);
        }
        if (checkRefusal()) return;
        checkVerdict();
        if (document.querySelector(SEL.haul) || document.querySelector(SEL.row)) captureBanks();
      }, MO_DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // Start preloading BEFORE the first prompt lookup: loadAnswers() then
    // awaits this promise and the cold load hits the in-memory snapshot
    // instead of falling straight through to a network request.
    state.preloadPromise = preloadAnswers();
    const initial = promptText();
    if (initial) loadAnswers(initial);
    else status('Waiting for the next prompt…', 'loading');
    flushQueue();
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
