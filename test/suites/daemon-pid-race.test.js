'use strict';
// Alpha Task 4: kill the duplicate-daemon pid race.
//
// Today `cmdDaemon` (bin/membridge.js) unconditionally writes its own pid to
// membridge.pid before doing anything else. A second `membridge daemon` started
// while the first is alive silently overwrites the marker; both keep running,
// both scribble state.json (which has NO locking -- MEMORY
// state-json-cross-process-clobber), and only one is ever cleaned up by
// SIGTERM. The characteristic bug shape of this codebase: a flag recording a
// success the code never achieved (MEMORY state-claiming-unearned-success).
//
// This suite plants a pid file pointing at an alive-and-really-MemBridge
// process, invokes the daemon start path, and asserts the pid file was NOT
// overwritten and the second daemon exited non-zero with a message that names
// the existing pid.
//
// PORT USAGE: the daemon subprocess spawned here will try to bind its
// dashboard. To keep it off shared ports, MEMBRIDGE_PORT is set to a fresh
// ephemeral port (noEgress.freePort()) per run rather than a P(N) block --
// no other test binds an ephemeral, so no cross-suite collision is possible.
// This file itself opens NO listening sockets, so it needs no P(N) offset.
// (harness.js keeper on PORT_BASE+99 is unaffected.)

const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, skip, ROOT, BIN, noEgress } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const util = require('../../lib/util');

// Wait for the pid file to appear (in the RED state we expect it to be
// overwritten by the second daemon; in GREEN it stays the seeded pid).
function readPidFile() {
  try { return fs.readFileSync(util.pidPath(), 'utf8').trim(); } catch { return null; }
}

async function main() {
  // WINDOWS: the guard this suite proves is gated OFF on win32 in cmdDaemon --
  // its liveness/refusal path hangs daemon startup on the Windows CI runner
  // (second `membridge daemon`: empty output, pid never overwritten, killed at
  // the 4s timeout with status=null), which is worse than no guard. Tracked in
  // task #34 for a Windows-observed fix. There is nothing to refuse here, so the
  // three behavioural checks below cannot run; skip them VISIBLY (never a silent
  // green) and instead pin the gate itself -- if it is removed before #34 lands
  // a verified guard, Windows startup can hang again and this goes red.
  if (process.platform === 'win32') {
    skip('a second `membridge daemon` does not overwrite the running daemon\'s pid file',
      'win32: duplicate-daemon guard gated to POSIX until task #34');
    skip('a second `membridge daemon` exits non-zero when one is already running',
      'win32: duplicate-daemon guard gated to POSIX until task #34');
    skip('a second `membridge daemon` names the running pid in its refusal message',
      'win32: duplicate-daemon guard gated to POSIX until task #34');
    check('cmdDaemon gates the duplicate-daemon guard off on win32 (task #34)', () => {
      const src = fs.readFileSync(BIN, 'utf8');
      assert.ok(/platform\s*!==\s*'win32'/.test(src),
        'the win32 gate around the duplicate-daemon refusal is gone -- Windows daemon '
        + 'startup can hang again until task #34 lands a Windows-verified guard');
    });
    return; // the bottom `main().then(() => h.finish())` tallies and exits
  }

  // 1. Fake-MemBridge fixture. `ps -o command= -p <pid>` on macOS and Linux
  //    reports the command line as invoked; a script whose FILENAME contains
  //    "membridge" is enough to satisfy the guard's /membridge/i check --
  //    and mirrors what a real `node /path/bin/membridge.js daemon` looks
  //    like to ps. Kept alive with a plain setInterval so nothing besides
  //    the process itself is exercised.
  const fakeDir = path.join(ROOT, 'fake');
  fs.mkdirSync(fakeDir, { recursive: true });
  const fakePath = path.join(fakeDir, 'fake-membridge.js');
  fs.writeFileSync(fakePath, "setInterval(() => {}, 1000);\n");
  const fake = spawn(process.execPath, [fakePath], { stdio: 'ignore' });
  assert.ok(fake.pid, 'fake process failed to spawn');

  try {
    // Give the OS a beat to register the pid so isRunning(pid) will see it.
    await new Promise(r => setTimeout(r, 150));

    // 2. Plant the fake pid in the real pid path. This is what a first,
    //    running daemon would have left behind.
    fs.mkdirSync(util.homeDir(), { recursive: true });
    fs.writeFileSync(util.pidPath(), String(fake.pid));
    const seededPid = String(fake.pid);

    // 3. Spawn the second daemon. Give it an isolated dashboard port so it
    //    cannot collide with the user's real daemon or another suite; keep
    //    the interval huge so if the guard fails and it starts syncing, it
    //    does not thrash the fixture. Kill after a short timeout with
    //    SIGKILL so the daemon's cleanup handler cannot delete evidence of
    //    the overwrite -- SIGTERM would trigger cleanup, whose
    //    readPid()===process.pid guard would unlink the pid file it had
    //    just clobbered, hiding the exact defect this suite is proving.
    const dashboardPort = await noEgress.freePort();
    const child = spawnSync(process.execPath, [BIN, 'daemon'], {
      env: {
        ...process.env,
        MEMBRIDGE_PORT: String(dashboardPort),
        MEMBRIDGE_INTERVAL: '3600',
        MEMBRIDGE_NO_DIAGNOSTICS: '1',
        MEMBRIDGE_NO_RETRIEVALS: '1',
        MEMBRIDGE_NO_RECALL: '1',
      },
      timeout: 4000,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
    });

    const pidAfter = readPidFile();
    const combinedOutput = `${child.stdout || ''}\n${child.stderr || ''}`;

    check('a second `membridge daemon` does not overwrite the running daemon\'s pid file', () => {
      assert.strictEqual(pidAfter, seededPid,
        `pid file was overwritten (or unlinked): seeded=${seededPid}, after=${pidAfter}\n` +
        `stdout: ${child.stdout || '(empty)'}\nstderr: ${child.stderr || '(empty)'}`);
    });

    check('a second `membridge daemon` exits non-zero when one is already running', () => {
      // spawnSync sets .status = null when killed by signal. Non-null + non-zero
      // status is the intended clean exit; null status is a REGRESSION here --
      // it means the daemon ran until we killed it.
      assert.ok(child.status !== null && child.status !== 0,
        `second daemon did not exit cleanly non-zero (status=${child.status}, signal=${child.signal})\n` +
        `stdout: ${child.stdout || '(empty)'}\nstderr: ${child.stderr || '(empty)'}`);
    });

    check('a second `membridge daemon` names the running pid in its refusal message', () => {
      assert.ok(combinedOutput.includes(seededPid),
        `second daemon's output did not mention existing pid ${seededPid}\n` +
        `output: ${combinedOutput}`);
    });
  } finally {
    try { fake.kill('SIGKILL'); } catch {}
  }
}

main().then(() => h.finish()).catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
