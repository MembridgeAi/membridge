'use strict';
// A file under test/ that CI never runs still looks like coverage.
// Run via `node test/run.js test-files-declare-themselves`, or directly.
//
// WHY THIS SUITE EXISTS. CI runs `node test/run.js` and nothing else
// (.github/workflows/ci.yml), and run.js discovers exactly `test/suites/
// *.test.js` plus the legacy `test/run-tests.js`. Everything else under test/
// is invisible to it. test/teammate-notes-e2e.js is 622 lines of end-to-end
// assertions about teammate notes, passes today, and gates NOTHING — anyone
// auditing that area finds it and reasonably concludes the area is covered.
//
// That is the documentation-asserting-a-false-state shape, except the false
// claim is made by a file's EXISTENCE rather than its contents, which is why
// reading the file does not dispel it. Its own header does say "Opt-in ...
// never wired into npm test" — 28 lines in, under a heading that spends the
// preceding paragraph explaining what it catches that the unit suite cannot.
//
// MEASURED, not assumed (see that file's header for the numbers): scored as a
// mutation runner against the two regions it claims to own, it killed ZERO
// mutants that the discovered suites do not already kill, and far fewer
// overall. It is a demonstration harness, not coverage.
//
// THE RULE. Every .js under test/ must be one of three things, and must be
// able to say which:
//
//   1. DISCOVERED — test/suites/*.test.js, or test/run-tests.js. CI runs it.
//   2. INFRASTRUCTURE — require()d, directly or transitively, by something
//      discovered. It runs as part of a suite.
//   3. DECLARED — carries `NOT_RUN_BY_CI: <what it is and why>` in its first
//      40 lines.
//
// The 40-line ceiling is the point. A declaration buried under an argument for
// the file's value is not a declaration; it has to be the first thing an
// auditor reads. As with the KNOWN_READS_UNOWNED_FILE marker in
// tests-own-their-state.test.js, the string is not the goal — forcing the
// author to answer "does CI run this?" before adding it is.
//
// NO_UNOWNED_FILE_READS: this file reads only test/ sources under __dirname
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DIR = path.join(__dirname, '..');
const MARKER = /NOT_RUN_BY_CI:\s*(.+)/;
const MARKER_LINE_LIMIT = 40;

function allTestJs(dir = TEST_DIR, out = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) allTestJs(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

// What run.js discovers, mirrored from its discover(): suites/*.test.js plus
// the legacy monolith. Kept as a literal rather than by importing run.js so a
// change to the runner's discovery makes this gate FAIL rather than silently
// agree with itself — the two must be compared, not shared.
function discoveredFiles() {
  const out = [path.join(TEST_DIR, 'run-tests.js')];
  const suiteDir = path.join(TEST_DIR, 'suites');
  for (const f of fs.readdirSync(suiteDir).sort()) {
    if (f.endsWith('.test.js')) out.push(path.join(suiteDir, f));
  }
  return out;
}

// Transitive closure of relative require()s from the discovered set. A file
// pulled in by a suite runs in CI even though the runner never names it.
function reachableFrom(roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\(\s*(['"])(\.[^'"]+)\1\s*\)/g)) {
      const resolved = path.resolve(path.dirname(file), m[2]);
      for (const cand of [resolved, `${resolved}.js`, path.join(resolved, 'index.js')]) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) { queue.push(cand); break; }
      }
    }
  }
  return seen;
}

function markerOf(src) {
  const head = src.split('\n').slice(0, MARKER_LINE_LIMIT).join('\n');
  const m = head.match(MARKER);
  return m ? m[1].trim() : null;
}

