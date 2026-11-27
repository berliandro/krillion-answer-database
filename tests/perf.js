#!/usr/bin/env node
/**
 * Phase 6 HARD GATE — dependency-free perf harness.
 *
 *   node tests/perf.js
 *
 * Replays >=50 real prompts against the REAL local bridge (127.0.0.1:8768,
 * token in the URL) while running the REAL userscript
 * (injection/krillion-autofill.user.js) inside a stubbed GM/DOM sandbox, using
 * the same load/export pattern as tests/roadmap_helpers.js and
 * tests/mode_harness.js. No real game is started and no browser account is
 * touched. All bridge writes (POST /api/miss, /api/prompt-review, /api/evidence,
 * /api/bot-log) are intercepted locally and never reach the bridge.
 *
 * Reports p50/p95 for:
 *   - prompt-visible -> chips rendered   (target p95 <100 ms; stretch <50 ms)
 *   - exact/premap path                  (target p95 <25 ms, zero /api/answers)
 *   - cold fuzzy path                    (target p95 <150 ms)
 *   - bridge small lookup HTTP           (target p95 <5 ms)
 *   - /api/all client parse+map          (target <20 ms)
 * Also counts missed prompts and timeouts across the replay (target 0/0).
 *
 * Prints a p50/p95 table, TARGETS_MET: true|false and MISSED/TIMEOUTS.
 * Exits non-zero when any target is not met.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.resolve(REPO, 'injection', 'krillion-autofill.user.js');
const HOST = '127.0.0.1';
const PORT = 8768;
const TOKEN = 'krillion-local-v1';
// Minimum 50 prompts is the acceptance contract; allow a larger run via env.
const N = Math.max(50, parseInt(process.env.KRILLION_PERF_N || '50', 10) || 50);
const WATCHDOG_MS = 8000;
const PARSE_ITERS = 5;

const ns = () => Number(process.hrtime.bigint());
const ms = (t0) => (ns() - t0) / 1e6;

function percentile(arr, p) {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = (s.length - 1) * (p / 100);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : 'n/a');

/** Real HTTP GET to the bridge. Returns {status, ms, bytes, raw, json}. */
function getJson(pathname, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const t0 = ns();
    const url = new URL('http://' + HOST + ':' + PORT + pathname);
    url.searchParams.set('t', TOKEN);
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { /* keep raw */ }
        resolve({
          status: res.statusCode, ms: ms(t0), bytes: Buffer.byteLength(body),
          raw: body, json,
        });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('http timeout')));
    req.on('error', reject);
  });
}

/** Per-lookup watchdog; resolves false if it had to cut the call loose. */
function withWatchdog(promise, timeoutMs) {
  let fired = false;
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => { fired = true; resolve(); }, timeoutMs);
  });
  return Promise.race([promise.then(() => false, () => false), guard])
    .then(() => { clearTimeout(timer); return fired; });
}

