#!/usr/bin/env node
/**
 * Phase 5 hard gate: full script-state x game-state robustness matrix.
 *
 *   node tests/state_matrix.js
 *
 * Dependency-free. Loads the real userscript in a vm sandbox with stubbed
 * GM/DOM globals (modeled on tests/roadmap_helpers.js), builds a controllable
 * DOM scene for every Phase 0 game state, applies the Phase 1 script-state
 * contexts (premap / tierPremap / bot / roundClosed / refusalActive /
 * bankCapturing-capture-settled / retry-backoff), drives the real functions,
 * and asserts the documented decision (answer / wait / capture / restart /
 * refuse / log / no-log) for each pair.
 *
 * Every row of the four Phase 1 inventory documents is mapped to at least one
 * matrix pair; coverage is recomputed from the documents at runtime.
 *
 * Prints one line per pair and a final summary. Exits non-zero on any FAIL or
 * incomplete inventory coverage. Never starts a real game or touches an account.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const SCRIPTS = {
  'STATES': path.join(REPO, 'injection', 'STATES.md'),
  'STATES-KRILLO': path.join(REPO, 'injection', 'STATES-KRILLO.md'),
  'STATES-MP-DUEL': path.join(REPO, 'injection', 'STATES-MP-DUEL.md'),
  'INTERACTIONS': path.join(REPO, 'injection', 'INTERACTIONS.md'),
};
const USER_SCRIPT = path.join(REPO, 'injection', 'krillion-autofill.user.js');
const SRC = fs.readFileSync(USER_SCRIPT, 'utf8');

const PROMPT = 'Name any one famous park';
let ANSWERS = ['Central Park', 'Golden Gate Park'];

// ---------------------------------------------------------------------------
// Result collection
// ---------------------------------------------------------------------------
let passes = 0;
let fails = 0;
let nas = 0;
function record(status, scriptState, gameState, detail) {
  if (status === 'PASS') passes++;
  else if (status === 'FAIL') fails++;
  else nas++;
  console.log(`[${status}] ${scriptState} x ${gameState}: ${detail}`);
}

// ---------------------------------------------------------------------------
// Best-effort, read-only bridge probe for real answer text. Purely cosmetic:
// assertions never depend on the specific answer string. No game is started.
// ---------------------------------------------------------------------------
function probeBridge() {
  return new Promise((resolve) => {
    try {
      const http = require('http');
      const req = http.get('http://127.0.0.1:8768/api/all?t=krillion-local-v1', (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const rows = (data && data.data) || [];
            const hit = rows.find((r) => r && r.q === PROMPT) || rows[0];
            if (hit && Array.isArray(hit.answers) && hit.answers.length) {
              ANSWERS = hit.answers.slice(0, 6).map((a) => String(a));
            }
          } catch (e) { /* offline / old bridge — keep fallback answers */ }
          resolve();
        });
      });
      req.on('error', () => resolve());
      req.setTimeout(400, () => { req.destroy(); resolve(); });
    } catch (e) { resolve(); }
  });
}
function ensureAnswers() {
  ANSWERS = Array.from(new Set(ANSWERS.concat([
    'Golden Gate Park', 'Yosemite National Park', 'Central Park',
  ]))).slice(0, 8);
}
ensureAnswers();

// ---------------------------------------------------------------------------
// Stubbed GM/DOM environment
// ---------------------------------------------------------------------------
const env = {
  timers: [],
  timerId: 0,
  logs: [],
  clicks: [],
  inputWrites: [],
  ids: new Map(),
  store: new Map(),
  response: { ok: true },
  failAll: false,
};

function HTMLInputElementStub() {}
Object.defineProperty(HTMLInputElementStub.prototype, 'value', {
  configurable: true,
  get() { return this._value || ''; },
  set(v) {
    this._value = String(v);
    if (this._sel === 'input.kr-input') env.inputWrites.push(String(v));
  },
});

function EventStub(type, opts) { this.type = type; Object.assign(this, opts || {}); }
function KeyboardEventStub(type, opts) { EventStub.call(this, type, opts); }

function matches(el, sel) {
  if (!el || !sel) return false;
  const base = String(sel).replace(/\[[^\]]*\]/g, '').trim();
  if (el._sel === base) return true;
  const cls = base.replace(/^\./, '');
  return String(el.className || '').split(/\s+/).indexOf(cls) !== -1;
}

class El extends HTMLInputElementStub {
  constructor(sel, opts) {
    super();
    const o = opts || {};
    this._sel = sel || 'div';
    this.tagName = String(o.tag || (sel && /^input\b/.test(sel) ? 'input' : 'div')).toUpperCase();
    this.textContent = o.text == null ? '' : String(o.text);
    this.innerText = this.textContent;
    this.innerHTML = '';
    this.className = o.className || '';
    this.dataset = Object.assign({}, o.dataset);
    this.style = {};
    this.hidden = !!o.hidden;
    this.disabled = !!o.disabled;
    this.readOnly = !!o.readOnly;
    this.placeholder = o.placeholder || '';
    this._visible = o.visible !== false;
    this._attrs = Object.assign({}, o.attrs);
    this.children = [];
    this._listeners = {};
    this._value = '';
  }
  get offsetParent() { return this._visible ? {} : null; }
  getClientRects() { return this._visible ? [{}] : []; }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
  }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener() {}
  dispatchEvent(ev) { env.events.push(ev); }
  focus() {}
  click() { env.clicks.push({ el: this, via: 'click' }); }
  requestSubmit() { env.clicks.push({ el: this, via: 'submit' }); }
  remove() {}
  querySelector(sel) {
    if (typeof sel === 'string' && sel.charAt(0) === '#') {
      return getId(sel.slice(1));
    }
    return this.children.find((c) => matches(c, sel)) || null;
  }
  querySelectorAll(sel) {
    return this.children.filter((c) => matches(c, sel));
  }
}

env.events = [];

function getId(id) {
  if (!env.ids.has(id)) env.ids.set(id, new El('#' + id, { visible: true }));
  return env.ids.get(id);
}

const scene = {
  map: new Map(),
  reset() { this.map.clear(); },
  set(sel, opts) {
    const el = new El(sel, opts);
    this.map.set(sel, el);
    return el;
  },
  list(sel, items) {
    this.map.set(sel, items);
    return items;
  },
  hide(sel) {
    const v = this.map.get(sel);
    if (v && !Array.isArray(v)) v._visible = false;
  },
  show(sel) {
    const v = this.map.get(sel);
    if (v && !Array.isArray(v)) v._visible = true;
  },
};

function queryOne(sel) {
  const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
  let firstPresent = null;
  for (const part of parts) {
    const value = scene.map.get(part);
    if (!value) continue;
    const el = Array.isArray(value) ? value[0] : value;
    if (!el) continue;
    if (!firstPresent) firstPresent = el;
    if (el._visible) return el;
  }
  return firstPresent;
}

function queryAll(sel) {
  const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const value = scene.map.get(part);
    if (!value) continue;
    if (Array.isArray(value)) out.push.apply(out, value);
    else out.push(value);
  }
  return out.filter((el, i) => out.indexOf(el) === i);
}

