'use strict';
// A check that cannot fail is worse than no check: it occupies the slot where
// coverage would go, and it reports success while doing it. Run via
// `node test/run.js checks-can-fail`, or directly.
//
// WHY THIS SUITE EXISTS. Four instances of one class landed in a single week:
//
//   1. An `async` check() that was never `await`ed. It resolved after the
//      reporter had totalled, so the suite printed 19/19 over a check that had
//      not run — and would have printed the same 19/19 had it failed.
//   2. The Windows guard family in run-tests.js: six checks in the "a read
//      failure must not read as missing" set, each wrapping every assertion in
//      `if (notRoot() && denied) { ... }` with no else. fs.chmod on Windows
//      cannot clear READ, so `denied` was false and the body vanished. Five of
//      six stayed green on both Windows CI legs with the bug deliberately
//      restored. One carries the comment "If this check ever goes red, do not
//      fix it by loosening readSettings" — on Windows it could not go red.
//   3. A crashed suite counting as 0/0, so a run whose largest suite died
//      printed a green total. Fixed in test/run.js.
//   4. A stub that refuses the operation under test, so the check proves the
//      stub's behaviour instead of the product's.
//
// TWO HALVES, because neither alone is enough.
//
//   RUNTIME (test/check-accounting.js): every require('assert') from inside
//   test/ returns a counting copy; check() fails a body that moved the counter
//   by zero, and finish() names any check still in flight. Exact about what it
//   sees, but it only sees the platform it runs on — a body that vanishes only
//   on Windows is caught only by the Windows leg — and its in-flight set is a
//   backstop rather than the gate for instance 1: a stray promise that later
//   awaits happen to drain is empty again by the time finish() runs.
//
//   STATIC (this file): reads the SOURCE of every test file the runner
//   discovers and finds the shapes that make a body vanish on SOME platform,
//   from any platform. Approximate, but platform-blind.
//
// WHAT NEITHER HALF CATCHES, stated plainly so a green run is not read as more
// than it is:
//   • Assertions that hold trivially — assert.ok(true), assert.strictEqual(x,
//     x), or an expected value computed by the code path under test. Both
//     halves see an assertion and are satisfied. Review only.
//   • Instance 4, the lying stub. The check genuinely asserts; what it asserts
//     is the stub's behaviour. Caught only by reading what the stub returns.
//   • Vacuity from data rather than control flow — a loop over a fixture array
//     that happens to be empty asserts nothing, and the static scanner sees
//     assertions in the source. The runtime half DOES catch this one, on the
//     platform where it happens.
//
// NO_UNOWNED_FILE_READS: this file reads only test/ sources under __dirname
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const accounting = require('../check-accounting');

const TEST_DIR = path.join(__dirname, '..');

// Same scope as tests-own-their-state.test.js: only files test/run.js actually
// runs. A test no orchestrator runs cannot report a false green to one.
function testFilesInScope() {
  const files = [path.join(TEST_DIR, 'run-tests.js'), path.join(TEST_DIR, 'harness.js')];
  for (const f of fs.readdirSync(path.join(TEST_DIR, 'suites')).sort()) {
    if (f.endsWith('.test.js')) files.push(path.join(TEST_DIR, 'suites', f));
  }
  return files;
}

// Source text scanning is SHARED with test/mutate.js (test/js-scan.js). It used
// to be a private copy here, and that copy still had the regex-literal bug the
// mutate.js copy had already been fixed for — so the first suite to contain a
// regex with a quote in it parsed to ZERO checks. The "finds every check"
// assertion below is what caught it; one implementation is what stops it
// happening a third time.
const { blankNonCode, matchingBrace } = require('../js-scan');

