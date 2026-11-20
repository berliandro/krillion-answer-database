#!/usr/bin/env node
// Fast Krillion answer harvester (job gameplay-001).
//
// Measured recipe (zero gameplay):
//   1. POST /api/krillion/deal {"mode":"classic"} -> 7 prompts + 7 tickets
//   2. Probe one GET /api/krillion/answers; on 425 parse {wait}, sleep wait+2s
//   3. Burst all 7 GET /api/krillion/answers in parallel -> 7/7 x 200
//   4. Repeat with a fresh deal
// The 7 tickets from one deal share one ~65 s global window, so bursting all
// 7 inside that window yields ~350 answers per ~68 s (vs ~50/min paced).
//
// Usage: node scripts/harvest_game.js [--max-batches N] [--minutes N]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'answers_gameplay.jsonl');
const NOTES = path.join(DATA, 'gameplay-notes.md');
const TEMP = path.join(process.env.TEMP || os.tmpdir(), 'opencode');
const STATE = path.join(TEMP, 'krillion-gameplay-state.json');
const ORIGIN = 'https://playdaily.org';
const SOURCE_URL = ORIGIN + '/krillion';
const COORDINATOR = 'ses_e0720335cffeyCAhxPyntUehLO';
const SELF = 'ses_e06f05a44ffeywiGB4J3PET0Fq';

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const MAX_BATCHES = parseInt(arg('max-batches', '0'), 10) || 0;
const MAX_MINUTES = parseFloat(arg('minutes', '0')) || 0;

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const keyOf = (q, a) => q + '\u0000' + a;

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return {}; }
}
function writeState(s) {
  fs.mkdirSync(TEMP, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s), 'utf8');
}

function loadSeen() {
  const seen = new Set();
  const seenQuestions = new Set();
  const files = fs.readdirSync(DATA).filter((f) => /^answers.*\.jsonl$/i.test(f));
  for (const f of files) {
    const content = fs.readFileSync(path.join(DATA, f), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.question != null && o.answer != null) {
          seen.add(keyOf(o.question, o.answer));
          seenQuestions.add(o.question);
        }
      } catch (_) {}
    }
  }
  return { seen, seenQuestions, files };
}

function checkpoint(state) {
  const lines = fs.existsSync(OUT)
    ? fs.readFileSync(OUT, 'utf8').split(/\r?\n/).filter(Boolean).length
    : 0;
  const mins = ((now() - state.startedAt) / 60000).toFixed(1);
  const rate = state.startedAt ? (state.totalNew / ((now() - state.startedAt) / 60000)).toFixed(0) : '0';
  console.log('[harvest_game] CHECKPOINT lines=' + lines + ' added=' + state.totalNew +
    ' krillion=' + state.totalKrillion + ' batches=' + state.batches +
    ' minutes=' + mins + ' rate=' + rate + '/min');

  const msg = [
    'Message from DeepSeek V4.1 Flash 1017 (gameplay harvester, session ' + SELF +
      ', directory ' + ROOT + ').',
    '',
    '[job:gameplay-001] status=working evidence=' + lines +
      ' lines in data/answers_gameplay.jsonl (+' + state.totalNew +
      ' this run, ' + state.totalKrillion + ' One-in-a-Krillion, ' +
      state.batches + ' batches, ' + rate + ' answers/min over ' + mins + ' min).',
    'Pure API burst harvester is the single active harvester; no gameplay and no browsing.',
  ].join('\n');
  const mf = path.join(TEMP, 'gameplay-checkpoint.txt');
  fs.writeFileSync(mf, msg, 'utf8');
  const helper = path.join(process.env.USERPROFILE || '', '.config', 'opencode',
    'skills', 'opencode-session-comm', 'scripts', 'session-comm.ps1');
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', helper, 'notify', '-Session', COORDINATOR,
      '-ExpectDirectory', ROOT, '-SenderSession', SELF, '-MessageFile', mf],
      { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) console.error('[harvest_game] checkpoint notify failed: ' + (r.stderr || '').slice(0, 200));
  } catch (e) {
    console.error('[harvest_game] checkpoint notify error: ' + e.message);
  }
}