const documentStub = {
  readyState: 'complete',
  body: null, // keep mount() inert; we drive internals explicitly
  documentElement: new El('html'),
  head: new El('head'),
  createElement(tag) { return new El(tag); },
  querySelector: queryOne,
  querySelectorAll: queryAll,
  getElementById: getId,
  addEventListener() {},
};

const sandbox = {
  console, Math, JSON, Number, String, Array, Map, Set, Object, Date, Promise,
  RegExp, isFinite, parseInt, parseFloat, Error, Boolean, Symbol,
  document: documentStub,
  location: { pathname: '/krillion', hash: '', href: 'https://playdaily.org/krillion' },
  navigator: { userAgent: 'node-state-matrix' },
  HTMLInputElement: HTMLInputElementStub,
  Event: EventStub,
  KeyboardEvent: KeyboardEventStub,
  MutationObserver: class {
    constructor(fn) { this.fn = fn; }
    observe() {}
    disconnect() {}
  },
  unsafeWindow: {
    fetch() {
      return Promise.resolve({ clone() { return this; }, json() { return Promise.resolve({}); } });
    },
  },
  fetch() {
    return Promise.resolve({ ok: true, clone() { return this; }, json() { return Promise.resolve({}); } });
  },
  GM_addStyle() {},
  GM_setValue(k, v) { env.store.set(k, v); },
  GM_getValue(k, d) { return env.store.has(k) ? env.store.get(k) : d; },
  GM_xmlhttpRequest(opts) {
    const url = String(opts.url || '');
    let p = url.replace(/^http:\/\/127\.0\.0\.1:8768/, '');
    p = p.split('?')[0];
    let body = null;
    try { body = opts.data ? JSON.parse(opts.data) : null; } catch (e) { body = null; }
    env.logs.push({ method: opts.method || 'GET', path: p, body: body });
    if (env.failAll) { opts.onerror && opts.onerror(); return; }
    opts.onload && opts.onload({ responseText: JSON.stringify(env.response) });
  },
  setTimeout(fn, ms) {
    const id = ++env.timerId;
    env.timers.push({ id, fn, ms: Number(ms) || 0 });
    return id;
  },
  clearTimeout(id) { env.timers = env.timers.filter((t) => t.id !== id); },
  setInterval() { return ++env.timerId; },
  clearInterval() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const EXPORT_NAMES = [
  'state', 'bot', 'SEL', 'gameState', 'mode', 'promptText', 'inputState', 'ctx',
  'checkRefusal', 'checkVerdict', 'reportScore', 'reportBot', 'reportPrompt',
  'reportMiss', 'request', 'logLookupFailure', 'clearLookupFailure',
  'captureBanks', 'finalizeClassicResults', 'classicRows', 'classicBankSignature',
  'classicExpandRows', 'botTick', 'answerCurrentPrompt', 'submitAnswer', 'fill',
  'raceBurst', 'raceBuildPool', 'raceNextAnswer', 'raceSchedule', 'raceCancel',
  'resetBotRound', 'setBot', 'startMode', 'joinLobbyRoom', 'restartFromResults',
  'duelTick', 'duelClick', 'duelRequeueGate', 'loadAnswers', 'applyResult',
  'preloadAnswers', 'keyFor', 'visible', 'isVisible',
];
const exportHook = '\n;globalThis.__KR_MATRIX__ = {' + EXPORT_NAMES.join(',') + '};';
const closeIx = SRC.lastIndexOf('})();');
if (closeIx < 0) throw new Error('userscript closing IIFE not found');
const prepared = SRC.slice(0, closeIx) + exportHook + SRC.slice(closeIx);

vm.createContext(sandbox);
vm.runInContext(prepared, sandbox, { filename: 'krillion-autofill.user.js', timeout: 5000 });
const KR = sandbox.__KR_MATRIX__;
if (!KR || typeof KR.gameState !== 'function') {
  throw new Error('userscript internals were not exported: ' + (sandbox.__KR_MATRIX_ERR__ || 'unknown'));
}

// ---------------------------------------------------------------------------
// Case helpers
// ---------------------------------------------------------------------------
function resetCtx() {
  env.timers.length = 0;
  env.logs.length = 0;
  env.clicks.length = 0;
  env.inputWrites.length = 0;
  env.events.length = 0;
  env.response = { ok: true };
  env.failAll = false;
  sandbox.location.pathname = '/krillion';
  sandbox.location.hash = '';
  scene.reset();

  Object.assign(KR.state, {
    question: '', answers: [], groups: [], answerQuestion: {}, lastFilled: '',
    scored: new Set(), bankSent: '', collapsed: false, autoEnter: false,
    exact: false, deepcut: [], deepcutExact: false, deepcutPrompt: '',
    premap: null, tierPremap: null, netCache: new Map(),
    bankCapturing: false, bankCapturePromise: null, bankCaptureSettled: false,
    bankCaptureSignature: '', bankCaptureRows: undefined, bankCaptureAnswers: undefined,
    classicFinalize: null, classicExpandedHeads: null, refusalKey: '',
    refusalActive: false, prefetchQueue: [], prefetchActive: 0,
    prefetchCount: 0, prefetchSeen: new Set(), loadedPrompt: '',
    advancedFor: null, loadToken: 0,
  });
  Object.assign(KR.bot, {
    on: false, mode: 'classic', timer: null, busy: false, answered: new Set(),
    lastAction: '', state: 'idle', submittedForPrompt: new Set(), lastSubmitAt: 0,
    answerCount: 0, roundClosed: false, answeredInput: null, answeredPrompt: '',
    lastPrompt: '', lastRoomLog: '', lastDuelAction: null, duelResultHandled: null,
    duelRequeueAllowed: undefined, duelLossStreak: 0, duelRematches: 0,
    raceTimer: null, raceSubmitTimer: null, racePrompt: '', raceInput: null,
    racePool: null, racePoolIdx: 0, raceTierReady: false, raceSubmitted: new Set(),
    pick: 'random',
  });
  KR.clearLookupFailure();
}

const rowHead = (attrs) => new El('.kr-row-head', {
  text: 'Show answers', attrs: Object.assign({ 'aria-expanded': 'false' }, attrs || {}),
});
function bankRow(question, withOwnLine) {
  const row = new El('.kr-row', { visible: true });
  row.appendChild(rowHead());
  row.appendChild(new El('.kr-row-prompt', { text: question, visible: true }));
  if (withOwnLine) {
    const line = new El('.kr-line', { visible: true, attrs: { 'data-me': '' } });
    line.appendChild(new El('.kr-line-answer', { text: ANSWERS[0], visible: true }));
    line.appendChild(new El('.kr-line-tier', { text: 'ONE IN A KRILLION', visible: true }));
    line.appendChild(new El('.kr-line-pts', { text: '100', visible: true }));
    row.appendChild(line);
  }
  return row;
}

function buildDom(kind) {
  switch (kind) {
    case 'loading-shell':
      break;
    case 'intro':
      scene.set('.kr-intro', { visible: true, text: 'Krillion' });
      scene.set('button.kr-begin', { visible: true, text: 'Begin descent' });
      scene.list('button.kr-mode', [
        new El('button.kr-mode', { visible: true, text: 'Classic', className: 'kr-mode selected' }),
      ]);
      scene.list('button.kr-online', [
        new El('button.kr-online', { visible: true, text: 'Play multiplayer' }),
        new El('button.kr-online', { visible: true, text: 'Play 1 vs 1' }),
      ]);
      scene.set('a.kr-peek', { visible: true, text: 'Play Krillocity' });
      break;
    case 'countdown':
      scene.set('.kr-intro', { visible: false, text: 'Krillion' });
      break;
    case 'prompt-reveal':
      scene.set('p.kr-prompt', { visible: true, text: PROMPT });
      break;
    case 'answering':
      scene.set('p.kr-prompt', { visible: true, text: PROMPT });
      scene.set('input.kr-input', { visible: true, placeholder: 'Type one answer…' });
      scene.set('form.kr-bar', { visible: true, tag: 'form' });
      scene.set('button.kr-send', { visible: true, text: 'Dive' });
      break;
    case 'verdict':
      scene.set('.kr-reveal[role="status"]', { visible: true, text: '100 PTS' });
      scene.set('.kr-reveal-points b', { visible: true, text: '+100 PTS' });
      scene.set('.kr-reveal-tier', { visible: true, text: 'ONE IN A KRILLION' });
      scene.set('button.kr-next', { visible: true, text: 'Next' });
      scene.set('input.kr-input', { visible: false, placeholder: 'Type one answer…' });
      break;
    case 'results':
      scene.set('.kr-over', { visible: true, text: 'Dive over' });
      scene.set('button.kr-haul-toggle', { visible: true, text: 'Show answers', attrs: { 'aria-expanded': 'false' } });
      scene.list('.kr-row', [bankRow(PROMPT, true)]);
      scene.list('button', [new El('button', { visible: true, text: 'Play again' })]);
      break;
    case 'results-no-rows':
      scene.set('.kr-over', { visible: true, text: 'Dive over' });
      scene.list('button', [new El('button', { visible: true, text: 'Play again' })]);
      break;
    case 'arena-wait':
      scene.set('.kr-stage-multi', { visible: true });
      scene.set('.kr-wait', { visible: true });
      scene.set('.kr-board-head', { visible: true, text: 'No catch this time.' });
      scene.set('.kr-board-rows', { visible: true });
      scene.set('.kr-chat-sys', { visible: true, text: 'someone said something' });
      break;
    case 'lobby':
      scene.set('.kr-lobby-tab', { visible: true, text: 'Rooms' });
      scene.set('.kr-lobby-back', { visible: true, text: '◂ Dive on your own' });
      scene.list('.kr-room-row', [
        roomRow('The Marathon · 5 sec', '50 prompts, 5s each', '12 of 40'),
        roomRow('Casual', '7 prompts, 15s each', '30 of 40'),
      ]);
      break;
    case 'create-room':
      scene.set('.kr-guess-range', { visible: true, tag: 'input' });
      scene.set('.kr-make-go', { visible: true, text: 'Enter The Marathon · 6 sec' });
      break;
    case 'create-room-code':
      scene.set('.kr-guess-range', { visible: true, tag: 'input' });
      scene.set('.kr-make-go', { visible: true, text: 'Join room' });
      scene.set('input.kr-input', { visible: true, placeholder: '6-digit code' });
      break;
    case 'duel-play':
      scene.set('.kd-play', { visible: true, text: 'Find a match' });
      break;
    case 'duel-rule':
      scene.set('.kd-tab-rule', { visible: true });
      scene.set('.kd-tab-rule-key', { visible: true, text: 'agree' });
      break;
    case 'duel-elsewhere':
      scene.set('.kd-elsewhere', { visible: true });
      scene.set('.kd-elsewhere-key', { visible: true, text: 'Queue here' });
      break;
    case 'duel-versus':
      scene.set('.kd-versus', { visible: true, text: 'Match found' });
      scene.set('.kd-versus-leave', { visible: true, text: 'Leave before it starts' });
      scene.set('.kd-home', { visible: true, text: 'Back to the arena' });
      break;
    case 'duel-result':
      scene.set('.kd-result-keys', { visible: true });
      scene.set('.kd-again', { visible: true, text: 'Find another match' });
      scene.set('.kd-result-title', { visible: true, text: 'Victory' });
      break;
    case 'duel-leave':
      scene.set('.kd-versus-leave', { visible: true, text: 'Leave before it starts' });
      scene.set('.kd-home', { visible: true, text: 'Back to the arena' });
      break;
    default:
      throw new Error('unknown scene: ' + kind);
  }
}

function roomRow(name, detail, count) {
  const row = new El('.kr-room-row', { visible: true, className: 'kr-room-row' });
  row.appendChild(new El('.kr-room-name', { visible: true, text: name }));
  row.appendChild(new El('.kr-room-detail', { visible: true, text: detail }));
  row.appendChild(new El('.kr-room-count', { visible: true, text: count }));
  return row;
}

const flags = {
  premapReady() {
    KR.state.premap = new Map([[KR.keyFor(PROMPT), { q: PROMPT, answers: ANSWERS }]]);
    KR.state.loadedPrompt = PROMPT;
    KR.state.question = PROMPT;
    KR.state.groups = [{ question: PROMPT, score: 1, answers: ANSWERS }];
    KR.state.answers = ANSWERS.slice();
    KR.state.exact = true;
  },
  premapPending() {
    KR.state.premap = null;
    KR.state.loadedPrompt = '';
    KR.state.question = '';
    KR.state.groups = [];
    KR.state.answers = [];
  },
  tierReady() {
    KR.state.tierPremap = new Map([[KR.keyFor(PROMPT), [
      ['Deep Cut', 85], ['Rare', 60], ['Schooler', 30],
    ]]]);
  },
  tierPending() { KR.state.tierPremap = null; },
  botOn(mode) { KR.bot.on = true; KR.bot.mode = mode || 'classic'; },
  botOff() { KR.bot.on = false; },
  roundClosed() { KR.bot.roundClosed = true; },
  refusal() { KR.state.refusalActive = true; },
};

function observe() {
  return {
    logs: env.logs.slice(),
    inputWrites: env.inputWrites.slice(),
    clicks: env.clicks.slice(),
    timers: env.timers.slice(),
    botState: KR.bot.state,
    gameState: KR.gameState(),
    mode: KR.mode(),
    state: KR.state,
    bot: KR.bot,
  };
}
function hasLog(obs, p, pred) {
  return obs.logs.some((l) => l.path === p && (!pred || pred(l.body)));
}
function clicked(obs, pred) { return obs.clicks.some((c) => pred(c)); }
function timerAt(obs, ms) { return obs.timers.some((t) => t.ms === ms); }

function micro() { return new Promise((resolve) => setImmediate(resolve)); }
async function fireTimers(ms) {
  const due = env.timers.filter((t) => t.ms === ms);
  env.timers = env.timers.filter((t) => t.ms !== ms);
  due.forEach((t) => { try { t.fn(); } catch (e) { /* recorded via status */ } });
  await micro();
}

function verdict(ok, behavior, detail) { return { ok, behavior, detail }; }

// ---------------------------------------------------------------------------
// Inventory IDs (namespaced) + matrix cases
// ---------------------------------------------------------------------------
const S = (n) => 'STATES:' + n;
const K = (n) => 'STATES-KRILLO:K-' + n;
const M = (n) => 'STATES-MP-DUEL:M' + n;
const D = (n) => 'STATES-MP-DUEL:D' + n;
const MS = (n) => 'STATES-MP-DUEL:S' + n;
const P = (n) => 'INTERACTIONS:P' + n;
const T = (n) => 'INTERACTIONS:T' + n;
const IS = (n) => 'INTERACTIONS:S' + n;
const G = (n) => 'INTERACTIONS:G' + n;

const cases = [];
function addCase(scriptState, gameState, covers, setup, run, check, na) {
  cases.push({ scriptState, gameState, covers, setup, run, check, na: !!na });
}

/* ---- loading-shell -------------------------------------------------------- */
addCase('premap-pending', 'loading-shell', [
  S('1'), S('C1'), K('01'), MS('01'), G('10'),
  P('01'), P('02'), P('03'), P('04'), P('05'), P('06'), P('07'), P('15'), P('16'),
  T('01'), T('02'), T('03'), T('04'), T('09'), T('10'), T('24'), IS('01'),
], () => {}, async () => {
  await KR.preloadAnswers();
  return observe();
}, (o) => verdict(
  o.state.premap instanceof Map && o.logs.every((l) => l.method !== 'POST') && o.inputWrites.length === 0,
  'wait / no-log',
  `preload resolved to ready Map, ${o.logs.length} GET(s), no POST, gameState=${o.gameState}, fetchWrapped=${!!sandbox.unsafeWindow.fetch.__krillionWrapped}`,
));

addCase('retry-backoff', 'loading-shell', [T('12'), T('15'), IS('04'), IS('10')], () => {
  env.failAll = true;
}, async () => {
  KR.request('/api/answers?q=probe', {
    forever: true,
    onFinalFail: (info) => KR.logLookupFailure(PROMPT, info),
  });
  await fireTimers(400);
  await fireTimers(400);
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/miss', (b) => /unreachable.*bridge offline after 3 attempts/.test(b.reason || ''))
    && timerAt(o, 1000) && o.inputWrites.length === 0,
  'log / backoff',
  `miss=${hasLog(o, '/api/miss')}, 1000ms backoff armed=${timerAt(o, 1000)}, gameState=${o.gameState}`,
));

/* ---- intro ---------------------------------------------------------------- */
addCase('bot-on(setBot)', 'intro', [
  S('2'), S('C2'), MS('02'), G('09'), P('09'), P('10'), P('11'), P('12'), T('18'), T('23'),
], () => {
  buildDom('intro');
}, async () => {
  KR.setBot(true);
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/bot-log', (b) => b.event === 'bot-start')
    && clicked(o, (c) => c.el._sel === 'button.kr-begin') && o.bot.on === true,
  'log / start',
  `bot-start logged, begin clicked, bot.on=${o.bot.on}, gameState=${o.gameState}`,
));

addCase('bot-off', 'intro', [IS('05'), M('02')], () => { buildDom('intro'); }, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  o.logs.length === 0 && o.clicks.length === 0 && o.inputWrites.length === 0,
  'wait / no-log',
  `bot off: no click, no log, no fill, botStatus="${o.botState}"`,
));

