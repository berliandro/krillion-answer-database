#!/usr/bin/env node
// Verify the Krillocity harvest outputs: counts, unique prompts, classification,
// zero-match mirror log, and the "never authoritative / never merge" invariant.
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'data');
const read = (f) => fs.existsSync(path.join(DIR, f))
  ? fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  : [];
const answers = read('krillocity_answers.jsonl');
const zero = read('krillocity_zero_match.jsonl');
const prompts = read('krillocity_prompts.jsonl');

const matched = answers.filter((r) => r.match === true).length;
const zeroRows = answers.filter((r) => r.zero_match === true);
const unknown = answers.filter((r) => r.match === null).length;
const badSource = answers.filter((r) => r.source !== 'krillocity' || r.authoritative !== false).length;
const withNames = answers.filter((r) => 'n' in r || 'name' in r || 'player' in r).length;
const zeroKeys = new Set(zero.map((r) => `${r.prompt}|${r.answer}|${r.room}|${r.race}|${r.slot}`));
const missingMirror = zeroRows.filter((r) => !zeroKeys.has(`${r.prompt}|${r.answer}|${r.room}|${r.race}|${r.slot}`)).length;
const promptSet = new Set(prompts.map((p) => p.prompt));

const result = {
  answers: answers.length,
  matched,
  zeroMatchRows: zeroRows.length,
  unknownStatusRows: unknown,
  uniquePromptsInAnswers: new Set(answers.map((r) => r.prompt)).size,
  promptBankLines: prompts.length,
  uniquePromptsInBank: promptSet.size,
  promptSources: prompts.reduce((a, p) => { a[p.source] = (a[p.source] || 0) + 1; return a; }, {}),
  roomsWithPrompts: new Set(prompts.map((p) => p.room).filter(Boolean)).size,
  zeroReviewLogLines: zero.length,
  zeroMirrorMissing: missingMirror,
  wrongSourceOrAuthoritative: badSource,
  rowsWithPlayerIdentity: withNames,
  checks: {
    allRowsSeparated: badSource === 0,
    zeroPathMirrored: missingMirror === 0,
    noPlayerIdentity: withNames === 0,
    promptBankCoversAnswers: [...new Set(answers.map((r) => r.prompt))].every((q) => promptSet.has(q)),
  },
};
console.log(JSON.stringify(result, null, 2));
const failed = Object.entries(result.checks).filter(([, ok]) => !ok).map(([k]) => k);
if (failed.length) { console.error('FAILED: ' + failed.join(', ')); process.exitCode = 1; }
else console.log('ALL CHECKS PASS');
