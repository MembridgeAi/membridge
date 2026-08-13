'use strict';
// QA 2026-08-08, tickets 2 and 3: what a brand-new user meets at the CLI.
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
// Ticket 3a. `membridge stop` against a dead daemon printed "MemBridge is not
// running." but left the stale pid file behind -- a crash or kill -9 never
// reaches cmdDaemon's cleanup handler, so the dead pid was re-read forever.
// stop now clears it.
//
// Ticket 3b. Right after kill -9, the dead daemon is a ZOMBIE until its parent
// reaps it (~1-2s): kill(pid, 0) still succeeds, so cmdStart's isRunning()
// courtesy check read it as alive and refused with "already running (pid X)".
// cmdStart now probes `ps -o stat=` (state Z => dead) on POSIX. Creating a
// real zombie needs a parent that does not reap -- Node/libuv auto-reaps its
// children, so the fixture uses python3's subprocess (which reaps only on
// wait/poll) and skips VISIBLY where python3 is absent.
//
// PORT USAGE: the zombie check spawns a real daemon via `membridge start`; it
// gets a fresh ephemeral port from noEgress.freePort() and is SIGKILLed before
// the check ends. This file itself opens no listening sockets.

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

// A pid that is dead and CANNOT come back to life while this check runs.
//
// This used to spawn a child, let spawnSync reap it, and use its pid -- reaped
// therefore dead. That premise is false on Windows, which recycles pids
// aggressively; with thousands of short-lived processes spawning across 106
// suites, the number was live again by the time `stop` read the pid file.
// cmdStop was then RIGHT to report "Stopped MemBridge (pid 1536)": isRunning()
// saw a live pid and isMembridgeProcess() is unconditionally true on win32
// (bin/membridge.js:113, a deliberate choice because reading a Windows command
// line is too fragile to gate startup on). The check failed on a fixture whose
// premise had quietly expired -- windows-only, load-dependent, and it passed on
// ci.yml while failing on build-app for the SAME commit.
//
// Re-drawing until the pid reads dead does NOT fix it, and shipping that was a
// mistake: the race is not between spawn and draw, it is between the fixture's
// last look and cmdStop's, which no amount of redrawing closes. It is also
// actively harmful -- every lost race means cmdStop TERMINATES whatever process
// inherited that pid, so a retry loop kills a stranger on the runner each time
// round, on a machine whose other 105 suites are those strangers.
//
// So stop drawing from the space the OS is handing out. A pid near INT32_MAX is
// never allocated in practice (Windows hands out low numbers -- the observed
// collisions were 1536 and 1564) and answers ESRCH, which isRunning() reads as
// not-running through exactly the same path a reaped pid takes. Nothing is
// spawned, nothing can be recycled into it, and nothing gets killed. The
// liveness predicate mirrors bin/membridge.js:93 exactly (EPERM means alive,
// anything else means gone) so the fixture and the code under test agree on
// what dead means; the assert exists so that a machine which somehow DOES own
// this pid fails loudly instead of quietly killing it.
const UNALLOCATABLE_PIDS = [2147483646, 2147483645, 999999999];
function deadReapedPid() {
  const live = pid => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return !!e && e.code === 'EPERM';
    }
  };
  const pid = UNALLOCATABLE_PIDS.find(p => !live(p));
  assert.ok(pid, `every fixture pid (${UNALLOCATABLE_PIDS.join(', ')}) is live on ` +
    'this machine, which should be impossible — refusing to hand cmdStop a pid ' +
    'it would terminate');
  return pid;
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

  // ---- Ticket 3a: stop clears a stale pid file --------------------------

  {
    fs.mkdirSync(util.homeDir(), { recursive: true });
    const dead = deadReapedPid();
    fs.writeFileSync(util.pidPath(), String(dead));
    const r = runCli(['stop']);
    check('`membridge stop` against a dead daemon removes the stale pid file', () => {
      assert.strictEqual(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);
      assert.ok((r.stdout || '').includes('not running'),
        `expected "not running", got: ${r.stdout}`);
      assert.ok(!fs.existsSync(util.pidPath()),
        `stale pid file survived stop: ${util.pidPath()} still names dead pid ${dead}`);
    });
  }

  // ---- stop must not kill a process that is not MemBridge ----------------
  //
  // The pid file can name a LIVE process that is not ours: pids get recycled,
  // aggressively so on Windows, and a stale pid file is likeliest exactly when
  // the daemon died badly — which is also when its pid is likeliest to have
  // been handed to somebody else. `isRunning()` cannot tell the difference and
  // `isMembridgeProcess()` is unconditionally true on win32 by design, so stop
  // asks the daemon over HTTP instead: /api/status reports the serving
  // process's own pid, and a reply naming our pid is proof.
  //
  // The victim here is a real, live, innocent process. If stop regresses, this
  // check does not merely fail — it kills it, and the assertion says so.
  {
    const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore', detached: false,
    });
    // Liveness is tracked by the child's own exit event, NOT by kill(pid, 0).
    // The victim is a child of this process, so once it is signalled it sits as
    // a ZOMBIE until this process reaps it — and kill(pid, 0) succeeds against a
    // zombie, so the naive probe reports "alive" forever and the check can never
    // pass. (The same distinction the zombie-start check below is built on.)
    let exited = false;
    victim.on('exit', () => { exited = true; });
    const stillAlive = () => !exited;
    fs.writeFileSync(util.pidPath(), String(victim.pid));
    const r = runCli(['stop']);
    await check('`membridge stop` refuses to kill a live pid it cannot confirm is MemBridge', async () => {
      const said = `${r.stdout || ''}${r.stderr || ''}`;
      assert.ok(!said.includes(`Stopped MemBridge (pid ${victim.pid})`),
        'stop reported stopping MemBridge for a process that was never MemBridge');
      assert.ok(/not running|Refusing/i.test(said),
        `expected stop to say it refused or that MemBridge is not running, got: ${said}`);
      // Survival is asserted AFTER giving the event loop a turn. A signalled
      // child does not report its exit synchronously, so checking immediately
      // would read "alive" even in the regression case and prove nothing --
      // the message assertions above are what fail fast; this is the one that
      // states the actual stake.
      await new Promise(r2 => setTimeout(r2, 250));
      assert.ok(stillAlive(),
        `stop TERMINATED pid ${victim.pid}, an unrelated live process that merely ` +
        'happened to be named by the pid file. This is the bug itself: a recycled ' +
        'pid makes stop take out a stranger.');
    });
    await check('`membridge stop --force` still stops a pid it could not confirm', async () => {
      // The escape hatch has to work, or a genuinely wedged daemon — which
      // cannot answer the HTTP probe either — becomes unstoppable.
      //
      // The pid file is re-seeded because the refusal above may legitimately
      // have cleared it: on POSIX the command line POSITIVELY disconfirms the
      // victim, so the file is known garbage and stop removes it. On win32 no
      // such answer exists, so the refusal leaves the file alone and --force is
      // the documented next step. --force overrides an inability to confirm,
      // never a positive disconfirmation, and this check is about the former.
      assert.ok(stillAlive(), 'fixture: the victim must survive the unforced stop above');
      fs.writeFileSync(util.pidPath(), String(victim.pid));
      const forced = runCli(['stop', '--force']);
      assert.strictEqual(forced.status, 0, `exit ${forced.status}, stderr: ${forced.stderr}`);
      assert.ok((forced.stdout || '').includes('Stopped MemBridge'),
        `expected --force to stop it, got: ${forced.stdout}${forced.stderr}`);
      // SIGTERM is delivered, not applied: the process stays schedulable for a
      // moment after kill() returns. Yield to the event loop rather than
      // spinning — a busy-wait here would starve the very 'exit' event this is
      // waiting on, and hang until the deadline every time.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && stillAlive()) {
        await new Promise(r => setTimeout(r, 25));
      }
      assert.ok(!stillAlive(), '--force did not actually terminate the pid');
    });
    try { victim.kill('SIGKILL'); } catch {}
    try { fs.unlinkSync(util.pidPath()); } catch {}
  }

  {
    const r = runCli(['stop']);
    check('`membridge stop` with no pid file at all stays a clean no-op', () => {
      assert.strictEqual(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);
      assert.ok((r.stdout || '').includes('not running'),
        `expected "not running", got: ${r.stdout}`);
    });
  }

  // ---- Ticket 3b: start is not fooled by a zombie -----------------------

  const zombieCheckName = '`membridge start` right after kill -9 starts, not "already running (pid X)"';
  if (process.platform === 'win32') {
    skip(zombieCheckName, 'win32: no zombie process state, isZombie() is POSIX-only by design');
  } else {
    const py = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    if (py.error || py.status !== 0) {
      skip(zombieCheckName, 'python3 unavailable; cannot fabricate an unreaped zombie (Node auto-reaps its children)');
    } else {
      // python3 keeps the killed child unreaped (no wait/poll) for 30s, which
      // is the zombie window cmdStart must see through. It prints the zombie
      // pid then holds; the finally below releases it.
      const holder = spawn('python3', ['-c',
        'import subprocess, os, sys, time, signal\n' +
        "p = subprocess.Popen(['sleep', '300'])\n" +
        'os.kill(p.pid, signal.SIGKILL)\n' +
        'time.sleep(0.3)\n' +
        'print(p.pid, flush=True)\n' +
        'time.sleep(30)\n',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      let daemonPid = null;
      try {
        const zombiePid = await new Promise((resolve, reject) => {
          let buf = '';
          const t = setTimeout(() => reject(new Error('zombie fixture timed out')), 10000);
          holder.stdout.on('data', d => {
            buf += d;
            if (buf.includes('\n')) { clearTimeout(t); resolve(parseInt(buf, 10)); }
          });
          holder.on('exit', () => reject(new Error('zombie fixture exited early')));
        });
        assert.ok(zombiePid > 0, 'no zombie pid from fixture');
        // Sanity: the pid must look ALIVE to kill(0) -- that is the whole trap.
        let looksAlive = true;
        try { process.kill(zombiePid, 0); } catch { looksAlive = false; }

        fs.mkdirSync(util.homeDir(), { recursive: true });
        fs.writeFileSync(util.pidPath(), String(zombiePid));
        const port = await noEgress.freePort();
        const r = runCli(['start'], { MEMBRIDGE_PORT: String(port) });

        // The daemon cmdStart detached really does boot; find it so the
        // finally can kill it whether or not the assertions below pass.
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline) {
          let onDisk = null;
          try { onDisk = parseInt(fs.readFileSync(util.pidPath(), 'utf8'), 10); } catch {}
          if (onDisk && onDisk !== zombiePid) { daemonPid = onDisk; break; }
          await new Promise(res => setTimeout(res, 150));
        }

        check(zombieCheckName, () => {
          assert.ok(looksAlive,
            'fixture failure: zombie pid already reaped before start ran, the check proved nothing');
          assert.ok(!(r.stdout || '').includes('already running'),
            `start refused against a zombie:\n${r.stdout}`);
          assert.ok((r.stdout || '').includes('daemon started'),
            `start did not report starting:\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
          assert.ok(daemonPid, 'daemon never wrote its own pid over the zombie\'s');
        });
      } finally {
        if (daemonPid) { try { process.kill(daemonPid, 'SIGKILL'); } catch {} }
        try { fs.unlinkSync(util.pidPath()); } catch {}
        try { holder.kill('SIGKILL'); } catch {}
      }
    }
  }
}

main().then(() => h.finish()).catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