addCase('premap-ready', 'intro (countdown)', [S('C3')], () => { buildDom('countdown'); }, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  KR.promptText() === '' && o.clicks.length === 0 && o.logs.length === 0,
  'wait / no-log',
  `promptText='' while intro is mounted-but-hidden, botStatus="${o.botState}"`,
));

addCase('premap-ready', 'intro (krillocity open)', [K('03'), P('14')], () => {
  buildDom('intro');
  KR.bot.mode = 'krillocity';
}, async () => {
  KR.startMode();
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/bot-log', (b) => b.event === 'krillocity-open')
    && clicked(o, (c) => c.el._sel === 'a.kr-peek'),
  'log / open',
  `krillocity-open logged, a.kr-peek clicked, mode=${o.mode}`,
));

addCase('premap-ready', 'intro (START DAILY)', [S('12'), K('02'), K('04'), P('14')], () => {
  buildDom('intro');
  sandbox.location.pathname = '/krillocity';
  KR.bot.mode = 'krillocity';
}, async () => {
  KR.startMode();
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/bot-log', (b) => b.event === 'krillocity-start')
    && clicked(o, (c) => c.el._sel === 'button.kr-begin') && o.mode === 'krillocity',
  'log / start',
  `krillocity-start logged, START DAILY clicked, mode=${o.mode}`,
));

