#!/usr/bin/env node
/**
 * Phase 5 / W5-B — dependency-free fault-injection suite for the SHIPPED userscript.
 *
 *   node tests/faults.test.js
 *
 * Loads injection/krillion-autofill.user.js in a fresh vm sandbox per fault with
 * stubbed GM/DOM globals (roadmap_helpers.js / mode_harness.js stub pattern),
 * then injects one controlled fault at a time and checks whether the script
 * handles it. Nothing in the repository is modified and no bridge is contacted.
 *
 * Each fault prints exactly one [PASS] (handled correctly) or [FAIL] (genuine
 * bug found) line. A FAIL includes the reproduction and expected vs actual so
 * the coordinator can route it to W5-D. The process exits non-zero on any FAIL.
 *
 * Classes: M miscalculation | W missed wording | T missed timing | O optimisation.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.resolve(REPO, 'injection', 'krillion-autofill.user.js');
const src = fs.readFileSync(SCRIPT, 'utf8');
const TIER_PATH = path.resolve(REPO, 'data', 'tier-data.json');
const tierObj = JSON.parse(fs.readFileSync(TIER_PATH, 'utf8'));
const tierRows = Array.isArray(tierObj.data) ? tierObj.data
  : (Array.isArray(tierObj.rows) ? tierObj.rows : []);

const CLS = {
  M: 'miscalculation',
  W: 'missed-wording',
  T: 'missed-timing',
  O: 'optimisation',
};
const results = [];

function ck(ok, name, detail) { return { ok: !!ok, name, detail: String(detail) }; }
function verify(checks) {
  const bad = checks.filter((c) => !c.ok);
  return {
    ok: bad.length === 0,
    detail: bad.length
      ? bad.map((c) => `${c.name}: ${c.detail}`).join(' | ')
      : checks.map((c) => `${c.name}=${c.detail}`).join(' | '),
  };
}
async function fault(cls, id, fn) {
  let out;
  try {
    out = await fn();
  } catch (e) {
    out = { ok: false, detail: `THREW ${(e && e.message) || String(e)}` };
  }
  const ok = !!(out && out.ok);
  const detail = (out && out.detail) || String(out);
  results.push({ cls, id, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${cls}/${id}: ${detail}`);
}
async function flushMicro() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

// ---------------------------------------------------------------------------
// Sandboxed userscript loader (roadmap_helpers.js stub pattern, extended).
// ---------------------------------------------------------------------------
const EXPORT_HOOK = `
;globalThis.__FAULT_T__ = {
  state, bot, SEL, GOD_TIER_POINTS, GOD_TIER_CHANCE, GOD_TIER_TEXT_POINTS,
  PREFETCH_MAX, PREFETCH_CONCURRENCY, MO_DEBOUNCE_MS, LOOKUP_TIMEOUT,
  normLocal, keyFor, buildPremap, applyResult, loadAnswers,
  tierPointsOf, parseTierAnswers, nearestGodGroup, pickAnswer, pickGodAnswer,
  gameState, promptText, mode, inputState, ctx, isVisible, visible,
  checkRefusal, checkVerdict, reportScore, reportBot, reportPrompt, reportMiss,
  captureBanks, classicRows, classicExpandRows, finalizeClassicResults,
  raceBuildPool, raceNextAnswer, raceBurst, raceCancel, raceSchedule,
  answerCurrentPrompt, joinLobbyRoom, startMode, restartFromResults,
  request, enqueuePrefetch, drainPrefetch, botTick, submitAnswer,
  preloadAnswers, resetBotRound, queuePost, strategyIdsFor
};`;

function makeHarness(opts) {
  opts = opts || {};
  const clock = { now: opts.now === undefined ? 1700000000000 : opts.now };
  const timers = [];
  const intervals = [];
  const requests = [];
  const observers = [];
  const inputWrites = [];
  const randomQueue = Array.isArray(opts.random) ? opts.random.slice() : [0.5];
  let timerId = 0;

  class FakeDate extends Date { static now() { return clock.now; } }

  class StubElement {
    constructor(tag, sels) {
      this.tagName = String(tag || 'div').toUpperCase();
      this._sels = Array.isArray(sels) ? sels.slice() : (sels ? String(sels).split(',') : []);
      this._attrs = {};
      this._listeners = {};
      this._rects = [{}];
      this._clicks = 0;
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.textContent = '';
      this.innerText = '';
      this.innerHTML = '';
      this.value = '';
      this.disabled = false;
      this.readOnly = false;
      this.placeholder = '';
      this.offsetParent = {};
      this.hidden = false;
      this.className = '';
      this.id = '';
    }
    matches(sel) { return this._sels.indexOf(sel) !== -1; }
    setAttribute(k, v) { this._attrs[k] = String(v); }
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
    }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
    }
    remove() {}
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
    removeEventListener() {}
    dispatchEvent() { return true; }
    getClientRects() { return this._rects; }
    focus() {}
    requestSubmit() { this._submits = (this._submits || 0) + 1; }
    click() {
      this._clicks++;
      if (Object.prototype.hasOwnProperty.call(this._attrs, 'aria-expanded')) {
        this._attrs['aria-expanded'] = this._attrs['aria-expanded'] === 'true' ? 'false' : 'true';
      }
      (this._listeners.click || []).slice().forEach((f) => f({ type: 'click', target: this }));
    }
    querySelector(sel) { return this._query(sel, true); }
    querySelectorAll(sel) { return this._query(sel, false); }
    _query(sel, one) {
      const parts = String(sel).split(',').map((s) => s.trim());
      const found = [];
      const walk = (node) => {
        node.children.forEach((ch) => {
          if (parts.some((p) => ch._sels.indexOf(p) !== -1 || ch.id === '#' + p)) found.push(ch);
          walk(ch);
        });
      };
      walk(this);
      // The script queries its own panel ids at mount before they are inserted;
      // mirror roadmap_helpers.js by lazily materialising a stable stub.
      if (!found.length) {
        parts.forEach((p) => {
          if (/^#ka-/.test(p)) {
            const stub = new StubElement('div', [p]);
            stub.id = p;
            this.appendChild(stub);
            found.push(stub);
          }
        });
      }
      return one ? (found[0] || null) : found;
    }
  }

  const all = [];
  function add(sel, props, parent) {
    const parts = String(sel).split(',').map((s) => s.trim());
    const sels = parts.slice();
    parts.forEach((p) => {
      const m = /^[a-zA-Z]+/.exec(p);
      if (m) sels.push(m[0].toLowerCase());
    });
    const tag = (props && props.tag) || (/^[a-zA-Z]+/.exec(parts[0]) || ['div'])[0];
    const el = new StubElement(tag, sels);
    Object.assign(el, props || {});
    if (parent) parent.appendChild(el); else all.push(el);
    return el;
  }
  const dom = {
    all,
    add,
    get(sel) {
      const parts = String(sel).split(',').map((s) => s.trim());
      return all.find((e) => parts.some((p) => e._sels.indexOf(p) !== -1)) || null;
    },
    set(sel, props) {
      const el = dom.get(sel);
      if (el) Object.assign(el, props || {});
      else return add(sel, props);
      return el;
    },
    remove(sel) {
      const parts = String(sel).split(',').map((s) => s.trim());
      for (let i = all.length - 1; i >= 0; i--) {
        if (parts.some((p) => all[i]._sels.indexOf(p) !== -1)) all.splice(i, 1);
      }
    },
  };

  const body = opts.mount ? new StubElement('body', ['body']) : null;
  const doc = {
    readyState: 'complete',
    body,
    head: new StubElement('head', ['head']),
    documentElement: new StubElement('html', ['html']),
    createElement: (tag) => new StubElement(tag, []),
    querySelector(sel) {
      const parts = String(sel).split(',').map((s) => s.trim());
      return all.find((e) => parts.some((p) => e._sels.indexOf(p) !== -1)) || null;
    },
    querySelectorAll(sel) {
      const parts = String(sel).split(',').map((s) => s.trim());
      return all.filter((e) => parts.some((p) => e._sels.indexOf(p) !== -1));
    },
    getElementById(id) {
      let el = all.find((e) => e.id === id || e._sels.indexOf('#' + id) !== -1);
      if (!el) el = add('#' + id, { id });
      return el;
    },
    addEventListener() {},
    removeEventListener() {},
  };

  function HTMLInputElementStub() {}
  Object.defineProperty(HTMLInputElementStub.prototype, 'value', {
    get() { return this.__krValue || ''; },
    set(v) { this.__krValue = v; inputWrites.push(String(v)); },
    configurable: true,
  });
  function EventStub(type, init) { this.type = type; Object.assign(this, init || {}); }
  function KeyboardEventStub(type, init) { EventStub.call(this, type, init); }
  function MutationObserverStub(fn) {
    this.fn = fn;
    this.observe = () => {};
    this.disconnect = () => {};
    this.takeRecords = () => [];
    observers.push(this);
  }

  const store = new Map(Object.entries(opts.store || {}));
  const sandbox = {
    console, JSON, Number, String, Array, Map, Set, WeakSet, WeakMap, Object,
    Promise, RegExp, isFinite, parseInt, parseFloat, Error, Boolean, Symbol,
    FakeDate, Date: FakeDate,
    setTimeout(fn, ms) {
      const t = { id: ++timerId, ms: Number(ms) || 0, due: clock.now + (Number(ms) || 0),
        fn, done: false, cancelled: false };
      timers.push(t);
      return t.id;
    },
    clearTimeout(id) {
      const t = timers.find((x) => x.id === id);
      if (t) t.cancelled = true;
    },
    setInterval(fn, ms) {
      const t = { id: ++timerId, ms: Number(ms) || 0, fn, cancelled: false };
      intervals.push(t);
      return t.id;
    },
    clearInterval(id) {
      const t = intervals.find((x) => x.id === id);
      if (t) t.cancelled = true;
    },
    location: Object.assign({ pathname: '/krillion', hash: '', href: 'https://playdaily.org/krillion' },
      opts.location || {}),
    navigator: { userAgent: 'node-fault-harness' },
    document: doc,
    HTMLInputElement: HTMLInputElementStub,
    Event: EventStub,
    KeyboardEvent: KeyboardEventStub,
    MutationObserver: MutationObserverStub,
    unsafeWindow: { fetch: null },
    GM_xmlhttpRequest(o) { requests.push(o); },
    GM_addStyle(css) { sandbox.__style = css; },
    GM_setValue(k, v) { store.set(k, v); },
    GM_getValue(k, d) { return store.has(k) ? store.get(k) : d; },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const math = Object.create(Math);
  math.random = () => (randomQueue.length > 1 ? randomQueue.shift() : (randomQueue[0] || 0.5));
  sandbox.Math = math;

  const closeIx = src.lastIndexOf('})();');
  if (closeIx < 0) throw new Error('userscript closing IIFE not found');
  const prepared = src.slice(0, closeIx) + EXPORT_HOOK + '\n' + src.slice(closeIx);
  vm.createContext(sandbox);
  try {
    vm.runInContext(prepared, sandbox, { filename: 'krillion-autofill.user.js', timeout: 5000 });
  } catch (e) {
    throw new Error('harness load failed: ' + ((e && e.message) || String(e)));
  }
  if (!sandbox.__FAULT_T__) {
    throw new Error('internals not exported: ' + (sandbox.__FAULT_T_ERR || 'unknown'));
  }

  const h = {
    T: sandbox.__FAULT_T__,
    sandbox, dom, clock, timers, intervals, requests, observers, inputWrites, store,
    advance(ms) {
      const target = clock.now + ms;
      let guard = 0;
      while (guard++ < 2000) {
        const due = timers.filter((t) => !t.cancelled && !t.done && t.due <= target)
          .sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!due) break;
        due.done = true;
        clock.now = Math.max(clock.now, due.due);
        try { due.fn(); } catch (e) { /* timer errors are surfaced by the fault itself */ }
      }
      clock.now = target;
    },
    posts(fragment) {
      return requests.filter((r) => r.url && r.url.indexOf(fragment) !== -1)
        .map((r) => { try { return JSON.parse(r.data || '{}'); } catch (e) { return {}; } });
    },
  };
  return h;
}

