// ==UserScript==
// @name         Krillion Autofill — rare answers + self-correcting archive
// @namespace    https://github.com/berliandro/krillion-answer-database
// @author       berliandro — https://github.com/berliandro
// @homepage     https://github.com/berliandro/krillion-answer-database
// @version      1.2.0
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
    premapText: null,     // exact stored wording -> authoritative nq key
    tierPremap: null,     // null until /api/all-tier resolves; Map afterwards
    krilloPrompts: null,  // harvested Krillocity wordings: normLocal -> exact text
    // Canonical merge: normLocal(real observed variant) -> {canonical, bank_questions}.
    // Advisory lookup only — never changes which labelled banks are displayed.
    krilloCanonical: null,
    krilloRacePool: null,  // normLocal(prompt) -> [{answer, points, source}] from bridge
    netCache: new Map(),
    bankCapturing: false, // guards the 50ms-debounced end-of-dive capture
    refusedAnswers: new Set(),
    // Set only when the graded bank confirms an answer that play-time grading
    // refused; that answer is authoritative and wins the next submission.
    bankConfirmed: null,
    refusalKey: '',
    refusalActive: false,
    // Identity of the refusal line currently on screen. A site can leave the
    // same .kr-refusal text up after the prompt/answer change; without this the
    // stale line gets re-attributed to the new answer and blocks it.
    refusalLine: '',
    refusalQuestion: '',
    refusalAnswer: '',
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
      /* Reference skin: a lavender -> peach field carrying white, softly
         shadowed cards. One violet accent; dark ink + muted grey copy. */
      --ka-card:#ffffff;
      --ka-track:#eeecf3;        --ka-track-hover:#e6e2ed;
      --ka-ink:#34313d;          --ka-muted:#605d69;        --ka-faint:#66626f;
      /* muted/faint are AA on every light surface: card, track, hover, accent-soft. */
      --ka-accent:#7055bd;       --ka-accent-deep:#5a3fa6;  --ka-accent-soft:#f4effc;
      --ka-success:#2e7d58;      --ka-success-soft:#e8f6ef;
      --ka-error:#b4485a;        --ka-error-soft:#fdeeee;
      --ka-line:#e7e3ee;         --ka-line-strong:#d4cfdd;
      --ka-grad-a:#d9c9e7;       --ka-grad-mid:#e7d4e3;     --ka-grad-b:#f8e3d1;
      --ka-shadow:0 8px 22px rgba(78,58,104,.13), 0 2px 5px rgba(78,58,104,.08);
      --ka-shadow-sm:0 2px 6px rgba(78,58,104,.12);
      /* Motion primitives shared by every animation in the motion lane. */
      --ka-ease:cubic-bezier(.16,1,.3,1);
      --ka-quick:130ms;          --ka-soft:200ms;
      --ka-lift:0 6px 16px rgba(78,58,104,.18);
      /* Monochrome mask icons: painted with background:currentColor so they
         inherit text state, never load an image or a CDN. */
      --ka-i-eye:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2.2 12S5.8 5.5 12 5.5 21.8 12 21.8 12 18.2 18.5 12 18.5 2.2 12 2.2 12Z'/%3E%3Ccircle cx='12' cy='12' r='2.8'/%3E%3C/svg%3E");
      --ka-i-bolt:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M13.5 2.5 4.8 13.2h6.4L9.6 21.5l9.6-11.2h-6.4l.7-7.8Z'/%3E%3C/svg%3E");
      --ka-i-robot:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3.5' y='8' width='17' height='12.5' rx='3.5'/%3E%3Cpath d='M12 4.6V8'/%3E%3Ccircle cx='12' cy='3.4' r='1.4'/%3E%3Ccircle cx='9' cy='13.2' r='1'/%3E%3Ccircle cx='15' cy='13.2' r='1'/%3E%3Cpath d='M9.5 16.7h5'/%3E%3C/svg%3E");
      --ka-i-dice:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='1.8' stroke-linejoin='round'%3E%3Crect x='3.5' y='3.5' width='17' height='17' rx='4'/%3E%3Ccircle cx='8.5' cy='8.5' r='1.3' fill='%23000' stroke='none'/%3E%3Ccircle cx='15.5' cy='8.5' r='1.3' fill='%23000' stroke='none'/%3E%3Ccircle cx='12' cy='12' r='1.3' fill='%23000' stroke='none'/%3E%3Ccircle cx='8.5' cy='15.5' r='1.3' fill='%23000' stroke='none'/%3E%3Ccircle cx='15.5' cy='15.5' r='1.3' fill='%23000' stroke='none'/%3E%3C/svg%3E");
      --ka-i-flag:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5.5 21V3.8'/%3E%3Cpath d='M5.5 5h12.8l-2.6 3.6 2.6 3.6H5.5'/%3E%3C/svg%3E");
      --ka-i-check:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m5 12.8 4.4 4.4L19 7.6'/%3E%3C/svg%3E");
      position:fixed; top:18px; right:18px; z-index:2147483000;
      width:min(320px, calc(100vw - 24px));
      max-height:min(78vh,660px); display:flex; flex-direction:column; gap:12px; padding:10px;
      background:linear-gradient(168deg,var(--ka-grad-a) 0%,var(--ka-grad-mid) 46%,var(--ka-grad-b) 100%);
      border:1px solid rgba(255,255,255,.7); border-radius:20px;
      box-shadow:0 18px 44px rgba(86,62,112,.22), 0 2px 8px rgba(86,62,112,.10);
      color:var(--ka-ink); font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
      font-variant-numeric:tabular-nums; overflow:hidden; overflow-wrap:anywhere;
      caret-color:var(--ka-accent);
      animation:ka-in .28s var(--ka-ease) both;
    }
    /* Host pages set box-sizing differently. Contain our sizing so the panel
       and its wrapping chip row fit a 312px-wide narrow viewport. */
    #ka-root,#ka-root *{box-sizing:border-box}
    @keyframes ka-in{from{opacity:0;transform:translate3d(8px,-6px,0) scale(.985)}to{opacity:1;transform:none}}
    @keyframes ka-in-quiet{from{opacity:0}to{opacity:1}}
    #ka-root ::selection{background:rgba(112,85,189,.22);color:var(--ka-ink)}
    #ka-root *{scrollbar-color:var(--ka-line-strong) transparent;scrollbar-width:thin}
    #ka-root *::-webkit-scrollbar{width:8px;height:8px}
    #ka-root *::-webkit-scrollbar-track{background:transparent}
    #ka-root *::-webkit-scrollbar-thumb{background:var(--ka-line-strong);border-radius:99px;border:2px solid var(--ka-card)}
    /* Each section reads as its own white card on the gradient field. */
    #ka-head,#ka-body,.ka-botgroup,#ka-foot{
      background:var(--ka-card); border:1px solid rgba(255,255,255,.85);
      border-radius:16px; box-shadow:var(--ka-shadow);
    }
    #ka-head{display:flex;align-items:center;gap:9px;padding:11px 12px;flex:none;min-width:0}
    .ka-brand{
      flex:none; width:30px; height:30px; border-radius:9px; display:grid; place-items:center;
      color:var(--ka-accent-deep);
      background:linear-gradient(135deg,var(--ka-grad-a),var(--ka-grad-b));
      box-shadow:var(--ka-shadow-sm);
    }
    .ka-brand .ka-ico{width:16px;height:16px;color:inherit}
    .ka-headtext{flex:1;min-width:0}
    #ka-title{
      margin:0; font-size:14px; font-weight:700; letter-spacing:-.015em; line-height:1.25;
      color:var(--ka-ink); text-wrap:balance;
    }
    .ka-subtitle{margin:2px 0 0;font-size:11px;line-height:1.35;color:var(--ka-muted);text-wrap:pretty}
    #ka-count{
      display:inline-flex; align-items:center; gap:5px; flex:none;
      color:var(--ka-accent-deep); background:var(--ka-accent-soft);
      border-radius:999px; padding:3px 8px; font-size:11px; font-weight:700; line-height:1.2;
    }
    #ka-count::before{content:"";width:8px;height:8px;flex:none;border-radius:50%;background:var(--ka-accent)}
    #ka-count[hidden]{display:none}
    /* Hide is window chrome: a quiet pill with an eye glyph, not a primary action. */
    #ka-toggle{
      appearance:none; display:inline-flex; align-items:center; gap:5px; flex:none;
      background:var(--ka-track); color:var(--ka-muted); border:1px solid transparent;
      border-radius:9px; padding:6px 9px; font:inherit; font-size:11px; font-weight:600; line-height:1;
      cursor:pointer; -webkit-tap-highlight-color:transparent;
      transition:background-color var(--ka-quick) ease,color var(--ka-quick) ease,
                 transform var(--ka-quick) var(--ka-ease),box-shadow var(--ka-soft) var(--ka-ease);
    }
    /* Inline SVG icons inherit currentColor; mask icons are painted the same way. */
    .ka-ico{display:inline-block;width:14px;height:14px;flex:none;color:var(--ka-accent-deep)}
    .ka-ico-mask,#ka-toggle::before,.ka-chip[data-filled="true"]::after{
      content:""; background:currentColor;
      -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat;
      -webkit-mask-position:center; mask-position:center;
      -webkit-mask-size:contain; mask-size:contain;
    }
    .ka-ico-eye{-webkit-mask-image:var(--ka-i-eye);mask-image:var(--ka-i-eye)}
    .ka-ico-bolt{-webkit-mask-image:var(--ka-i-bolt);mask-image:var(--ka-i-bolt)}
    .ka-ico-robot{-webkit-mask-image:var(--ka-i-robot);mask-image:var(--ka-i-robot)}
    .ka-ico-dice{-webkit-mask-image:var(--ka-i-dice);mask-image:var(--ka-i-dice)}
    .ka-ico-flag{-webkit-mask-image:var(--ka-i-flag);mask-image:var(--ka-i-flag)}
    .ka-ico-check{-webkit-mask-image:var(--ka-i-check);mask-image:var(--ka-i-check)}
    #ka-toggle::before{-webkit-mask-image:var(--ka-i-eye);mask-image:var(--ka-i-eye)}
    .ka-chip[data-filled="true"]::after{-webkit-mask-image:var(--ka-i-check);mask-image:var(--ka-i-check)}
    #ka-toggle:hover{background:var(--ka-track-hover);color:var(--ka-ink)}
    #ka-toggle:active{background:var(--ka-line)}
    #ka-toggle:focus-visible{outline:2px solid var(--ka-accent);outline-offset:2px}
    /* Segmented pill: a light grey track with a raised white selected pill. */
    .ka-seg{
      position:relative; appearance:none; flex:none; width:112px; margin-left:auto;
      display:flex; align-items:stretch; padding:4px;
      background:var(--ka-track); border:1px solid var(--ka-line); border-radius:12px;
      box-shadow:inset 0 1px 2px rgba(78,58,104,.06);
      font:inherit; cursor:pointer; -webkit-tap-highlight-color:transparent;
      transition:background-color var(--ka-quick) ease,
                 transform var(--ka-quick) var(--ka-ease),box-shadow var(--ka-soft) var(--ka-ease);
    }
    .ka-seg-opt{
      position:relative; z-index:1; flex:1; text-align:center; padding:6px 2px;
      font-size:11px; font-weight:600; line-height:1; color:var(--ka-faint);
      transition:color var(--ka-quick) ease;
    }
    .ka-seg-thumb{
      position:absolute; z-index:0; left:4px; top:4px; bottom:4px; width:calc(50% - 4px);
      background:var(--ka-card); border-radius:9px;
      box-shadow:0 1px 3px rgba(78,58,104,.20), 0 1px 1px rgba(78,58,104,.10);
      transition:transform .2s var(--ka-ease);
    }
    .ka-seg[data-on="false"] .ka-seg-opt[data-val="off"],
    .ka-seg[data-on="true"] .ka-seg-opt[data-val="on"]{color:var(--ka-ink)}
    /* The reference keeps the selected label charcoal; violet stays a restrained
       accent (count, links, focus, chosen answers), not the pill's text colour. */
    .ka-seg[data-on="true"] .ka-seg-thumb{transform:translateX(100%)}
    .ka-seg:hover{background:var(--ka-track-hover)}
    .ka-seg:active .ka-seg-thumb{box-shadow:0 1px 2px rgba(78,58,104,.16)}
    .ka-seg:focus-visible{outline:2px solid var(--ka-accent);outline-offset:2px}
    .ka-seg:disabled{opacity:.55;cursor:not-allowed}
    .ka-seg:disabled:hover{background:var(--ka-track)}
    #ka-body{padding:11px 12px 12px;overflow:auto;display:grid;gap:8px;min-height:0;align-content:start}
    #ka-root[data-collapsed="true"] #ka-body{display:none}
    .ka-section-head{
      display:flex; align-items:center; gap:7px; margin:0;
      color:var(--ka-muted); font-size:11px; font-weight:650; letter-spacing:.01em; line-height:1.3;
    }
    #ka-status{
      margin:0; color:var(--ka-muted); font-size:12px; line-height:1.45;
      font-weight:500; min-height:1.45em; display:flex; gap:9px;
      align-items:flex-start; text-wrap:pretty;
    }
    #ka-status::before{
      content:""; width:7px; height:7px; border-radius:50%;
      background:currentColor; flex:none; margin-top:6px; opacity:.85;
    }
    #ka-status[data-kind="loading"]{color:var(--ka-accent-deep)}
    #ka-status[data-kind="ok"]{color:var(--ka-success);font-weight:650}
    #ka-status[data-kind="error"]{color:var(--ka-error);font-weight:650}
    /* Chip field: a wrapping flex row — short answers pack two per row. */
    #ka-list{
      display:flex; flex-wrap:wrap; align-items:stretch; gap:6px;
      margin:0; padding:0; list-style:none; min-width:0;
    }
    #ka-list>li{min-width:0;max-width:100%}
    .ka-group{
      /* Bank labels span their own row and stay put while the list scrolls. */
      flex:0 0 100%;
      position:sticky; top:0; z-index:2;
      display:flex; justify-content:space-between; gap:8px; align-items:center;
      color:var(--ka-muted); font-size:10.5px; line-height:1.35; letter-spacing:.01em;
      background:var(--ka-card); border-bottom:1px solid var(--ka-line);
      padding:6px 2px; margin-top:4px; text-wrap:balance;
    }
    .ka-group:first-child{margin-top:0}
    .ka-group .ka-group-name{color:var(--ka-muted);min-width:0}
    .ka-group .ka-match{
      color:var(--ka-accent-deep); background:var(--ka-accent-soft);
      border-radius:999px; padding:2px 7px; font-weight:700; flex:none;
    }
    #ka-list>li:not(.ka-group):not(.ka-empty){flex:1 1 auto;min-width:calc(50% - 3px)}
    #ka-list>li.ka-wide{flex-basis:100%}
    .ka-chip{
      position:relative; appearance:none; display:flex; align-items:center;
      width:100%; height:100%; min-width:0; min-height:40px; text-align:start; cursor:pointer;
      background:var(--ka-card); color:var(--ka-ink); border:1px solid var(--ka-line);
      border-radius:9px; padding:8px 10px; font:inherit; font-size:12.5px;
      line-height:1.35; overflow-wrap:anywhere; box-shadow:0 1px 2px rgba(78,58,104,.05);
      transition:background-color var(--ka-quick) ease,border-color var(--ka-quick) ease,
                 color var(--ka-quick) ease,transform var(--ka-quick) var(--ka-ease),
                 box-shadow var(--ka-soft) var(--ka-ease);
    }
    .ka-chip::after{
      content:""; position:absolute; right:9px; top:50%; width:12px; height:12px;
      transform:translateY(-50%) scale(.6); opacity:0; color:var(--ka-accent-deep);
      transition:opacity var(--ka-quick) ease,transform var(--ka-quick) var(--ka-ease);
    }
    .ka-chip:hover{border-color:#c9bde3}
    .ka-chip:active{background:var(--ka-accent-soft)}
    .ka-chip:focus-visible{outline:2px solid var(--ka-accent);outline-offset:2px}
    .ka-chip[data-filled="true"]{
      background:var(--ka-accent-soft); color:var(--ka-accent-deep);
      border-color:var(--ka-accent); font-weight:650; padding-right:26px;
    }
    .ka-chip[data-filled="true"]::after{opacity:1;transform:translateY(-50%) scale(1)}
    .ka-empty{
      flex:0 0 100%;
      color:var(--ka-muted); font-size:12px; line-height:1.5; text-align:center;
      padding:20px 14px; margin:0; text-wrap:pretty;
      background:var(--ka-track); border:1px dashed var(--ka-line-strong);
      border-radius:10px;
    }
    #ka-botbar{display:grid;gap:8px;flex:none;min-width:0}
    #ka-botbar[hidden]{display:none}
    .ka-botgroup{padding:11px 12px 12px;display:grid;gap:10px;min-width:0}
    .ka-grouphead{display:grid;gap:2px}
    .ka-grouptitle{font-size:12px;font-weight:700;line-height:1.3;color:var(--ka-ink)}
    .ka-groupsub{color:var(--ka-muted);font-size:11px;line-height:1.4;text-wrap:pretty}
    .ka-autorow{display:flex;align-items:center;gap:10px;min-width:0}
    .ka-rowlabel{
      display:inline-flex; align-items:center; gap:7px; flex:1; min-width:0;
      color:var(--ka-ink); font-size:12px; font-weight:600; line-height:1.25;
    }
    .ka-rowlabel .ka-ico{color:var(--ka-accent)}
    #ka-botdeps{display:grid;gap:8px;border-top:1px solid var(--ka-line);padding-top:10px;margin-top:1px}
    #ka-botdeps[hidden]{display:none}
    .ka-botnote{
      margin:0; color:var(--ka-muted); font-size:11px; line-height:1.45;
      text-wrap:pretty; background:var(--ka-accent-soft); border-radius:8px; padding:8px 10px;
    }
    .ka-botrow{display:flex;align-items:center;gap:10px}
    .ka-botrow label{
      display:inline-flex; align-items:center; gap:7px; flex:none; min-width:52px;
      color:var(--ka-ink); font-size:12px; font-weight:600;
    }
    .ka-botrow label .ka-ico{color:var(--ka-accent)}
    .ka-botrow select{
      flex:1; min-width:0; appearance:none; cursor:pointer; display:block;
      /* appearance:none removes the native arrow — draw a clean chevron. */
      background:var(--ka-card) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5 6 6.5 11 1.5' fill='none' stroke='%23605d69' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 10px center;
      color:var(--ka-ink); border:1px solid var(--ka-line-strong);
      border-radius:9px; padding:7px 30px 7px 10px; font:inherit; font-size:12px;
      box-shadow:inset 0 1px 2px rgba(78,58,104,.04);
    }
    .ka-botrow select:hover{border-color:#c9bde3}
    .ka-botrow select:focus-visible{outline:2px solid var(--ka-accent);outline-offset:1px}
    #ka-botstate{
      flex:1; min-width:0; display:inline-flex; align-items:center; gap:7px;
      color:var(--ka-muted); font-size:11.5px; line-height:1.35;
      overflow-wrap:anywhere; text-wrap:pretty;
    }
    #ka-botstate::before{
      content:""; width:7px; height:7px; border-radius:50%;
      background:var(--ka-line-strong); flex:none;
    }
    #ka-botstate[data-active="true"]{color:var(--ka-success);font-weight:600}
    #ka-botstate[data-active="true"]::before{
      background:var(--ka-success); box-shadow:0 0 0 3px var(--ka-success-soft);
    }
    #ka-foot{padding:9px 13px;color:var(--ka-muted);font-size:11px;line-height:1.4;flex:none;text-wrap:pretty}
    #ka-foot a{color:var(--ka-accent-deep);text-decoration:none;font-weight:600}
    #ka-foot a:hover,#ka-foot a:focus-visible{text-decoration:underline;text-underline-offset:2px}
    #ka-foot a:focus-visible{outline:2px solid var(--ka-accent);outline-offset:2px;border-radius:3px}
    /* ---- motion lane: balanced, light feedback --------------------------
       One authored arrival (the panel) plus short acknowledgements. Only
       transform + opacity move; colour/border/shadow carry state. Every
       animation reads the merged tokens above, so no var is undefined. */
    @keyframes ka-surface-in{from{opacity:0;transform:translate3d(0,6px,0)}to{opacity:1;transform:none}}
    @keyframes ka-load-pulse{0%,100%{opacity:.4;transform:scale(.82)}50%{opacity:1;transform:scale(1.12)}}
    @keyframes ka-count-in{from{opacity:0;transform:scale(.82)}to{opacity:1;transform:scale(1)}}
    @keyframes ka-chip-in{from{opacity:0;transform:translate3d(0,5px,0)}to{opacity:1;transform:none}}
    @keyframes ka-chip-set{0%{transform:scale(1)}45%{transform:scale(1.035)}100%{transform:scale(1)}}
    @keyframes ka-dot-breathe{0%,100%{opacity:.6;transform:scale(.85)}50%{opacity:1;transform:scale(1.15)}}
    #ka-body{animation:ka-surface-in var(--ka-soft) var(--ka-ease) backwards}
    #ka-status{transition:color var(--ka-soft) ease,opacity var(--ka-quick) ease}
    #ka-status::before{transition:transform var(--ka-soft) var(--ka-ease)}
    #ka-status[data-kind="ok"]::before,#ka-status[data-kind="error"]::before{transform:scale(1.2)}
    #ka-status[data-kind="loading"]::before{animation:ka-load-pulse 1.6s ease-in-out infinite}
    #ka-count:not([hidden]){animation:ka-count-in var(--ka-soft) var(--ka-ease) backwards}
    #ka-list>li:not(.ka-group) .ka-chip{animation:ka-chip-in var(--ka-soft) var(--ka-ease) backwards}
    #ka-list>li:nth-child(2) .ka-chip{animation-delay:18ms}
    #ka-list>li:nth-child(3) .ka-chip{animation-delay:36ms}
    #ka-list>li:nth-child(4) .ka-chip{animation-delay:54ms}
    #ka-list>li:nth-child(5) .ka-chip{animation-delay:72ms}
    #ka-list>li:nth-child(6) .ka-chip{animation-delay:90ms}
    #ka-list>li:nth-child(7) .ka-chip{animation-delay:108ms}
    #ka-list>li:nth-child(n+8) .ka-chip{animation-delay:126ms}
    #ka-list>li.ka-empty{animation:ka-surface-in var(--ka-soft) var(--ka-ease) backwards}
    .ka-chip:hover{transform:translate3d(0,-1px,0);box-shadow:var(--ka-lift)}
    .ka-chip:active{transform:scale(.985);box-shadow:none}
    .ka-chip[data-filled="true"]{animation:ka-chip-set 220ms var(--ka-ease) backwards}
    #ka-toggle:active,.ka-seg:active{transform:scale(.97)}
    .ka-seg[data-on="true"]{box-shadow:inset 0 1px 2px rgba(78,58,104,.10)}
    #ka-botstate::before{transition:background-color var(--ka-soft) ease,transform var(--ka-soft) var(--ka-ease)}
    #ka-botstate[data-active="true"]::before{animation:ka-dot-breathe 2s ease-in-out infinite}
    #ka-botbar:not([hidden]){animation:ka-surface-in var(--ka-soft) var(--ka-ease) backwards}
    @media (pointer: coarse){
      .ka-botrow select{min-height:44px}
      .ka-chip,#ka-toggle,.ka-seg{min-height:44px}
      #ka-toggle{padding-inline:12px}
      .ka-seg{width:118px}
    }
    @media (max-width: 560px){
      #ka-root{
        top:max(10px, env(safe-area-inset-top));
        right:max(10px, env(safe-area-inset-right));
        width:min(320px, calc(100vw - 20px));
        max-height:min(80vh,620px);
      }
    }
    @media (forced-colors: active){
      #ka-root,#ka-toggle,.ka-seg,.ka-chip,.ka-botrow select{border:1px solid CanvasText}
      .ka-seg-thumb{background:Canvas;box-shadow:none;border:1px solid CanvasText}
      #ka-status::before,#ka-botstate[data-active="true"]::before{background:Highlight}
      #ka-toggle:focus-visible,.ka-seg:focus-visible,.ka-chip:focus-visible,
      .ka-botrow select:focus-visible,#ka-foot a:focus-visible{outline:2px solid Highlight}
    }
    @media (prefers-reduced-motion: reduce){
      /* Collapse every motion-lane animation/transition to instant. State and
         colour feedback (data-kind, data-on, data-active, data-filled) stays. */
      #ka-root{animation:ka-in-quiet .12s ease-out both}
      #ka-body,#ka-status,#ka-count:not([hidden]),
      #ka-list>li:not(.ka-group) .ka-chip,#ka-list>li.ka-empty,
      .ka-chip[data-filled="true"],#ka-botbar:not([hidden]),
      #ka-status[data-kind="loading"]::before,
      #ka-botstate[data-active="true"]::before{animation:none}
      #ka-status[data-kind="loading"]::before{opacity:1;transform:none}
      #ka-status[data-kind]::before{transform:none}
      .ka-chip:hover,.ka-chip:active,#ka-toggle:active,.ka-seg:active,
      #ka-auto:active:not(:disabled),#ka-bot:active{transform:none;box-shadow:none}
      #ka-toggle,.ka-seg,.ka-seg-thumb,.ka-seg-opt,.ka-chip,.ka-chip::after,
      .ka-botrow select,#ka-status,#ka-status::before,#ka-botstate::before{transition:none}
    }
  `);

  const root = document.createElement('div');
  root.id = 'ka-root';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Krillion rare answers');
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
      '<div class="ka-headtext">' +
        '<h2 id="ka-title">Krillion rare answers</h2>' +
        '<p class="ka-subtitle">100-point answers, ready to dive.</p>' +
      '</div>' +
      '<span id="ka-count" hidden></span>' +
      '<button id="ka-toggle" type="button" aria-controls="ka-body" aria-expanded="true" aria-label="Hide answers">Hide</button>' +
    '</div>' +
    '<div id="ka-body">' +
      '<div class="ka-section-head">' + ICON.list + '<span>Known answers</span></div>' +
      '<p id="ka-status" role="status" aria-live="polite" aria-atomic="true" data-kind="loading">Connecting to local bridge…</p>' +
      '<ul id="ka-list"></ul>' +
    '</div>' +
    '<div id="ka-botbar">' +
      '<div class="ka-botgroup">' +
        '<div class="ka-grouphead">' +
          '<span class="ka-grouptitle">Manual</span>' +
          '<span class="ka-groupsub">Answer prompts yourself — click any answer to fill it in.</span>' +
        '</div>' +
        '<div class="ka-autorow">' +
          '<span class="ka-rowlabel"><span class="ka-ico ka-ico-mask ka-ico-bolt"></span>Dive on click</span>' +
          '<button id="ka-auto" class="ka-seg" type="button" aria-pressed="false" data-on="false" aria-label="Dive on click" title="When on, clicking an answer also submits it — no Enter needed.">' +
            '<span class="ka-seg-opt" data-val="off">Off</span>' +
            '<span class="ka-seg-opt" data-val="on">On</span>' +
            '<span class="ka-seg-thumb" aria-hidden="true"></span>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="ka-botgroup">' +
        '<div class="ka-grouphead">' +
          '<span class="ka-grouptitle">Auto-play</span>' +
          '<span class="ka-groupsub">The bot fills and submits answers for you.</span>' +
        '</div>' +
        '<div class="ka-autorow">' +
          '<span class="ka-rowlabel"><span class="ka-ico ka-ico-mask ka-ico-robot"></span>Play for me</span>' +
          '<button id="ka-bot" class="ka-seg" type="button" aria-pressed="false" data-on="false" aria-describedby="ka-botnote" aria-label="Play for me" title="Plays whole dives for you: picks an answer, fills it and submits it. Use Pick and Mode to choose how.">' +
            '<span class="ka-seg-opt" data-val="off">Off</span>' +
            '<span class="ka-seg-opt" data-val="on">On</span>' +
            '<span class="ka-seg-thumb" aria-hidden="true"></span>' +
          '</button>' +
        '</div>' +
        '<div class="ka-autorow">' +
          '<span id="ka-botstate" data-active="false" title="Play for me is off — you answer prompts yourself.">Off · you are playing</span>' +
        '</div>' +
        '<p class="ka-botnote" id="ka-botnote">While Play for me is on, it drives the dive and pauses Dive on click.</p>' +
        '<div id="ka-botdeps">' +
          '<div class="ka-botrow"><label for="ka-pick"><span class="ka-ico ka-ico-mask ka-ico-dice"></span>Pick</label>' +
            '<select id="ka-pick">' +
              '<option value="random">Random 100-point answer</option>' +
              '<option value="top">Top of list</option>' +
              '<option value="god">God player · Gaussian mix, peak at 85</option>' +
            '</select></div>' +
          '<div class="ka-botrow"><label for="ka-mode"><span class="ka-ico ka-ico-mask ka-ico-flag"></span>Mode</label>' +
            '<select id="ka-mode">' +
              '<option value="classic">Classic</option>' +
              '<option value="krillocity">Krillocity · daily race</option>' +
              '<option value="krillomulti">Krillocity · multiplayer race</option>' +
              '<option value="marathon5">Multiplayer · 5s / 50 prompts</option>' +
              '<option value="showoff">Multiplayer · most players</option>' +
              '<option value="duel">1 vs 1</option>' +
            '</select></div>' +
        '</div>' +
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
    // The Off/On segments are static markup; only the selected state moves.
    // Update the accessible label without overwriting the pill structure.
    btn.dataset.on = String(state.autoEnter);
    // The accessible label is constant; aria-pressed is the single state signal.
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
    // Confidence gate: multi-bank matches pause auto-pick for a manual choice.
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
    const textKeys = new Map();
    (data || []).forEach((item) => {
      if (!item || !item.q) return;
      const key = keyFor(item);
      // The bridge's nq strips punctuation/contractions that normLocal keeps
      // (e.g. "Dr. Seuss" -> "dr seuss"). Remember the exact stored wording so
      // a verbatim on-screen prompt resolves to the authoritative nq key.
      textKeys.set(item.q, key);
      const bank = { q: item.q, answers: item.answers || [], score: item.score || 1 };
      if (!map.has(key)) {
        map.set(key, bank);
        return;
      }
      // Near-duplicate prompts can normalise to the same nq key. Policy: keep
      // them as separate labelled banks, never merge their answers into one.
      // The shared-key record keeps the complete flat answers view for legacy
      // consumers, plus `banks` for the fast paths that must show each label.
      const prev = map.get(key);
      if (!prev.banks) {
        // Keep a pristine copy of the first bank: the flat answers view below
        // is aggregated for legacy consumers, but groups must stay separate.
        prev.banks = [{ q: prev.q, answers: prev.answers.slice(), score: prev.score }];
      }
      prev.banks.push(bank);
      prev.answers = prev.answers.concat(bank.answers);
      // Also address the colliding bank by its exact label so neither bank is
      // dropped when two prompts share an nq.
      map.set(item.q, bank);
    });
    state.premapText = textKeys;
    return map;
  }

  // Fast-path lookup: a verbatim prompt uses the bridge's authoritative nq
  // key; reworded prompts fall back to normLocal as before. Resolving through
  // the key (not through a bank alias) keeps near-duplicate banks aggregated,
  // and netCache / tierPremap keep their own unchanged key source.
  function premapItem(question) {
    if (!state.premap) return null;
    const textKey = state.premapText && state.premapText.get(question);
    return state.premap.get(textKey || keyFor(question)) || null;
  }

  // Single-key lookups stay instant: a plain record yields one group exactly
  // as before; only collision records carry multiple labelled banks.
  function premapGroups(item, question) {
    const banks = item && item.banks ? item.banks : [item];
    return banks.map((b) => ({
      question: b.q || question,
      score: Number(b.score || 1),
      answers: b.answers || [],
    }));
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
    // A new prompt drops any stale refusal tag; refusalLine/Question/Answer are
    // deliberately kept so a lingering .kr-refusal line is recognised as stale
    // instead of being re-logged against the next filled answer.
    state.refusalActive = false;
    render();

    // PROVEN classic "confidence-gated retry (refusal handling)": bounded
    // preload wait (LOOKUP_TIMEOUT) so a forever-retrying /api/all can never
    // block this prompt; fill() adds the multi-bank manual pause and
    // checkRefusal() adds the distinct-answer retry.
    if (!state.premap && state.preloadPromise) {
      try {
        await Promise.race([
          state.preloadPromise,
          new Promise((r) => setTimeout(r, LOOKUP_TIMEOUT)),
        ]);
      } catch (e) { /* continue with network */ }
    }
    if (isStale()) return;

    // PROVEN classic "exact-100 preload fast path": the whole rare-answer
    // archive is loaded once at page start, so an exact premap hit resolves
    // with zero /api/answers calls. Verbatim prompts use the bridge's nq key;
    // netCache/prefetch keep their normLocal key source unchanged.
    const item = premapItem(question);
    if (item) {
      applyResult({ exact: true, groups: premapGroups(item, question) }, question);
      return;
    }
    const key = keyFor(question);
    if (state.netCache.has(key)) {
      applyResult(state.netCache.get(key), question);
      return;
    }

    status('Loading 100-point answers…', 'loading');
    // Primary lookup is ALWAYS the exact wording the game showed. Krillocity
    // wordings are retried only when this yields zero answer groups, so a
    // matching labelled bank is never replaced or merged by a guess.
    let data;
    try {
      data = await request('/api/answers?q=' + encodeURIComponent(question), {
        timeout: LOOKUP_TIMEOUT,
        forever: true,
        isStale,
        onFinalFail: (info) => logLookupFailure(question, info),
      });
      if (isStale()) return; // a newer prompt won while we were retrying
      clearLookupFailure();
    } catch (e) {
      // Stale requests are cancelled on purpose — never log them as misses.
      if (isStale()) return;
      reportMiss(question, 'unreachable: ' + (e && e.message || e));
      status(e && /timeout/.test(e.message)
        ? 'The local archive took too long to answer — retrying on the next prompt.'
        : 'Can’t reach the local archive. Start injection/bridge.py.', 'error');
      return;
    }

    // Fallback: only a VERBATIM bank question is ever used as the retry query.
    // The merge canonical is review metadata only — it may be a generic wording
    // that is not a bank, and must never redirect a constrained prompt. Log-only
    // variants are never lookup keys (no alias application, no bank merging).
    const wording = krilloWording(question);
    if (wording && wording !== question && answerCount(data) === 0) {
      const canonical = krilloCanonicalMatch(question);
      try {
        const fallback = await request('/api/answers?q=' + encodeURIComponent(wording), {
          timeout: LOOKUP_TIMEOUT,
          retries: 1, // bounded: never block on a dead bridge after a valid reply
          isStale,
        });
        if (isStale()) return;
        if (answerCount(fallback) > 0) {
          data = fallback; // banks come back as-is, each label preserved
          if (canonical) {
            reportPrompt('krillocity-canonical-match', question, {
              candidates: [], chosen_bank: canonical.target,
              matched_canonical: canonical.target,
              merge_canonical: canonical.canonical,
              bank_questions: canonical.bank_questions || [],
              mode: mode(), auto: state.autoEnter,
            });
          } else {
            reportPrompt('krillocity-bank-match', question, {
              candidates: [], chosen_bank: wording, mode: mode(), auto: state.autoEnter,
            });
          }
        }
      } catch (e) {
        // Keep the zero-group primary result; applyResult() logs the no-match.
      }
    }

    state.netCache.set(key, data); // only successful lookups are cached
    applyResult(data, question);
    // Archive this race prompt and any other-player answers already visible.
    archiveKrillocityRace(question, data);
    // Race pool: all graded tiers + harvested other-player answers, high->low.
    if (/^\/krillocity\/?$/.test(location.pathname)) loadKrilloRacePool(question);
  }

  // Fetch the server-side race pool for the exact wording on screen. The bridge
  // resolves reworded prompts via exact/alias/fuzzy and attaches real tierIndex
  // points plus other players' game-graded answers from public race results.
  function loadKrilloRacePool(question) {
    request('/api/krillocity-race-pool?q=' + encodeURIComponent(question), {
      timeout: LOOKUP_TIMEOUT, retries: 1,
    }).then((d) => {
      if (!state.krilloRacePool) state.krilloRacePool = new Map();
      state.krilloRacePool.set(keyFor(question), (d && d.answers) || []);
      if (bot.on && mode() === 'krillocity') {
        bot.racePool = null;   // rebuild with the full sorted pool
        raceSchedule(0);
      }
    }).catch(() => { /* old bridge: local pool fallback stays in place */ });
  }

  function storageGet(key, fallback) {
    try { return GM_getValue(key, fallback); } catch (e) { return fallback; }
  }
  function storageSet(key, value) {
    try { GM_setValue(key, value); } catch (e) { /* no storage available */ }
  }

  async function preloadAnswers() {
    // Harvested Krillocity wordings are a fallback matcher for the race modes.
    // Independent and non-blocking: an old bridge simply leaves the map empty.
    request('/api/krillo-prompts', { timeout: LOOKUP_TIMEOUT, retries: 1 })
      .then((d) => {
        const map = new Map();
        ((d && d.data) || []).forEach((row) => {
          if (!row || !row.q) return;
          const key = normLocal(row.q);
          if (!map.has(key)) map.set(key, row.q);
        });
        state.krilloPrompts = map;
      })
      .catch(() => { state.krilloPrompts = new Map(); });

    // Canonical merge of REAL observed wordings -> labelled bank questions.
    // Independent and non-blocking: an old bridge (or a not-yet-built file)
    // simply leaves the map empty and the existing lookup path is unchanged.
    request('/api/krillo-canonical', { timeout: LOOKUP_TIMEOUT, retries: 1 })
      .then((d) => {
        const map = new Map();
        const groups = (d && Array.isArray(d.data)) ? d.data : [];
        groups.forEach((group) => {
          if (!group) return;
          const canonical = group.canonical || '';
          const bankQuestions = Array.isArray(group.bank_questions)
            ? group.bank_questions.filter((q) => typeof q === 'string' && q) : [];
          // A merge canonical may NOT be a real bank ("What's an example of a
          // city?" for a constrained "Name any US city" bank). Only a VERBATIM
          // bank question may ever be used as a lookup target.
          const target = bankQuestions[0] || '';
          if (!target) return;
          // Log-only / non-bank wordings are review data, never lookup keys:
          // applying them would be an alias rewrite (DECISIONS.md).
          const variants = Array.isArray(group.variants) ? group.variants : [];
          variants.forEach((variant) => {
            if (!variant || variant.exact_bank !== true || variant.log_only === true) return;
            const text = variant.text;
            // Only the variant that IS the target bank may be a key. A real
            // bank in the same cluster can have different graded answers.
            if (!text || text !== target) return;
            const key = normLocal(text);
            if (!map.has(key)) map.set(key, { target, canonical, bank_questions: bankQuestions });
          });
        });
        state.krilloCanonical = map;
      })
      .catch(() => { state.krilloCanonical = new Map(); });

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
        const item = premapItem(state.question);
        if (item) {
          applyResult({ exact: true, groups: premapGroups(item, state.question) }, state.question);
        }
      }
    } catch (e) {
      state.premap = new Map();
    }
  }

  // Krillocity keeps a hidden "wait" card with an empty p.kr-prompt AHEAD of
  // the live card. document.querySelector() returns that stale node, so the
  // panel never sees a prompt and the bot never answers. Pick the first
  // genuinely visible prompt, preferring one with text. A visible-but-empty
  // node is kept as a fallback so gameState() still sees the prompt reveal.
  function promptEl() {
    let all = document.querySelectorAll ? Array.from(document.querySelectorAll(SEL.prompt)) : [];
    if (!all.length) {
      // Minimal/stubbed DOMs may only implement querySelector.
      const one = document.querySelector(SEL.prompt);
      all = one ? [one] : [];
    }
    let fallback = null;
    for (const el of all) {
      const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
      if (cs && (cs.visibility === 'hidden' || cs.display === 'none')) continue;
      if (!(el.offsetParent !== null || el.getClientRects().length > 0)) continue;
      if (!fallback) fallback = el;
      if ((el.textContent || '').trim()) return el;
    }
    return fallback;
  }

  function isVisible(sel) {
    const el = sel === SEL.prompt ? promptEl() : document.querySelector(sel);
    return !!(el && (el.offsetParent !== null || el.getClientRects().length > 0));
  }

  function promptText() {
    // The intro stays in the DOM after a dive begins, just hidden. Only a
    // visible intro means we are still on the start screen.
    if (isVisible(SEL.intro)) return '';
    const el = promptEl();
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
    if (points >= 100) {
      // The dive-end graded bank is authoritative: a play-time refusal for the
      // same (question, answer) is evidence only. Once the bank confirms the
      // answer at 100, unblock exactly that key so the bot can submit it again.
      const confirmed = question + '\u0000' + answer;
      if (state.refusedAnswers.has(confirmed)) {
        const kept = Array.from(state.refusedAnswers).filter((k) => k !== confirmed);
        state.refusedAnswers.clear();
        kept.forEach((k) => state.refusedAnswers.add(k));
        // The bank-confirmed answer is now the authoritative choice for this
        // prompt; prefer it over alternatives that play-time never proved.
        state.bankConfirmed = { question, answer };
      }
    }
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
    // Confidence gate: a refusal clears answeredPrompt so the next tick retries
    // with a distinct answer — never a demotion from a play score.
    if (!state.question || !state.lastFilled) return false;
    const el = document.querySelector('.kr-refusal');
    const line = el ? (el.textContent || '').trim() : '';
    if (!line) return false;
    const answer = state.lastFilled;
    // A site can leave the previous round's .kr-refusal line on screen after
    // the prompt changed. If this exact line was already attributed to a
    // different (prompt, answer), it is stale: never re-attribute it and never
    // add a refusedAnswers entry for an answer that was not actually refused.
    if (state.refusalLine === line &&
        (state.refusalQuestion !== state.question || state.refusalAnswer !== answer)) {
      state.refusalActive = false;
      state.lastFilled = '';
      bot.answeredPrompt = '';
      return false;
    }
    const bank = state.answerQuestion[answer] || state.question;
    const key = state.question + '\u0000' + answer + '\u0000' + line;
    if (state.refusalKey !== key) {
      state.refusalKey = key;
      state.refusalLine = line;
      state.refusalQuestion = state.question;
      state.refusalAnswer = answer;
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

  // Fire-and-forget archive write with the same offline queue as other logs.
  function reportKrillo(path, body) {
    request(path, { method: 'POST', body, retries: 1 })
      .catch(() => queuePost(path, body));
  }

  // Log a live race prompt into the separate Krillocity archive. Zero-match
  // prompts get their own review record; matched prompts stay identifiable as
  // race wordings. Nothing here can demote a graded 100-point answer.
  function archiveKrillocityRace(question, data) {
    if (!/^\/krillocity\/?$/.test(location.pathname)) return;
    const el = document.querySelector('p.kr-prompt');
    const rec = { prompt: question, prompt_id: el && el.id ? el.id : '', source: 'userscript', source_url: location.href };
    reportKrillo('/api/krillo-prompt', rec);
    const groups = (data && data.groups) || [];
    const matches = groups.reduce((n, g) => n + ((g.answers || []).length), 0);
    if (matches === 0) {
      reportKrillo('/api/krillo-zero', Object.assign({}, rec, { reason: 'zero-index-match' }));
    } else {
      reportPrompt('krillocity-race-prompt', question, {
        candidates: candidateInfo(), mode: mode(), exact: !!(data && data.exact),
        auto: state.autoEnter, index_matches: matches,
      });
    }
  }

  // The harvest stores the exact wordings the game deals in Krillocity races.
  // Use one of them as the lookup query only after the on-screen wording misses
  // the index. The canonical merge is checked first: it maps a REAL observed
  // variant to the exact bank wording it was reviewed against, so we land on
  // the right existing labelled bank. Neither path applies an invented alias.
  function krilloWording(question) {
    if (!question) return null;
    const key = normLocal(question);
    const canonical = krilloCanonicalMatch(question);
    // NEVER return the merge canonical: it can be a generic wording that is not
    // a bank at all. Only the reviewed verbatim bank question is a safe target.
    if (canonical && canonical.target) return canonical.target;
    return (state.krilloPrompts && state.krilloPrompts.get(key)) || null;
  }

  // Metadata for the review log. Null unless the on-screen wording is itself a
  // real observed variant present in the canonical merge.
  function krilloCanonicalMatch(question) {
    if (!question || !state.krilloCanonical) return null;
    return state.krilloCanonical.get(normLocal(question)) || null;
  }

  // Total answer rows across every labelled bank (a zero-count is the signal
  // that a fallback lookup is allowed).
  function answerCount(data) {
    const groups = (data && data.groups) || [];
    return groups.reduce((n, g) => n + (((g && g.answers) || []).length), 0);
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
  // Stable per-dive signature shared with the classic restart gate so both
  // agree on which dive's banks a capture run belongs to.
  function classicBankSignature(rows) {
    return rows.length + ':' + rows.map((r) => r.querySelector(SEL.rowPrompt)?.textContent || '').join('|');
  }

  async function captureBanks() {
    // The observer is debounced to 50ms, so a second tick can land while this
    // one is mid-await. Without a guard the two passes click each other's row
    // heads and leave the bank collapsed/expanded in an inconsistent state.
    if (state.bankCapturing) return state.bankCapturePromise;
    state.bankCapturing = true;
    state.bankCaptureSettled = false;
    // Expose an in-flight promise so the classic results gate can tell when
    // the POST (or its queued fallback) has fully settled for this dive.
    let settle;
    state.bankCapturePromise = new Promise((r) => { settle = r; });
    try {
      const rows = [...document.querySelectorAll(SEL.row)];
      if (!rows.length) return;
      const signature = classicBankSignature(rows);
      state.bankCaptureSignature = signature;
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

      // Remember counts for the classic restart-gate report before any early
      // return drops an empty capture.
      state.bankCaptureRows = rows.length;
      state.bankCaptureAnswers = learned.length;
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
      state.bankCaptureSettled = true;
      settle();
    }
  }

  // ---- classic end-of-dive: capture all banks, THEN restart --------------
  const CLASSIC_CAPTURE_TIMEOUT_MS = 2200; // hard safety net: never hang the bot
  const CLASSIC_NO_ROWS_DELAY_MS = 400;    // no rows => nothing to capture

  function classicRows() {
    return [...document.querySelectorAll(SEL.row)];
  }

  function classicExpandRows(rows) {
    rows.forEach((row) => {
      const head = row.querySelector('.kr-row-head');
      if (!head || head.getAttribute('aria-expanded') === 'true') return;
      // Only re-click heads not already clicked for this dive; avoids a
      // React-lag double-toggle collapsing a row that is still expanding.
      if (!state.classicExpandedHeads) state.classicExpandedHeads = new WeakSet();
      if (state.classicExpandedHeads.has(head)) return;
      state.classicExpandedHeads.add(head);
      head.click();
    });
  }

  // PROVEN classic "capture-banks-before-restart flywheel": gate Play-again on
  // a settled bank capture (own rows only), hard-bounded at 2,200 ms.
  function finalizeClassicResults() {
    const rows = classicRows();
    const signature = classicBankSignature(rows);
    const now = Date.now();
    const noRows = rows.length === 0;

    // A changed signature means a fresh dive's results: start a new gate so a
    // stale capture from the previous dive can never block this restart.
    if (!state.classicFinalize || state.classicFinalize.key !== signature) {
      state.classicFinalize = {
        key: signature, startedAt: now, reported: false, gated: false, kickoff: true,
      };
      state.classicExpandedHeads = new WeakSet();
    }
    const fin = state.classicFinalize;
    const elapsed = now - fin.startedAt;

    // Make sure a capture for this dive is actually in flight. The observer
    // normally triggers it; this is a safety net for debounce/mount timing.
    if (fin.kickoff) {
      fin.kickoff = false;
      if (!noRows && !state.bankCapturing && state.bankCaptureSignature !== signature) {
        captureBanks();
      }
    }

    const captureSettled = !!state.bankCapturePromise
      && state.bankCaptureSettled
      && state.bankCaptureSignature === signature;

    // (a) verify every visible row head is expanded. Re-click only after the
    //     capture has settled, so we never toggle a head it still works on.
    const heads = rows.map((r) => r.querySelector('.kr-row-head')).filter(Boolean);
    let allExpanded = heads.length === 0 || heads.every((h) => h.getAttribute('aria-expanded') === 'true');
    if (!allExpanded && captureSettled) {
      classicExpandRows(rows);
      allExpanded = heads.every((h) => h.getAttribute('aria-expanded') === 'true');
    }

    // (b)+(c) capture settled + rows expanded, bounded by a hard timeout.
    const timeoutHit = elapsed >= CLASSIC_CAPTURE_TIMEOUT_MS;
    const ready = noRows
      ? elapsed >= CLASSIC_NO_ROWS_DELAY_MS
      : ((allExpanded && captureSettled) || timeoutHit);

    if (!ready) {
      fin.gated = true;
      botStatus('classic: saving dive banks before restart');
      return false;
    }

    if (!fin.reported) {
      fin.reported = true;
      reportBot('classic-bank-capture', {
        rows: state.bankCaptureRows != null ? state.bankCaptureRows : rows.length,
        answers: state.bankCaptureAnswers || 0,
        gated: fin.gated,
        all_expanded: allExpanded,
        timed_out: timeoutHit && !captureSettled && !noRows,
      });
    }
    const did = restartFromResults();
    if (did) botStatus('classic: banks captured, restarting');
    return did;
  }

  // ---- auto-play engine --------------------------------------------------
  // ---- verified strategy router (Phase 4) --------------------------------
  // Single source of truth for which PROVEN strategies are active per mode.
  // Derived field-by-field from injection/STRATEGY-VERIFIED.md:
  //   FILES=18 RUNS=55 PROVEN=14 REJECTED=4 UNTESTED=0 BAD_SHAPE=0 POLICY_VIOLATIONS=0
  // This is a declaration/router layer ONLY. Strategy implementations stay in
  // their owning functions (classic*/race*/lobby*/duel*); botTick consults this
  // config to select the handler family, it never re-implements a strategy here.
  // REJECTED ids live in doNotWire lists and must never be activated.
  const STRATEGY_CONFIG = {
    classic: {
      proven: [
        'capture-banks-before-restart flywheel',
        'confidence-gated retry (refusal handling)',
        'exact-100 preload fast path',
        'God Gaussian pick',
      ],
      doNotWire: [
        'tier-greedy fallback / rare-first within confidence', // do-not-wire (REJECTED)
      ],
      route: { answer: 'answerCurrentPrompt', lobby: 'joinLobbyRoom', start: 'startMode', idle: null },
    },
    krillocity: {
      proven: [
        'S1 supply expansion (bank-backed answers per prompt)',
        'S2 rare-100 first then 85/60/30/15/10 with strict dedupe',
        'S3 hold 50ms fill / 90ms step safe cadence',
      ],
      doNotWire: [
        'S4 submit to buzzer + claim 2.5s verdict grace', // do-not-wire (REJECTED)
        'S5 protect AI-judge allowance: prefer bank-known answers', // do-not-wire (REJECTED)
      ],
      route: { answer: 'answerCurrentPrompt', lobby: 'joinLobbyRoom', start: 'startMode', idle: null },
    },
    mp: {
      proven: [
        'cache-top-picks',
        'duel-rare-first',
        'most-populated-trap',
        'marathon-5s-50',
        'long-private-rooms',
        'refusal-calibration',
        'requeue-stop-loss',
      ],
      doNotWire: [
        'rating-protection', // do-not-wire (REJECTED)
      ],
      route: { answer: 'answerCurrentPrompt', lobby: 'joinLobbyRoom', start: 'startMode', idle: null },
    },
    duel: {
      // Duel shares the Multiplayer set; duel-rare-first leads the pick order.
      proven: [
        'cache-top-picks',
        'duel-rare-first',
        'most-populated-trap',
        'marathon-5s-50',
        'long-private-rooms',
        'refusal-calibration',
        'requeue-stop-loss',
      ],
      doNotWire: [
        'rating-protection', // do-not-wire (REJECTED)
      ],
      route: { answer: 'answerCurrentPrompt', lobby: 'joinLobbyRoom', start: 'startMode', idle: 'duelTick' },
    },
  };

  // Maps a UI mode value to a STRATEGY_CONFIG group. marathon5/showoff are both
  // Multiplayer rooms, so they share the `mp` group; duel has its own group so
  // its idle handler stays duelTick. Krillocity multiplayer is still a rapid
  // race, so it uses the `krillocity` proven set even though it joins a room.
  function modeConfigKey(modeValue) {
    if (modeValue === 'classic' || modeValue === 'krillocity' || modeValue === 'duel') return modeValue;
    if (modeValue === 'krillomulti') return 'krillocity';
    return 'mp';
  }

  // Read-only accessors: never expose a REJECTED id as active, never mutate config.
  function modeConfigFor(modeValue) {
    return STRATEGY_CONFIG[modeConfigKey(modeValue)] || STRATEGY_CONFIG.classic;
  }

  function modeConfigForBot() {
    return modeConfigFor(bot.mode);
  }

  // Diagnostics view: the PROVEN ids for a mode (copy, so callers cannot edit config).
  function strategyIdsFor(modeValue) {
    return modeConfigFor(modeValue).proven.slice();
  }

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
    // Race helpers are lazily initialised, but safe to reset for every mode.
    raceCancel();
    bot.racePrompt = '';
    bot.raceInput = null;
    bot.racePool = null;
    bot.racePoolIdx = 0;
    bot.raceTierReady = false;
    // A race-local dedupe set survives a same-prompt input remount (which
    // botTick treats as a round boundary and clears submittedForPrompt for).
    if (closed) bot.raceSubmitted = new Set();
  }

  function botStatus(text) {
    bot.state = text;
    const el = document.getElementById('ka-botstate');
    if (el) el.textContent = text;
  }

  function setBot(on) {
    bot.on = !!on;
    botActive = bot.on;
    // Pick / Mode are deliberately always visible: choose the next run before
    // turning Play for me on. They are inert while the bot is off, not hidden.
    const deps = document.getElementById('ka-botdeps');
    if (deps) deps.hidden = false;
    try { GM_setValue(BOT_KEY, bot.on); } catch (e) { /* no storage */ }
    const btn = document.getElementById('ka-bot');
    btn.setAttribute('aria-pressed', String(bot.on));
    btn.dataset.on = String(bot.on);
    btn.title = bot.on
      ? 'Playing dives for you. Click again to stop and take control.'
      : 'Plays whole dives for you: picks an answer, fills it and submits it.';
    const stateEl = document.getElementById('ka-botstate');
    if (stateEl) stateEl.dataset.active = String(bot.on);
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
    const el = sel === SEL.prompt ? promptEl() : document.querySelector(sel);
    return !!(el && (el.offsetParent !== null || el.getClientRects().length > 0));
  }

  // God mode draws a point GROUP, not a fixed cadence. Gaussian w(i) =
  // exp(-(i-4)^2 / (2*1.1^2)) over tier indices 4..9 (10..100), normalised to
  // 100.00% exactly: 10=0.05%, 15=0.95%, 30=7.54%, 60=26.04%, 85=39.38%, 100=26.04%.
  // The peak stays at 85pt; the former 0.01 shortfall went to 100pt via the
  // rounding guard below, skewing the declared distribution.
  const GOD_TIER_POINTS = [10, 15, 30, 60, 85, 100];
  const GOD_TIER_CHANCE = { 10: 0.05, 15: 0.95, 30: 7.54, 60: 26.04, 85: 39.38, 100: 26.04 };
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

  // PROVEN classic "God Gaussian pick": Gaussian tier draw with empty-tier
  // redistribution — an empty bucket hands its chance to the nearest populated
  // tier via nearestGodGroup(), never to a bucket with no answers.
  // do-not-wire: REJECTED classic id `tier-greedy fallback / rare-first within confidence` — NEVER wired here.
  // The greedy 85pt pick exists only in the Krillocity race pool; no Classic proof.
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

  // ---- Krillocity race helpers -------------------------------------------
  // Krillocity is rapid-fire: one prompt at a time, type as many correct
  // answers as you can before the timer expires. The burst loop below is
  // self-scheduled from here so botTick's 500ms timer stays untouched.
  //
  // REJECTED — do-not-wire (STRATEGY-VERIFIED.md / Phase 4 input):
  //   S4 submit to buzzer + claim 2.5s verdict grace — verdicts are
  //     server-authoritative and unobservable without a live scored daily.
  //   S5 protect AI-judge allowance: prefer bank-known answers — allowance
  //     size/refill are server-side; bank-only vs speculative is a proxy only.
  function raceCancel() {
    if (bot.raceTimer) { clearTimeout(bot.raceTimer); bot.raceTimer = null; }
    if (bot.raceSubmitTimer) { clearTimeout(bot.raceSubmitTimer); bot.raceSubmitTimer = null; }
  }

  function raceSchedule(delay) {
    raceCancel();
    if (!bot.on || bot.roundClosed) return;
    bot.raceTimer = setTimeout(() => {
      bot.raceTimer = null;
      raceBurst();
    }, delay);
  }

  // PROVEN S1 supply expansion (bank-backed answers per prompt): the pool
  // draws rare 100pt answers from /api/all (state.groups) AND low-tier answers
  // from /api/all-tier (state.tierPremap). Both sources are bank-backed only —
  // no play-score demotion and no near-duplicate bank merge.
  // PROVEN S2 rare-100 first then 85/60/30/15/10 with strict dedupe: the rare
  // list is pushed first, tiers sorted high->low, and `seen` enforces strict
  // per-prompt uniqueness. Near-duplicate banks stay separate — only groups[0]
  // is used, and aliases are never applied.
  function raceBuildPool(prompt) {
    const seen = new Set();
    const pool = [];
    // Preferred path: the bridge's full race pool (100/85/60/30/15/10 plus
    // other players' graded answers) already sorted highest points first.
    const serverPool = state.krilloRacePool && state.krilloRacePool.get(keyFor(prompt));
    if (serverPool && serverPool.length) {
      const sorted = serverPool.slice().sort((x, y) => (y.points || 0) - (x.points || 0));
      sorted.forEach((entry) => {
        const a = String(entry && entry.answer == null ? '' : entry.answer).trim();
        const key = a.toLowerCase();
        if (!a || seen.has(key)) return;
        if (state.refusedAnswers.has(prompt + '\u0000' + a)) return;
        seen.add(key);
        pool.push(a);
      });
      return pool;
    }
    const groups = state.groups.length ? state.groups : [{ answers: state.answers || [] }];
    const rareList = groups[0].answers || [];
    rareList.forEach((value) => {
      const a = String(value == null ? '' : value).trim();
      if (!a || seen.has(a)) return;
      if (state.refusedAnswers.has(prompt + '\u0000' + a)) return;
      seen.add(a);
      pool.push(a);
    });
    const bank = state.answerQuestion[rareList[0]] || groups[0].question || prompt;
    const tier = state.tierPremap && (
      state.tierPremap.get(keyFor(prompt)) || state.tierPremap.get(keyFor(bank))
    );
    if (tier && tier.length) {
      parseTierAnswers(tier)
        .sort((x, y) => y.points - x.points) // 85 before 60/30/15/10
        .forEach((entry) => {
          const a = String(entry.answer == null ? '' : entry.answer).trim();
          if (!a || seen.has(a)) return;
          if (state.refusedAnswers.has(prompt + '\u0000' + a)) return;
          seen.add(a);
          pool.push(a);
        });
    }
    return pool;
  }

  function raceNextAnswer(prompt) {
    const tierReady = state.tierPremap !== null;
    if (!bot.racePool || (tierReady && !bot.raceTierReady)) {
      bot.racePool = raceBuildPool(prompt);
      bot.racePoolIdx = 0;
      bot.raceTierReady = tierReady;
    }
    while (bot.racePoolIdx < bot.racePool.length) {
      const a = bot.racePool[bot.racePoolIdx++];
      const key = prompt + '\u0000' + a;
      if (state.refusedAnswers.has(key)) continue;
      if (bot.submittedForPrompt.has(key)) continue;
      if (bot.raceSubmitted && bot.raceSubmitted.has(key)) continue;
      return a;
    }
    return '';
  }

  function raceBurst() {
    if (!bot.on || bot.roundClosed) { raceCancel(); return false; }
    const prompt = promptText();
    const input = document.querySelector(SEL.input);
    if (!prompt || !input) { raceCancel(); return false; }
    // PROVEN S2 rare-100 first then 85/60/30/15/10 with strict dedupe:
    // Prompt boundary: text change OR a freshly mounted input element. Either
    // restarts the burst at once. Only a TEXT change is a genuinely new prompt,
    // so keep the no-repeat set across a same-prompt React input remount;
    // a text change clears it so answers never leak to the next prompt.
    const textChanged = prompt !== bot.racePrompt;
    if (textChanged || input !== bot.raceInput) {
      raceCancel();
      if (textChanged) {
        bot.raceSubmitted = new Set();
        bot.submittedForPrompt.clear();
        bot.answeredPrompt = prompt;
      }
      bot.racePrompt = prompt;
      bot.raceInput = input;
      bot.racePool = null;
      bot.racePoolIdx = 0;
      bot.raceTierReady = false;
      bot.answeredInput = input;
    }
    // botTick also calls answerCurrentPrompt every 500ms — never submit twice
    // for the same slot while a self-scheduled step is already armed.
    if (bot.raceTimer) return false;
    if (state.loadedPrompt !== prompt
        || (!state.groups.length && !(state.answers && state.answers.length))) {
      botStatus('loading answers');
      raceSchedule(80);
      return false;
    }
    const answer = raceNextAnswer(prompt);
    if (!answer) {
      // Pool drained (or tier premap still loading): wait briefly, then
      // re-check. raceNextAnswer rebuilds once the premap becomes ready.
      botStatus('race: no more answers');
      raceSchedule(150);
      return false;
    }
    // PROVEN S3 hold 50ms fill / 90ms step safe cadence: bounded gaps that let
    // React register each input (harness model, not an exact live minimum).
    const SUBMIT_GAP = 50; // fill -> submit, so React registers each input
    const STEP_GAP = 90;   // submit -> next fill (rapid, but still registered)
    bot.submittedForPrompt.add(prompt + '\u0000' + answer);
    if (!bot.raceSubmitted) bot.raceSubmitted = new Set();
    bot.raceSubmitted.add(prompt + '\u0000' + answer);
    bot.lastSubmitAt = Date.now();
    bot.answerCount++;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, answer);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    state.lastFilled = answer;
    state.refusalActive = false;
    state.answerQuestion[answer] = state.groups.length
      ? (state.groups[0].question || prompt) : prompt;
    botStatus('race answer sent');
    raceSchedule(STEP_GAP);
    bot.raceSubmitTimer = setTimeout(() => {
      bot.raceSubmitTimer = null;
      submitAnswer();
    }, SUBMIT_GAP);
    return true;
  }

  function answerCurrentPrompt() {
    const prompt = promptText();
    const input = document.querySelector(SEL.input);
    const isRace = mode() === 'krillocity';
    if (!prompt || !input) { if (isRace) raceCancel(); return false; }
    // A verdict/results screen is open for this round — never re-answer it.
    if (bot.roundClosed) { if (isRace) raceCancel(); return false; }
    // Race mode is fully handled by the self-scheduled burst helpers above.
    if (isRace) return raceBurst();
    if (!isRace && bot.answeredPrompt === prompt) return false;
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
      const confirmed = state.bankConfirmed;
      const bankQ = groups[0] && groups[0].question ? groups[0].question : prompt;
      const preferred = confirmed
        && (confirmed.question === prompt || confirmed.question === bankQ)
        && list.indexOf(confirmed.answer) !== -1 ? confirmed.answer : '';
      answer = preferred || pickAnswer(list);
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

  // PROVEN cache-top-picks (STRATEGY-VERIFIED.md): in every multiplayer mode the
  // shared engine answers from the warm netCache/premap with the 'top' pick,
  // submitting a banked 100-point answer. Near-duplicate banks stay labelled and
  // separate; no play score ever demotes one. This selector only chooses a room.
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
      // PROVEN marathon-5s-50: parse "50 prompts, 5s each" numerically instead
      // of guessing by text, and join a 5s room with >=50 prompts (15+ fallback).
      // Depth/minute is higher there; a cold cache just answers nothing.
      const parsed = info.map((x) => {
        const m = x.detail.toLowerCase().match(/(\d+)\s*prompts?\s*,\s*(\d+)\s*s(?:ec)?/);
        return Object.assign({}, x, { prompts: m ? Number(m[1]) : 0, seconds: m ? Number(m[2]) : 0 });
      });
      target = parsed.find((x) => x.seconds === 5 && x.prompts >= 50)
        || parsed.find((x) => x.seconds === 5 && x.prompts >= 15);
      reason = target ? 'matched 5-second room' : 'no 5-second room available';
    } else if (bot.mode === 'showoff' || bot.mode === 'krillomulti') {
      // PROVEN most-populated-trap: argmax seat count wins. Crowding only lengthens
      // the between-round settle; our own grade stays independent of population.
      // Other players' rows are never read, so room place stays unmeasured.
      // Krillocity multiplayer uses the same room-list selector on /krillocity.
      let best = -1;
      info.forEach((x) => { if (x.count > best) { best = x.count; target = x; } });
      // PROVEN long-private-rooms: this same argmax path selects a long (50-prompt)
      // private room when it holds the most players; codes join manually.
      // Low scores stay evidence-only, never a bank demotion.
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
    // Krillocity multiplayer: same rapid-fire race engine, but enter through
    // the room lobby instead of START DAILY. Room selection is the most-populated
    // trap already proven for multiplayer, and other players' answers are never read.
    if (bot.mode === 'krillomulti') {
      if (!/^\/krillocity\/?$/.test(location.pathname)) {
        const link = document.querySelector('a.kr-peek');
        if (link && link.offsetParent !== null) {
          reportBot('krillocity-open', { note: 'Play Krillocity (multiplayer)' });
          link.click();
          botStatus('opening Krillocity');
          return true;
        }
        return false;
      }
      const play = [...document.querySelectorAll('button')].find(
        (b) => /play\s+multiplayer/i.test(b.innerText || '') && b.offsetParent !== null
      );
      if (play) {
        reportBot('krillocity-multi-open', { note: 'Play multiplayer' });
        play.click();
        botStatus('opening Krillocity multiplayer lobby');
        return true;
      }
      return false;
    }
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
        // Drop any race state left over from the previous daily run.
        raceCancel();
        resetBotRound(false);
        bot.raceSubmitted = new Set();
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
    // PROVEN refusal-calibration (MP/duel): refusals are logged as evidence only
    // and retried with a different rare answer by the shared engine. The 500 ms
    // bot tick is the calibration — under 120 ms left on a 5s clock no retry is
    // accepted; 15s/30s rooms leave room for a 100-point retry. No demotion.
    const wanted = bot.mode === 'duel' ? /1\s*vs\s*1/i : /multiplayer/i;
    const btn = online.find((b) => wanted.test(b.innerText) && b.offsetParent !== null);
    if (btn) {
      if (bot.mode === 'duel') { bot.duelLossStreak = 0; bot.duelRematches = 0; }
      btn.click();
      botStatus(bot.mode === 'duel' ? 'finding opponent' : 'opening lobby');
      return true;
    }
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

  // PROVEN requeue-stop-loss (STRATEGY-VERIFIED.md): after a result, requeue
  // unless 2 consecutive defeats (stop-loss) or the 3-rematch session cap is hit.
  // Outcome comes from OUR OWN .kd-result-title only; foe identity, rating,
  // answers and room place are never read or logged. Element identity is the
  // edge trigger, so a lingering result screen is evaluated exactly once.
  function duelRequeueGate() {
    const keys = document.querySelector('.kd-result-keys');
    if (!keys) return false;
    if (bot.duelResultHandled === keys) return !!bot.duelRequeueAllowed;
    bot.duelResultHandled = keys;

    const title = (document.querySelector('.kd-result-title')?.textContent || '').toLowerCase();
    if (/defeat|loss|lost/.test(title)) bot.duelLossStreak = (bot.duelLossStreak || 0) + 1;
    else if (/victory|win|won/.test(title)) bot.duelLossStreak = 0;
    const losses = bot.duelLossStreak || 0;
    const rematches = bot.duelRematches || 0;

    if (losses >= 2) {
      bot.duelRequeueAllowed = false;
      reportBot('duel-stop-loss', { note: 'stop-loss after ' + losses + ' defeats', lossStreak: losses, rematches });
      botStatus('stop-loss: not requeueing');
      return false;
    }
    if (rematches >= 3) {
      bot.duelRequeueAllowed = false;
      reportBot('duel-rematch-cap', { note: 'rematch cap reached', rematches, lossStreak: losses });
      botStatus('rematch cap reached');
      return false;
    }
    bot.duelRequeueAllowed = true;
    bot.duelRematches = rematches + 1;
    return true;
  }

  function duelTick() {
    // State-aware handling of the real Colosseum screens. Never click the
    // "Leave before it starts" or "Back to the arena" buttons.
    // do-not-wire: rating-protection (REJECTED — live forfeit test unsafe,
    // liveForfeitTested=false). Tab-out/leave avoidance cannot be proven without
    // deliberately forfeiting a real match, so no leave/forfeit logic is added.
    if (visible('.kd-versus')) { botStatus('match found — waiting for first prompt'); return; }
    if (visible('.kd-tab-rule')) { duelClick('.kd-tab-rule-key', 'duel-rule', 'accepted tab rule'); return; }
    if (visible('.kd-elsewhere')) { duelClick('.kd-elsewhere-key', 'duel-claim', 'claimed queue here'); return; }
    // PROVEN duel-rare-first: duel prompts are answered from the 100-point rare
    // list first by the shared engine; a refusal retries another rare answer,
    // never a foe's row (foeRowsRead=0).
    if (visible('.kd-result-keys')) {
      if (duelRequeueGate()) duelClick('.kd-again', 'duel-requeue', 'queued another match');
      return;
    }
    if (visible('.kd-play')) { duelClick('.kd-play', 'duel-queue', 'finding a match'); return; }
    botStatus('waiting for duel lobby');
  }

  function botTick() {
    if (!bot.on || bot.busy) return;
    bot.busy = true;
    try {
      // Config is the single source of truth for the active mode's handler
      // family. Dispatch below only reads it; strategy logic stays in the
      // owning functions. The roundClosed results branch is W4-B owned.
      const cfg = modeConfigForBot();
      const route = cfg.route;
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
        if (visible('.kr-over') || visible('.kr-over-next')) {
          // Classic must save every expanded bank BEFORE starting a new dive.
          if (bot.mode === 'classic') finalizeClassicResults();
          else restartFromResults();
        }
        else if (bot.mode === 'duel') duelTick();
        else botStatus('waiting for the next round');
      } else if (p && visible(SEL.prompt) && visible(SEL.input) && route.answer) {
        answerCurrentPrompt();
      } else if ((visible('.kr-lobby-tab') || visible('.kr-room-row')) && route.lobby) {
        joinLobbyRoom();
      } else if ((visible('.kr-intro') || visible('button.kr-begin')) && route.start) {
        startMode();
      } else if (route.idle) {
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
      $('ka-toggle').setAttribute('aria-label', state.collapsed ? 'Show answers' : 'Hide answers');
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