const CHECK_CALL = /(?:^|[^\w.$])(?:h\.)?(check|checkNeedsUnreadable|checkNoThrow)\s*\(/g;

// Every check(...) call in a file, with its body span and whether the call
// site awaited it. `check` is the only name here whose body is subject to the
// assertion requirement; checkNoThrow is exempt by construction.
function findChecks(rawSrc) {
  const src = blankNonCode(rawSrc);
  const out = [];
  CHECK_CALL.lastIndex = 0;
  let m;
  while ((m = CHECK_CALL.exec(src)) !== null) {
    const callAt = m.index + m[0].length - 1;
    const arrow = src.indexOf('=>', callAt);
    if (arrow === -1) continue;
    const brace = src.indexOf('{', arrow);
    // `=> {` possibly with whitespace. A concise arrow body (`=> assert.ok(x)`)
    // has no braces to scan and no room for an early return.
    if (brace === -1 || brace - arrow > 4) continue;
    const close = matchingBrace(src, brace);
    if (close === -1) continue;
    // Awaited? Look back past the call for `await` (`await check(`, and the
    // `} else await check(` form the repairs in run-tests.js use).
    const before = src.slice(Math.max(0, m.index - 12), m.index + 1);
    const isAsync = /=>\s*$/.test(src.slice(arrow - 40, arrow).replace(/\basync\s*\(\)\s*$/, 'ASYNC'))
      || /\basync\b/.test(src.slice(callAt, arrow));
    out.push({
      kind: m[1],
      callIndex: m.index,
      awaited: /\bawait\s*$/.test(before.slice(0, -1)),
      isAsync,
      bodyStart: brace + 1,
      bodyEnd: close,
      body: src.slice(brace + 1, close),
      line: rawSrc.slice(0, m.index).split('\n').length,
      name: (rawSrc.slice(m.index, m.index + 400).match(/check[A-Za-z]*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/) || [, , '?'])[2],
    });
  }
  return out;
}

const ASSERT_IN = s => /\bassert(\s*\.|\s*\()/.test(s);

// The runtime-gate checks below drive real check() instances over fixture
// bodies, and those print their own `ok`/`FAIL` lines. Left alone they land in
// this suite's transcript looking exactly like real results — a fixture FAIL
// is indistinguishable from a genuine one, which is a smaller version of the
// bug this file is about. Swallow their output; the assertions read the
// results array, not the console.
async function quiet(fn) {
  const real = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = real; }
}

// SHAPE A: an exit path that reaches no assertion. A bare `return;` at the top
// level of a check body, with no assert before it, means every run that takes
// that branch registers `ok` having proven nothing. This is exactly the
// redaction keychain check (`if (process.platform !== 'darwin') return;`,
// vacuous on 4 of 6 CI legs) and the mcp-wiring probeHit check (vacuous on any
// machine with claude on the probe list).
function assertionFreeExits(chk) {
  const hits = [];
  const b = chk.body;
  let depth = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (depth <= 1 && b.startsWith('return', i) && !/[\w$.]/.test(b[i - 1] || ' ')) {
      // Only a VALUELESS return is an exit-from-a-check. `return x` inside a
      // nested helper is a value, and depth<=1 already excludes most of those.
      if (!/^\s*[;\n}]/.test(b.slice(i + 6, i + 8))) continue;
      if (!ASSERT_IN(b.slice(0, i))) hits.push({ at: i });
    }
  }
  return hits;
}

// SHAPE B: a condition whose falseness swallows EVERY assertion in the check.
// The Windows guard family verbatim — `if (notRoot() && denied) { ...every
// assertion... }` with no else, sitting after a block of fixture setup. Where
// the condition is false the check asserts nothing and still prints `ok`.
//
// Stated as an invariant rather than a syntax: for each `if (cond) { block }`
// with no `else`, if EVERY assert in the whole body is inside that block, then
// `!cond` makes the check vacuous. That formulation catches the shape wherever
// it sits — first statement, after setup, or nested inside a try — which the
// real bug required, since its `if` came after twenty lines of fixture writing.
//
// An `else` clears it (both branches assert). So does one assertion outside
// the block: something can still fail.
function conditionsSwallowingEveryAssertion(chk) {
  const b = chk.body;
  const totalAsserts = countAsserts(b);
  if (totalAsserts === 0) return []; // a body with no assertions at all is shape A's problem
  const hits = [];
  for (let i = 0; i < b.length; i++) {
    if (!b.startsWith('if', i)) continue;
    if (/[\w$.]/.test(b[i - 1] || ' ')) continue;      // `elseif`, `notify`, a property named if
    if (/[\w$]/.test(b[i + 2] || ' ')) continue;
    const openParen = b.indexOf('(', i);
    if (openParen === -1 || b.slice(i + 2, openParen).trim() !== '') continue;
    let depth = 0, closeParen = -1;
    for (let j = openParen; j < b.length; j++) {
      if (b[j] === '(') depth++;
      else if (b[j] === ')') { depth--; if (depth === 0) { closeParen = j; break; } }
    }
    if (closeParen === -1) continue;
    const braceAt = b.indexOf('{', closeParen);
    if (braceAt === -1 || b.slice(closeParen + 1, braceAt).trim() !== '') continue;
    const braceEnd = matchingBrace(b, braceAt);
    if (braceEnd === -1) continue;
    if (b.slice(braceEnd + 1).trimStart().startsWith('else')) continue; // both branches exist
    const inside = countAsserts(b.slice(braceAt, braceEnd));
    if (inside > 0 && inside === totalAsserts) {
      hits.push({ cond: b.slice(openParen + 1, closeParen).replace(/\s+/g, ' ').trim().slice(0, 90), inside });
    }
  }
  return hits;
}

