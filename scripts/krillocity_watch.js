#!/usr/bin/env node
// Krillocity room watcher + per-room collectors.
//
// WHAT
//   - Polls the game's public Krillocity room list.
//   - For every room with >= KRILLO_MIN_PLAYERS players, spawns a collector.
//   - A collector reads the current race's 7 prompts (lineup) and EVERY other
//     player's accepted answers WITH the game's own point values (results).
//   - Each (prompt, answer) is checked against the local answer index (bridge).
//     * 0 matches  -> written to krillocity_answers.jsonl with match=false AND
//                    logged to krillocity_zero_match.jsonl for later verification
//                    (duplicate check / search-engine fault check).
//     * >=1 match  -> written to krillocity_answers.jsonl with match=true and a
//                    separate krillocity source/tier marker. NEVER merged into
//                    the authoritative 100-point archive.
//
// WHY REST AND NOT A SEAT
//   The same data is public at /api/krillion/blitz/results, so occupying a seat
//   is unnecessary and would risk the account/rating. The watcher still applies
//   the requested room policy: a room with only one player is skipped and an
//   already-collected (room, race) is never collected twice.
//
// RUN
//   node scripts/krillocity_watch.js                       # until stopped
//   KRILLO_MAX_MINUTES=20 node scripts/krillocity_watch.js  # bounded run
//   KRILLO_POLL_MS=15000 node scripts/krillocity_watch.js
//
// OUTPUT (all append-only, under data/)
//   krillocity_answers.jsonl   every observed (prompt, answer, points, marker)
//   krillocity_zero_match.jsonl prompts with zero index matches (review queue)
//   krillocity_watch.log       watcher/collector events
//   krillocity_state.json      processed room:race keys + locks (restart-safe)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const SITE = 'https://playdaily.org';
const API = SITE + '/api/krillion/blitz';
const BRIDGE = process.env.KRILLO_BRIDGE || 'http://127.0.0.1:8768';
const TOKEN = process.env.KRILLO_TOKEN || 'krillion-local-v1';
const POLL_MS = Number(process.env.KRILLO_POLL_MS || 15000);
const MIN_PLAYERS = Number(process.env.KRILLO_MIN_PLAYERS || 2);
const MAX_MINUTES = Number(process.env.KRILLO_MAX_MINUTES || 0);
const RACE_SEED = Number(process.env.KRILLO_RACE_SEED || 0); // 0 = auto-discover

const FILES = {
  answers: path.join(DATA, 'krillocity_answers.jsonl'),
  zero: path.join(DATA, 'krillocity_zero_match.jsonl'),
  log: path.join(DATA, 'krillocity_watch.log'),
  state: path.join(DATA, 'krillocity_state.json'),
  prompts: path.join(DATA, 'krillocity_prompts.jsonl'),
};
const H = {
  origin: SITE,
  referer: SITE + '/krillocity',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

function log(msg) {
  const line = `[${now()}] ${msg}\n`;
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(FILES.log, line, 'utf8');
  process.stdout.write(line);
}
function append(file, obj) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}
function readState() {
  try { return JSON.parse(fs.readFileSync(FILES.state, 'utf8')); }
  catch (_) { return { done: {}, locks: {}, lastRace: {}, stats: {} }; }
}
function writeState(s) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(FILES.state, JSON.stringify(s), 'utf8');
}

async function getJson(url, opts = {}) {
  // A hard timeout keeps one slow room from stalling the whole watcher.
  const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(12000), ...opts });
  const text = await r.text();
  if (r.status === 425) {
    let wait = 5000;
    try { wait = Math.min(10000, Math.max(250, Number(JSON.parse(text).wait) || 5000)); } catch (_) {}
    return { status: 425, wait, body: null };
  }
  let body = null;
  try { body = JSON.parse(text); } catch (_) {}
  return { status: r.status, body };
}

async function rooms() {
  const r = await getJson(API + '/rooms');
  return r.status === 200 && r.body && r.body.rooms ? r.body.rooms : {};
}

// A room's shift key is returned by the public results endpoint.
async function shiftFor(room, race) {
  const r = await getJson(`${API}/results?room=${encodeURIComponent(room)}&race=${race}&m=${race}:join`);
  if (r.status !== 200 || !r.body || !r.body.shift) return null;
  return r.body.shift;
}

