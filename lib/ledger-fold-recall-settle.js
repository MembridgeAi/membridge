'use strict';
// Settlement math for the direct-avoidance fold (spec §7.1, §7.3; Task 6).
// Split out of lib/ledger-fold-recall.js so that module stays under the
// file-size budget -- this half owns "given these queued rows and this
// clock, which serves are settleable and what do they net", the other half
// owns the actual queue file I/O (read, bound, rewrite) and the
// lib/ledger-store.js entry point. See lib/ledger-fold-recall.js's own
// header for the full impure/pure split rationale (mirrors ledger-fold.js /
// ledger-fold-state.js's own precedent).
//
//   net = callTokens - (skeletonTokens + followTokens)
//
// followTokens is priced with recall.estimateCallTokens(limit, fileStat) --
// the EXACT function lib/recall.js's decide() uses to price the original
// call -- applied to the follow-up read's OWN offset/limit. Reusing it
// (rather than re-deriving the same arithmetic here) is deliberate: pricing
// both sides of the formula with two different estimators would make "net"
// meaningless the moment they drift apart.
const fs = require('fs');
const path = require('path');
const recall = require('./recall');
const { readKeyFor } = require('./ledger-fold');

// Bug fix round 1 (post-review): how long a committed serve row must sit in
// the queue before it is eligible to settle. WITHOUT this window, the race
// is real and routine, not theoretical: syncOnce ticks every intervalSec
// (default 60s, configurable down to 15s -- see lib/util.js's getConfig),
// and lib/hooks-recall.js writes a serve's pending row plus its committed
// confirmation SYNCHRONOUSLY, within milliseconds of each other, inside the
// very same PreToolUse hook invocation that answered the read. So the very
// next fold tick after a serve is committed can -- and typically does --
// see it before the agent's follow-up read (if any) has had a chance to
// happen. Settling on that first pass always finds followTokens=0, which
// mis-files every partial win as full avoidance and starves bumpRejection of
// the net-negative cases spec §7.3 exists for -- silently defeating the
// whole point of this fold. lib/scan.js's settleProvisionalCommits() faces
// the analogous "don't settle before the corroborating evidence has had a
// chance to arrive" problem for commit attribution and solves it with a
// bounded grace window (SETTLE_GRACE_MS); this is the same pattern applied
// here.
//
// 5 minutes: the corroborating evidence here is a follow-up READ, not a
// follow-up COMMIT, so it arrives on a much shorter clock than scan.js's
// 15-minute commit-settle grace -- a same-session follow-up read of a served
// path, when it happens at all, is essentially always part of the SAME
// agent turn that received the skeleton (the agent asks again seconds to
// tens of seconds later, not commit-review-later). 5 minutes comfortably
// outlasts one turn (and several sync ticks at the fastest configurable 15s
// interval) while still keeping the ledger's numbers fresh within a few
// minutes, not hours -- unlike a commit's provenance, nobody is blocked
// waiting on a serve to settle.
const RECALL_SETTLE_GRACE_MS = 5 * 60 * 1000;

// A serve lands as TWO rows (lib/hooks-recall.js): a pending row carrying
// the full detail (tier/callTokens/skeletonTokens/holdout:false,
// committed:false), written BEFORE the session-state commit, and a
// confirmation row (committed:true, otherwise just ts/sessionId/relPath)
// written only once that commit actually succeeded, as a SEPARATE
// appendFileSync call. Group rows by their shared ts|sessionId|relPath key
// (the two rows of one serve are always stamped with the exact same ts) so
// the pending/confirmation pair -- or a still-unconfirmed pending row -- can
// be reasoned about together.
//
// Bug fix round 1: a pending row with NO confirmation is only a genuine
// phantom (the state write failed, the agent never received the serve --
// spec: "a phantom row from a failed session-state write") once it is OLD
// ENOUGH that its confirmation can no longer still be in flight. A fold
// landing in the gap between hooks-recall.js's two appendFileSync calls
// used to see an as-yet-unconfirmed row and drop it right there -- silently
// UNDER-counting a real serve, the one residual that runs the opposite
// direction from everything else this module accepts. Reusing
// RECALL_SETTLE_GRACE_MS for this too is deliberate: that gap is at most the
// time between two synchronous calls in the same function (microseconds),
// so any grace window generous enough to wait out a follow-up READ is
// trivially generous enough to wait out a same-hook confirmation write.
//
// Returns { settleGroups, retained }: settleGroups holds serves ready to be
// reduced this pass (committed AND past grace); retained holds every row
// (holdout excluded -- see below) that must stay queued for a later pass,
// either because it is not yet aged past the grace window or because it is
// still waiting on a confirmation that has not (yet, or ever) arrived.
function groupServeRows(rows, now) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.ts}|${row.sessionId}|${row.relPath}`;
    // A pending row is explicitly holdout:false, committed:false (the full
    // detail rows carries). A confirmation row carries NEITHER a `holdout`
    // field nor any detail beyond ts/sessionId/relPath -- lib/hooks-recall.js's
    // own appendEvent for it is exactly `{ ts, sessionId, relPath,
    // committed: true }` -- so it must be recognized by committed===true
    // alone, never gated on a holdout field it was never given. Anything
    // else (holdout:true rows, garbage) falls through unclassified here.
    if (row.holdout === false && row.committed === false) {
      const slot = byKey.get(key) || {};
      slot.pending = row;
      byKey.set(key, slot);
    } else if (row.committed === true) {
      const slot = byKey.get(key) || {};
      slot.confirm = row;
      byKey.set(key, slot);
    }
  }

  const settleGroups = [];
  const retained = [];
  for (const { pending, confirm } of byKey.values()) {
    if (!pending) continue; // a stray confirmation with no pending row: nothing to settle or retain
    const ts = Date.parse(pending.ts);
    // An unparseable ts can never certify its own age -- treat it as already
    // past grace so a garbled row does not wait forever, matching this
    // module's existing "one bad row never blocks the fold" stance.
    const pastGrace = !Number.isFinite(ts) || (now - ts) >= RECALL_SETTLE_GRACE_MS;
    if (!confirm) {
      if (!pastGrace) retained.push(pending); // may still be confirmed by the next pass
      // else: genuinely a phantom -- past grace, no confirmation ever showed. Dropped.
      continue;
    }
    if (!pastGrace) { retained.push(pending); retained.push(confirm); continue; }
    settleGroups.push(pending);
  }
  return { settleGroups, retained };
}

