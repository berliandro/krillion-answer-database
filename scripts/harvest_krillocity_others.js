#!/usr/bin/env node
// Harvest other players' game-graded answers from public Krillocity race
// results across an enumerated room range, and POST them to the local bridge.
// Never imports into the graded bank; records source=krillocity only.
const BRIDGE = 'http://127.0.0.1:8768';
const TOKEN = 'krillion-local-v1';
const API = 'https://playdaily.org/api/krillion/blitz';
const H = { origin: 'https://playdaily.org', referer: 'https://playdaily.org/krillocity', 'user-agent': 'Mozilla/5.0' };
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ROOMS = Number(arg('rooms', '150'));
const RACES = (arg('races', '106002,106003') || '').split(',').map(Number).filter(Boolean);
const CONCURRENCY = Number(arg('concurrency', '6'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  try {
    const r = await fetch(url, { headers: H });
    const t = await r.text();
    if (r.status === 425) { let w = 5000; try { w = Math.min(8000, Math.max(250, JSON.parse(t).wait || 5000)); } catch (e) {} return { status: 425, wait: w }; }
    let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { status: r.status, body: j };
  } catch (e) { return { status: 0, error: String(e) }; }
}

(async () => {
  let posted = 0, roomsOk = 0, roomsSkip = 0;
  const jobs = [];
  for (const race of RACES) for (let i = 1; i <= ROOMS; i++) jobs.push({ room: `race2-${i}`, race });
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < jobs.length) {
      const { room, race } = jobs[cursor++];
      const lu = await getJson(`${API}/lineup?room=${room}&race=${race}&upto=6&s=0&k=Is6n8Pek-bT1XoO_w1QCv7`);
      if (lu.status !== 200 || !lu.body || !Array.isArray(lu.body.prompts)) { roomsSkip++; continue; }
      const rs = await getJson(`${API}/results?room=${room}&race=${race}&m=${race}:join`);
      if (rs.status !== 200 || !rs.body || !Array.isArray(rs.body.rows)) { roomsSkip++; continue; }
      roomsOk++;
      const prompts = lu.body.prompts;
      const seen = new Set();
      const payloads = [];
      for (const row of rs.body.rows) {
        const slot = Number(row.s);
        if (!Number.isInteger(slot) || !prompts[slot]) continue;
        if (!Array.isArray(row.w) || !Array.isArray(row.v)) continue;
        for (let k = 0; k < row.w.length; k++) {
          const answer = String(row.w[k] || '').trim();
          if (!answer) continue;
          const key = `${slot}\u0000${answer.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          payloads.push({
            source: 'krillocity', room, race,
            prompt_id: prompts[slot].id || '', prompt: prompts[slot].text || '',
            slot, answer, game_points: Number(row.v[k]),
            other_players: 1, match: true, zero_match: false, authoritative: false,
          });
        }
      }
      for (const body of payloads) {
        try {
          const r = await fetch(`${BRIDGE}/api/krillo-answer?t=${TOKEN}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
          if (r.ok) posted++;
        } catch (e) {}
      }
    }
  });
  await Promise.all(workers);
  console.log(JSON.stringify({ rooms: ROOMS, races: RACES, roomsOk, roomsSkip, answersPosted: posted }, null, 2));
})();
