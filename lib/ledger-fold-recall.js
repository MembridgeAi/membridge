'use strict';
// Impure half of the direct-avoidance fold (spec §7.1, §7.3; Task 6). Reads
// the recall hook's queue file (.membridge/recall/events.jsonl, written by
// lib/hooks-recall.js), settles every fully-committed serve against any
// later same-session follow-up read of the same path, and returns the plain
// deltas lib/ledger-fold.js's foldRecallSettlement() adds onto the durable
// ledger.
//
// Kept OUT of lib/ledger-fold.js on purpose: that module stays a pure
// accumulator, table-testable with plain object literals (its own header
// says so), while settlement genuinely needs I/O -- reading the queue file,
// statting a follow-up read's target to price it with lib/recall.js's own
// estimator, and (on a net loss) calling lib/recall-store.js's
// bumpRejection. This module is where all of that I/O lives; ledger-fold.js
// only ever sees the already-reduced numbers.
//
//   net = callTokens - (skeletonTokens + followTokens)
//
// followTokens is priced with recall.estimateCallTokens(limit, fileStat) --
// the EXACT function lib/recall.js's decide() uses to price the original
// call -- applied to the follow-up read's OWN offset/limit. Reusing it
// (rather than re-deriving the same arithmetic here) is deliberate: pricing
// both sides of the formula with two different estimators would make "net"
// meaningless the moment they drift apart.
//
// The queue is append-only and otherwise unbounded (lib/hooks-recall.js
// documents its own separate byte-size rotation as a backstop). This fold
// bounds itself independently, at the row level: at most MAX_FOLD_LINES
// lines are consumed per call. A file bigger than that has its LEADING
// (oldest) lines processed and dropped; whatever is left past the bound
// stays queued for the next fold pass -- lines are never processed twice or
// silently discarded, just deferred.
const fs = require('fs');
const path = require('path');
const { DIR_NAME } = require('./memorydb');
const recall = require('./recall');
const recallStore = require('./recall-store');
const { readKeyFor } = require('./ledger-fold');

const MAX_FOLD_LINES = 10000;

// Duplicated from lib/hooks-recall.js's own recallDir/eventsPath rather than
// required from it: hooks-recall.js already requires lib/ledger-store.js
// (which requires this module through updateLedger), so importing it here
// would be a require cycle. Two one-line path builders staying in sync is a
// smaller cost than that.
const eventsPath = projectPath => path.join(projectPath, DIR_NAME, 'recall', 'events.jsonl');

// Read up to MAX_FOLD_LINES complete rows off the front of the queue.
// Missing file / unreadable -- an ordinary "nothing queued yet" state, not
// an error -- returns empty. A line that fails to parse (a torn write, a
// future/foreign row shape) is dropped rather than aborting the whole fold;
// one bad row must never block every row after it.
function readQueue(projectPath) {
  const file = eventsPath(projectPath);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { file, lines: [], remainder: [] };
  }
  const lines = text.split('\n').filter(Boolean);
  return { file, lines: lines.slice(0, MAX_FOLD_LINES), remainder: lines.slice(MAX_FOLD_LINES) };
}

function parseRows(lines) {
  const rows = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') rows.push(row);
    } catch {
      // one torn/foreign line never aborts the fold
    }
  }
  return rows;
}

// A serve lands as TWO rows (lib/hooks-recall.js): a pending row carrying
// the full detail (tier/callTokens/skeletonTokens/holdout:false,
// committed:false), written BEFORE the session-state commit, and a
// confirmation row (committed:true, otherwise just ts/sessionId/relPath)
// written only once that commit actually succeeded. A pending row with no
// matching confirmation is a phantom -- the state write failed, the agent
// never received the serve -- and must never be settled as one (spec: "a
// phantom row from a failed session-state write").
function committedServes(rows) {
  const confirmedKeys = new Set(
    rows.filter(r => r.committed === true).map(r => `${r.ts}|${r.sessionId}|${r.relPath}`),
  );
  return rows.filter(r => r.holdout === false && r.committed === false
    && confirmedKeys.has(`${r.ts}|${r.sessionId}|${r.relPath}`));
}

// Holdout rows (spec §7.2) are single, non-two-phase writes -- no pending/
// confirm pairing to resolve -- so every row is complete as logged.
const holdoutRows = rows => rows.filter(r => r.holdout === true);

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

// Settle every committed serve against `readEvents` (proj.events, already in
// hand -- the same window lib/ledger-fold.js's own foldReads folds) and
// reduce the whole batch to plain deltas. Pure given its inputs (no I/O of
// its own beyond the one byteSizeOf stat per no-limit follow-up), so it is
// the one piece of this module that stays easy to call from a test with
// canned rows.
function settleRows(rows, readEvents, projectPath) {
  const avoidedDelta = zeroAvoided();
  const holdoutDelta = zeroHoldout();
  const rejections = [];

  for (const serve of committedServes(rows)) {
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

  for (const h of holdoutRows(rows)) {
    holdoutDelta.skips += 1;
    holdoutDelta.callTokens += Number.isFinite(h.callTokens) ? h.callTokens : 0;
  }

  return { avoidedDelta, holdoutDelta, rejections };
}

// Truncate the queue down to whatever this pass did NOT consume (see
// readQueue's MAX_FOLD_LINES bound) and apply the rejection bumps a net loss
// earned. Called ONLY after the caller's ledger write has already succeeded
// (lib/ledger-store.js's updateLedger) -- truncating first and having the
// ledger write then fail would durably lose the very rows that write needed.
// Best-effort past that point, matching every other write in this codebase
// (rotateEvents in lib/hooks-recall.js, bumpRejection itself): a truncation
// failure here means the NEXT fold re-reads and re-settles the same rows,
// over-counting once -- the same "over-count is the acceptable direction"
// tradeoff lib/ledger-fold-state.js's own header already accepts elsewhere,
// never a lost or duplicated ledger write.
let writeCounter = 0;
function commit(projectPath, queue, rejections) {
  try {
    const dir = path.dirname(queue.file);
    const body = queue.remainder.length ? queue.remainder.join('\n') + '\n' : '';
    if (queue.remainder.length) {
      const tmp = path.join(dir, `.${path.basename(queue.file)}.${process.pid}.${writeCounter++}.tmp`);
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, queue.file);
    } else {
      fs.rmSync(queue.file, { force: true });
    }
  } catch {
    // best-effort; see the header comment above for the accepted residual
  }
  for (const relPath of rejections) {
    try { recallStore.bumpRejection(projectPath, relPath); } catch {}
  }
}

// The single entry point lib/ledger-store.js's updateLedger calls: read the
// queue, settle it against this pass's read events, hand back the deltas AND
// a `finish` closure the caller invokes only once its own ledger write has
// landed (see commit()'s header). A project with no queue file at all is the
// overwhelmingly common case (most projects never trip the recall hook) and
// costs one failed stat -- settleRecallQueue returns zero deltas and a no-op
// finish.
function settleRecallQueue(projectPath, readEvents) {
  const queue = readQueue(projectPath);
  if (!queue.lines.length) {
    return { avoidedDelta: zeroAvoided(), holdoutDelta: zeroHoldout(), finish: () => {} };
  }
  const rows = parseRows(queue.lines);
  const { avoidedDelta, holdoutDelta, rejections } = settleRows(rows, readEvents || [], projectPath);
  return { avoidedDelta, holdoutDelta, finish: () => commit(projectPath, queue, rejections) };
}

module.exports = { settleRecallQueue, settleRows, eventsPath, MAX_FOLD_LINES };
