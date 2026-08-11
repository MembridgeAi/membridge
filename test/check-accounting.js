'use strict';
// A check that never ran still prints `ok`.
//
// REQUIRE THIS BEFORE `require('assert')` in any file that registers checks.
// Both test/harness.js (the split suites) and test/run-tests.js (the legacy
// monolith) do, and they share this file rather than duplicating it, because a
// gate that covers one of the two runners covers the half of the suite the bug
// did not happen to land in.
//
// WHY (four instances in one week, all real):
//
//   1. An `async` check() that was never `await`ed. The promise settled after
//      the reporter had already totalled, so the suite printed 19/19 over a
//      check whose assertions had not run yet — and would have printed the
//      same 19/19 if they had failed.
//   2. The Windows guard family (run-tests.js, the "read failure must not read
//      as missing" checks): every assertion wrapped in `if (notRoot() &&
//      denied) { ... }` with no else. `fs.chmod` on Windows cannot clear READ,
//      so `denied` was false and the whole body vanished. Five of six checks
//      stayed green on both Windows CI legs with the bug deliberately
//      restored. One of them carries the comment "If this check ever goes red,
//      do not fix it by loosening readSettings" — on Windows it could not go
//      red.
//   3. A crashed suite counting as 0/0, so a run whose largest suite died
//      still printed a green total. Fixed on the reporting side in test/run.js.
//   4. A stub that refuses the operation under test, so the check proves the
//      stub's behaviour rather than the code's.
//
// 1, 2 and 4 share one signature: the check made NO ASSERTION. Nothing in the
// output distinguishes that from a check that asserted and passed, which is
// why all four survived review. So count assertions and refuse the `ok`.
//
// HOW. Every `require('assert')` from inside test/ returns a counting copy
// instead of the real module. Scoped by the REQUIRING FILE, so lib/ and bin/
// get the real assert and nothing about the code under test changes. check()
// samples the counter before and after; a delta of zero is a FAIL.
//
// WHAT THIS CANNOT CATCH — read this before trusting a green run:
//
//   • Assertions that hold trivially. `assert.ok(true)`,
//     `assert.strictEqual(x, x)`, or an expected value computed by the same
//     code path under test all count as assertions. A counter cannot see the
//     difference; that stays a review problem.
//   • A stub whose behaviour, not the product's, is what the assertions
//     describe (instance 4). The check does assert, so it passes this gate.
//     Caught only by reading what the stub returns.
//   • Attribution is by counter delta, exact only while checks run one at a
//     time. Two checks genuinely in flight at once cross-attribute.
//   • The pending set is a BACKSTOP for instance 1, not the gate for it. It
//     only fires when nothing drained the stray promise before finish() —
//     measured: unawaiting a real check in team-invites let later awaits in
//     the same suite settle it, so pending was empty by the time finish() ran
//     and only a cascading `fetch failed` betrayed it. The gate that catches
//     an unawaited check UNCONDITIONALLY is the static one in
//     test/suites/checks-can-fail.test.js, which reads the call site.
//   • It sees the platform it runs on. A body that vanishes only on Windows
//     is caught only by the Windows CI leg. The static half reads every
//     platform's path at once, from any platform.
//   • The counting copy reaches files under test/ ONLY, by design (product
//     code must get the real module). A check file living anywhere ELSE gets
//     the real assert, so its assertions are not counted and every check in it
//     reads as vacuous. Hit live while building a throwaway fixture suite in a
//     temp dir: two genuine checks failed as "made no assertion". That is the
//     correct trade — scoping by requiring-file is what keeps the wrapper out
//     of lib/ — but a fixture suite outside test/ must not use this harness.
const path = require('path');

const ASSERTION_FNS = ['ok', 'equal', 'notEqual', 'strictEqual', 'notStrictEqual',
  'deepEqual', 'notDeepEqual', 'deepStrictEqual', 'notDeepStrictEqual',
  'throws', 'doesNotThrow', 'rejects', 'doesNotReject', 'match', 'doesNotMatch',
  'fail', 'ifError'];

let assertCount = 0;

function countingCopyOf(real) {
  const wrap = fn => function (...args) { assertCount++; return fn.apply(this, args); };
  const out = wrap(real); // assert is itself callable: `assert(v)` === assert.ok(v)
  for (const k of Object.getOwnPropertyNames(real)) {
    if (k === 'length' || k === 'name' || k === 'prototype') continue;
    const v = real[k];
    // ONLY assertion entry points are wrapped. AssertionError and CallTracker
    // are constructors; wrapping them breaks `new` and `instanceof`.
    out[k] = (typeof v === 'function' && ASSERTION_FNS.includes(k)) ? wrap(v) : v;
  }
  return out;
}