addCase('premap-ready', 'intro (duel mode)', [D('01')], () => {
  buildDom('intro');
  KR.bot.mode = 'duel';
}, async () => {
  KR.startMode();
  return observe();
}, (o) => verdict(
  clicked(o, (c) => /1\s*vs\s*1/i.test(c.el.innerText)) && o.logs.length === 0,
  'start / no-log',
  `Play 1 vs 1 clicked, no log (classic/online begin is decision-only), gameState=${o.gameState}`,
));

/* ---- prompt-reveal -------------------------------------------------------- */
addCase('premap-ready', 'prompt-reveal', [
  S('6'), S('C4'), M('11'), G('07'), T('05'), T('11'), T('13'), T('14'),
], () => {
  buildDom('prompt-reveal');
  flags.premapReady();
  flags.botOn();
}, async () => {
  await KR.loadAnswers(PROMPT);
  KR.botTick();
  return observe();
}, (o) => verdict(
  o.gameState === 'prompt-reveal' && o.state.groups.length === 1
    && o.inputWrites.length === 0 && o.logs.length === 0,
  'wait / prompt-level only',
  `premap hit loaded ${o.state.answers.length} answers, no input yet, gameState=${o.gameState}`,
));

addCase('premap-pending', 'prompt-reveal', [IS('02'), T('09'), T('12')], () => {
  buildDom('prompt-reveal');
  flags.botOn();
  KR.state.preloadPromise = new Promise(() => {});
}, async () => {
  // Deliberately not awaited: the 2500ms Promise.race timer is the observable.
  KR.loadAnswers(PROMPT);
  KR.botTick();
  return observe();
}, (o) => verdict(
  timerAt(o, 2500) && o.inputWrites.length === 0 && o.state.groups.length === 0,
  'wait / backoff',
  `2500ms preload race armed, no fill, botStatus="${o.botState}"`,
));

/* ---- answering ------------------------------------------------------------ */
addCase('premap-ready', 'answering', [
  S('7'), S('C5'), S('C7'), S('C12'), M('12'), G('06'), T('19'),
], () => {
  buildDom('answering');
  flags.premapReady();
  flags.botOn();
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  o.inputWrites.length === 1 && !!o.state.lastFilled && timerAt(o, 120),
  'answer',
  `filled "${o.state.lastFilled}" via native setter, 120ms submit armed, gameState=${o.gameState}`,
));

