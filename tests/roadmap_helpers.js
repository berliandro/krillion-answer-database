#!/usr/bin/env node
/**
 * Roadmap Phase 0 scaffold: stubbed-GM/DOM harness + source registry.
 *
 *   node tests/roadmap_helpers.js [--json path]
 *
 * Loads injection/krillion-autofill.user.js in a vm sandbox with stubbed
 * browser/GM globals, exports its internals, and generates a source-level
 * registry of selectors, state-classifier branches and log sites. The registry
 * is the checklist Phase 1 uses to prove every selector/state is inventoried.
 *
 * Dependency-free. Exits non-zero only if the scaffold itself fails.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.resolve(REPO, 'injection', 'krillion-autofill.user.js');
const src = fs.readFileSync(SCRIPT, 'utf8');

let failures = 0;
function pass(name, detail) { console.log(`[PASS] ${name}: ${detail}`); }
function fail(name, detail) { failures++; console.log(`[FAIL] ${name}: ${detail}`); }
function check(name, ok, detail) { ok ? pass(name, detail) : fail(name, detail); }

// ---------------------------------------------------------------------------
// Stubbed DOM / GM environment (mirrors tests/mode_harness.js)
// ---------------------------------------------------------------------------
class StubElement {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.readOnly = false;
    this.placeholder = '';
    this.offsetParent = {};
    this._attrs = {};
    this._listeners = {};
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  querySelector(sel) {
    // The real script queries its own panel ids at mount. Return a stable stub
    // so listeners attach without needing an HTML parser.
    if (typeof sel === 'string' && /^#ka-/.test(sel)) {
      if (!this._kids) this._kids = new Map();
      if (!this._kids.has(sel)) this._kids.set(sel, new StubElement('div'));
      return this._kids.get(sel);
    }
    return elements.get(sel) || null;
  }
  querySelectorAll() { return []; }
  getClientRects() { return [{}]; }
  focus() {}
  click() {}
  remove() {}
}

const elements = new Map();
function makeElement(key, props) {
  const el = new StubElement(props && props.tag);
  Object.assign(el, props || {});
  elements.set(key, el);
  return el;
}

const timers = [];
let timerId = 0;
const store = new Map();

const sandbox = {
  console, Math, JSON, Number, String, Array, Map, Set, Object, Date, Promise,
  RegExp, isFinite, parseInt, parseFloat, Error, Boolean, Symbol,
  setTimeout(fn, ms) { timers.push({ fn, ms: Number(ms) || 0 }); return ++timerId; },
  clearTimeout() {},
  setInterval() { return ++timerId; },
  clearInterval() {},
  location: { pathname: '/krillion', hash: '', href: 'https://playdaily.org/krillion' },
  document: {
    readyState: 'complete',
    body: new StubElement('body'),
    head: new StubElement('head'),
    createElement: (tag) => new StubElement(tag),
    querySelector: (sel) => elements.get(sel) || null,
    querySelectorAll: () => [],
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new StubElement('div'));
      return elements.get(id);
    },
    addEventListener() {},
  },
  MutationObserver: class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} },
  HTMLInputElement: function () {},
  Event: class { constructor(type) { this.type = type; } },
  KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } },
  GM_xmlhttpRequest() {},
  GM_addStyle(css) { sandbox.__style = css; },
  GM_setValue(k, v) { store.set(k, v); },
  GM_getValue(k, d) { return store.has(k) ? store.get(k) : d; },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.unsafeWindow = { fetch: null };
sandbox.HTMLInputElement = function () {};
Object.defineProperty(sandbox.HTMLInputElement, 'prototype', { value: { value: '' } });

// Export internals without changing the shipped file.
const exportHook = `\n;try{globalThis.__KR = {
  state, bot, SEL,
  gameState, mode, promptText, inputState, ctx,
  answerCurrentPrompt, captureBanks, finalizeClassicResults, restartFromResults,
  raceBuildPool, raceNextAnswer, raceBurst, preloadAnswers,
  reportBot, reportPrompt, reportMiss, reportScore
};}catch(e){globalThis.__KR_ERR=String(e)}`;

// Insert the export inside the top-level IIFE, immediately before its closing.
const endMarker = src.lastIndexOf('})();');
const runnable = endMarker > 0
  ? src.slice(0, endMarker) + exportHook + '\n' + src.slice(endMarker)
  : src + exportHook;

try {
  vm.createContext(sandbox);
  vm.runInContext(runnable, sandbox, { timeout: 5000 });
} catch (e) {
  fail('harness load', String(e && e.message || e));
}

const KR = sandbox.__KR || null;

// ---------------------------------------------------------------------------
// Source-level registry generator
// ---------------------------------------------------------------------------
function namedFunctions(source, nameRe) {
  const re = new RegExp('\\bfunction\\s+(' + nameRe + ')\\s*\\([^)]*\\)\\s*\\{', 'g');
  const out = [];
  let m;
  while ((m = re.exec(source))) out.push(m[1]);
  return out;
}

function buildRegistry() {
  const selectors = new Set();
  const selBlock = /const SEL\s*=\s*\{([\s\S]*?)\};/.exec(src);
  if (selBlock) {
    const re = /[A-Za-z0-9_]+\s*:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(selBlock[1]))) selectors.add(m[1]);
  }
  // Additional selectors used inline in gameState / botTick / duelTick.
  const inlineSelRe = /(?:isVisible|visible)\(\s*'([^']+)'\s*\)/g;
  let s;
  while ((s = inlineSelRe.exec(src))) selectors.add(s[1]);

  const states = [];
  const gs = /function gameState\(\)\s*\{([\s\S]*?)\n  \}/.exec(src);
  if (gs) {
    // Direct returns AND ternary returns (e.g. answering / prompt-reveal).
    const re = /'([a-z][a-z-]+)'/g;
    let m;
    while ((m = re.exec(gs[1]))) states.push(m[1]);
  }

  const logSites = namedFunctions(src, 'report\\w+').sort();
  const modes = [];
  const re = /value="([a-z0-9]+)"/g;
  let m;
  while ((m = re.exec(src))) {
    if (!modes.includes(m[1]) && /^(classic|krillocity|krillomulti|marathon5|showoff|duel)$/.test(m[1])) modes.push(m[1]);
  }

  return {
    generated_at: new Date().toISOString(),
    source: path.relative(REPO, SCRIPT),
    version: (/@version\s+(\S+)/.exec(src) || [])[1] || null,
    selectors: Array.from(selectors).sort(),
    states: Array.from(new Set(states)),
    log_sites: logSites,
    modes: modes.sort(),
    control_ids: Array.from(new Set((src.match(/id="(ka-[a-z]+)"/g) || []).map((x) => x.slice(4, -1)))).sort(),
  };
}

const registry = buildRegistry();

check('harness load: userscript evaluated', !!KR, KR ? 'internals exported' : (sandbox.__KR_ERR || 'no exports'));
check('registry: selectors found', registry.selectors.length >= 15, `${registry.selectors.length} selectors`);
check('registry: states found', registry.states.length >= 8, `${registry.states.length} states: ${registry.states.join(', ')}`);
check('registry: log sites found', registry.log_sites.length >= 4, `${registry.log_sites.length} sites: ${registry.log_sites.join(', ')}`);
check('registry: modes found', registry.modes.length >= 5, `${registry.modes.length} modes: ${registry.modes.join(', ')}`);
check('registry: control ids found', registry.control_ids.length >= 15,
  `${registry.control_ids.length} markup ids (ka-root set via root.id; ka-head is an extra wrapper)`);

if (process.argv.includes('--json')) {
  const outArg = process.argv[process.argv.indexOf('--json') + 1];
  const outPath = path.resolve(outArg || path.join(__dirname, 'roadmap-registry.json'));
  fs.writeFileSync(outPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  console.log(`[INFO] registry written to ${outPath}`);
}

console.log(`\nSummary: ${failures === 0 ? 'all scaffold checks passed' : failures + ' FAILED'}`);
process.exit(failures ? 1 : 0);
