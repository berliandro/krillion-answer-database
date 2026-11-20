// Krillion bulk harvester — job scrape-001 (durable copy of the running temp script).
//
// WHAT: Reads the graded answer bank for prompts dealt by playdaily.org/krillion and
//       appends one JSON object per line to data/answers.jsonl:
//       {"question":"...","answer":"...","is_krillion":true|false,"source_url":"..."}
//       Tier index 5 ("One in a Krillion", 100 pts) is the only one flagged true.
//       Append-only; never rewrites or deletes existing lines.
//
// RUN:  node scripts/harvest.js                 (defaults: 180 prompts, 4 h cap)
//       KRILLION_MAX_PROMPTS=50 node scripts/harvest.js
//       Safe to run alongside the coordinator's `python scripts/krillion_db.py import`.
//
// API:
//   POST /api/krillion/deal  {"mode":"classic"}
//        -> {prompts:[{id,text,level}...], tickets:{id:ticket}, lap}   (unthrottled)
//   GET  /api/krillion/answers?prompt=<promptId>&ticket=<ticket>
//        -> {"answers":[[tierIndex,"answer text"], ...]}               (rate-limited)
//
// 425 RULE (mirror of the site's own client in 1pb-w_75d3u07.js):
//   The ticket MUST come from the same /deal call that produced the prompt id.
//   On HTTP 425 parse {"wait":ms}, sleep wait + 250 ms and retry the SAME ticket.
//   The official client gives up after 4 attempts; this script allows up to 12
//   and refills with a brand-new /deal (fresh ticket) when the queue empties.
//   Progress state lives in the temp dir so a repo restart can resume safely.
const fs = require('fs');
const path = require('path');

const BASE = 'https://playdaily.org';
const JSONL = path.join(__dirname, '..', 'data', 'answers.jsonl');
const LOG = path.join(process.env.TEMP || 'C:\\Users\\nberl\\AppData\\Local\\Temp', 'opencode', 'krillion-harvest.log');
const STATE = path.join(process.env.TEMP || 'C:\\Users\\nberl\\AppData\\Local\\Temp', 'opencode', 'krillion-harvest-state.json');
const MAX_PROMPTS = Number(process.env.KRILLION_MAX_PROMPTS || 180);
const MAX_MS = Number(process.env.KRILLION_MAX_MS || 4 * 60 * 60 * 1000);
const H = {
  'content-type': 'application/json',
  origin: BASE,
  referer: BASE + '/krillion',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(msg) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG, line, 'utf8');
  process.stdout.write(line);
}

async function getJson(url, opts) {
  const r = await fetch(url.startsWith('http') ? url : BASE + url, { headers: H, ...(opts || {}) });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

async function deal() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await getJson('/api/krillion/deal', {
      method: 'POST',
      body: JSON.stringify({ mode: 'classic' }),
    });
    if (r.status === 200 && Array.isArray(r.body.prompts) && r.body.tickets) {
      return r.body.prompts
        .filter((p) => p && p.id && p.text && r.body.tickets[p.id])
        .map((p) => ({ id: p.id, text: p.text, ticket: r.body.tickets[p.id] }));
    }
    log(`deal failed: status=${r.status} body=${JSON.stringify(r.body).slice(0, 200)}`);
    await sleep(5000);
  }
  throw new Error('deal failed repeatedly');
}

async function fetchAnswers(p) {
  const url = `/api/krillion/answers?prompt=${encodeURIComponent(p.id)}&ticket=${encodeURIComponent(p.ticket)}`;
  for (let attempt = 0; attempt < 12; attempt++) {
    const r = await getJson(url);
    if (r.status === 200 && Array.isArray(r.body.answers)) return r.body.answers;
    if (r.status === 425) {
      // wait + 250 ms per the official client; +2000 ms here for extra safety.
      const wait = Math.min(180000, Math.max(0, Number(r.body && r.body.wait) || 65000));
      log(`  425 cooldown: waiting ${Math.round((wait + 2000) / 1000)}s (attempt ${attempt + 1})`);
      await sleep(wait + 2000);
      continue;
    }
    if (r.status === 403 || r.status === 400 || r.status === 404) {
      log(`  prompt rejected (${r.status}): ${p.id} ${JSON.stringify(r.body).slice(0, 120)}`);
      return null;
    }
    log(`  answers status=${r.status}: ${JSON.stringify(r.body).slice(0, 200)}; retry in 10s`);
    await sleep(10000);
  }
  log(`  all attempts 425 for ${p.id}; dropping it — next prompt gets a fresh deal ticket`);
  return null;
}

function loadSeen() {
  const seen = new Set();
  if (fs.existsSync(JSONL)) {
    for (const line of fs.readFileSync(JSONL, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        seen.add(o.question + '\u0000' + o.answer);
      } catch {}
    }
  }
  return seen;
}