addCase('premap-ready', 'answering (locked input)', [S('C6')], () => {
  buildDom('answering');
  scene.map.get('input.kr-input').disabled = true;
  scene.map.get('input.kr-input').readOnly = true;
  flags.premapReady();
  flags.botOn();
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  o.inputWrites.length === 1 && !!o.state.lastFilled,
  'answer (code-derived)',
  `disabled/readOnly input still filled (script gates only on visible): ${o.state.lastFilled}`,
));

addCase('premap-ready', 'answering (autoEnter fill)', [P('08'), P('17'), IS('11')], () => {
  buildDom('answering');
  flags.premapReady();
  KR.state.autoEnter = true;
}, async () => {
  KR.fill(ANSWERS[0], { dataset: { q: PROMPT } });
  return observe();
}, (o) => verdict(
  o.inputWrites.length === 1 && timerAt(o, 220),
  'answer',
  `chip fill wrote "${o.state.lastFilled}", 220ms auto-dive armed`,
));

addCase('premap-ready', 'answering (Enter submit)', [P('18')], () => {
  buildDom('answering');
  flags.premapReady();
}, async () => {
  KR.submitAnswer();
  return observe();
}, (o) => verdict(
  clicked(o, (c) => c.via === 'submit'),
  'submit',
  `form.requestSubmit() used as the primary submit path`,
));

addCase('tierPremap-ready', 'answering (God pick)', [IS('03'), P('13')], () => {
  buildDom('answering');
  flags.premapReady();
  flags.tierReady();
  flags.botOn();
  KR.bot.pick = 'god';
}, async () => {
  KR.answerCurrentPrompt();
  return observe();
}, (o) => verdict(
  o.inputWrites.length === 1 && !!o.state.lastFilled,
  'answer',
  `God Gaussian pick filled "${o.state.lastFilled}" synchronously from ready tierPremap`,
));

addCase('tierPremap-pending', 'answering (God pick)', [IS('03')], () => {
  buildDom('answering');
  flags.premapReady();
  flags.tierPending();
  flags.botOn();
  KR.bot.pick = 'god';
}, async () => {
  KR.answerCurrentPrompt();
  return observe();
}, (o) => verdict(
  o.inputWrites.length === 0 && /loading 85-point answers/.test(o.botState)
    && hasLog(o, '/api/answers-tier'),
  'wait / async fallback',
  `tier fallback requested, no fill, botStatus="${o.botState}"`,
));

addCase('bot-off', 'answering', [IS('05'), K('12')], () => {
  buildDom('answering');
  flags.premapReady();
  flags.botOff();
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  o.inputWrites.length === 0 && o.logs.length === 0,
  'wait / no-log',
  `bot off: no fill, no log, botStatus="${o.botState}"`,
));

addCase('roundClosed', 'answering', [IS('06'), M('15')], () => {
  buildDom('answering');
  flags.premapReady();
  flags.botOn();
  flags.roundClosed();
}, async () => {
  KR.answerCurrentPrompt();
  return observe();
}, (o) => verdict(
  o.inputWrites.length === 0 && o.bot.roundClosed === true,
  'wait / no double answer',
  `roundClosed guard blocked re-answer; roundClosed=${o.bot.roundClosed}`,
));

addCase('premap-ready', 'answering (duel mode)', [D('06')], () => {
  buildDom('answering');
  scene.set('.kr-duel-board', { visible: true });
  flags.premapReady();
  flags.botOn('duel');
}, async () => {
  KR.answerCurrentPrompt();
  return observe();
}, (o) => verdict(
  o.inputWrites.length === 1 && o.mode === '1v1' && o.gameState === 'duel',
  'answer',
  `duel answer filled with game_state=duel, mode=${o.mode}`,
));

/* ---- refusal -------------------------------------------------------------- */
function refusalSetup() {
  buildDom('answering');
  scene.set('.kr-refusal', { visible: true, text: '"Ice cubes" was not accepted' });
  flags.premapReady();
  flags.botOn();
  KR.state.lastFilled = 'Ice cubes';
  KR.state.answerQuestion['Ice cubes'] = PROMPT;
  flags.refusal();
}
addCase('refusalActive', 'refusal', [
  S('8'), S('C8'), K('08'), M('13'), G('05'), IS('07'), T('06'), T('22'),
], refusalSetup, async () => {
  KR.checkRefusal();
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/prompt-review', (b) => b.kind === 'refused')
    && hasLog(o, '/api/evidence', (b) => b.outcome === 'refused')
    && o.state.refusalActive === true,
  'refuse / log',
  `prompt-review:refused + evidence:refused posted, refusalActive=true, gameState=${o.gameState}`,
));

addCase('refusalActive', 'answering (classifier precedence)', [S('C8')], refusalSetup, async () => {
  const detected = KR.gameState();
  KR.checkRefusal();
  const o = observe();
  o.detected = detected;
  return o;
}, (o) => verdict(
  o.detected === 'refusal' && hasLog(o, '/api/evidence', (b) => b.outcome === 'refused'),
  'refuse / log',
  `refusalActive overrides prompt+input visibility: gameState=${o.detected}`,
));

/* ---- verdict -------------------------------------------------------------- */
addCase('premap-ready', 'verdict (solo reveal)', [
  S('9'), S('C9'), S('C11'), T('07'), T('21'),
], () => {
  buildDom('verdict');
  flags.premapReady();
  flags.botOn();
  KR.state.lastFilled = ANSWERS[0];
  KR.state.answerQuestion[ANSWERS[0]] = PROMPT;
}, async () => {
  KR.checkVerdict();
  await fireTimers(180);
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/evidence', (b) => b.points === 100 && b.outcome === 'ok')
    && clicked(o, (c) => c.el._sel === 'button.kr-next')
    && o.bot.roundClosed === true,
  'log / advance',
  `100pt evidence posted, Next clicked once, roundClosed=true`,
));

addCase('premap-ready', 'verdict (classic board fallback)', [
  S('C10'), MS('03'), T('21'),
], () => {
  buildDom('verdict');
  scene.map.delete('.kr-reveal-points b'); // no solo reveal in this frame
  scene.set('.kr-board-head', { visible: true, text: 'You said ' + ANSWERS[0] + ' +30' });
  flags.premapReady();
  KR.state.lastFilled = ANSWERS[0];
  KR.state.answerQuestion[ANSWERS[0]] = PROMPT;
}, async () => {
  KR.checkVerdict();
  await micro(); // let reportScore's post-await low-score review land
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/evidence', (b) => b.points === 30)
    && hasLog(o, '/api/prompt-review', (b) => b.kind === 'low-score')
    && o.mode === 'classic',
  'log / classic-only',
  `classic board head parsed as +30, low-score review posted, mode=${o.mode}`,
));