function main() {
  const files = allTestJs();
  const discovered = new Set(discoveredFiles());
  const reachable = reachableFrom([...discovered]);

  const classify = f => {
    if (discovered.has(f)) return 'discovered';
    if (reachable.has(f)) return 'infrastructure';
    return markerOf(fs.readFileSync(f, 'utf8')) ? 'declared' : 'UNDECLARED';
  };
  // Forward-slash the relative path: path.relative yields backslashes on
  // Windows, and every comparison below (and the declared-list literal) is
  // written with '/'. Without this the whole gate misclassifies on the Windows
  // CI leg.
  const rel = f => path.relative(path.join(TEST_DIR, '..'), f).split(path.sep).join('/');

  // ---- teeth: the classifier must actually discriminate, or the bite below
  // is satisfied by a function that returns 'discovered' for everything.

  check('classifier: a suite under test/suites is DISCOVERED', () => {
    assert.strictEqual(classify(path.join(TEST_DIR, 'suites', 'redaction.test.js')), 'discovered');
    assert.strictEqual(classify(path.join(TEST_DIR, 'run-tests.js')), 'discovered');
  });

  check('classifier: harness.js is INFRASTRUCTURE, reached only through a suite\'s require', () => {
    const harness = path.join(TEST_DIR, 'harness.js');
    assert.ok(!discovered.has(harness), 'harness.js must not be discovered directly');
    assert.strictEqual(classify(harness), 'infrastructure',
      'harness.js is required by every suite and must classify as infrastructure');
    // ...and transitively, one hop further out: check-accounting is required by
    // harness, not by any suite. A non-transitive walk would miss it.
    assert.strictEqual(classify(path.join(TEST_DIR, 'check-accounting.js')), 'infrastructure',
      'the require walk is not transitive — a file two hops from a suite reads as unreachable');
  });

  check('classifier: a standalone script that nothing requires is NOT infrastructure', () => {
    // The whole point. test/teammate-notes-e2e.js is required by nothing and
    // discovered by nothing; only its marker can save it.
    const e2e = path.join(TEST_DIR, 'teammate-notes-e2e.js');
    assert.ok(fs.existsSync(e2e), 'fixture: the file this gate was written for is gone');
    assert.ok(!discovered.has(e2e) && !reachable.has(e2e),
      'teammate-notes-e2e.js is being counted as run by CI, which it is not');
  });

  check('classifier: a marker BELOW the head of the file does not count', () => {
    // A declaration under 40 lines of argument for the file's value is not a
    // declaration. This is the exact shape that let a 622-line script read as
    // coverage: its opt-in line sits at line 28, after a paragraph explaining
    // what it catches that the unit suite cannot.
    const buried = `${'// filler\n'.repeat(MARKER_LINE_LIMIT + 5)}// NOT_RUN_BY_CI: too late to help anyone\n`;
    assert.strictEqual(markerOf(buried), null, 'a marker past the head limit was accepted');
    assert.strictEqual(markerOf('// NOT_RUN_BY_CI: right at the top\n'), 'right at the top');
  });

  // ---- the bite.

  check('every .js under test/ is discovered by the runner, reached by a suite, or DECLARES that CI does not run it', () => {
    const undeclared = files.filter(f => classify(f) === 'UNDECLARED').map(rel);
    assert.deepStrictEqual(undeclared, [],
      'these files sit under test/ and CI never runs them, and they do not say so. A file named\n'
      + 'like a test, in the test directory, that gates nothing is read as coverage by everyone who\n'
      + 'finds it. Add `NOT_RUN_BY_CI: <what it is and why>` within the first '
      + `${MARKER_LINE_LIMIT} lines, or wire it into test/suites/.\n`
      + JSON.stringify(undeclared, null, 2));
  });

  check('the declared set is exactly what we think it is — a new undiscovered file cannot slip in quietly', () => {
    // Pinning the LIST, not just the count: a file added and declared is a
    // deliberate act that should show up in a diff of this line. Without it,
    // "add a marker" becomes a way to grow an unrun test directory silently.
    const declared = files.filter(f => classify(f) === 'declared').map(rel).sort();
    assert.deepStrictEqual(declared, [
      'test/ledger-equivalence.js',
      'test/log-homedir-preload.js',
      'test/mutate.js',
      'test/recall-e2e.js',
      'test/teammate-notes-e2e.js',
    ], 'the set of test/ files CI does not run has changed. If that is deliberate, update this list '
      + 'in the same commit — it is the one place the change is visible.');
  });

  h.finish();
}

main();
