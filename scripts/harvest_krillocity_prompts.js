#!/usr/bin/env node
// Bulk Krillocity prompt harvester via room enumeration.
//
// The public lineup endpoint answers for ANY room id of the form race2-N,
// not only the four rooms listed by /rooms. Enumerating a wide room range is
// therefore the fastest way to collect the prompt bank and every wording
// variant the game deals (near-duplicate prompts are kept separate).
//
// RUN
//   node scripts/harvest_krillocity_prompts.js --max-room 1000
//   KRILLO_MAX_ROOM=2000 node scripts/harvest_krillocity_prompts.js
//
// OUTPUT: data/krillocity_prompts.jsonl (append-only, deduped by prompt text)
//         data/krillocity_prompt_harvest.json (run stats)

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'krillocity_prompts.jsonl');
const STATS = path.join(DATA, 'krillocity_prompt_harvest.json');
const API = 'https://playdaily.org/api/krillion/blitz';
const H = {
  origin: 'https://playdaily.org',
  referer: 'https://playdaily.org/krillocity',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MAX_ROOM = Number(arg('max-room', process.env.KRILLO_MAX_ROOM || 1000));
const RACE = Number(arg('race', process.env.KRILLO_RACE || 105779));
const SHIFT_S = process.env.KRILLO_SHIFT_S || '219314';
const SHIFT_K = process.env.KRILLO_SHIFT_K || 'oSOjDWXHFiK8op_IMyZrwj';
const CONCURRENCY = Number(process.env.KRILLO_CONCURRENCY || 8);
const PASSES = Number(process.env.KRILLO_PASSES || 2);

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadSeen() {
  const seen = new Set();
  if (fs.existsSync(OUT)) {
    for (const line of fs.readFileSync(OUT, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const j = JSON.parse(line); if (j.prompt) seen.add(j.prompt); } catch (_) {}
    }
  }
  return seen;
}

async function lineup(room) {
  const u = `${API}/lineup?room=${encodeURIComponent(room)}&race=${RACE}&upto=6&s=${SHIFT_S}&k=${encodeURIComponent(SHIFT_K)}`;
  const r = await fetch(u, { headers: H });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, wait: j && j.wait ? j.wait : null, prompts: j && Array.isArray(j.prompts) ? j.prompts : null };
}

(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  const seen = loadSeen();
  const stats = { started: now(), maxRoom: MAX_ROOM, race: RACE, roomOk: 0, room425: 0, roomFail: 0, promptLines: 0, newPrompts: 0, promptsBefore: seen.size, passes: [] };
  console.log(`[prompt-harvest] start rooms=1..${MAX_ROOM} race=${RACE} seen=${seen.size}`);

  for (let pass = 0; pass < PASSES; pass++) {
    const pending = Array.from({ length: MAX_ROOM }, (_, i) => i + 1);
    let cursor = 0, ok = 0, throttled = 0, fail = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < pending.length) {
        const roomNo = pending[cursor++];
        let res;
        try { res = await lineup('race2-' + roomNo); }
        catch (e) { fail++; continue; }
        if (res.status === 200 && res.prompts) {
          ok++;
          for (const p of res.prompts) {
            if (!p || !p.text) continue;
            stats.promptLines++;
            if (!seen.has(p.text)) {
              seen.add(p.text);
              stats.newPrompts++;
              fs.appendFileSync(OUT, JSON.stringify({
                at: now(), prompt_id: p.id, prompt: p.text, level: p.level,
                source: 'krillocity-lineup-enum', room: 'race2-' + roomNo, race: RACE,
                source_url: 'https://playdaily.org/krillocity',
              }) + '\n', 'utf8');
            }
          }
        } else if (res.status === 425) throttled++;
        else fail++;
      }
    });
    await Promise.all(workers);
    stats.roomOk += ok; stats.room425 += throttled; stats.roomFail += fail;
    stats.promptsAfter = seen.size;
    stats.passes.push({ pass, ok, throttled, fail, uniquePrompts: seen.size });
    console.log(`[prompt-harvest] pass=${pass} ok=${ok} throttled=${throttled} fail=${fail} unique=${seen.size}`);
    if (pass < PASSES - 1) await sleep(3000);
  }
  stats.finished = now();
  fs.writeFileSync(STATS, JSON.stringify(stats, null, 2), 'utf8');
  console.log(JSON.stringify(stats, null, 2));
})().catch((e) => { console.error('FATAL ' + (e && e.stack || e)); process.exitCode = 1; });