addCase('premap-ready', 'verdict (multiplayer board ignored)', [
  S('9b'), M('14'), D('07'), T('21'),
], () => {
  buildDom('verdict');
  scene.map.delete('.kr-reveal-points b'); // multiplayer has no solo reveal
  scene.set('.kr-board-head', { visible: true, text: 'Someone went deepest +60' });
  scene.set('.kr-stage-multi', { visible: true });
  flags.premapReady();
  KR.state.lastFilled = ANSWERS[0];
  KR.state.answerQuestion[ANSWERS[0]] = PROMPT;
}, async () => {
  KR.checkVerdict();
  return observe();
}, (o) => verdict(
  !hasLog(o, '/api/evidence') && o.mode === 'multiplayer',
  'no-log (policy: never another player\'s score)',
  `board head not parsed in multiplayer mode=${o.mode}, no evidence posted`,
));

addCase('bot-off', 'verdict', [S('C9')], () => {
  buildDom('verdict');
  flags.premapReady();
  flags.botOff();
  KR.state.lastFilled = ANSWERS[0];
  KR.state.answerQuestion[ANSWERS[0]] = PROMPT;
}, async () => {
  KR.checkVerdict();
  await fireTimers(180);
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/evidence') && !clicked(o, (c) => c.el._sel === 'button.kr-next'),
  'log / no auto-advance',
  `observer logged the verdict; no Next click while bot is off and autoEnter=false`,
));

addCase('roundClosed', 'verdict', [IS('06'), T('18')], () => {
  buildDom('verdict');
  flags.premapReady();
  flags.botOn();
  flags.roundClosed();
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  o.inputWrites.length === 0 && o.logs.length === 0 && /waiting for the next round/.test(o.botState),
  'wait / no double answer',
  `roundClosed verdict screen keeps the bot idle: "${o.botState}"`,
));

addCase('premap-ready', 'krillocity (verdict reveal)', [K('07')], () => {
  buildDom('verdict');
  sandbox.location.pathname = '/krillocity';
  flags.premapReady();
  flags.botOn('krillocity');
  KR.state.lastFilled = ANSWERS[0];
  KR.state.answerQuestion[ANSWERS[0]] = PROMPT;
}, async () => {
  KR.checkVerdict();
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/evidence', (b) => b.points === 100) && o.mode === 'krillocity',
  'log / per-answer',
  `krillocity solo reveal logged as evidence, mode=${o.mode}`,
));

/* ---- results -------------------------------------------------------------- */
addCase('premap-ready', 'results (classic full capture)', [
  S('10'), S('C13'), S('C14'), S('C15'), S('C16'), M('16'), G('02'),
  T('08'), T('16'), T('17'), IS('08'), IS('09'),
], () => {
  buildDom('results');
  flags.premapReady();
  flags.botOn('classic');
}, async () => {
  KR.botTick();                       // kickoff: captureBanks in flight
  await micro();
  await fireTimers(120);              // haul settle
  await fireTimers(260);              // row expansion settle
  await micro();
  scene.list('.kr-row', [bankRow(PROMPT, true)]);
  scene.map.get('.kr-row')[0].children[0].setAttribute('aria-expanded', 'true');
  KR.botTick();                       // gate now ready -> report + restart
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/bank', (b) => b.rows && b.rows.some((r) => r.source === 'own'))
    && hasLog(o, '/api/bot-log', (b) => b.event === 'classic-bank-capture')
    && clicked(o, (c) => /play again/i.test(c.el.innerText)),
  'capture / log / restart',
  `own-only bank imported, classic-bank-capture logged, Play again clicked`,
));

addCase('bank-capturing', 'results', [S('C17'), IS('08'), T('17')], () => {
  buildDom('results');
  flags.premapReady();
  flags.botOn('classic');
  KR.state.bankCapturing = true;
  KR.state.bankCapturePromise = new Promise(() => {});
  KR.state.bankCaptureSettled = false;
  KR.state.bankCaptureSignature = KR.classicBankSignature(KR.classicRows());
  KR.state.classicFinalize = {
    key: KR.state.bankCaptureSignature, startedAt: Date.now(),
    reported: false, gated: false, kickoff: false,
  };
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  !clicked(o, (c) => /play again/i.test(c.el.innerText))
    && !hasLog(o, '/api/bot-log', (b) => b.event === 'classic-bank-capture')
    && /saving dive banks/.test(o.botState),
  'wait / gate',
  `capture still in flight: restart withheld, botStatus="${o.botState}"`,
));

addCase('capture-settled', 'results', [S('C18'), IS('09'), T('17')], () => {
  buildDom('results');
  flags.premapReady();
  flags.botOn('classic');
  const sig = KR.classicBankSignature(KR.classicRows());
  KR.state.bankCapturePromise = Promise.resolve();
  KR.state.bankCaptureSettled = true;
  KR.state.bankCaptureSignature = sig;
  KR.state.bankCaptureRows = 1;
  KR.state.bankCaptureAnswers = 2;
  KR.state.classicFinalize = {
    key: sig, startedAt: Date.now(), reported: false, gated: false, kickoff: false,
  };
  scene.map.get('.kr-row')[0].children[0].setAttribute('aria-expanded', 'true');
}, async () => {
  KR.finalizeClassicResults();
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/bot-log', (b) => b.event === 'classic-bank-capture')
    && clicked(o, (c) => /play again/i.test(c.el.innerText)),
  'log / restart',
  `settled capture: classic-bank-capture logged before Play again click`,
));

addCase('premap-ready', 'results (no rows, 400ms gate)', [S('C17'), M('17'), T('17')], () => {
  buildDom('results-no-rows');
  flags.premapReady();
  flags.botOn('classic');
  KR.state.classicFinalize = {
    key: '0:', startedAt: Date.now() - 500, reported: false, gated: false, kickoff: false,
  };
}, async () => {
  KR.finalizeClassicResults();
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/bot-log', (b) => b.event === 'classic-bank-capture')
    && clicked(o, (c) => /play again/i.test(c.el.innerText)),
  'log / restart',
  `no dive-end rows: 400ms gate elapsed, report + restart`,
));

addCase('bot-off', 'results', [IS('05')], () => {
  buildDom('results');
  flags.premapReady();
  flags.botOff();
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  o.logs.length === 0 && o.clicks.length === 0,
  'wait / no-log',
  `bot off: no capture, no restart, no log`,
));

addCase('premap-ready', 'results (krillocity daily report)', [K('10'), K('11'), T('20')], () => {
  buildDom('results-no-rows');
  scene.list('button', [new El('button', { visible: true, text: 'Continue' })]);
  flags.premapReady();
  flags.botOn('krillocity');
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  clicked(o, (c) => /continue/i.test(c.el.innerText))
    && !hasLog(o, '/api/bot-log', (b) => b.event === 'classic-bank-capture'),
  'restart / no new gameplay log',
  `non-classic results restart directly; no classic bank gate, mode=${o.mode}`,
));

/* ---- arena-wait ----------------------------------------------------------- */
addCase('premap-ready', 'arena-wait', [
  S('5'), M('08'), M('09'), M('10'), G('08'),
], () => {
  buildDom('arena-wait');
  flags.botOn('marathon5');
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  o.gameState === 'arena-wait' && o.logs.length === 0 && o.inputWrites.length === 0
    && /waiting for the next round/.test(o.botState),
  'wait / no-log',
  `board/chat read as context only; nothing logged, gameState=${o.gameState}`,
));