// ---------------------------------------------------------------------------
// M — miscalculation
// ---------------------------------------------------------------------------
async function miscalculation() {
  await fault(CLS.M, 'wrong-points-parsed', () => {
    const h = makeHarness();
    const T = h.T;
    const row = tierRows.find((r) => Array.isArray(r) && /keep on a desk/i.test(r[0]));
    const by = {};
    T.parseTierAnswers(row[1]).forEach((p) => { by[p.answer] = p.points; });
    const checks = [
      ck(by['Syringe Pen'] === 85, 'real-85', by['Syringe Pen']),
      ck(by['Appointment Book'] === 60, 'real-60', by['Appointment Book']),
      ck(by['Eraser'] === 30, 'real-30', by['Eraser']),
      ck(by['Calendar'] === 10, 'real-10', by['Calendar']),
    ];
    const nullRow = tierRows.find((r) => Array.isArray(r) && r[1].some((e) => Array.isArray(e) && e[1] === null));
    const nullParsed = T.parseTierAnswers([nullRow[1].find((e) => Array.isArray(e) && e[1] === null)]);
    checks.push(ck(nullParsed.length === 1 && nullParsed[0].points === 85, 'real-null->85',
      JSON.stringify(nullParsed)));
    const bad = T.parseTierAnswers([['X', 'nope'], ['Y', 999], ['Z', 4], ['W', 5], { answer: '', points: 60 }]);
    checks.push(ck(bad.map((x) => x.points).join(',') === '85,85,85,100', 'malformed-coerced',
      JSON.stringify(bad.map((x) => x.points))));
    return verify(checks);
  });

  await fault(CLS.M, 'wrong-tier-mapped', () => {
    const T = makeHarness().T;
    const cases = [['PLANKTON', 10], ['Too Clever', 15], ['schooler', 30], ['rare', 60],
      ['deep cut', 85], ['ONE IN A KRILLION', 100], ['', 85], [null, 85], ['60', 60],
      [3, 60], [5, 100], [999, 85], ['garbage', 85]];
    const got = cases.map(([v]) => T.tierPointsOf(v));
    const want = cases.map(([, p]) => p);
    return { ok: got.join(',') === want.join(','), detail: `input=${JSON.stringify(cases.map((c) => c[0]))} -> got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}` };
  });

  await fault(CLS.M, 'gaussian-weights-sum', () => {
    const T = makeHarness().T;
    const weights = Object.keys(T.GOD_TIER_CHANCE)
      .map((k) => Number(T.GOD_TIER_CHANCE[k]));
    const sum = weights.reduce((a, b) => a + b, 0);
    const line = src.split('\n').findIndex((l) => l.indexOf('GOD_TIER_CHANCE =') !== -1) + 1;
    return {
      ok: Math.abs(sum - 100) < 1e-9,
      detail: `REPRO: read krillion-autofill.user.js line ${line} GOD_TIER_CHANCE {10:0.05,15:0.95,30:7.54,60:26.04,85:39.37,100:26.04}; sum them. EXPECTED 100.00 (comment says "normalised to 100%"), ACTUAL ${sum.toFixed(2)}. A rounding guard in pickGodAnswer assigns the missing 0.01 to the last tier, so the draw never fails, but the declared distribution is skewed toward 100pt.`,
    };
  });

  await fault(CLS.M, 'gaussian-empty-tier-redistribution', () => {
    const h = makeHarness({ random: [0.01, 99.9999, 0.5] });
    const T = h.T;
    T.bot.pick = 'top';
    T.state.deepcutPrompt = '';
    T.state.deepcut = [{ answer: 'deepA', points: 85 }, { answer: 'deepB', points: 85 },
      { answer: 'rareA', points: 100 }];
    T.state.refusedAnswers = new Set();
    T.bot.submittedForPrompt = new Set();
    const low = T.pickGodAnswer('p', ['rareA'], false);      // draw 0.01 -> 85 band
    const high = T.pickGodAnswer('p', ['rareA'], false);     // draw 99.9999 -> 100 band
    T.state.deepcut = [{ answer: 'only100', points: 100 }];
    const only = T.pickGodAnswer('p', ['only100'], false);   // all empty mass -> 100
    return verify([
      ck(low === 'deepA', 'low-draw-85', low),
      ck(high === 'rareA', 'high-draw-100', high),
      ck(only === 'only100', 'empty-mass-not-lost', only),
    ]);
  });

  await fault(CLS.M, 'nearest-tier-tie-order', () => {
    const T = makeHarness().T;
    const got = [
      T.nearestGodGroup(72.5, [85, 60, 100]),
      T.nearestGodGroup(50, [85, 60, 100]),
      T.nearestGodGroup(100, [85, 100]),
      T.nearestGodGroup(10, [85, 100]),
      T.nearestGodGroup(30, []),
    ];
    const want = [85, 60, 100, 85, null];
    return { ok: got.join(',') === want.join(','), detail: `got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}` };
  });

  await fault(CLS.M, 'low-tier-fallback-order', () => {
    const h = makeHarness();
    const T = h.T;
    const prompt = 'Name a desk item';
    const key = T.keyFor(prompt);
    T.state.groups = [{ question: prompt, answers: ['R1', 'R2'] }];
    T.state.answerQuestion = {};
    T.state.tierPremap = new Map([[key, [
      ['A', 85], ['B', 60], ['C', 30], ['D', 15], ['E', 10], ['R1', 60],
    ]]]);
    const pool = T.raceBuildPool(prompt);
    const want = ['R1', 'R2', 'A', 'B', 'C', 'D', 'E'];
    const checks = [ck(pool.join(',') === want.join(','), 'rare-then-descending', JSON.stringify(pool))];
    T.state.refusedAnswers = new Set([prompt + '\u0000A']);
    const filtered = T.raceBuildPool(prompt);
    checks.push(ck(filtered.indexOf('A') === -1 && filtered[0] === 'R1', 'refused-filtered',
      JSON.stringify(filtered)));
    return verify(checks);
  });

  await fault(CLS.M, 'rank-depth-room-math', () => {
    const h = makeHarness();
    const T = h.T;
    T.bot.mode = 'marathon5';
    const mk = (name, detail, count) => {
      const row = h.dom.add('.kr-room-row', { className: 'kr-room-row', offsetParent: {} });
      h.dom.add('.kr-room-name', { textContent: name }, row);
      h.dom.add('.kr-room-detail', { textContent: detail }, row);
      h.dom.add('.kr-room-count', { textContent: String(count) }, row);
      return row;
    };
    const shallow = mk('Short room', '5 prompts, 5s each', 2);
    const target = mk('Deep room', '50 prompts, 5s each', 3);
    const slow = mk('Slow room', '50 prompts, 15s each', 4);
    T.joinLobbyRoom();
    const checks = [
      ck(target._clicks === 1, '5s-50-prompt-room', `clicks ${target._clicks}`),
      ck(shallow._clicks === 0 && slow._clicks === 0, 'no-shallow-or-slow',
        `shallow ${shallow._clicks}, slow ${slow._clicks}`),
    ];
    const h2 = makeHarness();
    h2.T.bot.mode = 'showoff';
    const a = h2.dom.add('.kr-room-row', { className: 'kr-room-row' });
    h2.dom.add('.kr-room-count', { textContent: '2' }, a);
    const b = h2.dom.add('.kr-room-row', { className: 'kr-room-row' });
    h2.dom.add('.kr-room-count', { textContent: '7' }, b);
    h2.T.joinLobbyRoom();
    checks.push(ck(b._clicks === 1 && a._clicks === 0, 'most-populated-argmax',
      `a ${a._clicks}, b ${b._clicks}`));
    return verify(checks);
  });
}

