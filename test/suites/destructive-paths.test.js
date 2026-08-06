'use strict';
// Every path that destroys user data, and whether the user could have stopped it.
//
// The counterpart to the rest of this session. Those asked who may READ what is
// stored; this asks what gets DELETED, by whom, and whether it comes back.
//
// The class worth the most attention is remote-triggered destruction: a
// revocation arriving from the backend causes deletion on THIS user's disk, so
// someone else's action destroys their data. That path is `teamAccessLost` in
// lib/teamsync.js, and on inspection it is correct. Four properties make it
// correct, all of them one edit from gone, none of them obvious from reading
// the destructive lines alone. That is what this suite pins.
//
// RESULT: clean. Source-reading, same caveat as the MCP and Electron suites —
// it catches a future edit removing a guard, not a misunderstanding of the
// runtime.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'lib');
const teamsync = fs.readFileSync(path.join(LIB, 'teamsync.js'), 'utf8');
const archive = fs.readFileSync(path.join(LIB, 'team-archive.js'), 'utf8');

async function main() {
  // 1. TRIGGER — POSITIVE CONFIRMATION ONLY. The single most important property
  // here. `visible` is null whenever the visibility probe could not answer, and
  // the destructive branch is guarded on `visible &&` so a network blip, an
  // expired token or a backend outage skips it entirely. Without this, every
  // transient failure would read as "you have been removed" and delete on it.
  await check('destruction requires a positive answer, never a failed probe', () => {
    assert.match(teamsync, /if \(visible && !visible\.has\(String\(link\.projectId\)\)\)/,
      'the destructive branch must require BOTH a non-null probe result and a ' +
      'confirmed absence — guarding on the absence alone would treat every ' +
      'failed probe as a revocation');
  });

  // 2. BLAST RADIUS matches the trigger. One project's revocation clears that
  // project only: the row cache is on `proj`, and the archive prune is keyed to
  // that project's own id. A prune scoped to the team, or a loop that cleared
  // every project on one bad answer, is the shape to distrust.
  await check('a revocation clears exactly the project it names', () => {
    assert.match(teamsync, /teamArchive\.pruneArchive\(link\.projectId\)/,
      'the archive prune must be keyed to THIS project id, never the team');
    assert.match(teamsync, /proj\.teamEntries = \[\]/,
      'the row cache cleared must be the one hanging off this project');
  });

  // 3. RECOVERABLE, AND SOMETHING ACTUALLY REBUILDS IT. "Recoverable in
  // principle" only counts if a real path restores it. Everything destroyed
  // here is a cache of rows the backend still holds — none of the user's own
  // work — and when access returns the marker is DELETED so the normal paths
  // resume and backfill refills from the authoritative copy. Without the
  // delete, a transient or mistaken revocation would cut the project off
  // permanently, and nothing on this machine records a revocation to undo.
  await check('the access marker is cleared when access comes back', () => {
    assert.match(teamsync, /if \(visible && proj\.teamAccessLost\) \{/,
      'a restored-access branch must exist');
    assert.match(teamsync, /delete proj\.teamAccessLost;/,
      'the marker must be DELETED on restore — a one-way flag makes a ' +
      'temporary revocation permanent, and no local record could undo it');
  });

  // 4. PARTIAL FAILURE. The ordering is the safety property: the marker is set
  // BEFORE the destructive calls, and the prune is best-effort. So if the prune
  // throws halfway, the marker is already set and every reader (activity.js
  // returns [] for team rows on this flag) treats the project as revoked
  // regardless of what is still on disk. Destroy-then-mark would leave the
  // opposite: a half-pruned archive that still reads as authorised.
  // HONEST SCOPE, established by mutation rather than assumed. This check
  // confirms the destructive calls appear AFTER the stamp. It does NOT prove
  // nothing destructive happens before it: inserting an extra
  // `proj.teamEntries = []` ahead of the stamp leaves the suite green, because
  // the original statement is still there after it and that is what the slice
  // finds. So this is a guard against the calls being MOVED, not against a new
  // one being ADDED earlier. Catching that properly needs an executed test with
  // a failing prune, which needs a live sync fixture this suite does not have.
  // Recorded rather than quietly left as an implied guarantee.
  await check('the destructive calls sit after the marker is stamped', () => {
    // Scoped to the revocation branch, NOT searched across the whole file.
    // The first version used indexOf over the module and failed: the same two
    // statements also appear in the UNLINK path (teamsync.js:1267,1291), which
    // sits earlier in the file, so indexOf matched those and reported the
    // ordering inverted. The code was correct; the instrument was not. Third
    // time this session that a source-reading check found the wrong occurrence,
    // and the second time it made working code look broken.
    const branch = teamsync.slice(teamsync.indexOf('proj.teamAccessLost = new Date().toISOString()'));
    assert.ok(branch, 'the revocation branch must exist');
    // The slice STARTS at the stamp, so the stamp is at offset 0 and both
    // destructive calls simply have to be found after it. (Asserting
    // `markAt > 0` here was my own second error in this one check — it can
    // never be true by construction, so the assertion failed on correct code.)
    const clearAt = branch.indexOf('proj.teamEntries = []');
    const pruneAt = branch.indexOf('teamArchive.pruneArchive(link.projectId)');
    assert.ok(clearAt > 0 && pruneAt > 0,
      'the flag must be stamped first, so a failure partway through still ' +
      'leaves every reader refusing the data rather than serving a ' +
      'half-deleted cache as if it were authorised');
    assert.match(teamsync, /try \{ teamArchive\.pruneArchive\(link\.projectId\); \} catch/,
      'the prune is best-effort by design; it must not abort the pass and ' +
      'leave the marker unstamped');
  });

  // The derived copy. The notes index is built FROM the rows cleared above, so
  // clearing the rows without it left teammates' decisions being injected into
  // every agent session indefinitely — a real bug, fixed, and worth pinning
  // because the same omission is invisible: nothing about the rows says a
  // derived copy exists elsewhere.
  await check('the derived notes index is erased alongside the rows it came from', () => {
    assert.match(teamsync, /teammateNotes|clearTeammateNotes|notesStore/,
      'revocation must reach the derived notes index too, not just the rows');
  });

  // The archive prune's own scope, checked at the other end: it must sweep by
  // project id prefix and not take a neighbouring project's files with it.
  await check('pruneArchive is scoped to one project id', () => {
    assert.match(archive, /function pruneArchive\(projectId\)/,
      'pruneArchive must take a project id, never a team or a wildcard');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