addCase('bot-off', 'arena-wait', [IS('05')], () => {
  buildDom('arena-wait');
  flags.botOff();
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  o.logs.length === 0 && o.clicks.length === 0,
  'wait / no-log',
  `bot off between rounds: idle, no log`,
));

addCase('premap-ready', 'arena-wait (duel board)', [D('07'), T('21')], () => {
  buildDom('arena-wait');
  flags.botOn('duel');
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  !hasLog(o, '/api/evidence') && /waiting for duel lobby/.test(o.botState),
  'wait / no-log',
  `duel board head never parsed as our score, botStatus="${o.botState}"`,
));

/* ---- lobby ---------------------------------------------------------------- */
addCase('premap-ready', 'lobby (marathon5)', [
  S('3'), M('01'), M('03'), M('04'), G('04'), T('23'),
], () => {
  buildDom('lobby');
  flags.botOn('marathon5');
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/bot-log', (b) => b.event === 'room-select' && /5-second room/.test(b.reason || ''))
    && clicked(o, (c) => c.el._sel === '.kr-room-row'),
  'log / click',
  `5s/50 room selected, room-select logged, no answer data read`,
));

addCase('premap-ready', 'lobby (showoff)', [M('06')], () => {
  buildDom('lobby');
  flags.botOn('showoff');
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/bot-log', (b) => b.event === 'room-select' && /most populated/.test(b.reason || ''))
    && clicked(o, (c) => c.el._sel === '.kr-room-row'),
  'log / click',
  `most-populated room selected via argmax, room-select logged`,
));

addCase('bot-off', 'lobby', [M('02')], () => {
  buildDom('lobby');
  flags.botOff();
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  o.logs.length === 0 && o.clicks.length === 0,
  'wait / no-log',
  `lobby idle chrome, bot off: no room click, no log`,
));

addCase('premap-ready', 'lobby (classic mode guard)', [S('C19')], () => {
  buildDom('lobby');
  flags.botOn('classic');
}, async () => {
  KR.joinLobbyRoom();
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/bot-log', (b) => b.event === 'room-select' && /mode does not join rooms/.test(b.reason || ''))
    && !clicked(o, (c) => c.el._sel === '.kr-room-row'),
  'log / no click',
  `classic mode never joins a room; decision logged only`,
));

addCase('premap-ready', 'lobby (leave controls)', [M('18')], () => {
  buildDom('lobby');
  flags.botOn('marathon5');
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  !clicked(o, (c) => c.el._sel === '.kr-lobby-back'),
  'log / no leave',
  `.kr-lobby-back never clicked by the bot`,
));

/* ---- create-room ---------------------------------------------------------- */
addCase('premap-ready', 'create-room', [S('4'), M('05'), G('03'), S('C19')], () => {
  buildDom('create-room');
  flags.botOn('classic');
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  o.gameState === 'create-room' && o.logs.length === 0 && o.clicks.length === 0,
  'wait / no-log',
  `manual setup screen is read-only context, gameState=${o.gameState}`,
));

addCase('premap-ready', 'create-room (private code field)', [M('07')], () => {
  buildDom('create-room-code');
  flags.botOn('classic');
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  o.inputWrites.length === 0 && o.logs.length === 0,
  'wait / no-log',
  `6-digit code field is never filled by the answer bot`,
));

/* ---- duel ----------------------------------------------------------------- */
addCase('premap-ready', 'duel (queue)', [
  S('11'), D('00'), D('03'), G('01'), T('23'),
], () => {
  buildDom('duel-play');
  flags.botOn('duel');
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/bot-log', (b) => b.event === 'duel-queue')
    && clicked(o, (c) => c.el._sel === '.kd-play') && o.gameState === 'duel',
  'log / click',
  `duel-queue logged, Find a match clicked once, gameState=${o.gameState}`,
));

addCase('premap-ready', 'duel (tab rule)', [D('02')], () => {
  buildDom('duel-rule');
  flags.botOn('duel');
}, async () => {
  KR.duelTick();
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/bot-log', (b) => b.event === 'duel-rule')
    && clicked(o, (c) => c.el._sel === '.kd-tab-rule-key'),
  'log / click',
  `tab rule accepted and logged`,
));

addCase('premap-ready', 'duel (elsewhere claim)', [D('04'), D('10')], () => {
  buildDom('duel-elsewhere');
  flags.botOn('duel');
}, async () => {
  KR.duelTick();
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/bot-log', (b) => b.event === 'duel-claim')
    && clicked(o, (c) => c.el._sel === '.kd-elsewhere-key'),
  'log / click',
  `queue claimed in this tab; other tab's match never recorded`,
));

addCase('premap-ready', 'duel (versus wait)', [D('05')], () => {
  buildDom('duel-versus');
  flags.botOn('duel');
}, async () => {
  KR.duelTick();
  return observe();
}, (o) => verdict(
  o.logs.length === 0 && !clicked(o, (c) => c.el._sel === '.kd-versus-leave'),
  'wait / no-log',
  `match found: silent wait, Leave never clicked`,
));

addCase('premap-ready', 'duel (result / requeue)', [D('08'), D('09')], () => {
  buildDom('duel-result');
  flags.botOn('duel');
}, async () => {
  KR.duelTick();
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/bot-log', (b) => b.event === 'duel-requeue')
    && clicked(o, (c) => c.el._sel === '.kd-again'),
  'log / click',
  `duel-requeue logged, no opponent/rating data archived`,
));

addCase('premap-ready', 'duel (stop-loss)', [D('09')], () => {
  buildDom('duel-result');
  scene.map.get('.kd-result-title').textContent = '';
  scene.map.get('.kd-result-title').innerText = '';
  flags.botOn('duel');
  KR.bot.duelLossStreak = 2;
}, async () => {
  KR.duelTick();
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/bot-log', (b) => b.event === 'duel-stop-loss')
    && !clicked(o, (c) => c.el._sel === '.kd-again'),
  'log / no requeue',
  `2 defeats: stop-loss logged, requeue withheld`,
));

addCase('premap-ready', 'duel (rematch cap)', [D('09'), T('23')], () => {
  buildDom('duel-result');
  flags.botOn('duel');
  KR.bot.duelRematches = 3;
}, async () => {
  KR.duelTick();
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/bot-log', (b) => b.event === 'duel-rematch-cap')
    && !clicked(o, (c) => c.el._sel === '.kd-again'),
  'log / no requeue',
  `3 rematches: cap logged, requeue withheld`,
));

addCase('premap-ready', 'duel (leave never automated)', [D('11')], () => {
  buildDom('duel-leave');
  flags.botOn('duel');
}, async () => {
  KR.duelTick();
  return observe();
}, (o) => verdict(
  !clicked(o, (c) => c.el._sel === '.kd-versus-leave' || c.el._sel === '.kd-home'),
  'wait / no-log',
  `no Leave/Back automation, botStatus="${o.botState}"`,
));

