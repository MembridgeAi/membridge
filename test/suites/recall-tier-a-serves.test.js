'use strict';
// Tier A must SERVE, through the real hook binary (REV-8).
//
// WHY THIS EXISTS SEPARATELY FROM recall-tier-a-interval.test.js. That suite
// is a table test of tierFor, and it stayed green through the entire period
// Tier A could not fire at all: lib/hooks-recall.js returned on a store miss
// BEFORE hashing the file, so the read-time hash Tier A needs was never
// recorded for any file outside the top-25 warm set, and no second read could
// ever serve. A policy test that calls tierFor directly cannot see that, and
// two further faults hid behind it (decide() building the body from a
// storeEntry that is null on this path, and "already served" keyed on the path
// rather than the content it served).
//
// So this suite crosses the hook binary with real PreToolUse payloads. If Tier
// A ever goes inert again, this is what says so — scripts/prove-tier-a-serves.js
// proves the same thing by hand, but CI runs `node test/run.js`, not scripts/.
//
// Run directly, or via `node test/run.js recall-tier-a-serves`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', '..', 'lib', 'membridge-hook.js');

function main() {
  const util = require('../../lib/util');
  const hooksRecall = require('../../lib/hooks-recall');
  const ledgerStore = require('../../lib/ledger-store');

  const runHook = payload => spawnSync(process.execPath, [HOOK, 'recall'], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env },
  });

  // A tracked scratch project, with the ledger a session's second read arrives
  // in: `sessions` naming this session is the OTHER half of Tier A's evidence
  // (the hash proves WHAT the file looked like; only the ledger proves the read
  // actually happened, since the hook runs BEFORE the read).
  let projN = 0;
  function seed(relPath, content, sessionId, { ledger = true } = {}) {
    const proj = path.join(ROOT, 'projects', `tier-a-${projN++}`);
    fs.mkdirSync(path.join(proj, path.dirname(relPath)), { recursive: true });
    fs.mkdirSync(path.join(proj, '.membridge'), { recursive: true });
    const st = util.loadState();
    util.saveState({ ...st, projects: { ...(st.projects || {}), [proj]: { events: [] } } });
    fs.writeFileSync(path.join(proj, relPath), content);
    if (ledger) {
      ledgerStore.writeLedger(proj, {
        fileReaders: { [relPath]: { sessions: [sessionId], reads: 1, lastTs: 't', firstTs: 't', firstSession: sessionId } },
      });
    }
    return proj;
  }
  const readOf = (proj, sessionId, relPath) => runHook({
    session_id: sessionId, cwd: proj, tool_name: 'Read',
    tool_input: { file_path: path.join(proj, relPath) },
  });
  const sessionRecord = (proj, sessionId) => {
    try { return JSON.parse(fs.readFileSync(hooksRecall.sessionStatePath(proj, sessionId), 'utf8')); } catch { return null; }
  };
  // Must clear MIN_CALL_TOKENS (400 tokens ≈ 1600 bytes) or no tier applies.
  const body = n => Array.from({ length: 140 }, (_, i) => `function ${n}${i}() { return ${i}; }`).join('\n');

  // ---- 1. The bootstrap: the read that CANNOT be served records the proof ----
  {
    const REL = 'lib/payroll.js';
    const SESSION = 'aaaaaaaa-1111-2222-3333-444444444444';
    const proj = seed(REL, body('step'), SESSION);

    const first = readOf(proj, SESSION, REL);
    check('a first read does not serve, and records the read-time hash', () => {
      assert.strictEqual(first.status, 0, first.stderr);
      assert.strictEqual(first.stdout, '', 'nothing may be served before there is any evidence to serve it on');
      const rec = sessionRecord(proj, SESSION);
      assert.ok(rec && rec.reads && typeof rec.reads[REL] === 'string',
        `no read-time hash recorded, so no later read can ever serve Tier A: ${JSON.stringify(rec)}`);
    });

    const second = readOf(proj, SESSION, REL);
    check('the second read of unchanged content SERVES Tier A through the real hook', () => {
      assert.strictEqual(second.status, 0, second.stderr);
      assert.ok(second.stdout, 'the hook stepped aside on a read it had all the evidence to answer');
      const out = JSON.parse(second.stdout).hookSpecificOutput;
      assert.strictEqual(out.permissionDecision, 'deny');
      assert.ok(/already read/.test(out.permissionDecisionReason), out.permissionDecisionReason);
      const hash = sessionRecord(proj, SESSION).reads[REL];
      assert.ok(out.permissionDecisionReason.includes(hash.slice(0, 8)),
        `Tier A must quote the hash it proved: ${out.permissionDecisionReason}`);
    });
  }

  // ---- 2. Edited between the reads: never claim "unchanged since" ----
  {
    const REL = 'lib/edited.js';
    const SESSION = 'bbbbbbbb-1111-2222-3333-444444444444';
    const proj = seed(REL, body('alpha'), SESSION);
    readOf(proj, SESSION, REL);
    const before = sessionRecord(proj, SESSION).reads[REL];
    fs.writeFileSync(path.join(proj, REL), `${body('alpha')}\n// edited\n`);
    const after = readOf(proj, SESSION, REL);
    check('a file edited between the two reads is never called unchanged', () => {
      assert.strictEqual(after.stdout, '',
        `Tier A claimed "unchanged since" about a file that changed after the read: ${after.stdout}`);
      assert.notStrictEqual(sessionRecord(proj, SESSION).reads[REL], before,
        'the recorded hash must follow the file, or the session is stuck proving something about old bytes');
    });
    const third = readOf(proj, SESSION, REL);
    check('...and it serves again once the NEW content is what was read', () => {
      assert.ok(/already read/.test(third.stdout || ''),
        'a serve for one version of a file must not silence the next one — that is a different claim');
    });
  }

  // ---- 3. The guard: an oversized file is never hashed, and fails CLOSED ----
  // The hash is the most expensive thing the hook does (~1.4ms of CPU per MB),
  // and it sits in front of every Read. Above MAX_HASH_BYTES nothing is
  // recorded, so Tier A simply never fires for that file — silence, never a
  // claim made on evidence that was not gathered.
  {
    const REL = 'lib/huge.js';
    const SESSION = 'cccccccc-1111-2222-3333-444444444444';
    const line = 'const padding = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";\n';
    const huge = line.repeat(Math.ceil((5 * 1024 * 1024) / line.length)); // > 4MiB cap
    const proj = seed(REL, huge, SESSION);
    const first = readOf(proj, SESSION, REL);
    const second = readOf(proj, SESSION, REL);
    check('a file over the hash cap records nothing and never serves', () => {
      assert.strictEqual(first.status, 0, first.stderr);
      assert.strictEqual(second.stdout, '', 'an oversized file was served from evidence the hook never gathered');
      const rec = sessionRecord(proj, SESSION);
      assert.ok(!rec || !rec.reads || !rec.reads[REL],
        `the cap did not hold — an unbounded hash is back on the critical path of every read: ${JSON.stringify(rec)}`);
    });
  }

  // ---- 4. COUNTER: a file just under the cap is unaffected ----
  // A cap that quietly swallowed ordinary files would be "correctness by
  // silence", which is the failure mode this whole line of work exists to stop.
  {
    const REL = 'lib/big-but-fine.js';
    const SESSION = 'dddddddd-1111-2222-3333-444444444444';
    const line = 'const padding = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";\n';
    const big = line.repeat(Math.floor((3 * 1024 * 1024) / line.length)); // < 4MiB cap
    const proj = seed(REL, big, SESSION);
    readOf(proj, SESSION, REL);
    const second = readOf(proj, SESSION, REL);
    check('COUNTER: a large file UNDER the cap still bootstraps and serves', () => {
      assert.ok(/already read/.test(second.stdout || ''),
        'the cap is swallowing ordinary files — Tier A stopped serving for a file it can prove');
    });
  }

  // ---- 5. Unreadable content is a SILENT step-aside, not a logged error ----
  // stat() succeeds, the read of the content does not (a permissions bit, or a
  // race with a delete). Now that a store miss reaches the hash at all, letting
  // this fall through to the outer fail-open would file an ordinary condition
  // as 'hook recall error' in the user's log on every read of that file.
  {
    const REL = 'lib/unreadable.js';
    const SESSION = 'eeeeeeee-1111-2222-3333-444444444444';
    const proj = seed(REL, body('locked'), SESSION);
    const abs = path.join(proj, REL);
    fs.chmodSync(abs, 0o000);
    const logBefore = fs.existsSync(util.logPath()) ? fs.readFileSync(util.logPath(), 'utf8') : '';
    const out = readOf(proj, SESSION, REL);
    const logAfter = fs.existsSync(util.logPath()) ? fs.readFileSync(util.logPath(), 'utf8') : '';
    fs.chmodSync(abs, 0o644);
    check('an unreadable file steps aside quietly, with no error line in the log', () => {
      assert.strictEqual(out.status, 0, out.stderr);
      assert.strictEqual(out.stdout, '');
      // A root-run suite cannot enforce chmod, so this passes vacuously there
      // (same caveat as the M5 check in run-tests.js).
      assert.ok(!logAfter.slice(logBefore.length).includes('hook recall error'),
        'an ordinary unreadable file was filed as an internal hook error, on every read of it');
    });
  }

  // ---- 6. Recall off means nothing is recorded at all ----
  // The off switch has to stay free: with recall disabled for a solo project
  // there is no serve to prepare for, so the hook must not pay the hash or the
  // write to prepare for one.
  {
    const REL = 'lib/off.js';
    const SESSION = 'ffffffff-1111-2222-3333-444444444444';
    const proj = seed(REL, body('off'), SESSION);
    const cfgPath = path.join(process.env.MEMBRIDGE_HOME, 'config.json');
    const before = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : null;
    const cfg = before ? JSON.parse(before) : {};
    fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, recall: { ...(cfg.recall || {}), enabled: false } }));
    readOf(proj, SESSION, REL);
    const rec = sessionRecord(proj, SESSION);
    if (before === null) fs.unlinkSync(cfgPath); else fs.writeFileSync(cfgPath, before);
    check('recall disabled records no read hash — the off switch costs nothing', () => {
      assert.strictEqual(rec, null, `a disabled feature still wrote per-read state: ${JSON.stringify(rec)}`);
    });
  }

  h.finish();
}

main();
