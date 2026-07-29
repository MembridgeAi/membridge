'use strict';
// Impure half of the direct-avoidance fold (spec §7.1, §7.3; Task 6). Reads
// the recall hook's queue file (.membridge/recall/events.jsonl, written by
// lib/hooks-recall.js), settles every confirmed serve IMMEDIATELY, runs the
// CORRECTION pass that revises already-settled serves against this pass's
// read events, and returns the plain deltas lib/ledger-fold.js's
// foldRecallSettlement() adds onto the durable ledger.
//
// Kept OUT of lib/ledger-fold.js on purpose: that module stays a pure
// accumulator, table-testable with plain object literals (its own header
// says so), while settlement genuinely needs I/O -- reading the queue file,
// statting a follow-up read's target to price it with lib/recall.js's own
// estimator, and (on a net loss) calling lib/recall-store.js's
// bumpRejection. This module is where all of that I/O lives.
//
// The settlement MATH (grouping pending/confirmation rows, pricing one
// serve or one read event) lives in lib/ledger-fold-recall-settle.js; the
// OPEN SERVE bookkeeping and correction-pass math lives in
// lib/ledger-fold-recall-open-serves.js -- both split out purely to keep
// every module under the file-size budget. This file owns: bounding and
// reading the queue file, wiring settlement + corrections together, and
// (only once the caller's ledger write has landed) selectively rewriting the
// queue and applying rejection bumps.
//
// The queue is append-only and otherwise unbounded (lib/hooks-recall.js
// documents its own separate byte-size rotation as a backstop). This fold
// bounds itself independently, at the row level: at most MAX_FOLD_LINES
// lines are consumed per call. A file bigger than that has its LEADING
// (oldest) lines processed; whatever is left past the bound stays queued
// for the next fold pass -- lines are never processed twice or silently
// discarded, just deferred.
const fs = require('fs');
const path = require('path');
const { DIR_NAME } = require('./memorydb');
const recallStore = require('./recall-store');
const { normalizeOpenServes } = require('./ledger-fold-state');
const { settleRows, zeroAvoided, zeroHoldout } = require('./ledger-fold-recall-settle');
const { buildOpenServe, applyCorrections, capOpenServes } = require('./ledger-fold-recall-open-serves');

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
// the unconsumed MAX_FOLD_LINES overflow (queue.remainder) PLUS every pending
// row settleRows decided to retain (too young to give up on -- see
// PENDING_CONFIRM_GRACE_MS in the settle module). Called ONLY after the
// caller's ledger write has already succeeded (lib/ledger-store.js's
// updateLedger) -- rewriting first and having the ledger write then fail
// would durably lose the very rows that write needed.
//
// Best-effort, matching every other write in this codebase (rotateEvents in
// lib/hooks-recall.js, bumpRejection itself): a failed rewrite leaves the
// on-disk queue exactly as it was, so the next pass re-reads and re-settles
// the same rows from scratch. Since settlement is now immediate (item 1),
// the residual this causes is a bounded, one-time OVER-count -- the same
// serve gets a second openServe record and its net double-counted into
// avoided.tokens -- never a lost or under-counted serve. This mirrors the
// "over-count on retry, never lose or double-count a LANDED write" tradeoff
// lib/ledger-fold-state.js's own header already accepts elsewhere.
let writeCounter = 0;
function commit(projectPath, queue, retainedLines) {
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
  } catch {
    // best-effort; see the header comment above for the accepted residual
  }
}

// The single entry point lib/ledger-store.js's updateLedger calls: settle
// every newly-confirmed serve in the queue, run the correction pass against
// this pass's read events (over BOTH the newly-settled serves and every
// still-open one carried over from `prevLedger`), and hand back the plain
// deltas plus a `finish` closure the caller invokes only once its own ledger
// write has landed (see commit()'s header).
//
// Correction rejections (a serve's net crossing into 'negative') are applied
// UNCONDITIONALLY once finish() runs -- unlike the queue-rewrite residual
// above, a correction's effect (avoided.tokens delta, the bucket move, and
// the read's key landing in correctedBy) is already durably written into
// ledger.json by the time finish() is even called, so there is no "still
// queued, will retry" path for it the way there is for the events.jsonl
// rows. Gating it on the (unrelated) queue-rewrite outcome would risk
// silently dropping a rejection bump forever instead of merely delaying one.
//
// nowFn is injectable (offline-deterministic tests, mirroring lib/scan.js's
// settleProvisionalCommits) and threads straight through to the correction
// pass's OPEN_SERVE_TTL_MS gate -- production callers (scan.js) pass nothing
// and get the real clock.
function settleRecallQueue(projectPath, readEvents, prevLedger, nowFn = Date.now) {
  const now = nowFn();
  const prevOpenServes = normalizeOpenServes(prevLedger && prevLedger.openServes);

  const queue = readQueue(projectPath);
  const rows = parseRows(queue.lines);
  const settled = settleRows(rows, now, buildOpenServe);

  const merged = prevOpenServes.concat(settled.newOpenServes);
  const corrected = applyCorrections(merged, readEvents || [], projectPath, now);
  const openServes = capOpenServes(corrected.openServes);

  const avoidedDelta = zeroAvoided();
  for (const k of Object.keys(avoidedDelta)) {
    avoidedDelta[k] = (settled.avoidedDelta[k] || 0) + (corrected.avoidedDelta[k] || 0);
  }

  const retainedLines = settled.retained.map(r => JSON.stringify(r));
  const finish = () => {
    for (const relPath of corrected.rejections) {
      try { recallStore.bumpRejection(projectPath, relPath); } catch {}
    }
    // The overwhelmingly common case -- most projects never trip the recall
    // hook at all -- has nothing queued; skip touching the queue file
    // entirely rather than a no-op rmSync every single fold pass.
    if (queue.lines.length > 0) commit(projectPath, queue, retainedLines);
  };

  return { avoidedDelta, holdoutDelta: settled.holdoutDelta, openServes, finish };
}

module.exports = { settleRecallQueue, settleRows, eventsPath, MAX_FOLD_LINES };