async function main() {
  const src = fs.readFileSync(SCRIPT, 'utf8');

  // -------------------------------------------------------------------------
  // Bridge readiness (read-only GET).
  // -------------------------------------------------------------------------
  let status;
  try {
    status = await getJson('/api/status', 2500);
  } catch (e) {
    console.error('BRIDGE_UNREACHABLE: ' + (e && e.message || e));
    process.exitCode = 1;
    return;
  }
  if (status.status !== 200 || !status.json || status.json.ok !== true) {
    console.error('BRIDGE_UNHEALTHY: status ' + status.status);
    process.exitCode = 1;
    return;
  }

  // -------------------------------------------------------------------------
  // Stubbed DOM / GM environment (mirrors roadmap_helpers.js + mode_harness.js)
  // -------------------------------------------------------------------------
  const counters = { gets: Object.create(null), post: 0, timeouts: 0, getErrors: 0 };
  const captured = Object.create(null);
  const kaElements = new Map();
  const storage = new Map();
  let chipHook = null;
  let lastChipCount = 0;

  class StubElement {
    constructor(tag) {
      this.tagName = String(tag || 'div').toUpperCase();
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.textContent = '';
      this.value = '';
      this.disabled = false;
      this.hidden = false;
      this.offsetParent = {};
      this._attrs = {};
      this._listeners = {};
      this._html = '';
    }
    get innerHTML() { return this._html; }
    set innerHTML(v) {
      this._html = String(v == null ? '' : v);
      if (this.__onHtml) this.__onHtml(this._html);
    }
    setAttribute(k, v) { this._attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); }
    appendChild(c) { this.children.push(c); return c; }
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
    querySelector(sel) {
      if (typeof sel === 'string' && /^#ka-/.test(sel)) {
        if (!kaElements.has(sel)) kaElements.set(sel, new StubElement('div'));
        return kaElements.get(sel);
      }
      return null;
    }
    querySelectorAll(sel) {
      if (sel === '.ka-chip') {
        const n = (this._html.match(/class="ka-chip"/g) || []).length;
        return new Array(n).fill(0).map(() => new StubElement('button'));
      }
      return [];
    }
    getClientRects() { return [{}]; }
    focus() {}
    click() {}
    remove() {}
  }

  const promptEl = new StubElement('p');
  promptEl.textContent = '';
  const listEl = new StubElement('ul');
  listEl.__onHtml = (html) => {
    const n = (html.match(/class="ka-chip"/g) || []).length;
    if (n > 0) {
      lastChipCount = n;
      if (chipHook) { const t = ns(); chipHook(t); chipHook = null; }
    }
  };
  kaElements.set('#ka-list', listEl);

  const doc = {
    readyState: 'complete',
    body: null, // keep mount() from auto-running; we drive internals directly
    documentElement: new StubElement('html'),
    head: new StubElement('head'),
    createElement: (tag) => new StubElement(tag),
    querySelector: (sel) => {
      if (sel === 'p.kr-prompt') return promptEl;
      if (sel === '.kr-intro') return null; // intro hidden once a dive starts
      return kaElements.get(sel) || null;
    },
    querySelectorAll: () => [],
    getElementById: (id) => {
      const key = '#' + id;
      if (!kaElements.has(key)) kaElements.set(key, new StubElement('div'));
      return kaElements.get(key);
    },
    addEventListener() {},
  };

  function gmRequest(opts) {
    const method = String(opts.method || 'GET').toUpperCase();
    if (method !== 'GET') {
      // Read-only contract: never let the userscript write to the user's data.
      counters.post++;
      try {
        opts.onload({ status: 200, responseText: '{"ok":true,"harness":"read-only"}' });
      } catch (e) { /* consumer error is not a harness failure */ }
      return;
    }
    let u;
    try { u = new URL(opts.url); } catch (e) {
      if (opts.onerror) opts.onerror({ error: String(e) });
      return;
    }
    const key = u.pathname;
    counters.gets[key] = (counters.gets[key] || 0) + 1;
    const req = http.get(u, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        captured[key] = body;
        try { opts.onload({ status: res.statusCode, responseText: body }); }
        catch (e) { /* consumer error is not a harness failure */ }
      });
    });
    let settled = false;
    const fail = (kind) => {
      if (settled) return;
      settled = true;
      if (kind === 'timeout') counters.timeouts++;
      else counters.getErrors++;
      try {
        if (kind === 'timeout' && opts.ontimeout) opts.ontimeout({});
        else if (opts.onerror) opts.onerror({});
      } catch (e) { /* ignore */ }
      req.destroy();
    };
    req.setTimeout(Number(opts.timeout) || 2500, () => fail('timeout'));
    req.on('error', () => fail('error'));
  }

  function InputStub() {}
  Object.defineProperty(InputStub.prototype, 'value', {
    get() { return this.__v || ''; }, set(v) { this.__v = v; }, configurable: true,
  });
  function EventStub(type, init) { this.type = type; Object.assign(this, init || {}); }
  function KeyboardEventStub(type, init) { EventStub.call(this, type, init); }
  function MutationObserverStub() {
    this.observe = () => {}; this.disconnect = () => {}; this.takeRecords = () => [];
  }

  const sandbox = {
    console, Math, JSON, Number, String, Array, Map, Set, Object, Date, Promise,
    RegExp, isFinite, isNaN, parseInt, parseFloat, Error, Boolean, Symbol,
    document: doc,
    location: { pathname: '/krillion', hash: '', href: 'https://playdaily.org/krillion' },
    navigator: { userAgent: 'node-perf-harness' },
    HTMLInputElement: InputStub,
    Event: EventStub,
    KeyboardEvent: KeyboardEventStub,
    MutationObserver: MutationObserverStub,
    unsafeWindow: {
      fetch() {
        return Promise.resolve({ clone() { return this; }, json() { return Promise.resolve({}); } });
      },
    },
    GM_xmlhttpRequest: gmRequest,
    GM_addStyle() {},
    GM_setValue(k, v) { storage.set(k, v); },
    GM_getValue(k, d) { return storage.has(k) ? storage.get(k) : d; },
    setTimeout: (fn, delay) => setTimeout(fn, delay),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, delay) => setInterval(fn, delay),
    clearInterval: (id) => clearInterval(id),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  // Export real internals without changing the shipped file.
  const exportHook = ';globalThis.__KR_PERF__ = { state, SEL, bot, '
    + 'loadAnswers, preloadAnswers, buildPremap, premapGroups, keyFor, '
    + 'applyResult, render, promptText, parseTierAnswers, normLocal };';
  const endMarker = src.lastIndexOf('})();');
  if (endMarker < 0) {
    console.error('USERSCRIPT_LOAD_FAILED: closing IIFE not found');
    process.exitCode = 1;
    return;
  }
  const runnable = src.slice(0, endMarker) + exportHook + '\n' + src.slice(endMarker);
  try {
    vm.createContext(sandbox);
    vm.runInContext(runnable, sandbox, { filename: 'krillion-autofill.user.js', timeout: 10000 });
  } catch (e) {
    console.error('USERSCRIPT_LOAD_FAILED: ' + (e && e.message || e));
    process.exitCode = 1;
    return;
  }
  const KR = sandbox.__KR_PERF__;
  if (!KR || typeof KR.loadAnswers !== 'function' || typeof KR.buildPremap !== 'function') {
    console.error('USERSCRIPT_LOAD_FAILED: internals were not exported');
    process.exitCode = 1;
    return;
  }

  // Real preload through the real userscript (real /api/all + /api/all-tier).
  await KR.preloadAnswers();
  const allRaw = captured['/api/all'] || '';
  const tierRaw = captured['/api/all-tier'] || '';
  const allPayload = allRaw ? JSON.parse(allRaw) : null;
  const tierPayload = tierRaw ? JSON.parse(tierRaw) : null;
  if (!allPayload || !Array.isArray(allPayload.data) || allPayload.data.length < N) {
    console.error('DATA_INVALID: /api/all has fewer than ' + N + ' prompts');
    process.exitCode = 1;
    return;
  }
  if (!KR.state.premap || KR.state.premap.size < N) {
    console.error('DATA_INVALID: userscript premap was not built (' +
      (KR.state.premap ? KR.state.premap.size : 0) + ' keys)');
    process.exitCode = 1;
    return;
  }

  // -------------------------------------------------------------------------
  // Metric: /api/all client parse+map (real payload, real buildPremap).
  // -------------------------------------------------------------------------
  const parseSamples = [];
  let parsedMap = null;
  // Do the work inside the vm realm, exactly where the userscript's own
  // `JSON.parse(r.responseText)` + buildPremap() run in the browser.
  vm.runInContext(
    'globalThis.__perfParseMap = function (raw) { '
    + 'const parsed = JSON.parse(raw); '
    + 'return globalThis.__KR_PERF__.buildPremap(parsed.data); };',
    sandbox
  );
  const parseMapInVm = sandbox.__perfParseMap;
  for (let i = 0; i < PARSE_ITERS + 2; i++) {
    const t0 = ns();
    const map = parseMapInVm(allRaw);
    if (i >= 2) parseSamples.push(ms(t0)); // first two warm the JIT
    if (i === 2) parsedMap = map;
  }
  console.log('parse+map samples (ms): ' + parseSamples.map(fmt).join(', '));
  if (!parsedMap || parsedMap.size < N) {
    console.error('DATA_INVALID: rebuildPremap produced too few keys');
    process.exitCode = 1;
    return;
  }

  // -------------------------------------------------------------------------
  // Select N deterministic prompts + a fuzzy variant for each (real data).
  // Validation warms the bridge's server-side resolve cache so the measured
  // fuzzy path is "cold client (netCache cleared), warm server" — the only
  // regime compatible with the <150 ms responsiveness budget.
  // -------------------------------------------------------------------------
  const eligible = allPayload.data.filter((it) => it && it.q && Array.isArray(it.answers) && it.answers.length);
  const candidates = [];
  for (let i = 0; i < Math.min(eligible.length, N * 3); i++) {
    const idx = Math.floor(i * (eligible.length - 1) / Math.max(1, Math.min(eligible.length, N * 3) - 1));
    candidates.push(eligible[idx]);
  }
  const transforms = [
    (q) => q + ' please',
    (q) => 'Please ' + q,
  ];
  const replay = [];
  for (const item of candidates) {
    if (replay.length >= N) break;
    const q = item.q;
    // exact path needs a premap hit with the userscript's own key source.
    const key = KR.keyFor(q);
    if (!KR.state.premap.has(key)) continue;
    let fq = null;
    for (const tr of transforms) {
      const cand = tr(q);
      const r = await getJson('/api/answers?q=' + encodeURIComponent(cand), 2500);
      if (r.status === 200 && r.json && r.json.ok && r.json.count > 0 && r.json.exact === false) {
        fq = cand;
        break;
      }
    }
    if (fq) replay.push({ q, fq });
  }
  if (replay.length < N) {
    console.error('DATA_INVALID: only ' + replay.length + '/' + N + ' prompts had a usable fuzzy variant');
    process.exitCode = 1;
    return;
  }

  // Warm-up (not measured): JIT + one of each path.
  KR.state.netCache.clear();
  await KR.loadAnswers(replay[0].q);
  KR.state.netCache.clear();
  await KR.loadAnswers(replay[0].fq);

  // -------------------------------------------------------------------------
  // Replay: each prompt gets an exact/premap lookup and a cold-fuzzy lookup,
  // plus a direct small bridge lookup. POSTs are blocked locally.
  // -------------------------------------------------------------------------
  const exactSamples = [];
  const fuzzySamples = [];
  const visibleSamples = [];
  const bridgeSamples = [];
  let missed = 0;
  let timeouts = 0;
  let exactCallViolations = 0;
  let fuzzyNoCall = 0;
  let chipFailures = 0;

  function doLookup(question, expectNetwork) {
    promptEl.textContent = question;       // "prompt visible"
    lastChipCount = 0;
    let chipAt = null;
    chipHook = (t) => { chipAt = t; };
    const before = counters.gets['/api/answers'] || 0;
    const t0 = ns();
    const p = KR.loadAnswers(question);    // real prompt-detect -> load path
    return withWatchdog(p, WATCHDOG_MS).then((watchdogFired) => {
      chipHook = null;
      const after = counters.gets['/api/answers'] || 0;
      const calls = after - before;
      const latency = chipAt !== null ? (chipAt - t0) / 1e6 : NaN;
      const chips = lastChipCount > 0;
      if (watchdogFired) timeouts++;
      if (!chips) chipFailures++;
      if (expectNetwork === 0 && calls !== 0) exactCallViolations++;
      if (expectNetwork === 1 && calls < 1) fuzzyNoCall++;
      return { ok: chips && !watchdogFired && Number.isFinite(latency), latency, calls };
    });
  }

  for (let i = 0; i < N; i++) {
    const item = replay[i];

    KR.state.netCache.clear();
    const exact = await doLookup(item.q, 0);
    if (exact.ok) { exactSamples.push(exact.latency); visibleSamples.push(exact.latency); }

    KR.state.netCache.clear();
    const fuzzy = await doLookup(item.fq, 1);
    if (fuzzy.ok) { fuzzySamples.push(fuzzy.latency); visibleSamples.push(fuzzy.latency); }

    if (!exact.ok || !fuzzy.ok) missed++;

    try {
      const r = await getJson('/api/answers?q=' + encodeURIComponent(item.q), 2500);
      if (r.status === 200 && r.json && r.json.ok === true && r.json.count > 0) {
        bridgeSamples.push(r.ms);
      }
    } catch (e) { /* bridge error counted as a missing sample, not a miss */ }
  }

  // -------------------------------------------------------------------------
  // Targets + table.
  // -------------------------------------------------------------------------
  const p50v = percentile(visibleSamples, 50);
  const p95v = percentile(visibleSamples, 95);
  const p50e = percentile(exactSamples, 50);
  const p95e = percentile(exactSamples, 95);
  const p50f = percentile(fuzzySamples, 50);
  const p95f = percentile(fuzzySamples, 95);
  const p50b = percentile(bridgeSamples, 50);
  const p95b = percentile(bridgeSamples, 95);
  const p50p = percentile(parseSamples, 50);
  const p95p = percentile(parseSamples, 95);

  const failures = [];
  if (!(p95v < 100)) failures.push('prompt-visible -> chips rendered: p95 ' + fmt(p95v) + ' ms (target <100)');
  if (!(p95e < 25)) failures.push('exact/premap path: p95 ' + fmt(p95e) + ' ms (target <25)');
  if (exactCallViolations !== 0) failures.push('exact/premap path: ' + exactCallViolations + ' /api/answers calls (target 0)');
  if (!(p95f < 150)) failures.push('cold fuzzy path: p95 ' + fmt(p95f) + ' ms (target <150)');
  if (!(p95b < 5)) failures.push('bridge small lookup HTTP: p95 ' + fmt(p95b) + ' ms (target <5)');
  if (!(p95p < 20)) failures.push('/api/all client parse+map: p95 ' + fmt(p95p) + ' ms (target <20)');
  if (missed !== 0) failures.push('missed prompts: ' + missed + ' (target 0)');
  if (timeouts !== 0) failures.push('timeouts: ' + timeouts + ' (target 0)');
  if (fuzzyNoCall !== 0) failures.push('cold fuzzy path: ' + fuzzyNoCall + ' lookups made no /api/answers call');
  if (chipFailures !== 0) failures.push('chips not rendered: ' + chipFailures + ' lookups');

  const targetsMet = failures.length === 0;

  console.log('');
  console.log('Krillion Phase 6 perf harness — REAL bridge 127.0.0.1:' + PORT +
    ', REAL userscript in stubbed GM/DOM');
  console.log('Replay: ' + replay.length + ' prompts (' + replay.length +
    ' exact/premap + ' + replay.length + ' cold-fuzzy = ' + (replay.length * 2) +
    ' lookups), plus ' + bridgeSamples.length + ' direct bridge lookups');
  console.log('Data: /api/all ' + allPayload.data.length + ' banks / ' +
    Buffer.byteLength(allRaw) + ' B; /api/all-tier ' +
    ((tierPayload && tierPayload.data && tierPayload.data.length) || 0) + ' rows (version ' +
    ((tierPayload && tierPayload.version) || 'n/a') + ')');
  console.log('Bridge writes blocked locally (read-only harness): ' + counters.post +
    ' POST(s); GM timeouts ' + counters.timeouts + ', GET errors ' + counters.getErrors);
  const noise = [];
  for (let i = 0; i < 20; i++) {
    const t0 = ns();
    JSON.parse('{"calibration":1}');
    noise.push(ms(t0));
  }
  console.log('Host noise floor (20 tiny JSON.parse calls, p50/p95 ms): ' +
    fmt(percentile(noise, 50)) + ' / ' + fmt(percentile(noise, 95)));
  console.log('Note: prompt-visible -> chips excludes the deliberate 50 ms MutationObserver debounce;');
  console.log('      fuzzy is cold-client (netCache cleared), warm-server (budget <150 ms).');
  console.log('');
  const head = 'Metric'.padEnd(40) + 'p50(ms)'.padStart(9) + 'p95(ms)'.padStart(9) +
    '  ' + 'Target'.padEnd(24) + 'Result';
  console.log(head);
  console.log('-'.repeat(head.length));
  const row = (name, a, b, target, ok) => console.log(
    name.padEnd(40) + fmt(a).padStart(9) + fmt(b).padStart(9) + '  ' +
    target.padEnd(24) + (ok ? 'PASS' : 'FAIL'));
  row('prompt-visible -> chips rendered', p50v, p95v, 'p95 < 100', p95v < 100);
  row('exact/premap path (0 /api/answers)', p50e, p95e, 'p95 < 25, 0 calls',
    p95e < 25 && exactCallViolations === 0);
  row('cold fuzzy path (netCache cleared)', p50f, p95f, 'p95 < 150', p95f < 150);
  row('bridge small lookup HTTP', p50b, p95b, 'p95 < 5', p95b < 5);
  row('/api/all client parse+map', p50p, p95p, '< 20', p95p < 20);
  console.log('');
  console.log('Stretch (visible -> chips p95 < 50 ms): ' + (p95v < 50 ? 'MET' : 'NOT MET') +
    ' (p95 ' + fmt(p95v) + ' ms)');
  console.log('Exact path /api/answers calls: ' + exactCallViolations +
    '; fuzzy path lookups with no /api/answers call: ' + fuzzyNoCall);
  console.log('MISSED: ' + missed + ' TIMEOUTS: ' + timeouts);
  console.log('TARGETS_MET: ' + (targetsMet ? 'true' : 'false'));
  if (!targetsMet) {
    console.log('FAILED TARGETS:');
    failures.forEach((f) => console.log(' - ' + f));
  }
  process.exitCode = targetsMet ? 0 : 1;
}

main().catch((e) => {
  console.error('HARNESS_ERROR: ' + (e && e.stack || e));
  process.exitCode = 1;
});
