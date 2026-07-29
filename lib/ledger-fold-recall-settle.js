'use strict';
// Settlement math for the direct-avoidance fold (spec §7.1, §7.3; Task 6).
// Split out of lib/ledger-fold-recall.js so that module stays under the
// file-size budget -- this half owns "given these queued rows and this
// clock, which serves are settleable and what does each one net", the other
// half owns the actual queue file I/O (read, bound, rewrite), the open-serve
// correction pass (lib/ledger-fold-recall-open-serves.js), and the
// lib/ledger-store.js entry point. See lib/ledger-fold-recall.js's own
// header for the full impure/pure split rationale.
//
//   net = callTokens - (skeletonTokens + followTokens)
//
// followTokens is priced with recall.estimateCallTokens(limit, fileStat) --
// the EXACT function lib/recall.js's decide() uses to price the original
// call -- applied to a follow-up read's OWN offset/limit. Reusing it (rather
// than re-deriving the same arithmetic here) is deliberate: pricing both
// sides of the formula with two different estimators would make "net"
// meaningless the moment they drift apart.
//
// Fix round 2 (revisable settlement, spec §7.1 revision): a committed serve
// used to wait RECALL_SETTLE_GRACE_MS (5 minutes) before settling at all, so
// a same-session follow-up read that landed inside the window could be
// priced into followTokens up front. Measured against 57,941 real
// same-session re-reads, a 5-minute window still missed ~34% of follow-ups
// (median gap 1 min, p75 11 min, p90 59 min, p95 154 min) -- each of those
// misses permanently recorded a serve as full avoidance even though the
// agent went on to re-pull real content, inflating the headline number.
// Widening the window to 60 minutes still leaves ~10% permanently
// overstated -- there is no fixed window that both settles promptly AND
// waits long enough. So this module no longer waits at all: every committed
// serve settles on the very FIRST fold pass that sees it, optimistically
// priced with followTokens = 0 (full avoidance). Later reads correct that
// number instead of racing to beat a clock -- see
// lib/ledger-fold-recall-open-serves.js for the correction pass, and
// lib/ledger-fold.js's header for why avoided.tokens is now the one total
// this ledger allows to move down as well as up.
const fs = require('fs');
const path = require('path');
const recall = require('./recall');

// How long an uncommitted PENDING row may sit in the queue before it is
// treated as a genuine phantom (see groupServeRows below). This is a much
// narrower concern than the old follow-up-settling grace window it replaces:
// hooks-recall.js writes a serve's pending row and its committed
// confirmation as TWO SEPARATE, SYNCHRONOUS appendFileSync calls inside the
// same PreToolUse hook invocation, with nothing but a session-state write in
// between -- microseconds, not minutes. A fold landing in that gap must not
// mistake an about-to-be-confirmed row for a permanent failure and drop it
// (that would silently UNDER-count a real serve). One minute is generously
// longer than any realistic hook execution time while still keeping a truly
// abandoned pending row (the state write actually failed) from lingering in
// the queue indefinitely.
const PENDING_CONFIRM_GRACE_MS = 60 * 1000;

