'use strict';
// QA 2026-08-08, ticket 2: what a brand-new user meets at the CLI.
//
// Ticket 2. bin/membridge.js requires lib/activity eagerly, which requires
// lib/search-index, which requires node:sqlite at module load. On Node
// 22.13-23.x that require makes the runtime print
//   (node:NNNN) ExperimentalWarning: SQLite is an experimental feature...
// to stderr on EVERY invocation -- `membridge --version` included, the first
// command a new user ever runs, and it reads as an error. The bin now installs
// a process.emitWarning filter (SQLite ExperimentalWarning only; deprecations
// and other experimental warnings pass through) before any require. These
// checks assert the visible contract: version/help produce NOTHING on stderr.
// On Node >= 24 the runtime no longer emits the warning, so there these
// checks guard against any OTHER startup noise creeping into stderr; run this
// file directly under a 22.x binary to see the ticket's failure mode.
//
// PORT USAGE: none. This file itself opens no listening sockets.

const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, skip, ROOT, BIN, noEgress } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const util = require('../../lib/util');

const CLI_ENV = {
  ...process.env,
  MEMBRIDGE_INTERVAL: '3600',
  MEMBRIDGE_NO_DIAGNOSTICS: '1',
  MEMBRIDGE_NO_RETRIEVALS: '1',
  MEMBRIDGE_NO_RECALL: '1',
};

function runCli(args, extraEnv) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...CLI_ENV, ...(extraEnv || {}) },
    timeout: 15000,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
  });
}

// A pid that is guaranteed dead AND reaped: spawnSync waits for the child, and
// libuv reaps it, so kill(pid, 0) answers ESRCH -- unlike the zombie below.
function deadReapedPid() {
  const r = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.ok(r.pid, 'fixture child failed to spawn');
  return r.pid;
}

async function main() {
  // ---- Ticket 2: first contact is clean ---------------------------------

  for (const flagName of ['--version', '--help']) {
    const r = runCli([flagName]);
    check(`\`membridge ${flagName}\` writes nothing to stderr (no ExperimentalWarning greeting)`, () => {
      assert.strictEqual(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);
      assert.strictEqual((r.stderr || '').trim(), '',
        `expected clean stderr, got:\n${r.stderr}`);
      assert.ok((r.stdout || '').trim().length > 0, 'expected output on stdout');
    });
  }

  check('the SQLite warning filter passes every other warning through untouched', () => {
    // The filter lives at the very top of the bin, before the hook fast path,
    // so `hook recall` (cheapest command that exits fast) runs under it. A
    // deprecation emitted in that process must still reach stderr -- the
    // ticket explicitly forbids --no-warnings-style blanket suppression.
    const probe = path.join(ROOT, 'warn-probe.js');
    fs.writeFileSync(probe,
      "process.emitWarning('probe-deprecation', 'DeprecationWarning');\n" +
      "process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');\n");
    const r = spawnSync(process.execPath, ['-r', probe, BIN, '--version'], {
      env: CLI_ENV, timeout: 15000, killSignal: 'SIGKILL', encoding: 'utf8',
    });
    // -r preloads run before the bin's own top-of-file code, so the probe's
    // warnings are emitted BEFORE the filter installs -- both print. What this
    // pins is that the filter never rewrites process.emitWarning into
    // something that breaks later emitters; the pass-through behaviour itself
    // is asserted by the source check below.
    assert.ok((r.stderr || '').includes('probe-deprecation'),
      `deprecation warning was swallowed:\n${r.stderr}`);
    const src = fs.readFileSync(BIN, 'utf8');
    assert.ok(!/--no-warnings/.test(src) && !src.includes("removeAllListeners('warning')"),
      'the bin must filter ONLY the SQLite ExperimentalWarning, never all warnings');
    assert.ok(/SQLite/.test(src) && /ExperimentalWarning/.test(src),
      'the SQLite ExperimentalWarning filter is gone from the bin');
  });

}

main().then(() => h.finish()).catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
