'use strict';
// A serve with no tier must not be counted as a Tier B serve (REV-5).
//
// WHY THIS FIELD MATTERS MORE THAN IT LOOKS. avoided.tierA / avoided.tierB are
// the only thing that lets a later reader ask WHY `avoided` moved: Tier A
// rising means the pointer tier stopped being suppressed, Tier B rising means
// more files became eligible. Different causes, different follow-ups. That
// question is about to be asked for real -- REV-4 decoupled Tier A from the
// store, which will raise Tier A volume as a side effect of a CORRECTNESS fix
// rather than the mechanism improving, and in a month the only way to tell
// those apart will be these counters.
//
// THE BUG. settleRows counted `if (tier === 'A') tierA++ else tierB++`, so a
// row carrying no tier at all -- a pre-upgrade queue row, or a torn one --
// was recorded as a Tier B serve. An unknown counted as a known, on the one
// field the attribution depends on: a batch of untiered rows would read as
// "eligibility widened" when nothing of the sort happened.
//
// Tier C folding into tierB is KEPT: that is a judgement that two things are
// alike (they share the same cached-skeleton body). Folding `undefined` in
// with them was never a judgement, just an else.
//
// Run directly, or via `node test/run.js ledger-tier-attribution`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const { settleRows } = require('../../lib/ledger-fold-recall-settle');

const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const TS = '2026-08-05T11:00:00.000Z';

// A serve is two queue rows: the pending row carrying the detail, and the
// confirmation. Both are needed or settleRows retains rather than settles.
function serveRows(relPath, tier, i) {
  const ts = new Date(Date.parse(TS) + i * 1000).toISOString();
  const pending = {
    ts, sessionId: 's1', relPath, callTokens: 1000, skeletonTokens: 200,
    holdout: false, committed: false,
  };
  if (tier !== undefined) pending.tier = tier;
  return [pending, { ts, sessionId: 's1', relPath, committed: true }];
}

const settle = rows => settleRows(rows, NOW, () => ({}), new Set(), new Set(), new Set());

function main() {
  // ---- 1. THE BUG ----
  check('a serve row with NO tier counts as unknown, not as Tier B', () => {
    const { avoidedDelta } = settle(serveRows('lib/a.js', undefined, 0));
    assert.strictEqual(avoidedDelta.tierB, 0,
      'an untiered serve was recorded as a Tier B serve — a batch of these reads as "eligibility widened" when '
      + 'nothing of the sort happened, on the one field the attribution depends on');
    assert.strictEqual(avoidedDelta.tierUnknown, 1, 'the untiered serve was not recorded anywhere');
    assert.strictEqual(avoidedDelta.serves, 1, 'the serve stopped being counted at all');
  });

  // ---- 2. COUNTER-CHECKS: the known tiers are untouched ----
  // These read tierUnknown as `|| 0` ON PURPOSE. The field does not exist on
  // the pre-fix shape, and a counter-check that fails before the fix proves
  // nothing about the fix not breaking anything. Tightening this to a strict
  // 0 would turn three counter-checks back into three more RED checks.
  check('COUNTER: a Tier A serve still counts as Tier A', () => {
    const { avoidedDelta } = settle(serveRows('lib/a.js', 'A', 0));
    assert.strictEqual(avoidedDelta.tierA, 1);
    assert.strictEqual(avoidedDelta.tierB, 0);
    assert.strictEqual(avoidedDelta.tierUnknown || 0, 0, 'a known tier leaked into the unknown bucket');
  });
  check('COUNTER: a Tier B serve still counts as Tier B', () => {
    const { avoidedDelta } = settle(serveRows('lib/b.js', 'B', 0));
    assert.strictEqual(avoidedDelta.tierB, 1);
    assert.strictEqual(avoidedDelta.tierUnknown || 0, 0, 'a known tier leaked into the unknown bucket');
  });
  check('COUNTER: Tier C still folds into Tier B, deliberately', () => {
    const { avoidedDelta } = settle(serveRows('lib/c.js', 'C', 0));
    assert.strictEqual(avoidedDelta.tierB, 1,
      'Tier C stopped folding into tierB — that fold is a judgement that two mechanically identical tiers belong '
      + 'together, and this change was only ever meant to stop `undefined` riding along with them');
    assert.strictEqual(avoidedDelta.tierUnknown || 0, 0);
  });

  // ---- 3. the invariant that makes the breakdown trustworthy ----
  // If these three ever stop summing to `serves`, the breakdown is lying about
  // a total it is supposed to decompose, which is worse than not having it.
  check('tierA + tierB + tierUnknown always equals serves', () => {
    const rows = [
      ...serveRows('lib/a.js', 'A', 0),
      ...serveRows('lib/b.js', 'B', 1),
      ...serveRows('lib/c.js', 'C', 2),
      ...serveRows('lib/d.js', undefined, 3),
      ...serveRows('lib/e.js', 'Z', 4), // a tier from a future build this one does not know
    ];
    const { avoidedDelta: d } = settle(rows);
    assert.strictEqual(d.serves, 5, 'not every serve settled');
    assert.strictEqual(d.tierA + d.tierB + d.tierUnknown, d.serves,
      `the breakdown does not decompose the total it claims to: A=${d.tierA} B=${d.tierB} U=${d.tierUnknown} of ${d.serves}`);
    assert.strictEqual(d.tierUnknown, 2, 'an unrecognised future tier must land in unknown, not in a known bucket');
  });

  h.finish();
}

main();