// A serve lands as TWO rows (lib/hooks-recall.js): a pending row carrying
// the full detail (tier/callTokens/skeletonTokens/holdout:false,
// committed:false), written BEFORE the session-state commit, and a
// confirmation row (committed:true, otherwise just ts/sessionId/relPath)
// written only once that commit actually succeeded. Group rows by their
// shared ts|sessionId|relPath key (the two rows of one serve are always
// stamped with the exact same ts) so the pending/confirmation pair -- or a
// still-unconfirmed pending row -- can be reasoned about together.
//
// Returns { settleGroups, retained }: settleGroups holds every serve that IS
// confirmed -- settled unconditionally, no age check (see the file header);
// retained holds every pending row that is NOT yet confirmed and not yet old
// enough to give up on (see PENDING_CONFIRM_GRACE_MS above).
function groupServeRows(rows, now) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.ts}|${row.sessionId}|${row.relPath}`;
    // A pending row is explicitly holdout:false, committed:false. A
    // confirmation row carries NEITHER a `holdout` field nor any detail
    // beyond ts/sessionId/relPath -- lib/hooks-recall.js's own appendEvent
    // for it is exactly `{ ts, sessionId, relPath, committed: true }` -- so
    // it must be recognized by committed===true alone, never gated on a
    // holdout field it was never given.
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
    if (confirm) {
      settleGroups.push(pending); // confirmed: settle NOW, no age check (item 1)
      continue;
    }
    const ts = Date.parse(pending.ts);
    // An unparseable ts can never certify its own age -- treat it as already
    // past grace so a garbled row does not wait forever.
    const pastGrace = !Number.isFinite(ts) || (now - ts) >= PENDING_CONFIRM_GRACE_MS;
    if (!pastGrace) retained.push(pending); // may still be confirmed by the next pass
    // else: genuinely a phantom -- past grace, no confirmation ever showed. Dropped.
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

// Token price of ONE read event, priced the exact same way the original
// call was (recall.estimateCallTokens) -- shared by
// lib/ledger-fold-recall-open-serves.js's correction pass so every reader of
// the same event prices it identically. relPath is the CANONICAL
// (project-relative) path the caller already resolved via readKeyFor -- the
// only I/O here is the one byteSizeOf stat, and only for a no-limit read.
function estimateReadTokens(e, projectPath, relPath) {
  if (e.limit) return recall.estimateCallTokens(e.limit, null);
  return recall.estimateCallTokens(null, { size: byteSizeOf(projectPath, relPath) });
}

const zeroAvoided = () => ({ tokens: 0, serves: 0, tierA: 0, tierB: 0, partialWins: 0, netNegatives: 0 });
const zeroHoldout = () => ({ skips: 0, callTokens: 0 });

// Settle every CONFIRMED serve in `rows` immediately, optimistically pricing
// followTokens as 0 (item 1) -- no I/O, no clock dependency beyond grouping
// pending/confirmation pairs. Each settled serve nets the full
// callTokens - skeletonTokens and is handed back as a fresh OPEN SERVE
// record (see lib/ledger-fold-recall-open-serves.js's buildOpenServe) so a
// later fold can still correct it against a real follow-up read.
//
// A serve with followTokens===0 is classified 'full' and deliberately never
// touches partialWins/netNegatives -- those only exist once a follow-up read
// (initially: none; later: a correction) is actually in evidence. This
// mirrors the pre-revision rule exactly; only the WHEN (immediately vs after
// a grace wait) changed.
//
// `retained` carries back every pending row that must stay queued for a
// later pass (see groupServeRows' header).
function settleRows(rows, now, buildOpenServe) {
  const avoidedDelta = zeroAvoided();
  const holdoutDelta = zeroHoldout();
  const newOpenServes = [];

  const { settleGroups, retained } = groupServeRows(rows, now);
  for (const serve of settleGroups) {
    const net = serve.callTokens - serve.skeletonTokens;
    avoidedDelta.tokens += net;
    avoidedDelta.serves += 1;
    if (serve.tier === 'A') avoidedDelta.tierA += 1;
    // Tier C shares tier B's mechanics (the same cached-skeleton body --
    // lib/recall.js's tierBBody serves both) and the ledger shape only
    // distinguishes pointer-vs-skeleton, not B-vs-C, so C folds into tierB.
    else avoidedDelta.tierB += 1;
    newOpenServes.push(buildOpenServe(serve, net, now));
  }

  for (const row of rows) {
    if (row.holdout !== true) continue;
    holdoutDelta.skips += 1;
    holdoutDelta.callTokens += Number.isFinite(row.callTokens) ? row.callTokens : 0;
  }

  return { avoidedDelta, holdoutDelta, newOpenServes, retained };
}

module.exports = {
  settleRows, groupServeRows, byteSizeOf, estimateReadTokens,
  zeroAvoided, zeroHoldout, PENDING_CONFIRM_GRACE_MS,
};
