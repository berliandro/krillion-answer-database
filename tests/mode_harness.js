#!/usr/bin/env node
/**
 * Tiny dependency-free Node harness for the two mode contracts.
 *
 *   node tests/mode_harness.js [path/to/krillion-autofill.user.js]
 *
 * It loads the userscript in a `vm` sandbox with stubbed GM/DOM globals, exposes
 * its internals by splicing an export line in front of the closing `})();`, and
 * then:
 *   - exercises tier parsing / per-prompt reset,
 *   - exercises race-mode answer submission (no repeated answers, rapid
 *     re-entry scheduling),
 *   - statically asserts the classic results branch gates its restart on bank
 *     capture and that a race* helper self-schedules the next burst step.
 *
 * This file is intentionally OUTSIDE the Python suite (tests/run_all.py does
 * not call it).  Stream A/B checks are enforced only when that stream's
 * post-merge symbols are present; before the merge they are reported as INFO.
 * Exits non-zero only on a genuine FAIL.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'injection', 'krillion-autofill.user.js');
const src = fs.readFileSync(SCRIPT, 'utf8');

let failures = 0;
function pass(name, detail) { console.log(`[PASS] ${name}: ${detail}`); }
function fail(name, detail) { failures++; console.log(`[FAIL] ${name}: ${detail}`); }
function info(name, detail) { console.log(`[INFO] ${name}: ${detail}`); }
function check(name, ok, detail) { ok ? pass(name, detail) : fail(name, detail); }

// ---------------------------------------------------------------------------
// source helpers (brace-balanced function extraction, strings/comments skipped)
// ---------------------------------------------------------------------------
function extractFunction(source, name) {
  const re = new RegExp('\\bfunction\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(source);
  if (!m) return '';
  let i = m.index + m[0].length - 1; // opening brace
  let depth = 0, quote = null;
  for (; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return source.slice(m.index, i + 1); }
  }
  return '';
}

function namedFunctions(source, nameRe) {
  const re = new RegExp('\\bfunction\\s+(' + nameRe + ')\\s*\\([^)]*\\)\\s*\\{', 'g');
  const out = [];
  let m;
  while ((m = re.exec(source))) {
    const body = extractFunction(source, m[1]);
    if (body) out.push({ name: m[1], body });
  }
  return out;
}

function stripLiterals(text) {
  let out = '', i = 0, quote = null;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === quote) { quote = null; out += c; i++; continue; }
      out += c === '\n' ? '\n' : ' '; i++; continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      let j = text.indexOf('\n', i); j = j < 0 ? text.length : j;
      while (i < j) { out += text[i] === '\n' ? '\n' : ' '; i++; }
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      let j = text.indexOf('*/', i + 2); j = j < 0 ? text.length : j + 2;
      while (i < j) { out += text[i] === '\n' ? '\n' : ' '; i++; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += ' '; i++; continue; }
    out += c; i++;
  }
  return out;
}

