'use strict';
// Decide whether a failing test is a REAL failure or a load artifact.
//
// This repo's suites have a documented phantom-failure mode: Testing Library's
// findBy*/waitFor run on their own asyncUtilTimeout, and any wall-clock or
// scheduler-sensitive assertion can trip purely because the machine was busy.
// A test that fails while six other things are compiling says nothing about
// the code. That is a nuisance for a human and a trap for an agent, which will
// happily "fix" working code to make an imaginary failure go away.
//
// So: no test failure counts as a bug until it reproduces ALONE, on a quiet
// machine, more than once. This script is the gate that enforces that. It
// serializes itself against every other copy of itself (one global lock, so
// parallel agents cannot verify at the same time and re-create the very
// contention they are trying to rule out), waits for system load to settle,
// re-runs the target in isolation N times, and prints a verdict.
//
// THE ONE CASE THE VERDICT CANNOT SEE (#77). A PHANTOM verdict means "the
// test passed N times in isolation on a quiet machine, so the failure was
// load contention". That inference holds when the test's failure mode is
// scheduler starvation. It does NOT hold when the test READS A FILE THE OS
// KEEPS REWRITING ON ITS OWN CADENCE (mcp-wiring's snapshot of the
// developer's real ~/.claude.json is the observed case): those failures
// cluster under load because that is when live sessions run, not because of
// scheduler contention, and in 3 quiet-machine runs the external writer may
// simply not have fired.
//
// Widening this script to detect that case was considered and rejected. Two
// reasons: the script does not know which files a test might read, and
// speculatively snapshotting the whole home dir is expensive and imprecise.
// Instead the responsibility sits with the TEST AUTHOR:
// test/suites/tests-own-their-state.test.js audits every test file that
// mentions os.homedir() and forces an in-file marker declaring intent -- so
// an author writing "this test reads a real user file" is forced to write
// down "who else writes to it, and why owning it is not an option" before
// the check goes green. The gate stays narrow; the ownership question moves
// to authoring time.
//
//   node scripts/verify-finding.js --ui <testFile> [--name "<test name>"]
//   node scripts/verify-finding.js --suite <suiteName>
//   (optional: --runs <n>, default 3)
//
// Exit codes are the contract -- they are what an agent should branch on:
//   0  CONFIRMED  failed every run in isolation. Real. File it.
//   3  PHANTOM    passed in isolation. Load artifact. Do NOT file it.
//   4  FLAKY      inconsistent across identical isolated runs. Needs a human.
//   4  UNVERIFIED passed here, but --origin names a platform this host is not.
//                 Shares FLAKY's exit because it shares FLAKY's remedy: a
//                 human decides. It is NOT a PHANTOM -- see below.
//
// THE SECOND CASE THE VERDICT CANNOT SEE: A FAILURE FROM ANOTHER PLATFORM.
// PHANTOM asserts a cause ("the failure was machine load") and tells the
// reader to drop the finding. That is only available if this host could have
// reproduced the failure at all. A Mac cannot reproduce Windows process-spawn
// latency at any load level, so green runs here say nothing about a
// windows-latest failure. Observed for real: a Windows-only CI failure was
// verified on a Mac, returned "PHANTOM ... Do NOT file it", and the finding
// was a genuine fixture race that was pre-existing on master.
//
// Left unguarded, that is a definitive success marker written on a path where
// the work did not happen -- this repo's characteristic bug, inside the tool
// built to protect against it. Pass --origin <platform> whenever the failure
// came from CI rather than from this machine.
//   1  ERROR      bad usage, or the runner itself could not execute.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const LOCK_PATH = path.join(os.tmpdir(), 'membridge-verify-finding.lock');

const DEFAULT_RUNS = 3;
// Load average per core above which the machine is considered too busy for a
// verdict to mean anything. 0.6 leaves headroom for the run itself.
const QUIET_LOAD_PER_CORE = 0.6;
const LOAD_POLL_MS = 3000;
const MAX_QUIET_WAIT_MS = 5 * 60 * 1000;
// A lock whose owner died leaves the file behind; treat one this old as stale.
const STALE_LOCK_MS = 20 * 60 * 1000;
const LOCK_POLL_MS = 5000;
const MAX_LOCK_WAIT_MS = 30 * 60 * 1000;