// Discover the current race by probing around the last known race. Valid races
// answer 200 (raced) or 425 (scheduled); 404 means "not this race".
async function findRaces(room, hint) {
  const found = [];
  const start = hint || RACE_SEED;
  if (!start) return found;
  for (let race = start - 3; race <= start + 4; race++) {
    const r = await getJson(`${API}/lineup?room=${encodeURIComponent(room)}&race=${race}&upto=6`);
    if (r.status === 200 || r.status === 425) found.push({ race, status: r.status });
    await sleep(60);
  }
  // Prefer a race that has actually run: its results contain other players' answers.
  const raced = found.filter((x) => x.status === 200).map((x) => x.race);
  const scheduled = found.map((x) => x.race);
  return raced.length ? raced : scheduled;
}

async function lineup(room, race, shift) {
  const u = `${API}/lineup?room=${encodeURIComponent(room)}&race=${race}&upto=6`
    + `&s=${shift.s}&k=${encodeURIComponent(shift.k)}`;
  const r = await getJson(u);
  if (r.status === 425) { await sleep(r.wait + 300); return getJson(u); }
  return r;
}

async function results(room, race) {
  return getJson(`${API}/results?room=${encodeURIComponent(room)}&race=${race}&m=${race}:join`);
}

// Local index check. A prompt with exactly zero matches is a review candidate.
// If the bridge is offline, fall back to "unknown" and log the outage instead
// of inventing a match verdict.
async function matchInfo(question) {
  const url = `${BRIDGE}/api/answers?q=${encodeURIComponent(question)}&t=${encodeURIComponent(TOKEN)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { status: 'bridge-error', matches: null, http: r.status };
    const j = await r.json();
    const groups = Array.isArray(j.groups) ? j.groups : [];
    const matches = groups.reduce((n, g) => n + ((g.answers || []).length), 0);
    return { status: 'ok', matches, exact: !!j.exact, banks: groups.map((g) => g.question) };
  } catch (e) {
    return { status: 'bridge-offline', matches: null, error: String(e) };
  }
}

async function collectRoom(room, race, state) {
  const key = `${room}:${race}`;
  if (state.done[key] || state.locks[key]) return { skipped: 'seen-or-locked', key };
  state.locks[key] = true;
  writeState(state);
  try {
    const shift = await shiftFor(room, race);
    if (!shift) return { skipped: 'no-shift', key };
    const lu = await lineup(room, race, shift);
    if (lu.status !== 200 || !lu.body || !Array.isArray(lu.body.prompts)) {
      return { skipped: 'lineup-' + lu.status, key };
    }
    const prompts = lu.body.prompts;
    // Record the prompt bank itself (append-only, deduped below).
    for (const p of prompts) {
      if (!p || !p.text) continue;
      append(FILES.prompts, {
        at: now(), prompt_id: p.id, prompt: p.text, level: p.level,
        source: 'krillocity-lineup', room, race, source_url: SITE + '/krillocity',
      });
    }

    const res = await results(room, race);
    if (res.status !== 200 || !res.body || !Array.isArray(res.body.rows)) {
      return { skipped: 'results-' + res.status, key, prompts: prompts.length };
    }
    // Throttle: a second request often 425s; one retry after the wait.
    let rows = res.body.rows;
    if (!rows.length) {
      if (res.wait) await sleep(res.wait + 300);
      const again = await results(room, race);
      if (again.status === 200 && again.body && Array.isArray(again.body.rows)) rows = again.body.rows;
    }

    const bySlot = new Map();
    for (const row of rows) {
      const slot = Number(row.s);
      if (!Number.isInteger(slot) || slot < 0 || slot >= prompts.length) continue;
      if (!Array.isArray(row.w) || !Array.isArray(row.v)) continue;
      for (let i = 0; i < row.w.length; i++) {
        const answer = String(row.w[i] || '').trim();
        if (!answer) continue;
        const points = Number(row.v[i]);
        const k = `${slot}\u0000${answer.toLowerCase()}`;
        if (!bySlot.has(k)) bySlot.set(k, { slot, answer, points: Number.isFinite(points) ? points : null, players: 0 });
        bySlot.get(k).players++;
      }
    }

    let written = 0, zero = 0, matchErr = 0;
    const matchCache = new Map();
    for (const entry of bySlot.values()) {
      const p = prompts[entry.slot];
      const q = p && p.text ? p.text : '';
      if (!q) continue;
      if (!matchCache.has(q)) matchCache.set(q, await matchInfo(q));
      const mi = matchCache.get(q);
      if (mi.status !== 'ok') matchErr++;
      const isZero = mi.status === 'ok' && mi.matches === 0;
      const rec = {
        at: now(), source: 'krillocity', room, race,
        prompt_id: p.id, prompt: q, slot: entry.slot,
        answer: entry.answer, game_points: entry.points,
        other_players: entry.players,
        index_status: mi.status, index_matches: mi.matches,
        index_exact: mi.exact || false, index_banks: mi.banks || [],
        match: mi.status === 'ok' ? mi.matches > 0 : null,
        zero_match: isZero,
        authoritative: false, // never merged into the graded 100-point archive
        source_url: SITE + '/krillocity',
      };
      append(FILES.answers, rec);
      written++;
      if (isZero) {
        append(FILES.zero, {
          at: rec.at, prompt: q, prompt_id: p.id, room, race, slot: entry.slot,
          answer: entry.answer, game_points: entry.points,
          reason: 'zero-index-match', needs_review: ['duplicate-check', 'search-engine-fault-check'],
        });
        zero++;
      }
    }
    state.done[key] = { at: now(), prompts: prompts.length, rows: rows.length, written, zero, matchErr };
    log(`collected ${key}: prompts=${prompts.length} rows=${rows.length} unique=${bySlot.size} written=${written} zero=${zero} matchErr=${matchErr}`);
    return state.done[key];
  } finally {
    delete state.locks[key];
    writeState(state);
  }
}

(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  const started = Date.now();
  const state = readState();
  log(`watcher start poll=${POLL_MS}ms minPlayers=${MIN_PLAYERS} maxMinutes=${MAX_MINUTES || 'unlimited'}`);
  let lastDiscovery = 0;

  while (!stopping) {
    if (MAX_MINUTES && (Date.now() - started) / 60000 >= MAX_MINUTES) break;
    const rs = await rooms();
    const entries = Object.entries(rs).filter(([id]) => !id.startsWith('~'));
    // Only rooms with enough players; a lone player is not worth collecting.
    const active = entries.filter(([, count]) => Number(count) >= MIN_PLAYERS);
    log(`poll rooms=${entries.length} active=${active.length} ` +
        active.map(([id, c]) => `${id}:${c}`).join(','));

    if (Date.now() - lastDiscovery > 60000) {
      for (const [room] of active.slice(0, 4)) {
        const known = state.lastRace[room] || RACE_SEED;
        const races = await findRaces(room, known);
        if (races.length) state.lastRace[room] = Math.max(...races);
        await sleep(50);
      }
      writeState(state);
      lastDiscovery = Date.now();
    }

    // Fan out one collector per room concurrently (bounded) so a slow room
    // does not serialise the others. The lock file above still guarantees at
    // most one collector per room:race.
    const jobs = [];
    for (const [room] of active) {
      const hint = state.lastRace[room] || RACE_SEED;
      if (!hint) continue;
      jobs.push([room, hint]);
      for (const r of findCandidates(hint)) jobs.push([room, r]);
    }
    const CONCURRENCY = Number(process.env.KRILLO_CONCURRENCY || 4);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
      while (cursor < jobs.length) {
        const [room, race] = jobs[cursor++];
        try { await collectRoom(room, race, state); }
        catch (e) { log(`collector error ${room}:${race} ${e && e.message || e}`); }
      }
    });
    await Promise.all(workers);
    await sleep(POLL_MS);
  }
  writeState(state);
  log(`watcher stopped. stats=${JSON.stringify(state.stats || {})}`);
})().catch((e) => { log('FATAL ' + (e && e.stack || String(e))); process.exitCode = 1; });

function findCandidates(hint) {
  return [hint - 1, hint + 1];
}