const STREAM_A = /\bbankCapturePromise\b|\bfunction\s+(?:finalize|classic)\w*\s*\(/.test(src);
const STREAM_B = /\brace[A-Z]\w*|\brace_(?:tick|step|burst|submit|answer|loop|fire)\b/.test(src)
  || (src.includes('lastSubmitAt') && !/lastSubmitAt[^\n]{0,40}700/.test(src));

// ---------------------------------------------------------------------------
// load the userscript with stubbed GM / DOM globals
// ---------------------------------------------------------------------------
const scheduled = [];
let timerId = 0;
const storage = new Map();
const inputWrites = [];

function makeElement(opts) {
  return Object.assign({ textContent: '', innerHTML: '', offsetParent: {}, dataset: {},
    style: {}, hidden: false, innerText: '', className: '', attributes: {},
    getAttribute() { return null; }, setAttribute() {}, addEventListener() {},
    dispatchEvent() {}, click() {}, requestSubmit() {},
    getClientRects() { return [{}]; }, querySelector() { return null; },
    querySelectorAll() { return []; } }, opts || {});
}

const elements = new Map();
const doc = {
  body: null, // keep mount() from auto-running; we only want the pure functions
  querySelector(sel) {
    if (sel === '.kr-intro') return null; // intro hidden once a dive starts
    return elements.get(sel) || null;
  },
  querySelectorAll() { return []; },
  getElementById() { return null; },
  createElement() { return makeElement(); },
  addEventListener() {},
  documentElement: makeElement(),
  head: makeElement(),
};

function HTMLInputElementStub() {}
Object.defineProperty(HTMLInputElementStub.prototype, 'value', {
  get() { return this.__krValue || ''; },
  set(v) { this.__krValue = v; inputWrites.push(v); },
  configurable: true,
});
function EventStub(type, opts) { this.type = type; Object.assign(this, opts || {}); }
function KeyboardEventStub(type, opts) { EventStub.call(this, type, opts); }
function MutationObserverStub() { this.observe = () => {}; this.disconnect = () => {}; this.takeRecords = () => []; }

const sandbox = {
  console,
  document: doc,
  location: { pathname: '/krillocity', hash: '' },
  navigator: { userAgent: 'node' },
  HTMLInputElement: HTMLInputElementStub,
  Event: EventStub,
  KeyboardEvent: KeyboardEventStub,
  MutationObserver: MutationObserverStub,
  unsafeWindow: {
    fetch() { return Promise.resolve({ clone() { return this; }, json() { return Promise.resolve({}); } }); },
  },
  GM_setValue(k, v) { storage.set(k, v); },
  GM_getValue(k, d) { return storage.has(k) ? storage.get(k) : d; },
  GM_xmlhttpRequest() {},
  GM_addStyle() {},
  fetch() { return Promise.resolve({ ok: true, clone() { return this; }, json() { return Promise.resolve({}); } }); },
  setTimeout(fn, ms) { scheduled.push({ fn, ms: Number(ms) || 0 }); return ++timerId; },
  setInterval() { return ++timerId; },
  clearTimeout() {},
  clearInterval() {},
};
sandbox.globalThis = sandbox;

const exportLine = ';globalThis.__KR_TEST__ = { state, bot, answerCurrentPrompt, '
  + 'resetBotRound, parseTierAnswers, tierPointsOf, pickAnswer, botTick, '
  + 'captureBanks, restartFromResults, promptText, submitAnswer, mode };';
const closeIx = src.lastIndexOf('})();');
if (closeIx < 0) throw new Error('userscript closing IIFE not found');
const prepared = src.slice(0, closeIx) + exportLine + src.slice(closeIx);

vm.createContext(sandbox);
try {
  vm.runInContext(prepared, sandbox, { filename: 'krillion-autofill.user.js' });
} catch (e) {
  fail('harness load', String(e && e.message || e));
  process.exit(1);
}
const T = sandbox.__KR_TEST__;
if (!T || typeof T.answerCurrentPrompt !== 'function') {
  fail('harness load', 'internals were not exported');
  process.exit(1);
}
pass('harness load', 'userscript evaluated with stubbed GM/DOM globals');

// ---------------------------------------------------------------------------
// pure-function checks (always available, pre- or post-merge)
// ---------------------------------------------------------------------------
try {
  const parsed = T.parseTierAnswers([['Rare', 100], 'Deep', { answer: 'Schooler', points: 30 }]);
  const pts = parsed.map((x) => x.points);
  check('tier parsing', parsed.length === 3 && pts[0] === 100 && pts[1] === 85 && pts[2] === 30,
    `parsed ${parsed.length} answers -> points ${JSON.stringify(pts)}`);
} catch (e) {
  fail('tier parsing', String(e && e.message || e));
}

try {
  T.bot.submittedForPrompt.add('probe\u0000answer');
  T.bot.roundClosed = false;
  T.resetBotRound(true);
  check('per-prompt reset', T.bot.submittedForPrompt.size === 0 && T.bot.roundClosed === true,
    'resetBotRound(true) clears submittedForPrompt and marks the round closed');
} catch (e) {
  fail('per-prompt reset', String(e && e.message || e));
}

// ---------------------------------------------------------------------------
// race burst: no repeated answers + rapid re-entry scheduling
// ---------------------------------------------------------------------------
if (!STREAM_B) {
  info('race burst (functional)', 'pre-merge: Stream B symbols absent');
} else {
  try {
    const prompt = 'Name any one famous park';
    const input = new HTMLInputElementStub();
    input.dispatchEvent = () => {};
    elements.set('p.kr-prompt', makeElement({ textContent: prompt }));
    elements.set('input.kr-input', input);

    sandbox.location.pathname = '/krillocity';
    Object.assign(T.state, {
      loadedPrompt: prompt,
      groups: [{ answers: ['park-a', 'park-b', 'park-c', 'park-d'], question: prompt }],
      answerQuestion: {},
      deepcut: [],
    });
    T.state.refusedAnswers.clear();
    if (T.state.tierPremap && typeof T.state.tierPremap.clear === 'function') T.state.tierPremap.clear();
    Object.assign(T.bot, { pick: 'random', mode: 'krillocity', on: true,
      roundClosed: false, answeredPrompt: '', lastSubmitAt: 0 });
    T.bot.submittedForPrompt.clear();
    inputWrites.length = 0;
    scheduled.length = 0;

    // The race loop self-schedules via setTimeout and deliberately skips while
    // a step timer is armed, so drive the harness's fake timers between steps
    // (mirroring real time) instead of calling synchronously four times.
    T.answerCurrentPrompt(); // first answer
    for (let i = 0; i < 3; i++) {
      const due = scheduled.splice(0);
      const step = due.find((s) => s.ms === 90) || due.find((s) => s.ms > 0 && s.ms < 200);
      if (!step) break;
      step.fn();
    }
    const unique = new Set(inputWrites);
    check('race burst: no repeated answers', inputWrites.length === unique.size && unique.size === 4,
      `submitted ${inputWrites.length} answers, ${unique.size} unique (${JSON.stringify(inputWrites)})`);
    const small = scheduled.filter((s) => s.ms > 0 && s.ms < 200);
    check('race burst: rapid re-entry scheduled', small.length > 0,
      `${small.length} timer(s) scheduled under 200ms (delays ${JSON.stringify(scheduled.map((s) => s.ms))})`);
  } catch (e) {
    fail('race burst (functional)', String(e && e.message || e));
  }
  check('race: no 700ms throttle',
    !/lastSubmitAt[^\n]{0,60}700|700[^\n]{0,60}lastSubmitAt/.test(src)
      && !/lastSubmitAt\s*<\s*700/.test(src),
    'no 700ms per-answer throttle remains');
  const raceFns = namedFunctions(src, 'race\\w*').filter((f) => f.body.includes('setTimeout'));
  check('race: helper self-schedules', raceFns.length > 0,
    raceFns.length ? `self-scheduling helpers: ${raceFns.map((f) => f.name).join(', ')}`
      : 'no race* helper schedules its own next burst step');
}

// ---------------------------------------------------------------------------
// classic: results branch must gate the restart on bank capture
// ---------------------------------------------------------------------------
if (!STREAM_A) {
  info('classic capture gate', 'pre-merge: Stream A symbols absent');
} else {
  const bot = extractFunction(src, 'botTick');
  const helpers = namedFunctions(src, '(?:finalize|classic)\\w*');
  const flow = bot + '\n' + helpers.map((h) => h.body).join('\n');
  // Two call sites are intentional: one gated inside finalizeClassicResults()
  // for classic dives, one direct in botTick's non-classic results branch.
  const helperSites = (helpers.map((h) => h.body).join('\n').match(/restartFromResults\s*\(/g) || []).length;
  const botSites = (bot.match(/restartFromResults\s*\(/g) || []).length;
  check('classic: single gated restart in finalize helper', helperSites === 1,
    `found ${helperSites} gated restart call(s) in finalize/classic helpers (botTick direct calls: ${botSites})`);

  const GUARD = /\bawait\s|\.then\s*\(|\bPromise\b|\bsettled\b|\bbankCapturing\b|\bbankSent\b|\bsetTimeout\s*\(/;
  const rm = /if\s*\(\s*roundClosed\s*\)/.exec(bot);
  let gated = false, detail = 'could not locate botTick results branch';
  if (rm) {
    const results = bot.slice(rm.index);
    const direct = results.indexOf('restartFromResults(');
    if (direct >= 0 && GUARD.test(stripLiterals(results.slice(0, direct)))) {
      gated = true; detail = 'gate token precedes direct restartFromResults() in results branch';
    }
    if (!gated) {
      const hm = /\b((?:finalize|classic)\w*)\s*\(/.exec(results);
      if (hm) {
        const helper = helpers.find((h) => h.name === hm[1]);
        if (helper) {
          const hr = helper.body.indexOf('restartFromResults(');
          if (hr >= 0 && GUARD.test(stripLiterals(helper.body.slice(0, hr)))) {
            gated = true; detail = `results branch delegates to ${hm[1]}() which gates its restart`;
          }
        }
      }
    }
    if (!gated) detail = 'results branch calls restartFromResults()/finalize* with NO capture gate';
  }
  check('classic: results gated before restart', gated, detail);
}

console.log(failures
  ? `\nSummary: ${failures} FAIL`
  : '\nSummary: all harness checks passed');
process.exit(failures ? 1 : 0);
