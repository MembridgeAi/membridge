'use strict';
// events.jsonl rotation for the recall hook (lib/hooks-recall.js). Split out
// purely to keep that module under the file-size budget (same rationale as
// the lib/ledger-fold-recall-*.js split -- see that family's own headers).
//
// events.jsonl is append-only measurement data (spec §7.1), written in front
// of file reads -- the one file lib/hooks-recall.js writes that could
// otherwise grow without limit. Past MAX_EVENTS_BYTES it is rotated down to
// its most recent half on a line boundary: the recent rows are the ones any
// comparison cares about, and halving (rather than truncating to empty)
// keeps enough history to stay useful between rotations.
const fs = require('fs');

const MAX_EVENTS_BYTES = 2 * 1024 * 1024;

// A serve lands as TWO rows (see lib/hooks-recall.js's appendEvent, called
// twice per serve): a pending row (holdout:false, committed:false) and a
// confirmation row (committed:true), sharing the same ts|sessionId|relPath
// key -- lib/ledger-fold-recall-settle.js's groupServeRows pairs them back
// up on the fold side. A naive byte-midpoint cut has no notion of that
// pairing and can split a pair: if the pending row lands in the dropped head
// while its confirmation survives in the kept tail, the fold is left with a
// stray confirmation and NO pending row to settle it against
// (groupServeRows: "a stray confirmation with no pending row: nothing to
// settle or retain") -- the whole serve is silently lost, not merely
// delayed. This is not only a "daemon was down" scenario: appendEvent calls
// rotateEvents before EVERY write, including the confirmation write that
// follows a pending write by microseconds within the SAME hook invocation --
// if the pending row's own append happens to cross MAX_EVENTS_BYTES, the
// very next call (writing that row's own confirmation) can rotate the file
// and cut off the pending row it just wrote, moments before appending the
// now-orphaned confirmation. Scans the rows the naive cut would drop for any
// pending row whose confirmation survives in the kept tail, and if found,
// moves the cut back to keep that whole pair together (both dropped, never
// split). A pending row with no confirmation ANYWHERE in the file (a
// genuine, permanent state-write failure -- see PENDING_CONFIRM_GRACE_MS in
// lib/ledger-fold-recall-settle.js) has no pair to protect and is left to
// the naive cut like any other row.
function safePendingCut(lines, naiveCut) {
  const rowKey = row => `${row.ts}|${row.sessionId}|${row.relPath}`;
  const droppedPending = new Map(); // key -> earliest dropped line index still unconfirmed WITHIN the dropped head
  for (let i = 0; i < naiveCut; i++) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (!row || typeof row !== 'object') continue;
    if (row.holdout === false && row.committed === false) {
      const key = rowKey(row);
      if (!droppedPending.has(key)) droppedPending.set(key, i);
    } else if (row.committed === true) {
      droppedPending.delete(rowKey(row)); // paired off within the dropped head itself -- safe to drop both
    }
  }
  if (!droppedPending.size) return naiveCut;

  let cut = naiveCut;
  for (let i = naiveCut; i < lines.length && droppedPending.size; i++) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (!row || row.committed !== true) continue;
    const key = rowKey(row);
    const pendingIdx = droppedPending.get(key);
    if (pendingIdx !== undefined) {
      cut = Math.min(cut, pendingIdx);
      droppedPending.delete(key);
    }
  }
  return cut;
}

// Drop everything before (approximately) the midpoint of events.jsonl, on a
// LINE boundary so no half row ever survives, adjusted by safePendingCut so
// no pending/confirmation pair is ever split across the cut either.
// Best-effort: a rotation failure must never stop the row that triggered it
// from being written, so this swallows its own errors and lets the append
// proceed.
function rotateEvents(file) {
  try {
    if (fs.statSync(file).size <= MAX_EVENTS_BYTES) return;
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    // appendEvent always appends a trailing '\n', so split() leaves one
    // trailing '' entry -- drop it so every remaining index is a real row.
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) return;

    // Same "newline at/after the halfway point" target as before, just
    // expressed as a line index (via cumulative length) rather than a raw
    // string offset, so safePendingCut can reason about whole rows.
    const midpoint = Math.floor(text.length / 2);
    let chars = 0;
    let naiveCut = lines.length;
    for (let i = 0; i < lines.length; i++) {
      chars += lines[i].length + 1; // +1 for the newline this line was split on
      if (chars > midpoint) { naiveCut = i + 1; break; }
    }

    const cut = safePendingCut(lines, naiveCut);
    const kept = lines.slice(cut);
    fs.writeFileSync(file, kept.length ? kept.join('\n') + '\n' : '');
  } catch {}
}

module.exports = { rotateEvents, safePendingCut, MAX_EVENTS_BYTES };