const EXIT = { CONFIRMED: 0, ERROR: 1, PHANTOM: 3, FLAKY: 4 };

function parseArgs(argv) {
  const args = { runs: DEFAULT_RUNS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--ui') { args.ui = value; i += 1; }
    else if (flag === '--suite') { args.suite = value; i += 1; }
    else if (flag === '--name') { args.name = value; i += 1; }
    else if (flag === '--runs') { args.runs = Number(value); i += 1; }
    // The platform the ORIGINAL failure was observed on, as process.platform
    // spells it ('win32', 'darwin', 'linux'). Supply it whenever the failure
    // came from CI rather than from this machine; it is what stops a green
    // local run being reported as PHANTOM for a failure this host could never
    // have reproduced.
    else if (flag === '--origin') { args.origin = value; i += 1; }
  }
  return args;
}

function usage(message) {
  process.stderr.write(`${message}\n\n`);
  process.stderr.write('  node scripts/verify-finding.js --ui <testFile> [--name "<test name>"] [--runs N]\n');
  process.stderr.write('  node scripts/verify-finding.js --suite <suiteName> [--runs N]\n');
  process.exit(EXIT.ERROR);
}

function sleepSync(ms) {
  // Deliberately synchronous: this script is a gate, it has nothing to do
  // while it waits, and staying sync keeps the lock/run/unlock path linear.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function loadPerCore() {
  return os.loadavg()[0] / os.cpus().length;
}

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function isLockStale(lock) {
  if (!lock || typeof lock.startedAt !== 'number') return true;
  if (Date.now() - lock.startedAt > STALE_LOCK_MS) return true;
  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(lock.pid, 0);
    return false;
  } catch {
    return true;
  }
}

function acquireLock(label) {
  const deadline = Date.now() + MAX_LOCK_WAIT_MS;
  for (;;) {
    try {
      const payload = JSON.stringify({ pid: process.pid, label, startedAt: Date.now() });
      fs.writeFileSync(LOCK_PATH, payload, { flag: 'wx' });
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const held = readLock();
      if (isLockStale(held)) {
        log(`clearing stale lock from pid ${held ? held.pid : 'unknown'}`);
        try { fs.unlinkSync(LOCK_PATH); } catch { /* another waiter won the race */ }
        continue;
      }
      if (Date.now() > deadline) {
        fail(`another verification (pid ${held.pid}, "${held.label}") has held the lock for too long`);
      }
      log(`waiting for pid ${held.pid} to finish verifying "${held.label}"`);
      sleepSync(LOCK_POLL_MS);
    }
  }
}

function releaseLock() {
  const held = readLock();
  // Only clear our own lock -- if it is stale-collected and retaken by another
  // process, deleting it here would let two verifications run at once.
  if (held && held.pid === process.pid) {
    try { fs.unlinkSync(LOCK_PATH); } catch { /* already gone */ }
  }
}

function waitForQuiet() {
  const deadline = Date.now() + MAX_QUIET_WAIT_MS;
  let load = loadPerCore();
  while (load > QUIET_LOAD_PER_CORE && Date.now() < deadline) {
    log(`load ${load.toFixed(2)}/core is above ${QUIET_LOAD_PER_CORE} -- waiting for the machine to settle`);
    sleepSync(LOAD_POLL_MS);
    load = loadPerCore();
  }
  if (load > QUIET_LOAD_PER_CORE) {
    log(`WARNING: still ${load.toFixed(2)}/core after waiting. Verdict is lower confidence.`);
  }
  return load;
}

function buildCommand(args) {
  if (args.ui) {
    const argv = ['vitest', 'run', args.ui, '--pool=threads'];
    if (args.name) argv.push('-t', args.name);
    return { cmd: 'npx', argv, cwd: path.join(REPO_ROOT, 'ui') };
  }
  return { cmd: 'node', argv: ['test/run.js', args.suite], cwd: REPO_ROOT };
}

