#!/usr/bin/env node
// REV-7: prove a Tier A serve happens end to end through the REAL hook binary.
//
// STATUS: 9/9 since REV-8. It failed 6/9 when it was written, and that failure
// was the point: REV-4 had made Tier A independent of the recall store, but
// lib/hooks-recall.js still returned early on a store MISS -- before hashing
// the file -- so the read-time hash Tier A needs was never recorded for any
// file outside the store, and the tier could not fire in the real path however
// correct tierFor was in isolation. Its unit test passed throughout, because it
// calls tierFor directly and never crosses the hook's early return.
//
// REV-8 fixed that (see docs/recall-serve-funnel.md): on a store miss the hook
// now records the read-time hash and, when this session's earlier read of the
// path saw the same bytes, goes on to decide(). Two smaller faults on the same
// path came with it -- decide() built Tier A's body from storeEntry.contentHash
// (a TypeError the moment there is no store entry, swallowed by the outer
// fail-open into silence), and "already served" was keyed on the path alone, so
// one serve silenced a path for the rest of the session even after its content
// changed.
//
// Keep this script GREEN. It is the difference between "correct in a table
// test" and "works", and it is the only check that crosses the hook binary.
// Fully isolated: its own MEMBRIDGE_HOME and its own scratch project. Never
// touches the live daemon, the real ~/.membridge, or any real project.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

const REPO = '/Users/marco/Documents/Membridge/.claude/worktrees/ui';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'membridge-rev7-'));
const HOME = path.join(ROOT, 'home');
const PROJ = path.join(ROOT, 'scratch-project');
const SESSION = '11111111-2222-3333-4444-555555555555';
const REL = 'lib/payroll.js';
const ABS = path.join(PROJ, REL);

fs.mkdirSync(path.join(PROJ, 'lib'), { recursive: true });
fs.mkdirSync(path.join(PROJ, '.git'), { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
// Must clear MIN_CALL_TOKENS (400 tokens ~= 1600 bytes) or no tier applies.
const body = Array.from({ length: 140 }, (_, i) => `function step${i}() { return ${i}; }`).join('\n');
fs.writeFileSync(ABS, body);

const env = { ...process.env, MEMBRIDGE_HOME: HOME };
const hookBin = path.join(REPO, 'lib', 'membridge-hook.js');

function runHook(payload) {
  const r = cp.spawnSync(process.execPath, [hookBin, 'recall'], {
    input: JSON.stringify(payload), env, encoding: 'utf8',
  });
  return { out: r.stdout || '', err: r.stderr || '', status: r.status };
}
const payload = () => ({
  session_id: SESSION, cwd: PROJ, tool_name: 'Read', tool_input: { file_path: ABS },
});
const sessFile = path.join(PROJ, '.membridge', 'recall', 'sessions', `${SESSION}.json`);
const readSess = () => { try { return JSON.parse(fs.readFileSync(sessFile, 'utf8')); } catch { return null; } };

// state.json must track the project, and the ledger must show this session read
// the file -- Tier A requires BOTH the recorded hash and ledger proof the read
// happened. This is the state a real second read arrives in.
fs.writeFileSync(path.join(HOME, 'state.json'), JSON.stringify({
  version: 2, files: {}, projects: { [PROJ]: { events: [] } }, catchup: {}, feedback: {},
}));
fs.mkdirSync(path.join(PROJ, '.membridge'), { recursive: true });
const writeLedger = () => fs.writeFileSync(path.join(PROJ, '.membridge', 'ledger.json'), JSON.stringify({
  version: 5, sessions: 1, requests: 1, volume: 1, reads: {}, hotPaths: [],
  fileReaders: { [REL]: { sessions: [SESSION], reads: 1, lastTs: new Date().toISOString() } },
}));
writeLedger();

const results = [];
const t = (name, cond, detail) => { results.push([name, !!cond, detail]); };

// ---- 1. FIRST read: must not serve, must record the hash ----
const r1 = runHook(payload());
const s1 = readSess();
t('first read does not serve', !/MemBridge/.test(r1.out), r1.out.slice(0, 120));
t('first read RECORDS the read-time hash', s1 && s1.reads && typeof s1.reads[REL] === 'string',
  JSON.stringify(s1));

// ---- 2. SECOND read, file untouched: must serve Tier A ----
const r2 = runHook(payload());
t('second read SERVES Tier A end to end', /already read/.test(r2.out), r2.out.slice(0, 200));

// ---- 3. file EDITED between reads: must NOT claim unchanged ----
fs.writeFileSync(ABS, `${body}\n// edited\n`);
const r3 = runHook(payload());
t('after an edit it does NOT claim unchanged', !/already read/.test(r3.out), r3.out.slice(0, 200));
const s3 = readSess();
t('the edit updates the recorded hash', s3 && s3.reads[REL] !== s1.reads[REL], '');

// ---- 4. and then serves again once the new content is the read one ----
const r4 = runHook(payload());
t('serves again after the new content is what was read', /already read/.test(r4.out), r4.out.slice(0, 200));

// ---- 5. UPGRADE PATH: a pre-REV-4 session file has no `reads` map ----
const S2 = '99999999-8888-7777-6666-555555555555';
fs.mkdirSync(path.join(PROJ, '.membridge', 'recall', 'sessions'), { recursive: true });
fs.writeFileSync(path.join(PROJ, '.membridge', 'recall', 'sessions', `${S2}.json`),
  JSON.stringify({ served: {}, interceptions: 0 })); // the old shape, exactly
fs.writeFileSync(path.join(PROJ, '.membridge', 'ledger.json'), JSON.stringify({
  version: 5, sessions: 1, requests: 1, volume: 1, reads: {}, hotPaths: [],
  fileReaders: { [REL]: { sessions: [S2], reads: 1, lastTs: new Date().toISOString() } },
}));
const p2 = () => ({ session_id: S2, cwd: PROJ, tool_name: 'Read', tool_input: { file_path: ABS } });
const u1 = runHook(p2());
t('upgrade: pre-REV-4 session does not serve on its first read', !/already read/.test(u1.out), u1.out.slice(0, 160));
const us = JSON.parse(fs.readFileSync(path.join(PROJ, '.membridge', 'recall', 'sessions', `${S2}.json`), 'utf8'));
t('upgrade: it STARTS recording without needing a fresh install', us.reads && us.reads[REL], JSON.stringify(us));
const u2 = runHook(p2());
t('upgrade: the very next read serves Tier A', /already read/.test(u2.out), u2.out.slice(0, 200));

let pass = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `\n        ${detail}`}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${results.length}`);
console.log('\n--- actual Tier A output served by the real hook ---');
console.log(r2.out.trim().slice(0, 400) || '(none)');
fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(pass === results.length ? 0 : 1);