/* ---- krillocity ----------------------------------------------------------- */
function raceReady() {
  buildDom('answering');
  sandbox.location.pathname = '/krillocity';
  flags.premapReady();
  flags.botOn('krillocity');
}
addCase('premap-ready', 'krillocity (race burst)', [
  S('12'), K('06'), K('13'), T('20'), G('06'),
], raceReady, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  o.inputWrites.length === 1 && timerAt(o, 50) && timerAt(o, 90),
  'answer / rapid cadence',
  `race fill written, 50ms submit + 90ms step armed, mode=${o.mode}`,
));

addCase('tierPremap-ready', 'krillocity (race pool)', [K('13'), IS('03')], () => {
  raceReady();
  flags.tierReady();
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  o.inputWrites.length === 1 && KR.raceBuildPool(PROMPT).length > ANSWERS.length,
  'answer / expanded pool',
  `pool expanded from rare + tier bank, fill written`,
));

addCase('premap-pending', 'krillocity (answers loading)', [K('05'), T('20')], () => {
  buildDom('answering');
  sandbox.location.pathname = '/krillocity';
  flags.premapPending();
  flags.botOn('krillocity');
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  o.inputWrites.length === 0 && timerAt(o, 80) && /loading answers/.test(o.botState),
  'wait / 80ms retry',
  `no answers loaded: raceCancel + 80ms retry, no fill`,
));

addCase('roundClosed', 'krillocity (race cancelled)', [K('12'), IS('06')], () => {
  raceReady();
  flags.roundClosed();
}, async () => {
  KR.raceBurst();
  return observe();
}, (o) => verdict(
  o.inputWrites.length === 0 && o.bot.raceTimer === null,
  'wait / no-log',
  `roundClosed cancels the burst; no fill, no timer`,
));

addCase('refusalActive', 'krillocity (refused answer)', [K('08'), T('22')], () => {
  raceReady();
  scene.set('.kr-refusal', { visible: true, text: '"Ice cubes" was not accepted' });
  KR.state.lastFilled = 'Ice cubes';
  KR.state.answerQuestion['Ice cubes'] = PROMPT;
  flags.refusal();
}, async () => {
  KR.checkRefusal();
  return observe();
}, (o) => verdict(
  hasLog(o, '/api/evidence', (b) => b.outcome === 'refused')
    && KR.state.refusedAnswers.has(PROMPT + '\u0000Ice cubes'),
  'refuse / log',
  `refused answer logged and skipped by raceNextAnswer; no demotion`,
));

addCase('premap-ready', 'krillocity (prompt/input boundary dedupe)', [
  K('09'), K('14'), IS('12'),
], raceReady, async () => {
  KR.raceBurst();
  const first = env.inputWrites.slice();
  KR.bot.raceTimer = null;
  KR.bot.raceSubmitTimer = null;
  scene.set('input.kr-input', { visible: true, placeholder: 'Name as many as you can…' });
  KR.raceBurst();
  return observe();
}, (o) => verdict(
  o.inputWrites.length === 2 && new Set(o.inputWrites).size === 2,
  'answer / dedupe',
  `input remount kept raceSubmitted: ${JSON.stringify(o.inputWrites)}`,
));

addCase('bot-off', 'krillocity (bot stopped)', [K('12')], () => {
  raceReady();
  flags.botOff();
}, async () => {
  KR.botTick();
  return observe();
}, (o) => verdict(
  o.inputWrites.length === 0 && o.timers.length === 0,
  'wait / no-log',
  `bot off: no race timers, no fill`,
));

/* ---- genuinely impossible combinations ----------------------------------- */
addCase('bank-capturing', 'intro', [], () => { buildDom('intro'); }, async () => {
  return observe();
}, () => verdict(true, '',
  'bank capture is a results-only state; no intro DOM can have an in-flight capture'), true);

addCase('bank-capturing', 'answering', [], () => { buildDom('answering'); }, async () => {
  return observe();
}, () => verdict(true, '',
  'bank capture requires dive-end rows; an answering screen has no capture to settle'), true);

addCase('capture-settled', 'create-room', [], () => { buildDom('create-room'); }, async () => {
  return observe();
}, () => verdict(true, '',
  'manual room setup cannot follow a settled classic dive capture in one screen'), true);

// ---------------------------------------------------------------------------
// Inventory coverage: parse row IDs directly from the four documents
// ---------------------------------------------------------------------------
function parseInventory() {
  const out = new Set();
  const texts = {};
  Object.keys(SCRIPTS).forEach((name) => {
    texts[name] = fs.readFileSync(SCRIPTS[name], 'utf8');
  });
  let m;
  const reNum = /^\|\s*(\d+[ab]?)\s*\|/gm;
  while ((m = reNum.exec(texts.STATES))) out.add('STATES:' + m[1]);
  const reC = /^\|\s*(C\d+)\s*\|/gm;
  while ((m = reC.exec(texts.STATES))) out.add('STATES:' + m[1]);
  const reK = /^\|\s*(K-\d+)\s*\|/gm;
  while ((m = reK.exec(texts['STATES-KRILLO']))) out.add('STATES-KRILLO:' + m[1]);
  const reMPD = /^\|\s*([SMD]\d{2})\s*\|/gm;
  while ((m = reMPD.exec(texts['STATES-MP-DUEL']))) out.add('STATES-MP-DUEL:' + m[1]);
  const reI = /^\|\s*([PSTG]\d{2})\s*\|/gm;
  while ((m = reI.exec(texts.INTERACTIONS))) out.add('INTERACTIONS:' + m[1]);
  return out;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
(async function main() {
  await probeBridge();
  ensureAnswers();

  for (const c of cases) {
    resetCtx();
    try {
      c.setup();
      const obs = await c.run();
      const res = c.check(obs);
      if (c.na) {
        record('N/A', c.scriptState, c.gameState, res.detail);
      } else {
        const extra = res.behavior ? res.behavior + ' — ' : '';
        record(res.ok ? 'PASS' : 'FAIL', c.scriptState, c.gameState, extra + res.detail);
      }
    } catch (e) {
      record('FAIL', c.scriptState, c.gameState, 'harness threw: ' + (e && e.message || e));
    }
  }

  const parsed = parseInventory();
  const covered = new Set();
  cases.forEach((c) => c.covers.forEach((id) => covered.add(id)));
  const missing = Array.from(parsed).filter((id) => !covered.has(id)).sort();
  const extra = Array.from(covered).filter((id) => !parsed.has(id)).sort();
  if (missing.length) {
    record('FAIL', 'coverage', 'inventory',
      `${missing.length} inventory row(s) not represented: ${missing.join(', ')}`);
  }
  if (extra.length) {
    record('FAIL', 'coverage', 'inventory',
      `${extra.length} unknown inventory id(s) in matrix: ${extra.join(', ')}`);
  }
  const coverage = parsed.size && !missing.length && !extra.length
    ? 100 : Math.round((parsed.size - missing.length) / Math.max(1, parsed.size) * 100);
  console.log(`Summary: ${passes} PASS, ${fails} FAIL, ${nas} N/A, coverage=${coverage}%`);
  process.exit(fails > 0 || coverage < 100 ? 1 : 0);
})();