// ---------------------------------------------------------------------------
// W — missed wording
// ---------------------------------------------------------------------------
async function wording() {
  await fault(CLS.W, 'prompt-paraphrase-normLocal', () => {
    const T = makeHarness().T;
    const cases = [
      ['What is an example of a famous park', 'name a famous park'],
      ['What is an example of an animal with a shell', 'name an animal with a shell'],
      ['Name any one famous park', 'name a famous park'],
      ['Name one famous park', 'name a famous park'],
      ['Name any famous park', 'name a famous park'],
      ['Name a beginning with B animal', 'name a starting with b animal'],
      ['  What   is   one   verb  ', 'name a verb'],
    ];
    const got = cases.map(([q]) => T.keyFor(q));
    const want = cases.map(([, k]) => k);
    return { ok: got.join('|') === want.join('|'), detail: `got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}` };
  });

  await fault(CLS.W, 'nq-authoritative-paraphrase', () => {
    const T = makeHarness().T;
    const item = { q: 'A different on-screen wording', nq: 'name a famous park', answers: ['X'] };
    const checks = [
      ck(T.keyFor(item) === 'name a famous park', 'nq-wins-over-text', T.keyFor(item)),
      ck(T.buildPremap([item]).has('name a famous park'), 'premap-uses-nq', 'present'),
      ck(T.buildPremap([{ q: 'Name any famous park', answers: ['Y'] }]).has('name a famous park'),
        'normLocal-fallback', 'present'),
    ];
    return verify(checks);
  });

  await fault(CLS.W, 'selector-drift-missing-element', () => {
    const h = makeHarness();
    const T = h.T;
    h.dom.add('p.kr-prompt', { textContent: 'Name a famous park' });
    const state = T.gameState();
    const answered = T.answerCurrentPrompt();
    const checks = [
      ck(state === 'prompt-reveal', 'no-input-state', state),
      ck(answered === false, 'no-answer-without-input', String(answered)),
      ck(h.inputWrites.length === 0, 'no-input-write', JSON.stringify(h.inputWrites)),
    ];
    h.dom.remove('p.kr-prompt');
    checks.push(ck(T.promptText() === '' && T.gameState() === 'loading-shell',
      'missing-prompt-safe', `${T.promptText()} / ${T.gameState()}`));
    return verify(checks);
  });

  await fault(CLS.W, 'refusal-text-lingering', () => {
    const h = makeHarness();
    const T = h.T;
    h.dom.add('p.kr-prompt', { textContent: 'Q1' });
    h.dom.add('.kr-refusal', { textContent: 'That answer is not valid' });
    T.state.question = 'Q1';
    T.state.loadedPrompt = 'Q1';
    T.state.lastFilled = 'ans1';
    T.state.answerQuestion = { ans1: 'Q1' };
    h.requests.length = 0;
    T.checkRefusal();
    const first = h.posts('/api/prompt-review').filter((e) => e.kind === 'refused').length;
    // New prompt + new answer, but the site leaves the OLD refusal line on screen.
    T.state.question = 'Q2';
    T.state.loadedPrompt = 'Q2';
    T.state.lastFilled = 'ans2';
    T.state.answerQuestion = { ans2: 'Q2' };
    T.checkRefusal();
    const second = h.posts('/api/prompt-review').filter((e) => e.kind === 'refused').length;
    const blocked = T.state.refusedAnswers.has('Q2\u0000ans2');
    return {
      ok: first === 1 && second === 1 && !blocked,
      detail: `REPRO: fill ans1 for Q1, .kr-refusal="That answer is not valid", call checkRefusal(); then set question=Q2, lastFilled=ans2, leave the SAME refusal line and call checkRefusal() again. EXPECTED 1 refusal event total and Q2 ans2 NOT blocked (line belongs to ans1). ACTUAL ${second} refusal events and refusedAnswers.has("Q2 ans2")=${blocked}.`,
    };
  });

  await fault(CLS.W, 'alias-never-applied', () => {
    const h = makeHarness();
    const T = h.T;
    h.requests.length = 0;
    T.state.groups = [];
    T.applyResult({
      exact: false,
      groups: [
        { question: 'Name a famous park', score: 0.82, answers: ['A'] },
        { question: 'Name a well-known park', score: 0.81, answers: ['B'] },
      ],
    }, 'Name a park');
    const ambiguous = h.posts('/api/prompt-review').filter((e) => e.kind === 'ambiguous');
    return verify([
      ck(T.state.groups.length === 2, 'banks-not-merged', String(T.state.groups.length)),
      ck(T.state.answers.join(',') === 'A,B', 'no-alias-rewrite', JSON.stringify(T.state.answers)),
      ck(ambiguous.length === 1, 'ambiguity-flagged', String(ambiguous.length)),
      ck(!/request\(\s*['"`][^'"`]*alias/i.test(src), 'no-alias-request',
        'userscript never requests an alias endpoint'),
    ]);
  });

  await fault(CLS.W, 'bank-label-collision', () => {
    const h = makeHarness();
    const T = h.T;
    const seen = new Map();
    let pair = null;
    for (const r of tierRows) {
      if (!Array.isArray(r) || !r[1]) continue;
      const key = T.keyFor(r[0]);
      if (seen.has(key) && seen.get(key).q !== r[0]) {
        pair = [seen.get(key), { q: r[0], rows: r[1] }, key];
        break;
      }
      seen.set(key, { q: r[0], rows: r[1] });
    }
    if (!pair) return { ok: false, detail: 'no real colliding pair found in data/tier-data.json' };
    const first = pair[0];
    const second = pair[1];
    const answersOf = (rows) => rows.slice(0, 2).map((e) => (Array.isArray(e) ? e[0] : e.answer)).filter(Boolean);
    const map = T.buildPremap([
      { q: first.q, nq: pair[2], answers: answersOf(first.rows) },
      { q: second.q, nq: pair[2], answers: answersOf(second.rows) },
    ]);
    const kept = map.get(pair[2]) || { answers: [] };
    const total = answersOf(first.rows).length + answersOf(second.rows).length;
    return {
      ok: map.size === 2 && kept.answers.length === total,
      detail: `REPRO: real tier-data.json prompts "${first.q}" and "${second.q}" both normalise to key "${pair[2]}"; buildPremap([{q:first,nq:key,answers:A},{q:second,nq:key,answers:B}]). EXPECTED 2 labelled banks / ${total} answers retained. ACTUAL map.size=${map.size}, ${kept.answers.length} answers kept (${JSON.stringify(kept.answers)}) — the later row overwrites the earlier one.`,
    };
  });
}

// ---------------------------------------------------------------------------
// T — missed timing
// ---------------------------------------------------------------------------
async function timing() {
  await fault(CLS.T, 'prompt-before-input-mounts', () => {
    const h = makeHarness();
    const T = h.T;
    const prompt = 'Name a famous park';
    h.dom.add('p.kr-prompt', { textContent: prompt });
    T.state.loadedPrompt = prompt;
    T.state.groups = [{ question: prompt, answers: ['X'] }];
    T.bot.pick = 'random';
    const checks = [
      ck(T.promptText() === prompt, 'prompt-visible', T.promptText()),
      ck(T.gameState() === 'prompt-reveal', 'state=prompt-reveal', T.gameState()),
      ck(T.answerCurrentPrompt() === false, 'no-submit-yet', 'false'),
      ck(h.inputWrites.length === 0, 'no-write-yet', JSON.stringify(h.inputWrites)),
    ];
    h.dom.add('input.kr-input', { tag: 'input' });
    const later = T.answerCurrentPrompt();
    checks.push(ck(later === true && h.inputWrites[0] === 'X', 'answers-after-mount',
      `${later} / ${JSON.stringify(h.inputWrites)}`));
    return verify(checks);
  });

  await fault(CLS.T, 'fast-room-expiry', () => {
    const h = makeHarness();
    const T = h.T;
    const prompt = 'Fast room prompt';
    h.dom.add('p.kr-prompt', { textContent: prompt });
    h.dom.add('input.kr-input', { tag: 'input' });
    T.bot.mode = 'krillocity';
    T.bot.on = true;
    T.bot.pick = 'random';
    T.bot.roundClosed = false;
    T.state.question = prompt;
    T.state.loadedPrompt = prompt;
    T.state.groups = [{ question: prompt, answers: ['R1', 'R2', 'R3'] }];
    T.raceBurst();
    h.advance(50);
    h.advance(90);
    const uniq = new Set(h.inputWrites);
    const checks = [
      ck(h.inputWrites.length === 2 && uniq.size === 2, 'two-distinct-in-140ms', JSON.stringify(h.inputWrites)),
      ck(140 < 5000 && !/lastSubmitAt\s*<\s*700|lastSubmitAt[^\n]{0,60}700/.test(src),
        'no-700ms-throttle', '140ms < 5000ms window, no 700ms gate'),
    ];
    T.resetBotRound(true);
    h.inputWrites.length = 0;
    const after = T.answerCurrentPrompt();
    checks.push(ck(after === false && h.inputWrites.length === 0, 'verdict-closes-round',
      `${after} / ${h.inputWrites.length}`));
    return verify(checks);
  });

  await fault(CLS.T, 'observer-50ms-overlap', () => {
    const h = makeHarness({ mount: true });
    const T = h.T;
    const obs = h.observers[0];
    h.timers.length = 0;
    h.requests.length = 0;
    T.state.loadToken = 0;
    const checks = [ck(!!obs, 'observer-attached', String(h.observers.length))];
    for (const q of ['A', 'B', 'C', 'D', 'E']) {
      h.dom.set('p.kr-prompt', { textContent: q });
      if (obs) obs.fn([], obs);
    }
    h.advance(49);
    checks.push(ck(T.state.loadToken === 0, 'no-load-before-50ms', String(T.state.loadToken)));
    h.advance(1);
    checks.push(ck(T.state.loadToken === 1 && T.state.question === 'E', 'one-load-at-50ms',
      `token=${T.state.loadToken}, question=${T.state.question}`));
    h.dom.set('p.kr-prompt', { textContent: 'F' });
    if (obs) obs.fn([], obs);
    h.advance(50);
    checks.push(ck(T.state.loadToken === 2 && T.state.question === 'F', 'second-window-separate',
      `token=${T.state.loadToken}, question=${T.state.question}`));
    return verify(checks);
  });

  await fault(CLS.T, 'retry-backoff', async () => {
    const h = makeHarness();
    const T = h.T;
    let rejected = null;
    T.request('/api/answers', { retries: 2, timeout: 50 }).catch((e) => { rejected = e; });
    h.requests[0].onerror();
    h.advance(400);
    h.requests[1].onerror();
    h.advance(400);
    h.requests[2].onerror();
    await flushMicro();
    const checks = [
      ck(h.requests.length === 3, 'bounded-retries', String(h.requests.length)),
      ck(!!rejected && /bridge offline/.test(rejected.message), 'reject-after-retries',
        rejected ? rejected.message : 'not rejected'),
    ];
    const h2 = makeHarness();
    const T2 = h2.T;
    let finalFail = null;
    T2.request('/api/answers', { retries: 2, forever: true,
      onFinalFail: (info) => { finalFail = info; } }).catch(() => {});
    h2.requests[0].onerror();
    h2.advance(400);
    h2.requests[1].onerror();
    h2.advance(400);
    h2.requests[2].onerror();
    const delays = [1000, 2000, 4000, 8000, 16000];
    delays.forEach((d) => {
      h2.advance(d);
      const idx = h2.requests.length - 1;
      if (idx >= 3) h2.requests[idx].onerror();
    });
    checks.push(ck(!!finalFail && finalFail.attempts === 3, 'final-fail-once',
      JSON.stringify(finalFail)));
    checks.push(ck(h2.requests.length >= 8, 'forever-keeps-retrying', String(h2.requests.length)));
    checks.push(ck(h2.timers.some((t) => t.ms === 30000), '30s-backoff-cap',
      JSON.stringify(h2.timers.map((t) => t.ms).slice(-6))));
    return verify(checks);
  });

  await fault(CLS.T, 'capture-vs-restart-race', () => {
    const h = makeHarness();
    const T = h.T;
    const row = h.dom.add('.kr-row', {});
    const head = h.dom.add('.kr-row-head[aria-expanded="false"]', {}, row);
    head.setAttribute('aria-expanded', 'false');
    h.dom.add('.kr-row-prompt', { textContent: 'Q' }, row);
    const btn = h.dom.add('button', { innerText: 'Play again', offsetParent: {} });
    let settle;
    T.state.bankCaptureSignature = '1:Q';
    T.state.bankCapturing = true;
    T.state.bankCaptureSettled = false;
    T.state.bankCapturePromise = new Promise((r) => { settle = r; });
    T.state.classicFinalize = null;
    T.state.classicExpandedHeads = new WeakSet();
    T.bot.mode = 'classic';
    const first = T.finalizeClassicResults();
    const checks = [
      ck(first === false, 'gated-before-capture', String(first)),
      ck(btn._clicks === 0, 'no-early-restart', String(btn._clicks)),
      ck(/saving dive banks/.test(T.bot.state), 'gated-status', T.bot.state),
    ];
    T.state.bankCaptureSettled = true;
    settle();
    const second = T.finalizeClassicResults();
    checks.push(ck(second === true, 'restart-after-capture', String(second)));
    checks.push(ck(btn._clicks === 1, 'one-restart', String(btn._clicks)));
    return verify(checks);
  });

  await fault(CLS.T, 'cold-load-preload-gap', async () => {
    const prompt = 'Name a famous park';
    const h = makeHarness();
    const T = h.T;
    T.state.premap = new Map([[T.keyFor(prompt), { q: prompt, answers: ['FAST'] }]]);
    T.state.preloadPromise = Promise.resolve();
    h.requests.length = 0;
    T.loadAnswers(prompt);
    await flushMicro();
    const checks = [
      ck(T.state.answers.join(',') === 'FAST', 'resolved-preload-fast-path', JSON.stringify(T.state.answers)),
      ck(h.requests.length === 0, 'zero-http-on-fast-path', String(h.requests.length)),
    ];
    const h2 = makeHarness();
    const T2 = h2.T;
    T2.state.premap = null;
    T2.state.preloadPromise = new Promise(() => {});
    h2.requests.length = 0;
    const isLookup = (r) => r.url && r.url.indexOf('/api/answers?') !== -1;
    T2.loadAnswers(prompt);
    await flushMicro();
    checks.push(ck(h2.requests.filter(isLookup).length === 0, 'no-early-network',
      String(h2.requests.filter(isLookup).length)));
    h2.advance(T2.LOOKUP_TIMEOUT);
    await flushMicro();
    checks.push(ck(h2.requests.filter(isLookup).length === 1, 'network-after-bounded-wait',
      String(h2.requests.filter(isLookup).length)));
    return verify(checks);
  });
}

// ---------------------------------------------------------------------------
// O — optimisation defects
// ---------------------------------------------------------------------------
async function optimisation() {
  await fault(CLS.O, 'cache-invalidation', async () => {
    const h = makeHarness({ random: [0] });
    const T = h.T;
    const prompt = 'Q';
    h.dom.add('p.kr-prompt', { textContent: prompt });
    h.dom.add('input.kr-input', { tag: 'input' });
    T.state.question = prompt;
    T.state.loadedPrompt = prompt;
    T.state.netCache.set(T.keyFor(prompt), {
      exact: true, groups: [{ question: prompt, score: 1, answers: ['good', 'bad'] }],
    });
    T.bot.pick = 'random';
    T.loadAnswers(prompt);
    await flushMicro();
    const checks = [ck(T.state.answers.join(',') === 'good,bad', 'cache-hit',
      JSON.stringify(T.state.answers))];
    T.state.lastFilled = 'bad';
    T.state.answerQuestion = { bad: prompt };
    h.dom.add('.kr-refusal', { textContent: 'refused text' });
    T.checkRefusal();
    checks.push(ck(T.state.refusedAnswers.has(prompt + '\u0000bad'), 'refusal-recorded',
      String(T.state.refusedAnswers.has(prompt + '\u0000bad'))));
    h.inputWrites.length = 0;
    T.bot.answeredPrompt = '';
    T.answerCurrentPrompt();
    checks.push(ck(h.inputWrites[0] === 'good', 'stale-cache-answer-filtered',
      JSON.stringify(h.inputWrites)));
    return verify(checks);
  });

  await fault(CLS.O, 'dedupe-blocks-correct-answer', async () => {
    const h = makeHarness({ random: [0] });
    const T = h.T;
    const prompt = 'Q';
    h.dom.add('p.kr-prompt', { textContent: prompt });
    h.dom.add('input.kr-input', { tag: 'input' });
    T.state.question = prompt;
    T.state.loadedPrompt = prompt;
    T.state.groups = [{ question: prompt, answers: ['correct', 'other'] }];
    T.bot.pick = 'random';
    const key = prompt + '\u0000correct';
    T.state.refusedAnswers.add(key); // play-time refusal; AI grading is inconsistent
    T.reportScore(prompt, 'correct', 100, 'ONE IN A KRILLION'); // game's own graded bank
    await flushMicro();
    const stillBlocked = T.state.refusedAnswers.has(key);
    h.inputWrites.length = 0;
    T.bot.answeredPrompt = '';
    T.answerCurrentPrompt();
    const picked = h.inputWrites[0];
    return {
      ok: !stillBlocked && picked === 'correct',
      detail: `REPRO: add refusedAnswers["Q correct"] from a play-time refusal, then call reportScore("Q","correct",100,"ONE IN A KRILLION") (the authoritative graded bank) and answerCurrentPrompt() with pick=random. EXPECTED the bank-confirmed 100pt answer is eligible again and submitted. ACTUAL refusedAnswers still has the key (${stillBlocked}) and the bot submitted "${picked}" instead; no refusedAnswers.clear() exists in the script.`,
    };
  });

  await fault(CLS.O, 'prefetch-cap', async () => {
    const h = makeHarness();
    const T = h.T;
    h.requests.length = 0;
    const isLookup = (r) => r.url && r.url.indexOf('/api/answers?') !== -1;
    for (let i = 0; i < 100; i++) T.enqueuePrefetch('prefetch prompt ' + i);
    // Let the single-flight slots complete so the cap, not a stalled slot,
    // decides how many lookups are issued.
    let guard = 0;
    while (guard++ < 120) {
      const pending = h.requests.filter((r) => isLookup(r) && !r.__answered);
      if (!pending.length) break;
      pending.forEach((r) => {
        r.__answered = true;
        r.onload({ responseText: JSON.stringify({ exact: false, groups: [] }) });
      });
      await flushMicro();
    }
    const lookups = h.requests.filter(isLookup).length;
    return verify([
      ck(T.state.prefetchCount === T.PREFETCH_MAX, 'cap-60', String(T.state.prefetchCount)),
      ck(T.state.prefetchActive <= T.PREFETCH_CONCURRENCY, 'concurrency<=3', String(T.state.prefetchActive)),
      ck(T.state.prefetchQueue.length === 0, 'queue-cleared', String(T.state.prefetchQueue.length)),
      ck(lookups === T.PREFETCH_MAX, 'no-overshoot', String(lookups)),
    ]);
  });

  await fault(CLS.O, 'stale-response-newer-prompt', async () => {
    const h = makeHarness();
    const T = h.T;
    T.state.premap = new Map();
    T.state.netCache = new Map();
    T.state.preloadPromise = Promise.resolve();
    const isLookup = (r) => r.url && r.url.indexOf('/api/answers?') !== -1;
    T.loadAnswers('Q1');
    await flushMicro();
    const r1 = h.requests.filter(isLookup).find((r) => /Q1/.test(r.url));
    T.loadAnswers('Q2');
    await flushMicro();
    const r2 = h.requests.filter(isLookup).find((r) => /Q2/.test(r.url));
    r1.onload({ responseText: JSON.stringify({ exact: true,
      groups: [{ question: 'Q1', score: 1, answers: ['OLD'] }] }) });
    await flushMicro();
    const checks = [
      ck(T.state.question === 'Q2', 'newer-question-kept', T.state.question),
      ck(T.state.answers.join(',') === '', 'old-response-ignored', JSON.stringify(T.state.answers)),
    ];
    r2.onload({ responseText: JSON.stringify({ exact: true,
      groups: [{ question: 'Q2', score: 1, answers: ['NEW'] }] }) });
    await flushMicro();
    checks.push(ck(T.state.answers.join(',') === 'NEW', 'new-response-applied',
      JSON.stringify(T.state.answers)));
    return verify(checks);
  });
}

(async () => {
  console.log('Krillion Phase 5 / W5-B fault-injection suite (dependency-free)');
  console.log(`source: ${path.relative(REPO, SCRIPT)}  real tier rows: ${tierRows.length}\n`);
  await miscalculation();
  await wording();
  await timing();
  await optimisation();

  const order = [CLS.M, CLS.W, CLS.T, CLS.O];
  console.log('\n=== Fault counts ===');
  order.forEach((cls) => {
    const rows = results.filter((r) => r.cls === cls);
    const p = rows.filter((r) => r.ok).length;
    console.log(`${cls}: ${p}/${rows.length} PASS, ${rows.length - p} FAIL`);
  });
  const pass = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok);
  console.log(`TOTAL: ${pass}/${results.length} PASS, ${fail.length} FAIL`);
  if (fail.length) {
    console.log('\nFAIL list:');
    fail.forEach((r) => console.log(`- ${r.cls}/${r.id}: ${r.detail}`));
  }
  process.exit(fail.length ? 1 : 0);
})().catch((e) => {
  console.error('suite crashed:', e && e.stack || e);
  process.exit(1);
});
