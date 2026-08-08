'use strict';
// Orchestrator for the split test suite.
//
//   node test/run.js              run everything: small suites in parallel, then legacy core
//   node test/run.js redaction    run only suites whose name contains "redaction"
//   node test/run.js --list       list suite names and exit
//
// Suites are test/suites/*.test.js plus the legacy monolith test/run-tests.js
// (named "core"). Each runs as its own child process: per-process temp HOME
// and a per-process port block make parallel runs safe.
//
// A child is green ONLY if it exits 0 AND printed the "N/M checks passed"
// tally. A crash after the last check but before the summary would otherwise
// read as success to anything that greps for FAIL — that exact failure shape
// has produced silently-truncated baselines here before.
//
// A crashed suite's check count is UNKNOWN, and the summary says so. It used
// to contribute 0/0 to the totals, which made the footer of a run whose
// largest suite never finished read `TOTAL 451/451 checks passed across 26
// suites` — a green sentence over a truncated run (observed on PR #23, and
// again as `TOTAL 110/110` with SIX of twelve suites dead on node:sqlite).
// Nothing here may print an all-passed tally for a run that did not pass.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

// Assign each child its own verified-free port block up front. Left to itself a
// suite derives its block from its own pid and verifies nothing, and it may not
// bind its first server until minutes in — so two children whose pids map to
// the same block can both adopt it and cross-talk later. (Observed live: a
// redaction team-push check failing only when run next to core.) Assigning from
// one place is what removes the race, so this is the ONLY place a block is
// checked for freeness; the assignment also skips blocks squatted by e.g. a
// live daemon on this machine.
//
// This probe MUST be async. `net.Server#listening` is false synchronously when
// listen() is given a host: `listen(port, '127.0.0.1')` routes through an async
// DNS lookup, so the handle does not exist yet when the next statement runs.
// The earlier synchronous version read `s.listening` immediately and therefore
// answered "busy" for every port on every platform — the generator below
// yielded NOTHING, every child was spawned with no assigned block, and each
// one silently fell back to run-tests.js's `pid % 40` guess, whose own probe is
// broken the same way and so verifies nothing either. Twenty-six children
// drawing an unverified block out of forty is the port cross-talk this file
// claims in its header to have removed. Prove it before believing it:
//   node -e "const s=require('net').createServer();s.listen(17941,'127.0.0.1');console.log(s.listening)"  // false
const PORT_BLOCKS = 40;
function freePort(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    // Loopback only, deliberately: binding 0.0.0.0 would make the probe
    // synchronous but also trip the macOS incoming-connections prompt.
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
async function freeBlocks() {
  const free = [];
  for (let i = 0; i < PORT_BLOCKS; i++) {
    const base = 17900 + i * 100;
    // +99 is the sentinel a live run (this orchestrator's children included)
    // holds for its lifetime — checking it keeps two concurrent invocations,
    // e.g. from two sessions in different worktrees, off each other's blocks.
    // Sequential on purpose: 120 simultaneous binds on one loopback is its own
    // source of spurious EADDRINUSE. The whole sweep costs ~10ms.
    if (await freePort(base + 41) && await freePort(base + 96) && await freePort(base + 99)) free.push(base);
  }
  return free;
}

// A block is owned by ONE RUNNING CHILD AT A TIME — the invariant that
// actually matters, and which counting suites cannot satisfy.
//
// The previous dealer handed out one block per suite for the whole run and
// wrapped with `i % PORT_BLOCKS` when it ran out, while main() spawned every
// parallel suite at once via Promise.all. With 90 suites and 40 blocks that
// guaranteed what this file's header claims to have removed: children i and
// i+40 held the SAME block AND ran simultaneously. Its comment promised "a
// block nobody else in this run holds"; the arithmetic said otherwise, and CI
// showed it — 50 "unverified" warnings with ten bases dealt twice, and
// join-audit and removal-durability timing out waiting for their own daemons
// on all six legs. Master carried the same over-subscription (48 warnings,
// duplicate bases) and was green only because the colliding pairs happened
// not to overlap destructively; ONE added suite was enough to tip it.
//
// So the pool bounds concurrency instead of counting suites: one worker per
// verified-free block, each worker keeping its block for the whole run and
// pulling the next suite when its child exits. Two children never share a
// block because there are never more children than blocks. Suites beyond the
// block count now WAIT rather than collide, which also stops ~90 node
// processes contending on a 2-core runner.
function poolWorkers(free) {
  if (free.length) return free;
  // Nothing verified free (a machine already saturated): fall back to a single
  // unverified block. Serialized and loud, rather than parallel and lying.
  console.log('warning: no verified-free port block available; running suites one at a time on 17900');
  return [17900];
}

// Run `suites` across `blocks` workers, at most one child per block, and
// return results in the suites' original order.
async function runPooled(suites, blocks) {
  const results = new Array(suites.length);
  let next = 0;
  await Promise.all(blocks.map(async block => {
    for (let i = next++; i < suites.length; i = next++) {
      results[i] = await runSuite(suites[i], block);
    }
  }));
  return results;
}

// Overridable so this orchestrator's own reporting can be tested against
// fixture suites that pass, fail and crash on purpose — see
// test/suites/runner-reporting.test.js. With an override in play the legacy
// monolith is NOT appended: a reporting test must not drag in 25k lines.
const SUITE_DIR = process.env.MEMBRIDGE_TEST_SUITE_DIR || path.join(__dirname, 'suites');
const WITH_LEGACY = !process.env.MEMBRIDGE_TEST_SUITE_DIR;
const LEGACY = { name: 'core', file: path.join(__dirname, 'run-tests.js') };

function discover() {
  const suites = [];
  if (fs.existsSync(SUITE_DIR)) {
    for (const f of fs.readdirSync(SUITE_DIR).sort()) {
      if (!f.endsWith('.test.js')) continue;
      const file = path.join(SUITE_DIR, f);
      // A suite whose header carries "@serial" runs with nothing else going —
      // for wall-clock perf assertions, which measure contention, not the
      // code under test, when other suites share the CPU.
      const serial = fs.readFileSync(file, 'utf8').slice(0, 2048).includes('@serial');
      suites.push({ name: f.replace(/\.test\.js$/, ''), file, serial });
    }
  }
  if (WITH_LEGACY) suites.push(LEGACY);
  return suites;
}

function runSuite(suite, portBase) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [suite.file], {
      env: portBase ? { ...process.env, MEMBRIDGE_TEST_PORT_BASE: String(portBase) } : process.env,
      encoding: 'utf8',
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => {
      const tally = out.match(/^(\d+)\/(\d+) checks passed$/m);
      resolve({
        suite, code, out, secs: ((Date.now() - t0) / 1000).toFixed(1),
        // null, not 0: a suite that never printed a tally ran an UNKNOWN
        // number of checks. Zero is a number, and numbers get added up.
        passed: tally ? Number(tally[1]) : null,
        total: tally ? Number(tally[2]) : null,
        ok: code === 0 && !!tally && tally[1] === tally[2],
        noTally: !tally,
      });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const all = discover();
  if (args.includes('--list')) {
    for (const s of all) console.log(s.name);
    return;
  }
  const filters = args.filter(a => !a.startsWith('--'));
  const picked = filters.length
    ? all.filter(s => filters.some(f => s.name.toLowerCase().includes(f.toLowerCase())))
    : all;
  if (!picked.length) {
    console.error(`no suite matches ${JSON.stringify(filters)}; available: ${all.map(s => s.name).join(', ')}`);
    process.exit(1);
  }

  // Three phases: parallel small suites, then @serial suites one at a time,
  // then the legacy core alone. Serial suites carry wall-clock perf
  // assertions that measure contention instead of the code under test when
  // anything else shares the CPU (observed live: redaction's 200-event render
  // at 2.5x its budget with six suites in flight, comfortably green alone).
  // Core runs last for the same reason, and it dominates wall-clock anyway.
  const blocks = poolWorkers(await freeBlocks());
  const parallel = picked.filter(s => s.name !== 'core' && !s.serial);
  const serial = picked.filter(s => s.name !== 'core' && s.serial);
  const results = await runPooled(parallel, blocks);
  // The serial phase and core run with nothing else in flight, so the first
  // block is free by construction — no need to consume a distinct one.
  for (const s of serial) {
    results.push(await runSuite(s, blocks[0]));
  }
  if (picked.some(s => s.name === 'core')) {
    results.push(await runSuite(LEGACY, blocks[0]));
  }

  const { lines, exitCode } = summarize(results);
  console.log(lines.join('\n'));
  if (exitCode) process.exit(exitCode);
}

// The whole summary as text plus the exit code it must agree with. Pure and
// exported so test/suites/runner-reporting.test.js can drive it directly:
// this is the one place in the repo where a wrong success claim would hide
// every other one.
function summarize(results) {
  const lines = [''];
  let passed = 0, total = 0, tallied = 0;
  const crashed = [], failed = [];
  for (const r of results) {
    if (r.ok) {
      lines.push(`ok    ${r.suite.name.padEnd(24)} ${String(r.passed).padStart(5)}/${r.total}  ${r.secs}s`);
    } else {
      (r.noTally ? crashed : failed).push(r.suite.name);
      // A crashed suite's TOTAL is unknown, but its progress is not: every
      // check prints its own line as it runs, and the monolith prints its
      // tally only at the very end (run-tests.js:25530). So a crash 14k lines
      // in means ~1300 checks genuinely ran and reported — evidence the runner
      // used to throw away, leaving a reader with "0/0" for a run that had
      // done nearly all of its work. Counted from the captured output and
      // reported HERE only; it never touches the totals, because a partial
      // count folded into a total is the original bug this file exists for.
      const why = r.noTally
        ? `CRASHED after ${reportedChecks(r.out)} checks reported, before its tally; exit ${r.code}; TOTAL UNKNOWN${sigSuffix(r.out)}`
        : `exit ${r.code}`;
      // CRASH, not FAIL, in the per-suite column. They are different events
      // and the reader should not have to parse the rest of the line to tell
      // them apart.
      lines.push(`${r.noTally ? 'CRASH' : 'FAIL '} ${r.suite.name.padEnd(24)} ${why}`);
      // Show the tail of a failing suite's output — enough to see the first
      // FAIL line or the crash, without drowning the summary.
      const out = r.out.trimEnd().split('\n');
      const firstFail = out.findIndex(l => /^ {2}FAIL {2}/.test(l));
      const slice = firstFail >= 0 ? out.slice(firstFail, firstFail + 15) : out.slice(-25);
      lines.push(slice.map(l => `      | ${l}`).join('\n'));
    }
    // Only a suite that reported a tally contributes to the counts. A crashed
    // suite's checks are unknown, and folding its silence in as 0/0 is what
    // produced a passing-looking footer for a truncated run.
    if (r.total !== null) { passed += r.passed; total += r.total; tallied++; }
  }

  const suites = n => `${n} suite${n === 1 ? '' : 's'}`;
  lines.push('');
  if (!crashed.length && !failed.length) {
    lines.push(`TOTAL ${passed}/${total} checks passed across ${suites(results.length)}`);
    return { lines, exitCode: 0 };
  }
  // A failed run never prints the phrase "checks passed" at all, in any
  // arrangement: the counts are stated as counts, the verdict is the last
  // line, and the verdict agrees with the exit code. Anything quoted out of
  // this block still reads as a failure.
  //
  // ...and when NOTHING reported a tally, say that instead of printing a
  // count. `counted 0 of 0 checks in the 0 suites that reported a tally` is
  // arithmetic over an empty set dressed as a measurement: it is the mirror of
  // the 0/0-reads-as-success bug this file already fixed. An absence reading
  // as a failure is less dangerous than an absence reading as a pass, and
  // equally uninformative — nobody learns from it whether the suite is broken,
  // the tree is bad, or the machine fell over.
  if (tallied === 0) {
    // Deliberately NOT "nothing was measured": checks may well have run and
    // reported individually before the process died. What is missing is a
    // TALLY, and therefore a denominator — the run cannot say how much of
    // itself it got through, which is exactly why it cannot judge the tree.
    const ran = results.reduce((n, r) => n + reportedChecks(r.out), 0);
    lines.push(`NO SUITE REPORTED A TALLY — ${ran} check(s) reported before the crash, out of an UNKNOWN total, `
      + 'so this run cannot say whether the tree is good');
  } else {
    const scope = crashed.length
      ? `the ${suites(tallied)} that reported a tally (the rest crashed, so the real total is higher)`
      : `${suites(tallied)}`;
    lines.push(`counted ${passed} of ${total} checks in ${scope}`);
  }
  const why = [];
  if (failed.length) why.push(`failing checks: ${failed.join(', ')}`);
  if (crashed.length) why.push(`CRASHED with an UNKNOWN number of checks: ${crashed.join(', ')}`);
  // THREE verdicts, not two. "a check failed" and "the suite never finished"
  // are different events with different next actions — read the assertion, vs
  // find out why the process died — and collapsing them into FAILED sent a
  // lane hunting for a defect in a tree that was fine. INCOMPLETE is used only
  // when nothing actually failed a check: a genuine failure alongside a crash
  // is still a failure, because that is the finding you must act on.
  const verdict = failed.length ? 'FAILED' : 'INCOMPLETE';
  const gloss = failed.length
    ? ''
    : ' — no check failed; the run did not finish, so the tree is UNJUDGED (re-run before believing anything about it)';
  lines.push(`RESULT ${verdict}  ${failed.length + crashed.length} of ${suites(results.length)} did not pass — ${why.join('; ')}${gloss}`);
  return { lines, exitCode: 1 };
}

// A one-line "what killed it" for a suite that never reported a tally, pulled
// from the child's own output. Without it the per-suite line says only "exit
// 1", and the reader has to scroll the quoted tail to learn whether it was an
// assertion, a missing module, or a pipe closing under load. Prefers the most
// specific evidence available: a node errno code (EPIPE, ECONNREFUSED,
// ENOENT), then an `Error:` line, then a bare signal.
// How many checks a suite printed before it stopped. The harness prints one
// `  ok  ` or `  FAIL  ` line per check as it runs, so this is a real floor on
// the work done — never a total, and never added to one.
function reportedChecks(out) {
  return (String(out || '').match(/^ {2}(?:ok|FAIL) {2}/gm) || []).length;
}

const ERRNO_RX = /\b(EPIPE|ECONNREFUSED|ECONNRESET|ENOENT|EADDRINUSE|EACCES|ETIMEDOUT|ERR_[A-Z_]+)\b/;
function crashSignature(out) {
  const text = String(out || '');
  const errno = text.match(ERRNO_RX);
  if (errno) {
    // Name the frame too when the stack has one: "EPIPE at stdio.js:78" says
    // considerably more than "EPIPE".
    const frame = text.match(/at\s+[^\n]*?([\w.-]+\.js):(\d+)/);
    return frame ? `${errno[1]} at ${frame[1]}:${frame[2]}` : errno[1];
  }
  const err = text.match(/^\s*((?:[A-Za-z]*Error|Assertion\w*)[^\n]{0,120})/m);
  if (err) return err[1].trim();
  const sig = text.match(/\b(SIG[A-Z]+)\b/);
  return sig ? sig[1] : '';
}
const sigSuffix = out => {
  const s = crashSignature(out);
  return s ? ` (${s})` : '';
};

module.exports = { summarize, crashSignature, reportedChecks };

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