// Seed: verified response for 1viko16ceo9q ("Name an animal"), 59 graded answers.
const SEED = [
  [0,'Dog'],[0,'Cat'],[0,'Lion'],[0,'Elephant'],[0,'Tiger'],[0,'Horse'],[0,'Cow'],[0,'Giraffe'],[0,'Monkey'],[0,'Bear'],
  [1,'Bird'],[1,'Fish'],[1,'Sheep'],[1,'Rabbit'],[1,'Mouse'],[1,'Wolf'],[1,'Snake'],[1,'Dolphin'],[1,'Whale'],[1,'Shark'],
  [2,'Goat'],[2,'Duck'],[2,'Deer'],[2,'Hippopotamus'],[2,'Rhinoceros'],[2,'Gorilla'],[2,'Koala'],[2,'Cheetah'],[2,'Leopard'],[2,'Camel'],
  [3,'Okapi'],[3,'Pangolin'],[3,'Axolotl'],[3,'Quokka'],[3,'Tarsier'],[3,'Dugong'],[3,'Echidna'],[3,'Kakapo'],[3,'Cassowary'],[3,'Serval'],
  [4,'Fossa'],[4,'Saiga'],[4,'Numbat'],[4,'Gharial'],[4,'Gerenuk'],[4,'Markhor'],[4,'Dhole'],[4,'Bilby'],[4,'Zebu'],
  [5,'Kinkajou'],[5,'Nudibranch'],[5,'Solenodon'],[5,'Zorilla'],[5,'Tenrec'],[5,'Colugo'],[5,'Babirusa'],[5,'Tuatara'],[5,'Hirola'],[5,'Linsang'],
];

(async () => {
  const started = Date.now();
  const seen = loadSeen();
  let promptsDone = 0, linesAdded = 0, krillion = 0;
  let state = { doneIds: [], questions: 0 };
  if (fs.existsSync(STATE)) {
    try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
  }
  const doneIds = new Set(state.doneIds || []);

  function appendBank(question, bank) {
    let n = 0, k = 0;
    const chunks = [];
    for (const row of bank) {
      if (!Array.isArray(row) && !(row && typeof row === 'object')) continue;
      const tier = Array.isArray(row) ? Number(row[0]) : Number(row.tier);
      const answer = String((Array.isArray(row) ? row[1] : (row.answer ?? row.name)) || '').trim();
      if (!answer) continue;
      const key = question + '\u0000' + answer;
      if (seen.has(key)) continue;
      seen.add(key);
      const isK = tier === 5;
      chunks.push(JSON.stringify({
        question,
        answer,
        is_krillion: isK,
        source_url: BASE + '/krillion',
      }) + '\n');
      if (isK) k++;
      n++;
    }
    if (chunks.length) fs.appendFileSync(JSONL, chunks.join(''), 'utf8');
    linesAdded += n;
    krillion += k;
    return { n, k };
  }

  if (!seen.has('Name an animal\u0000Kinkajou')) {
    const s = appendBank('Name an animal', SEED);
    log(`seeded "Name an animal": +${s.n} lines (${s.k} krillion)`);
  }

  let queue = [];
  let lastAnswersAt = 0;

  while (promptsDone < MAX_PROMPTS && Date.now() - started < MAX_MS) {
    if (!queue.length) {
      queue = await deal();
      log(`dealt ${queue.length} new prompts (total done: ${promptsDone})`);
    }
    const p = queue.shift();
    if (!p || doneIds.has(p.id)) continue;

    // Never call /answers within ~66s of the previous call (server 425 cooldown).
    const gap = 66500 - (Date.now() - lastAnswersAt);
    if (lastAnswersAt && gap > 0) await sleep(gap);

    log(`[${promptsDone + 1}/${MAX_PROMPTS}] ${p.id} — ${p.text}`);
    let bank;
    try {
      bank = await fetchAnswers(p);
      lastAnswersAt = Date.now();
    } catch (e) {
      log(`FATAL on prompt ${p.id}: ${e.message}`);
      break;
    }
    if (bank) {
      const s = appendBank(p.text, bank);
      log(`  +${s.n} lines (${s.k} krillion); total lines=${linesAdded}, krillion=${krillion}`);
    }
    doneIds.add(p.id);
    promptsDone++;
    state = { doneIds: [...doneIds], questions: promptsDone };
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(state), 'utf8');
  }

  log(`DONE prompts=${promptsDone} linesAdded=${linesAdded} krillion=${krillion} elapsed=${Math.round((Date.now() - started) / 1000)}s`);
})().catch((e) => { log('UNCAUGHT: ' + (e && e.stack || e)); process.exitCode = 1; });
