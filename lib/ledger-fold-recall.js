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
// bumpRejection. This module is where all of that I/O lives.
//
// The settlement MATH itself (grace-window eligibility, followTokens
// pricing, net/partial-win/net-negative classification) lives in
// lib/ledger-fold-recall-settle.js, split out purely to keep this file under
// budget -- see that module's own header. This file owns: bounding and
// reading the queue file, calling settleRows, and (only once the caller's
// ledger write has landed) selectively rewriting the queue and applying
// rejection bumps.
//
// The queue is append-only and otherwise unbounded (lib/hooks-recall.js
// documents its own separate byte-size rotation as a backstop). This fold
// bounds itself independently, at the row level: at most MAX_FOLD_LINES
// lines are consumed per call. A file bigger than that has its LEADING
// (oldest) lines processed; whatever is left past the bound stays queued
// for the next fold pass -- lines are never processed twice or silently
// discarded, just deferred.
//
// Bug fix round 1: truncation of the consumed window is now SELECTIVE, not
// wholesale. Before this fix, every row inside the processed window was
// dropped from the queue regardless of whether it was actually settled --
// which discarded serves still waiting out RECALL_SETTLE_GRACE_MS (see the
// settle module) before their corroborating follow-up read could land. Now
// only rows settleRows actually settled (or genuinely-expired phantoms) are
// dropped; every retained row (see settleRows' return shape) is written
// back so the next pass re-examines it.
const fs = require('fs');
const path = require('path');
const { DIR_NAME } = require('./memorydb');
const recallStore = require('./recall-store');
const { settleRows, zeroAvoided, zeroHoldout, RECALL_SETTLE_GRACE_MS } = require('./ledger-fold-recall-settle');

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

// Rewrite the queue down to exactly what this pass did NOT finish with --
// the unconsumed MAX_FOLD_LINES overflow (queue.remainder) PLUS every row
// settleRows decided to retain (too young to settle, or a pending row still
// waiting on its confirmation) -- and apply the rejection bumps a net loss
// earned. Called ONLY after the caller's ledger write has already succeeded
// (lib/ledger-store.js's updateLedger) -- rewriting first and having the
// ledger write then fail would durably lose the very rows that write needed.
//
// Bug fix round 1 (Finding 3): the rejection bumps are now gated on the
// queue rewrite actually landing. Before this fix, bumpRejection ran
// unconditionally: with wholesale truncation, a rewrite failure meant the
// NEXT fold re-read and re-settled the exact same already-tallied rows,
// re-bumping rejections for the same net-negative serve every pass --
// against REJECTION_LIMIT=3 (lib/recall.js), a few failed rewrites in a row
// could disable serving a path from three genuinely distinct net-negative
// events, not three repeats of the SAME one. Now a failed rewrite skips this
// pass' bumps entirely: the settled rows stay OUT of the file we attempted
// to write (selective rewrite no longer includes them, matching every other
// write in this codebase -- rotateEvents in lib/hooks-recall.js,
// bumpRejection itself -- in being best-effort), so the next fold re-reads
// the UNCHANGED on-disk queue (still holding the pre-settlement rows) and
// re-settles the same serves from scratch, re-computing the same rejections
// list. The accepted residual: rejections are only durably counted on a
// pass whose queue rewrite succeeds, so REJECTION_LIMIT effectively counts
// distinct SUCCESSFUL settling passes, not every settlement computation --
// exactly mirroring the "over-count on retry, never lose or double-count a
// LANDED write" tradeoff lib/ledger-fold-state.js's own header already
// accepts elsewhere. A rewrite that fails repeatedly delays rejection bumps,
// it never invents extra ones.
let writeCounter = 0;
function commit(projectPath, queue, retainedLines, rejections) {
  let wroteQueue = false;
  try {
    const dir = path.dirname(queue.file);
    const combined = queue.remainder.concat(retainedLines);
    if (combined.length) {
      const body = combined.join('\n') + '\n';
      const tmp = path.join(dir, `.${path.basename(queue.file)}.${process.pid}.${writeCounter++}.tmp`);
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, queue.file);
    } else {
      fs.rmSync(queue.file, { force: true });
    }
    wroteQueue = true;
  } catch {
    // best-effort; see the header comment above for the accepted residual
  }
  if (!wroteQueue) return; // see Finding 3 residual above -- retry next pass, no bump now
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
// finish. nowFn is injectable (offline-deterministic tests), matching
// lib/scan.js's own settleProvisionalCommits -- the daemon passes nothing
// and gets the real clock.
function settleRecallQueue(projectPath, readEvents, nowFn = Date.now) {
  const queue = readQueue(projectPath);
  if (!queue.lines.length) {
    return { avoidedDelta: zeroAvoided(), holdoutDelta: zeroHoldout(), finish: () => {} };
  }
  const rows = parseRows(queue.lines);
  const { avoidedDelta, holdoutDelta, rejections, retained } = settleRows(rows, readEvents || [], projectPath, nowFn);
  const retainedLines = retained.map(r => JSON.stringify(r));
  return { avoidedDelta, holdoutDelta, finish: () => commit(projectPath, queue, retainedLines, rejections) };
}

module.exports = { settleRecallQueue, settleRows, eventsPath, MAX_FOLD_LINES, RECALL_SETTLE_GRACE_MS };