// Bytes of the CURRENT on-disk file, for pricing a follow-up read that
// carried no `limit` (a full re-read) -- mirrors the fileStat.size the
// PreToolUse hook itself stats at call time (lib/hooks-recall.js). A file
// that has since moved/vanished prices as 0 rather than throwing: the fold
// must never abort over one stale path.
function byteSizeOf(projectPath, relPath) {
  try {
    return fs.statSync(path.join(projectPath, relPath)).size;
  } catch {
    return 0;
  }
}

// followTokens for one committed serve: every same-session read of the same
// path in `readEvents` (proj.events' own 'read' rows) whose timestamp is
// STRICTLY LATER than the serve's -- the serve's own triggering call always
// carries an earlier or equal timestamp (the hook's row is stamped after the
// transcript already recorded the call), so this filter alone keeps it out
// without any extra bookkeeping. Multiple later reads (the agent going back
// more than once) all count -- "actually pulled" is the total, not just the
// first.
function followTokensFor(serve, readEvents, projectPath) {
  let total = 0;
  let sizeBytes = null; // stat only if/when actually needed, and only once
  for (const e of readEvents) {
    if (!e || e.kind !== 'read' || !e.file) continue;
    if ((e.session || '') !== serve.sessionId) continue;
    if (readKeyFor(projectPath, e.file) !== serve.relPath) continue;
    if (!(String(e.ts) > String(serve.ts))) continue;
    if (e.limit) {
      total += recall.estimateCallTokens(e.limit, null);
    } else {
      if (sizeBytes === null) sizeBytes = byteSizeOf(projectPath, serve.relPath);
      total += recall.estimateCallTokens(null, { size: sizeBytes });
    }
  }
  return total;
}

const zeroAvoided = () => ({ tokens: 0, serves: 0, tierA: 0, tierB: 0, partialWins: 0, netNegatives: 0 });
const zeroHoldout = () => ({ skips: 0, callTokens: 0 });

// Settle every committed serve that has cleared RECALL_SETTLE_GRACE_MS
// against `readEvents` (proj.events, already in hand -- the same window
// lib/ledger-fold.js's own foldReads folds) and reduce the batch to plain
// deltas. `retained` carries back every row (parsed object, not yet
// re-serialized) that must stay queued for a later pass -- see
// groupServeRows' header. No I/O of its own beyond the one byteSizeOf stat
// per no-limit follow-up, and now(), itself injectable -- easy to call from
// a test with canned rows and a fixed clock.
function settleRows(rows, readEvents, projectPath, nowFn = Date.now) {
  const avoidedDelta = zeroAvoided();
  const holdoutDelta = zeroHoldout();
  const rejections = [];
  const now = nowFn();

  const { settleGroups, retained } = groupServeRows(rows, now);
  for (const serve of settleGroups) {
    const followTokens = followTokensFor(serve, readEvents, projectPath);
    const net = serve.callTokens - (serve.skeletonTokens + followTokens);
    avoidedDelta.tokens += net;
    avoidedDelta.serves += 1;
    if (serve.tier === 'A') avoidedDelta.tierA += 1;
    // Tier C shares tier B's mechanics (the same cached-skeleton body --
    // lib/recall.js's tierBBody serves both) and the ledger shape only
    // distinguishes pointer-vs-skeleton, not B-vs-C, so C folds into tierB.
    else avoidedDelta.tierB += 1;
    if (followTokens > 0) {
      // A follow-up happened: either it clawed back less than the skeleton
      // saved (a PARTIAL WIN, net >= 0 -- the whole point of the §7.1
      // revision) or more (a real loss). "No follow-up" (followTokens === 0)
      // is full avoidance and deliberately lands in neither bucket.
      if (net < 0) {
        avoidedDelta.netNegatives += 1;
        rejections.push(serve.relPath);
      } else {
        avoidedDelta.partialWins += 1;
      }
    }
  }

  for (const row of rows) {
    if (row.holdout !== true) continue;
    holdoutDelta.skips += 1;
    holdoutDelta.callTokens += Number.isFinite(row.callTokens) ? row.callTokens : 0;
  }

  return { avoidedDelta, holdoutDelta, rejections, retained };
}

module.exports = {
  settleRows, groupServeRows, followTokensFor, byteSizeOf,
  zeroAvoided, zeroHoldout, RECALL_SETTLE_GRACE_MS,
};