function countAsserts(s) {
  return (s.match(/\bassert\s*[.(]/g) || []).length;
}

async function main() {
  const files = testFilesInScope();
  const scanned = files.map(f => ({
    file: path.relative(path.join(TEST_DIR, '..'), f),
    raw: fs.readFileSync(f, 'utf8'),
  }));
  for (const s of scanned) s.checks = findChecks(s.raw);

  // ---- teeth first: the scanner must find the shapes in known-bad source,
  // and must NOT find them in the adjacent-but-legitimate source right next to
  // them. A scanner that reports zero because it sees nothing is the same
  // defect this suite exists to catch.

  check('scanner: finds every check(...) call in the files it scans', () => {
    const monolith = scanned.find(s => s.file === 'test/run-tests.js');
    assert.ok(monolith, 'run-tests.js was not scanned');
    // The monolith registers ~1300 checks; if the parser silently stopped
    // early, every assertion below would be vacuously satisfied.
    assert.ok(monolith.checks.length > 800,
      `only ${monolith.checks.length} check(...) calls parsed out of run-tests.js — the scanner stopped early`);
    const suites = scanned.filter(s => s.file.startsWith('test/suites/'));
    // No file is exempt, this one included. The self-exemption that used to sit
    // here was never load-bearing — this file parses to 16+ checks, and did so
    // even under the desynced lexer that took migration-state.test.js to zero.
    // An unnecessary exemption in the zero-check gate is worse than none: it
    // costs nothing to carry and stands ready to hide the one reading the gate
    // exists to report.
    assert.ok(suites.every(s => s.checks.length > 0),
      `a suite parsed to zero checks: ${suites.filter(s => !s.checks.length).map(s => s.file).join(', ')}`);
  });

  check('scanner: blankNonCode preserves length and line count (so reported line numbers are real)', () => {
    // LENGTH IS NOT THE DESYNC DETECTOR, despite being how both failures first
    // presented (output one character longer than input). Fixing the blanker to
    // emit a terminator only when one was actually found removed the +1 — so a
    // mis-read quote OR backtick now blanks the rest of the file at exactly the
    // same length. Measured with the regex arm removed: both shapes come back
    // length-preserving and content-destroying.
    //
    // This assertion is kept because length- and line-preservation is a real
    // property worth holding on its own: every caller maps an index back to a
    // line number, and a drift of one character silently misreports every line
    // after it. The DESYNC detector is the content-survival check below, and
    // the meta-suite's own "finds every check" assertion above it.
    const fixtures = [
      // lib/redact.js:109 — apostrophe and double quote inside a character class.
      String.raw`const rx = /([?&])(?![0-9]+(?:[&#\s'"]|$))[^&#\s'"<>]{8,}/gi;` + '\nconst after = 1;\n',
      // test/suites/test-files-declare-themselves.test.js — the same shape.
      String.raw`for (const m of src.matchAll(/require\(\s*(['"])(\.[^'"]+)\1\s*\)/g)) {}` + '\nconst after = 2;\n',
      // division must NOT be read as a regex
      'const ratio = total / count; const x = 1;\n',
      // an escaped quote inside a string
      "const s = 'it\\'s fine'; const y = 2;\n",
      // template literal containing a nested quote and an interpolation
      'const t = `${\'// filler\'.repeat(3)} tail`; const z = 3;\n',
    ];
    for (const src of fixtures) {
      const out = blankNonCode(src);
      assert.strictEqual(out.length, src.length,
        `blankNonCode changed the length, so every offset after it is wrong:\n  in : ${JSON.stringify(src)}\n  out: ${JSON.stringify(out)}`);
      assert.strictEqual(out.split('\n').length, src.split('\n').length,
        `line count changed, so reported line numbers would be wrong:\n${JSON.stringify(out)}`);
    }
    // THE ACTUAL DETECTOR, at the primitive level: code after a regex holding
    // ANY string delimiter must survive blanking. All three are covered here
    // rather than the two that happened to break — the backtick case is pinned
    // at the CONSEQUENCE level by 'a regex holding a backtick does not swallow
    // the checks after it' below, which is the assertion that matters and is
    // not restated here.
    for (const [label, delim] of [['single quote', "'"], ['double quote', '"'], ['backtick', '`']]) {
      const src = `const rx = /[${delim}]x/g;\nconst after = 1;\n`;
      const out = blankNonCode(src);
      assert.ok(/const after = 1;/.test(out),
        `code following a regex containing a ${label} was swallowed: ${JSON.stringify(out)}`);
    }
  });

  // SEC-15 addition, and the reason it is a separate check rather than one more
  // fixture above: a BACKTICK inside a regex character class is the shape that
  // actually took a suite to zero in the merged tree — migration-state.test.js
  // parses its ledger rows with one — and **the length invariant cannot see
  // it**. Measured, not assumed: with the regex arm removed the backtick
  // fixture still comes back byte-for-byte the same LENGTH, because the
  // backtick opens a template literal that runs to end of file and an
  // unterminated string is length-preserving. Everything after it is blanked
  // all the same. So length preservation is necessary and not sufficient, and
  // the property worth asserting is the one that broke: a check written after
  // such a regex is still FOUND.
  //
  // Single-quoted fixtures deliberately. Inside a template literal a backtick
  // has to be written escaped, and the lexer would then take its escape path
  // rather than the bare-delimiter path this exists to exercise.
  check('scanner: a regex holding a backtick does not swallow the checks after it', () => {
    const src = 'const m = line.match(/^\\|\\s*(\\d{3})\\s*[`\\w\\s()]*\\|/);\n'
      + "check('the check after the regex', () => { assert.ok(thing); });\n";
    assert.strictEqual(findChecks(src).length, 1,
      'a regex holding a backtick swallowed the check that followed it');
    // And the length invariant is satisfied by the very same input, which is
    // the point: it agrees the output is fine while the code is gone. Asserted
    // on the CODE around the check name, not the name itself — blanking string
    // bodies is what this helper is for.
    const blanked = blankNonCode(src);
    assert.strictEqual(blanked.length, src.length, 'this fixture is length-preserving either way');
    assert.ok(/assert\.ok\(thing\)/.test(blanked),
      `the code after the regex was blanked despite the length being right: ${JSON.stringify(blanked)}`);
  });

  check('scanner: shape A fires on an early return that reaches no assertion', () => {
    const bad = findChecks(`
      check('x', () => {
        if (process.platform !== 'darwin') return;
        assert.ok(thing);
      });
    `);
    assert.strictEqual(bad.length, 1, 'fixture did not parse to one check');
    assert.strictEqual(assertionFreeExits(bad[0]).length, 1, 'shape A missed the early return');
  });

  check('scanner: shape A does NOT fire on a return that follows a real assertion', () => {
    // redaction.test.js's keychain round-trip check: the off-platform branch
    // asserts the fail-closed contract and THEN returns. That is a check that
    // can fail on every platform, and must not be reported.
    const good = findChecks(`
      check('x', () => {
        if (!keychain.available()) {
          assert.strictEqual(keychain.load('anything'), null);
          return;
        }
        assert.ok(keychain.store('a', 'b'));
      });
    `);
    assert.strictEqual(good.length, 1, 'fixture did not parse to one check');
    assert.deepStrictEqual(assertionFreeExits(good[0]), [], 'false positive on an asserted-then-return branch');
  });

  check('scanner: shape A ignores a `return` that is inside a comment or a string', () => {
    const good = findChecks(`
      check('x', () => {
        // if this fails, return early and fix the fixture
        assert.ok(thing, 'do not return here');
      });
    `);
    assert.strictEqual(good.length, 1, 'fixture did not parse to one check');
    assert.deepStrictEqual(assertionFreeExits(good[0]), [], 'comment/string text was read as control flow');
  });

  check('scanner: shape B fires on the Windows guard family shape (if with no else, assertions inside)', () => {
    const bad = findChecks(`
      check('x', () => {
        if (notRoot() && denied) {
          assert.throws(() => util.loadState(), /refusing to touch/i);
        }
      });
    `);
    assert.strictEqual(bad.length, 1, 'fixture did not parse to one check');
    assert.strictEqual(conditionsSwallowingEveryAssertion(bad[0]).length, 1, 'shape B missed the no-else wrapper');
  });

  check('scanner: shape B does NOT fire when the same wrapper has an else, or an assertion outside it', () => {
    const withElse = findChecks(`
      check('x', () => {
        if (canDeny) { assert.throws(f); } else { assert.strictEqual(g(), null); }
      });
    `);
    assert.deepStrictEqual(conditionsSwallowingEveryAssertion(withElse[0]), [], 'false positive: the else branch asserts too');
    const alsoOutside = findChecks(`
      check('x', () => {
        if (canDeny) { assert.throws(f); }
        assert.ok(alwaysTrueOfTheProduct);
      });
    `);
    assert.deepStrictEqual(conditionsSwallowingEveryAssertion(alsoOutside[0]), [], 'false positive: an assertion runs unconditionally');
  });

  check('scanner: detects an unawaited async check, and does not flag the awaited form', () => {
    const bad = findChecks(`
      check('x', async () => { assert.ok(await thing()); });
    `);
    assert.strictEqual(bad.length, 1, 'fixture did not parse to one check');
    assert.strictEqual(bad[0].isAsync, true, 'async callback not recognised');
    assert.strictEqual(bad[0].awaited, false, 'unawaited call reported as awaited');
    const good = findChecks(`
      await check('x', async () => { assert.ok(await thing()); });
    `);
    assert.strictEqual(good[0].awaited, true, 'awaited call reported as unawaited');
  });

  // ---- the runtime half has teeth too. Drive check-accounting directly with
  // fixture checks, so the gate itself is under test rather than assumed.

  await check('runtime gate: a check that asserts nothing is recorded as a FAIL, not an ok', async () => {
    const results = [];
    const { check: c } = accounting.createCheck(results);
    await quiet(() => c('vacuous', () => { const x = 1 + 1; return x; }));
    assert.strictEqual(results.length, 1, 'the check was not recorded at all');
    assert.ok(results[0][1], 'a check that asserted nothing was recorded as passing');
    assert.match(results[0][1].message, /made no assertion/);
  });

  await check('runtime gate: a check that DOES assert is still recorded as an ok', async () => {
    // The counter-check. A gate that fails everything is not a gate.
    const results = [];
    const { check: c } = accounting.createCheck(results);
    await quiet(() => c('real', () => { assert.strictEqual(1, 1); }));
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0][1], null, `a genuine check was failed by the gate: ${results[0][1] && results[0][1].message}`);
  });

  await check('runtime gate: checkNoThrow is the exemption, and it costs a written reason', async () => {
    const results = [];
    const { checkNoThrow: cnt } = accounting.createCheck(results);
    await quiet(() => cnt('no-throw', 'the assertion is that this call does not throw', () => { const x = 1; void x; }));
    assert.strictEqual(results[0][1], null, 'checkNoThrow was not exempted from the assertion requirement');
    assert.throws(() => cnt('no-reason', 'eh', () => {}), /needs a reason/,
      'the exemption must not be available without saying why');
  });

  await check('runtime gate: an unawaited async check is named as still in flight, not silently dropped', async () => {
    const results = [];
    const { check: c, checkNothingLeftInFlight } = accounting.createCheck(results);
    await quiet(async () => {
      c('slow one', async () => { await new Promise(r => setTimeout(r, 30)); assert.ok(true); }); // deliberately unawaited
      checkNothingLeftInFlight();
      // Drain the stray INSIDE the quiet window. Without this it settles later
      // and prints `ok slow one` into the real transcript — a fixture result
      // sitting among genuine ones, which is precisely the confusion this
      // suite exists to remove.
      await new Promise(r => setTimeout(r, 80));
    });
    const inFlight = results.find(([n]) => /left in flight/.test(n));
    assert.ok(inFlight, 'the in-flight guard did not register');
    assert.ok(inFlight[1], 'an unawaited check was not reported');
    assert.match(inFlight[1].message, /slow one/, 'the report must NAME the check that was left running');
    await new Promise(r => setTimeout(r, 60)); // let the stray settle before the process moves on
  });

  await check('runtime gate: with every check awaited, the in-flight guard passes', async () => {
    const results = [];
    const { check: c, checkNothingLeftInFlight } = accounting.createCheck(results);
    await quiet(async () => {
      await c('awaited one', async () => { await new Promise(r => setTimeout(r, 5)); assert.ok(true); });
      checkNothingLeftInFlight();
    });
    const inFlight = results.find(([n]) => /left in flight/.test(n));
    assert.strictEqual(inFlight[1], null, `false positive from the in-flight guard: ${inFlight[1] && inFlight[1].message}`);
  });

  check('runtime gate: the counting assert is handed to test/ only — lib/ gets the real module', () => {
    // If the wrapper leaked into product code, the code under test would be
    // running against something other than what ships.
    const fromLib = require('../../lib/util');
    assert.ok(fromLib, 'lib/util did not load');
    const before = accounting.assertionsMade();
    require('assert').ok(true);
    // +1, not +2: assertionsMade() is evaluated as an ARGUMENT, before the
    // strictEqual wrapper it is being passed to has run.
    assert.strictEqual(accounting.assertionsMade(), before + 1,
      'an assertion made from test/ was not counted — the counting copy is not reaching this file');
  });

  // ---- the bite. Every check in every scanned file, held to both shapes.

  check('no check in the suite has an exit path that reaches no assertion (shape A)', () => {
    const violations = [];
    for (const s of scanned) {
      for (const chk of s.checks) {
        if (chk.kind === 'checkNoThrow') continue; // exempt by construction
        for (const hit of assertionFreeExits(chk)) {
          violations.push(`${s.file}:${chk.line} — ${chk.name.slice(0, 70)}`
            + ` (exit at body offset ${hit.at} reaches no assertion)`);
        }
      }
    }
    assert.deepStrictEqual(violations, [],
      'these checks return before asserting anything, so on the platform or machine that takes that\n'
      + 'branch they print `ok` having proven nothing. Assert the contract that DOES hold on that\n'
      + 'branch, or say the precondition was not met out loud with skip(name, why).\n'
      + violations.join('\n'));
  });

  check('no check hides its entire body behind a condition with no else (shape B)', () => {
    const violations = [];
    for (const s of scanned) {
      for (const chk of s.checks) {
        if (chk.kind === 'checkNoThrow') continue;
        for (const hit of conditionsSwallowingEveryAssertion(chk)) {
          violations.push(`${s.file}:${chk.line} — ${chk.name.slice(0, 70)} `
            + `(all ${hit.inside} assertion(s) inside \`if (${hit.cond})\`, no else)`);
        }
      }
    }
    assert.deepStrictEqual(violations, [],
      'every assertion in these checks is inside one `if` with no else, so where the condition is\n'
      + 'false the check asserts nothing and still reports ok — the Windows guard family verbatim.\n'
      + 'Register the check only where the precondition holds and skip() otherwise, or assert the\n'
      + 'contract that holds in the other branch.\n'
      + violations.join('\n'));
  });

  check('every async check(...) call is awaited', () => {
    const violations = [];
    for (const s of scanned) {
      for (const chk of s.checks) {
        if (chk.isAsync && !chk.awaited) violations.push(`${s.file}:${chk.line} — ${chk.name.slice(0, 70)}`);
      }
    }
    assert.deepStrictEqual(violations, [],
      'an async check that is not awaited settles AFTER the reporter has totalled, so its result —\n'
      + 'pass or fail — reaches nobody. Add `await` at the call site.\n'
      + violations.join('\n'));
  });

  h.finish();
}

main().catch(err => { console.error(err); process.exit(1); });
