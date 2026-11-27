#!/usr/bin/env node
// Continuous Krillocity prompt-bank harvester.
//
// Finds the newest race that has actually run (lineup HTTP 200) and harvests it
// across the enumerated room range, then repeats. Appends only new prompt text
// to data/krillocity_prompts.jsonl and records growth per race so saturation
// can be measured. Stops when MAX_MINUTES elapses or SIGINT/SIGTERM.
//
//   KRILLO_MAX_MINUTES=30 node scripts/krillocity_continuous.js
//   KRILLO_MAX_ROOM=2000 node scripts/krillocity_continuous.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', 'data');
const STATS = path.join(DATA, 'krillocity_continuous.json');
const OUT = path.join(DATA, 'krillocity_prompts.jsonl');
const API = 'https://playdaily.org/api/krillion/blitz';
const H = { origin: 'https://playdaily.org', referer: 'https://playdaily.org/krillocity', 'user-agent': 'Mozilla/5.0' };
const MAX_ROOM = Number(process.env.KRILLO_MAX_ROOM || 1000);
const PASS_MS = Number(process.env.KRILLO_POLL_MS || 90000);
const MAX_MINUTES = Number(process.env.KRILLO_MAX_MINUTES || 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

function uniqueCount() {
  const s = new Set();
  if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split(/\r?\n/)) {
    if (!l.trim()) continue;
    try { const j = JSON.parse(l); if (j.prompt) s.add(j.prompt); } catch (_) {}
  }
  return s.size;
}

async function newestLiveRace(hint) {
  let best = null;
  for (let race = hint - 1; race <= hint + 6; race++) {
    try {
      const r = await fetch(`${API}/lineup?room=race2-1&race=${race}&upto=6&s=219314&k=oSOjDWXHFiK8op_IMyZrwj`, { headers: H });
      if (r.status === 200) best = race;
    } catch (_) {}
  }
  return best;
}

(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  const started = Date.now();
  let hint = Number(process.env.KRILLO_RACE_SEED || 105784);
  const history = [];
  console.log(`[continuous] start hint=${hint} rooms=${MAX_ROOM} maxMinutes=${MAX_MINUTES}`);
  while (!stopping) {
    if (MAX_MINUTES && (Date.now() - started) / 60000 >= MAX_MINUTES) break;
    const before = uniqueCount();
    const race = await newestLiveRace(hint);
    if (race == null) { console.log(`[continuous] ${now()} no live race yet; waiting`); await sleep(PASS_MS); continue; }
    if (race > hint) hint = race;
    const r = spawnSync(process.execPath, [path.join(__dirname, 'harvest_krillocity_prompts.js'),
      '--race', String(race), '--max-room', String(MAX_ROOM)], {
      encoding: 'utf8', env: { ...process.env, KRILLO_PASSES: '2', KRILLO_CONCURRENCY: '8' },
    });
    const after = uniqueCount();
    const row = { at: now(), race, before, after, added: after - before, exit: r.status };
    history.push(row);
    fs.writeFileSync(STATS, JSON.stringify({ started: new Date(started).toISOString(), maxRoom: MAX_ROOM, history }, null, 2), 'utf8');
    console.log(`[continuous] ${JSON.stringify(row)}`);
    if (after === before) console.log('[continuous] saturation signal: no new prompts this race');
    await sleep(PASS_MS);
  }
  console.log(`[continuous] stopped; finalUnique=${uniqueCount()} races=${history.length}`);
})().catch((e) => { console.error('FATAL ' + (e && e.stack || e)); process.exitCode = 1; });
