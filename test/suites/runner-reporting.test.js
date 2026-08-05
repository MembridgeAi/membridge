'use strict';
// test/run.js's own claims: the summary it prints, and the port block it says
// it reserves for each child. Run via `node test/run.js runner-reporting`, or
// directly.
//
// Why this suite exists: when a suite CRASHES it never prints its
// "N/M checks passed" tally, and test/run.js used to fold that silence in as
// 0/0. The footer of a run whose largest suite died therefore read
// `TOTAL 451/451 checks passed across 26 suites` (observed on PR #23), and
// `TOTAL 110/110 checks passed across 12 suites` with SIX of twelve suites
// dead on a missing node:sqlite. Exit status was 1 both times, so CI caught
// it — but every human and every agent reading the last line saw a pass.
//
// That is this repo's signature defect (a value asserting a success the code
// never established) living in the one place that can hide every other
// instance of it, which is why it gets a suite of its own rather than a line
// in someone else's.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { summarize } = require('../run.js');

const RUN_JS = path.join(__dirname, '..', 'run.js');

// A result row shaped exactly as runSuite() produces one.
const tallied = (name, passed, total, code = 0) => ({
  suite: { name }, code, out: `${passed}/${total} checks passed\n`, secs: '0.1',
  passed, total, ok: code === 0 && passed === total, noTally: false,
});
// A crash: no tally line at all, so the check count is unknown, not zero.
const crashed = (name, out = 'Error: boom\n') => ({
  suite: { name }, code: 1, out, secs: '0.1',
  passed: null, total: null, ok: false, noTally: true,
});

// The exact shape of a green footer: some number, over the SAME number.
const readsAsAllPassed = text => /(\d+)\s*(?:\/|of)\s*\1 checks passed/.test(text);
// The runner's own verdict, excluding the quoted tails of failing suites —
// a failing child's own "1/2 checks passed" line is evidence, not a claim.
const footerOf = lines => lines.slice(-2).join('\n');

function writeFixtureSuite(dir, name, body) {
  fs.writeFileSync(path.join(dir, `${name}.test.js`), body);
}

