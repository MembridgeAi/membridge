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
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

// Assign each child its own verified-free port block up front. The per-process
// probe inside each suite checks that a block LOOKS free but reserves nothing,
// and a suite may not bind its first server until minutes in — so two children
// whose pids map to the same block can both adopt it and cross-talk later.
// (Observed live: a redaction team-push check failing only when run next to
// core.) Assigning from one place removes the race; the assignment still
// skips blocks squatted by e.g. a live daemon on this machine.
function freePort(port) {
  try {
    const s = net.createServer();
    s.listen(port, '127.0.0.1');
    const r = s.listening;
    s.close();
    return r;
  } catch { return false; }
}
function* freeBlocks() {
  for (let i = 0; i < 40; i++) {
    const base = 17900 + i * 100;
    // +99 is the sentinel a live run (this orchestrator's children included)
    // holds for its lifetime — checking it keeps two concurrent invocations,
    // e.g. from two sessions in different worktrees, off each other's blocks.
    if (freePort(base + 41) && freePort(base + 96) && freePort(base + 99)) yield base;
  }
}

const SUITE_DIR = path.join(__dirname, 'suites');
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
  suites.push(LEGACY);
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
        passed: tally ? Number(tally[1]) : 0,
        total: tally ? Number(tally[2]) : 0,
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
  const blocks = freeBlocks();
  const parallel = picked.filter(s => s.name !== 'core' && !s.serial);
  const serial = picked.filter(s => s.name !== 'core' && s.serial);
  const results = await Promise.all(parallel.map(s => {
    const { value: portBase } = blocks.next();
    return runSuite(s, portBase);
  }));
  for (const s of serial) {
    const { value: portBase } = blocks.next();
    results.push(await runSuite(s, portBase));
  }
  if (picked.some(s => s.name === 'core')) {
    const { value: portBase } = blocks.next();
    results.push(await runSuite(LEGACY, portBase));
  }

  let passed = 0, total = 0, bad = 0;
  console.log('');
  for (const r of results) {
    if (r.ok) {
      console.log(`ok    ${r.suite.name.padEnd(24)} ${String(r.passed).padStart(5)}/${r.total}  ${r.secs}s`);
    } else {
      bad++;
      const why = r.noTally ? `no tally printed (crashed?), exit ${r.code}` : `exit ${r.code}`;
      console.log(`FAIL  ${r.suite.name.padEnd(24)} ${why}`);
      // Show the tail of a failing suite's output — enough to see the first
      // FAIL line or the crash, without drowning the summary.
      const lines = r.out.trimEnd().split('\n');
      const firstFail = lines.findIndex(l => /^ {2}FAIL {2}/.test(l));
      const slice = firstFail >= 0 ? lines.slice(firstFail, firstFail + 15) : lines.slice(-25);
      console.log(slice.map(l => `      | ${l}`).join('\n'));
    }
    passed += r.passed; total += r.total;
  }
  console.log(`\nTOTAL ${passed}/${total} checks passed across ${results.length} suite${results.length === 1 ? '' : 's'}`);
  if (bad) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