function appendNotes(state) {
  const text = [
    '',
    '## Harvest run ' + new Date().toISOString(),
    '- Recipe: deal -> 425 wait -> burst 7 /answers -> repeat.',
    '- Batches: ' + state.batches + ', answers added: ' + state.totalNew +
      ', krillion: ' + state.totalKrillion + ', elapsed min: ' +
      (((now() - state.startedAt) / 60000).toFixed(1)),
    '- De-duped against all data/answers*.jsonl.',
  ].join('\n');
  try { fs.appendFileSync(NOTES, text + '\n', 'utf8'); } catch (_) {}
}

async function api(url, init) {
  const res = await fetch(ORIGIN + url, {
    signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

async function deal(lapToken) {
  const body = { mode: 'classic' };
  if (lapToken) body.lap = lapToken;
  const r = await api('/api/krillion/deal', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.prompts)) {
    throw new Error('deal failed: ' + r.status + ' ' + r.text.slice(0, 200));
  }
  return r.json;
}

async function getBank(prompt, ticket) {
  const url = '/api/krillion/answers?prompt=' + encodeURIComponent(prompt.id) +
    '&ticket=' + encodeURIComponent(ticket);
  const r = await api(url);
  if (r.status === 200 && r.json && Array.isArray(r.json.answers)) {
    return { ok: true, answers: r.json.answers };
  }
  if (r.status === 425) {
    return { ok: false, wait: Number((r.json && r.json.wait) || 60000) };
  }
  return { ok: false, error: r.status + ' ' + r.text.slice(0, 200) };
}

async function main() {
  const previous = readState();
  const { seen, seenQuestions, files } = loadSeen();
  const state = {
    startedAt: now(),
    batches: 0,
    totalNew: 0,
    totalKrillion: 0,
    lastMilestone: Math.floor((previous.totalNew || 0) / 1000),
    totalNewBefore: previous.totalNew || 0,
    lap: previous.lap || null,
  };
  console.log('[harvest_game] dedupe files=' + files.join(',') + ' seen=' + seen.size +
    ' resumed batches=' + (previous.batches || 0) +
    ' lap=' + (state.lap ? state.lap.slice(0, 24) : 'none'));

  // Resume safely: do not burst into a window the previous run was already
  // waiting out. The probe below still gives the authoritative wait.
  if (previous.lastBurstAt && now() - previous.lastBurstAt < 67000) {
    const remain = 67000 - (now() - previous.lastBurstAt);
    console.log('[harvest_game] resume cooldown ' + remain + ' ms');
    await sleep(remain);
  }

  while (!stopping) {
    if (MAX_BATCHES && state.batches >= MAX_BATCHES) break;
    if (MAX_MINUTES && (now() - state.startedAt) / 60000 >= MAX_MINUTES) break;

    const t0 = now();
    let lap;
    try { lap = await deal(state.lap); }
    catch (e) {
      console.error('[harvest_game] deal error: ' + e.message);
      await sleep(10000);
      continue;
    }
    state.lap = lap.lap || state.lap;
    writeState({
      batches: (previous.batches || 0) + state.batches,
      totalNew: (previous.totalNew || 0) + state.totalNew,
      totalKrillion: (previous.totalKrillion || 0) + state.totalKrillion,
      lap: state.lap,
      lastBurstAt: previous.lastBurstAt || 0,
      updatedAt: now(),
    });
    const dealMs = now() - t0;
    const prompts = lap.prompts;
    const tickets = lap.tickets || {};
    const freshPrompts = prompts.filter((p) => !seenQuestions.has(p.text)).length;
    prompts.forEach((p) => seenQuestions.add(p.text));

    // Step 2: one probe to learn the remaining window. If it succeeds, reuse
    // that bank instead of re-fetching the same ticket (saves one call).
    let waitMs = 0;
    const probe = prompts[0];
    let pr = await getBank(probe, tickets[probe.id]);
    if (!pr.ok && pr.wait) {
      waitMs += pr.wait;
      await sleep(pr.wait + 2000);
      pr = await getBank(probe, tickets[probe.id]);
    }
    const results = prompts.map(() => null);
    if (pr.ok) results[0] = pr;
    else if (pr.error) console.error('[harvest_game] probe failed: ' + pr.error);

    // Step 3: burst the rest of the lap inside the unlocked window.
    const burstAt = now();
    const todo = prompts.map((p, i) => i).filter((i) => !results[i]);
    const burst = await Promise.all(todo.map(async (i) => {
      try { return await getBank(prompts[i], tickets[prompts[i].id]); }
      catch (e) { return { ok: false, error: e.message }; }
    }));
    const burstMs = now() - burstAt;
    burst.forEach((r, j) => { results[todo[j]] = r; });

    let retryWait = 0;
    for (const r of results) {
      if (r && !r.ok && r.wait) retryWait = Math.max(retryWait, r.wait);
    }
    if (retryWait) {
      waitMs += retryWait;
      await sleep(retryWait + 2000);
      const again = await Promise.all(todo.map(async (i) => {
        try { return await getBank(prompts[i], tickets[prompts[i].id]); }
        catch (e) { return { ok: false, error: e.message }; }
      }));
      again.forEach((r, j) => { if (r.ok) results[todo[j]] = r; });
    }

    // Parse, de-dupe, append one write per bank.
    let bankNew = 0, bankAnswers = 0, bankKrillion = 0;
    for (let i = 0; i < prompts.length; i++) {
      const r = results[i];
      const lines = [];
      if (r && r.ok) {
        for (const [tier, answer] of r.answers) {
          if (answer == null) continue;
          bankAnswers++;
          const q = prompts[i].text;
          const a = String(answer);
          const k = keyOf(q, a);
          if (seen.has(k)) continue;
          seen.add(k);
          const kr = Number(tier) === 5;
          if (kr) bankKrillion++;
          lines.push(JSON.stringify({
            question: q,
            answer: a,
            is_krillion: kr,
            source_url: SOURCE_URL,
          }));
        }
      } else {
        console.error('[harvest_game] bank failed ' + prompts[i].id + ': ' +
          ((r && r.error) || 'unknown'));
      }
      if (lines.length) {
        fs.appendFileSync(OUT, lines.join('\n') + '\n', 'utf8');
        bankNew += lines.length;
      }
    }

    state.batches++;
    state.totalNew += bankNew;
    state.totalKrillion += bankKrillion;
    writeState({
      batches: (previous.batches || 0) + state.batches,
      totalNew: (previous.totalNew || 0) + state.totalNew,
      totalKrillion: (previous.totalKrillion || 0) + state.totalKrillion,
      lap: state.lap,
      lastBurstAt: now(),
      updatedAt: now(),
    });

    console.log('[harvest_game] batch=' + state.batches +
      ' seconds=' + ((now() - t0) / 1000).toFixed(1) +
      ' dealMs=' + dealMs + ' waitMs=' + waitMs + ' burstMs=' + burstMs +
      ' prompts=' + prompts.length + ' fresh=' + freshPrompts +
      ' answers=' + bankAnswers + ' added=' + bankNew +
      ' krillion=' + bankKrillion + ' totalAdded=' + state.totalNew +
      ' lap=' + String(state.lap || '').slice(0, 24));

    const milestone = Math.floor(state.totalNew / 1000);
    if (milestone > state.lastMilestone) {
      state.lastMilestone = milestone;
      checkpoint(state);
    }
  }

  appendNotes(state);
  console.log('[harvest_game] done: batches=' + state.batches +
    ' new=' + state.totalNew + ' krillion=' + state.totalKrillion +
    ' elapsedSec=' + ((now() - state.startedAt) / 1000).toFixed(1));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