async function main() {
  // ---- the summary function, driven directly ----

  check('summarize: an all-green run prints one X/X tally and exits 0', () => {
    const { lines, exitCode } = summarize([tallied('a', 3, 3), tallied('b', 7, 7)]);
    const text = lines.join('\n');
    assert.strictEqual(exitCode, 0);
    assert.match(text, /TOTAL 10\/10 checks passed across 2 suites/);
  });

  check('summarize: a CRASHED suite never leaves a footer that reads as all-passed', () => {
    const { lines, exitCode } = summarize([tallied('a', 451, 451), crashed('core')]);
    const footer = footerOf(lines);
    assert.strictEqual(exitCode, 1, 'a crashed suite must exit nonzero');
    assert.ok(!readsAsAllPassed(footer), `the summary still reads as a pass:\n${footer}`);
    assert.ok(!/checks passed/.test(footer),
      `a failed run must not print the phrase "checks passed" in its verdict:\n${footer}`);
  });

  check('summarize: a crashed suite is reported with its check count UNKNOWN, not 0', () => {
    const { lines } = summarize([tallied('a', 451, 451), crashed('core')]);
    const text = lines.join('\n');
    assert.match(text, /UNKNOWN/, 'the crashed suite\'s check count must be called unknown');
    assert.ok(!/\b0\/0\b/.test(text), 'a crashed suite must never be counted as 0/0');
    assert.match(text, /core/, 'the crashed suite must be named in the footer');
  });

  check('summarize: the final line and the exit status agree on failure', () => {
    for (const results of [
      [tallied('a', 3, 3), crashed('core')],
      [tallied('a', 3, 3), tallied('b', 1, 2, 1)],
      [crashed('core')],
    ]) {
      const { lines, exitCode } = summarize(results);
      const footer = footerOf(lines);
      assert.strictEqual(exitCode, 1);
      assert.match(footer, /FAILED/, `exit 1 but the footer never says FAILED:\n${footer}`);
    }
  });

  check('summarize: a partial tally is never folded into a total that looks complete', () => {
    // b ran 1 of 2 checks and failed; the footer must show 4/5, not 4/4.
    const { lines } = summarize([tallied('a', 3, 3), tallied('b', 1, 2, 1)]);
    const footer = footerOf(lines);
    assert.ok(!readsAsAllPassed(footer), `partial run reads as a pass:\n${footer}`);
    assert.match(footer, /counted 4 of 5 checks/);
    assert.ok(!/checks passed/.test(footer),
      'a failed run must not print the phrase "checks passed" in its verdict');
  });

  check('summarize: a suite that exits 0 but tallies fewer passes than checks still fails the run', () => {
    // The shape a suite would have if it printed 5/6 and forgot to exit 1.
    const { exitCode } = summarize([tallied('a', 5, 6, 0)]);
    assert.strictEqual(exitCode, 1);
  });

  // ---- end to end: a real orchestrator run over suites that crash on purpose ----
  // MEMBRIDGE_TEST_SUITE_DIR points run.js at fixtures instead of test/suites
  // (and suppresses the legacy monolith), so this exercises the real spawn,
  // tally-grep and footer path rather than a hand-built result array.
  const fixtures = fs.mkdtempSync(path.join(h.ROOT, 'suites-'));
  writeFixtureSuite(fixtures, 'green', 'console.log("  ok    one");\nconsole.log("\\n2/2 checks passed");\n');
  writeFixtureSuite(fixtures, 'boom', 'console.log("  ok    one");\nthrow new Error("deliberate crash before the tally");\n');

  const runOrchestrator = (names, extraEnv = {}) => {
    const dir = fs.mkdtempSync(path.join(h.ROOT, 'pick-'));
    for (const n of names) fs.copyFileSync(path.join(fixtures, `${n}.test.js`), path.join(dir, `${n}.test.js`));
    const r = spawnSync(process.execPath, [RUN_JS], {
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv, MEMBRIDGE_TEST_SUITE_DIR: dir },
    });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };

  const green = runOrchestrator(['green']);
  check('end to end: a run whose fixture suites all pass exits 0 and says so', () => {
    assert.strictEqual(green.status, 0, green.out);
    assert.match(green.out, /TOTAL 2\/2 checks passed across 1 suite/);
  });

  const withCrash = runOrchestrator(['green', 'boom']);
  check('end to end: a deliberately crashing suite cannot produce a passing-looking footer', () => {
    assert.strictEqual(withCrash.status, 1, withCrash.out);
    const footer = footerOf(withCrash.out.trimEnd().split('\n'));
    assert.ok(!readsAsAllPassed(footer), `crashed run still reads as a pass:\n${footer}`);
    assert.match(footer, /FAILED/);
    assert.match(footer, /UNKNOWN/);
    assert.match(footer, /boom/, 'the crashed suite must be named');
  });

  // ---- the port block each child is promised ----
  // run.js's header claims it assigns "each child its own verified-free port
  // block up front", which "removes the race". It did not: the freeness probe
  // read `server.listening` synchronously after `listen(port, '127.0.0.1')`,
  // which is always false (that overload defers through a DNS lookup), so no
  // block ever qualified, every child was spawned with MEMBRIDGE_TEST_PORT_BASE
  // unset, and each fell back to `17900 + (pid % 40) * 100` — an unverified
  // guess, 26 children deep, which is the port cross-talk the header says was
  // removed. Assert what the header promises: a value, and a distinct one.
  // Reported through a file, not stdout: run.js swallows a PASSING child's
  // output, which is exactly why nobody noticed the env var was never set.
  const report = path.join(h.ROOT, 'port-bases.txt');
  writeFixtureSuite(fixtures, 'p1',
    'require("fs").appendFileSync(process.env.PORT_BASE_REPORT, "base=" + process.env.MEMBRIDGE_TEST_PORT_BASE + "\\n");\n'
    + 'console.log("\\n1/1 checks passed");\n');
  for (const n of ['p2', 'p3']) fs.copyFileSync(path.join(fixtures, 'p1.test.js'), path.join(fixtures, `${n}.test.js`));
  const ports = runOrchestrator(['p1', 'p2', 'p3'], { PORT_BASE_REPORT: report });
  const bases = [...(fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '').matchAll(/^base=(.*)$/gm)].map(m => m[1]);

  check('run.js hands every child a port block, never an unset env var', () => {
    assert.strictEqual(ports.status, 0, ports.out);
    assert.strictEqual(bases.length, 3, `expected three children to report a base, got ${JSON.stringify(bases)}`);
    for (const b of bases) {
      assert.ok(Number(b) >= 17900, `child was given no port block (got ${JSON.stringify(b)}) and fell back to a pid guess`);
    }
  });

  check('run.js hands each child a DISTINCT port block', () => {
    assert.strictEqual(new Set(bases).size, bases.length, `blocks collided: ${JSON.stringify(bases)}`);
  });

  h.finish();
}

main();