function runOnce({ cmd, argv, cwd }) {
  const result = spawnSync(cmd, argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) fail(`could not run ${cmd}: ${result.error.message}`);
  return { passed: result.status === 0, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function log(message) {
  process.stderr.write(`[verify] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[verify] ERROR: ${message}\n`);
  releaseLock();
  process.exit(EXIT.ERROR);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ui && !args.suite) usage('Nothing to verify: pass --ui <testFile> or --suite <suiteName>.');
  if (args.ui && args.suite) usage('Pass either --ui or --suite, not both.');
  if (!Number.isInteger(args.runs) || args.runs < 2) {
    usage('--runs must be an integer >= 2; a single run cannot distinguish a real failure from a flake.');
  }

  const label = args.ui ? `${args.ui}${args.name ? ` -t ${args.name}` : ''}` : `suite:${args.suite}`;
  const command = buildCommand(args);

  acquireLock(label);
  process.on('exit', releaseLock);

  try {
    const load = waitForQuiet();
    log(`verifying "${label}" -- ${args.runs} isolated runs at ${load.toFixed(2)} load/core`);

    const results = [];
    for (let run = 1; run <= args.runs; run += 1) {
      const { passed, output } = runOnce(command);
      results.push({ passed, output });
      log(`  run ${run}/${args.runs}: ${passed ? 'passed' : 'FAILED'}`);
    }

    const failures = results.filter(r => !r.passed);
    process.stdout.write('\n');

    if (failures.length === args.runs) {
      process.stdout.write(`VERDICT: CONFIRMED -- failed all ${args.runs} isolated runs. This is a real bug.\n\n`);
      process.stdout.write(`${failures[0].output.trim()}\n`);
      process.exit(EXIT.CONFIRMED);
    }
    if (failures.length === 0) {
      // PHANTOM asserts a CAUSE -- "the failure was machine load" -- and tells
      // the reader to drop the finding. That inference is only available when
      // this host could have reproduced the original failure in the first
      // place. If the failure came from another platform, N green runs here
      // establish nothing about it: a macOS host cannot reproduce Windows
      // process-spawn latency at any load level, so the tool would be
      // certifying a measurement it never took.
      //
      // That is this repo's characteristic bug -- a success marker written on
      // a path where the work did not happen -- inside the tool built to
      // protect against it. Observed: a Windows-only CI failure verified on a
      // Mac returned "PHANTOM ... Do NOT file it", for a real fixture race
      // that was pre-existing on master and needed fixing.
      //
      // Exits FLAKY rather than PHANTOM, because the ACTION is FLAKY's -- a
      // human decides -- and because silently downgrading to "drop it" is the
      // failure being prevented. Pass --origin <platform> when verifying a
      // failure seen elsewhere; omit it for a local failure and PHANTOM still
      // renders as before.
      if (args.origin && args.origin !== process.platform) {
        process.stdout.write(`VERDICT: UNVERIFIED -- passed all ${args.runs} isolated runs on ${process.platform}, `
          + `but the original failure was on ${args.origin}.\n`);
        process.stdout.write('This host cannot exercise that platform, so these runs do not clear the finding '
          + 'and this is NOT a PHANTOM. Escalate to a human, or re-verify on the origin platform.\n');
        process.exit(EXIT.FLAKY);
      }
      process.stdout.write(`VERDICT: PHANTOM -- passed all ${args.runs} isolated runs on ${process.platform}.\n`);
      process.stdout.write('The original failure was machine load, not a defect. Do NOT file it, and do NOT "fix" the code.\n');
      process.stdout.write('This holds only for a failure seen on THIS platform. If it came from CI on another OS, '
        + 're-run with --origin <platform>; these runs do not cover it.\n');
      process.exit(EXIT.PHANTOM);
    }
    process.stdout.write(`VERDICT: FLAKY -- failed ${failures.length} of ${args.runs} identical isolated runs.\n`);
    process.stdout.write('A genuinely nondeterministic test. Escalate to a human; do not guess at a fix.\n\n');
    process.stdout.write(`${failures[0].output.trim()}\n`);
    process.exit(EXIT.FLAKY);
  } finally {
    releaseLock();
  }
}

main();