const realAssert = require('assert');
const countingAssert = countingCopyOf(realAssert);
countingAssert.strict = countingCopyOf(realAssert.strict);
countingAssert.strict.strict = countingAssert.strict;

// Hand the counting copy to test/ files only. Module._load is the single
// choke point for every require in the process; builtins bypass require.cache
// entirely, so there is no cache entry to swap instead.
let installed = false;
function install() {
  if (installed) return countingAssert;
  installed = true;
  const Module = require('module');
  const TEST_DIR = __dirname + path.sep;
  const origLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    const fromTest = parent && typeof parent.filename === 'string' && parent.filename.startsWith(TEST_DIR);
    if (fromTest) {
      if (request === 'assert' || request === 'node:assert') return countingAssert;
      if (request === 'assert/strict' || request === 'node:assert/strict') return countingAssert.strict;
    }
    return origLoad.call(this, request, parent, ...rest);
  };
  return countingAssert;
}

const VACUOUS = 'this check made no assertion, so it cannot fail and proves nothing. '
  + 'Either it never reached its assertions (an early return, or a condition with no '
  + 'else), or the assertions are gone. If asserting nothing IS the intent, use '
  + 'checkNoThrow(name, reason, fn) and the reason becomes readable.';

// Builds the check/checkNoThrow/pending trio over a caller-owned results array,
// so harness.js and run-tests.js keep their own tallies and their own finish().
function createCheck(results) {
  // Checks whose fn returned a promise that had not settled when the caller
  // moved on. An unawaited async check resolves AFTER the reporter has
  // totalled, so its result — pass or fail — reaches nobody. finish() refuses
  // to tally while this is non-empty.
  const pending = new Set();

  function check(name, fn, opts) {
    const before = assertCount;
    const settle = err => {
      if (!err && assertCount === before && !(opts && opts.mayAssertNothing)) err = new Error(VACUOUS);
      if (err) { results.push([name, err]); console.log(`  FAIL  ${name}\n        ${err.message}`); }
      else { results.push([name, null]); console.log(`  ok    ${name}`); }
    };
    try {
      const ret = fn();
      if (ret && typeof ret.then === 'function') {
        pending.add(name);
        return ret.then(
          () => { pending.delete(name); settle(null); },
          e => { pending.delete(name); settle(e); });
      }
      settle(null);
    } catch (err) {
      settle(err);
    }
  }

  // "The assertion is that this does not throw." Registers like check() and is
  // exempt from the made-an-assertion requirement. `reason` is required on
  // purpose: an exemption that costs nothing becomes the way to silence the
  // gate.
  function checkNoThrow(name, reason, fn) {
    if (typeof reason !== 'string' || reason.trim().length < 10) {
      throw new Error(`checkNoThrow(${JSON.stringify(name)}) needs a reason string saying why asserting nothing is the intent`);
    }
    return check(name, fn, { mayAssertNothing: true });
  }

  // Register this FIRST in finish(), before any other end-of-run guard: a
  // check still in flight here will never be seen, and naming it is the only
  // way it becomes visible.
  function checkNothingLeftInFlight() {
    check('no check was left in flight — every promise-returning check(...) was awaited', () => {
      countingAssert.deepStrictEqual([...pending], [],
        'these checks were still running when the suite finished, so their result reaches nobody: '
        + `${[...pending].map(n => JSON.stringify(n)).join(', ')}. Add \`await\` at the call site.`);
    });
  }

  // A check that is not registered at all is the same silence as a check that
  // asserts nothing. Where a precondition genuinely cannot be met (Windows
  // cannot make a file unreadable; a machine with Claude Code installed cannot
  // produce a registration miss), say so on stdout instead of registering a
  // green line. Skips print, so a run that skipped half its checks looks
  // different from a run that passed them.
  function skip(name, why) {
    console.log(`  skip  ${name} — ${why}`);
  }

  return { check, checkNoThrow, skip, pending, checkNothingLeftInFlight };
}

module.exports = {
  install, createCheck, countingAssert,
  assertionsMade: () => assertCount,
  ASSERTION_FNS,
};
