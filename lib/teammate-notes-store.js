'use strict';
// The fs layer for <project>/.membridge/teammate-notes.json -- the single
// source of truth every delivery point reads (spec §4).
//
// FAIL-OPEN, like lib/recall-store.js's get(): any read or parse error is a
// MISS (null), never a thrown error. A hook that cannot read this file must
// behave exactly as if there were no teammate notes at all.
//
// One file, not a directory of blobs: the hook path reads it ahead of
// lib/hooks-recall.js's storeEntry gate on every Read, so it must be a single
// small parse and nothing more (spec §4.1).
const fs = require('fs');
const path = require('path');
const { DIR_NAME } = require('./memorydb');
const notes = require('./teammate-notes');
const util = require('./util');

const notesPath = projectPath => path.join(projectPath, DIR_NAME, 'teammate-notes.json');

// Same tmp + rename pattern as lib/util.js's saveState, lib/ledger-store.js's
// writeLedger and lib/recall-store.js's put: a crash mid-write can only ever
// leave a stray temp file behind, never a half-written index.
let writeCounter = 0;

function write(projectPath, index) {
  const target = notesPath(projectPath);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(index); // throws before anything touches disk
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${writeCounter++}.tmp`);
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {} // best-effort; the write may never have landed
    throw err;
  }
}

function read(projectPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(notesPath(projectPath), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

// Read-modify-write. A missing or corrupt index starts from empty rather than
// aborting: a hook marking a note as delivered must not fail just because the
// file was damaged -- worst case it re-delivers once.
function update(projectPath, fn) {
  try {
    const current = read(projectPath) || notes.emptyIndex();
    const next = fn(current);
    write(projectPath, next);
    return next;
  } catch {
    return null;
  }
}

// Called once per team pull (bin/membridge.js's teamTick). `entries` are the
// pulled teammate rows for ONE project -- state.projects[key].teamEntries, as
// lib/teamsync.js's pull stored them -- already carrying WIRE KEYS (spec §7).
//
// NO PATH TRANSLATION ON RECEIVE. Incoming keys are already wire keys (Task 3)
// and byFile stays keyed that way; the hook computes the wire key of the file
// it is about to read and looks it up directly. An inverse mapping would have
// to guess WHICH local checkout a key refers to, which is unanswerable when the
// same repo is checked out several times -- exactly the machine this ships on.
//
// Fail-open: any failure leaves the PREVIOUS index in place and serving.
function rebuildTeammateNotes(projectPath, entries, now) {
  try {
    // A non-array is a BROKEN CALLER (unreadable state, a missing project),
    // not "this teammate has nothing to say". buildIndex would answer it with a
    // perfectly valid EMPTY index and we would write that over a good one --
    // the silent no-op this feature keeps being bitten by. An empty ARRAY is a
    // real answer and does empty the index.
    if (!Array.isArray(entries)) return read(projectPath);
    const prev = read(projectPath);
    const built = notes.buildIndex(entries, prev, now);
    const pruned = notes.pruneSeen(built, now);
    write(projectPath, pruned);
    return pruned;
  } catch {
    return null;
  }
}

// THE ERASER. The index is a DERIVED copy of a project's teammate rows, so
// when this machine stops being allowed to read the project — revoked
// server-side, or unlinked locally — the copy has to go with the rows.
// rebuildTeammateNotes already treats an empty ARRAY as a real answer and
// empties the index; this is the named entry point for that plus the three
// properties its callers depend on:
//
//   - It writes an EMPTY index, it does NOT unlink the file. The empty file is
//     also a TOMBSTONE: backfillProjects' guard is "does an index file already
//     exist", so deleting it would invite the very next sync pass to rebuild
//     one from the stale teamEntries an unlink leaves behind in state.
//   - Silent when there is nothing to erase. A project with no index gets no
//     file conjured, and one already empty is not rewritten — this runs on
//     every sync tick for as long as the project stays revoked.
//   - `seen` is carried through by buildIndex on purpose: if access comes back,
//     decisions the user has already read must not be delivered a second time.
//
// Fail-open like everything else here: a failure leaves the previous index in
// place, and the reader gate (teamsync.mayServeTeammateNotes) is what keeps
// that from being a leak.
function clearTeammateNotes(projectPath, now) {
  try {
    const cur = read(projectPath);
    if (!cur) return false; // nothing on disk — conjure nothing
    const empty = !(Array.isArray(cur.prose) ? cur.prose.length : 0) &&
      !Object.keys(cur.byFile || {}).length;
    if (empty) return false; // already erased; do not rewrite it every pass
    return !!rebuildTeammateNotes(projectPath, [], now || new Date().toISOString());
  } catch {
    return false;
  }
}


// backfillProjects(state, now) -> [rebuilt project keys]
//
// THE FIRST-INSTALL GAP (found dogfooding Task 13). The daemon rebuilds the
// index only for projects whose pull just brought NEW rows -- but a user who
// upgrades into this feature already HAS teammate decisions sitting in
// state.projects[].teamEntries. Nothing ever puts them in an index, so every
// surface stays silent until a teammate happens to push again. Measured live:
// 65 team entries, 7 carrying real decisions, and no index file. That breaks
// the spec's vacation promise ("anything you haven't been shown never
// expires... waiting when you get back") at the moment it matters most, the
// install itself.
//
// So: any project that HAS teammate entries but NO index file gets one built.
// An existsSync per project per pass is the entire cost. The index is our own
// cache, never user config, so recreating it is always legitimate -- the kill
// switch, which callers must check, is the off ramp, and rebuildTeammateNotes
// itself refuses to write for a non-array. Fail-open per project: one broken
// project must not stop the rest.
//
// It is ALSO the reconciler for two opposite directions.
//
// REVOKED. A revoked project's index has to be erased even on a pass that never
// reaches syncTeams' access-lost branch -- and there is such a pass: when
// visibleProjectIds cannot answer (`visible === null`, a network blip) that
// branch is skipped entirely, while teamAccessLost stamped by an earlier,
// confirmed revocation still stands. Erasing here as well means the leak closes
// on ANY pass, not only the pass that first noticed.
//
// The erase is keyed on teamAccessLost and NEVER on "this project has no team
// rows", which would look like the same thing and is not: teamEntries is capped
// (lib/teamsync.js MAX_TEAM_ENTRIES = 100), so a perfectly legitimate index can
// hold notes derived from rows that have since rolled out of state. An empty row
// set is not evidence that the index should be empty, and treating it as such
// would delete undelivered decisions from a healthy project.
//
// UNLINKED. This used to say the unlink case belonged at its source
// (teamsync.unlinkProject) because on disk an unlinked project was
// indistinguishable from one that merely carries rows without a link file. That
// was true only of the FIXTURES: they gave every project teamEntries and no
// team.json, so "linked" and "unlinked with stale rows" were the same state and
// no test could tell them apart. With that fixed the two are distinguishable by
// path, and the unlink case is handled here as well -- because unlinkProject
// does NOT clear proj.teamEntries, so nothing else closes it. Both directions
// now reconcile in the same place; neither is left to a caller to remember.
// Is this project still linked to a team? Same file lib/teamsync.js's
// teamFilePath resolves (`<project>/<DIR_NAME>/team.json`), checked here by path
// rather than through teamsync so this module gains no dependency on it.
//
// It has to be checked by PATH, which is why util.teamRowsFor cannot do it:
// that function takes only the project OBJECT, so it structurally cannot know
// where the project lives and therefore cannot see whether team.json is gone.
// It guards teamAccessLost and nothing else.
//
// NOT fs.existsSync, deliberately. existsSync NEVER THROWS — it returns false on
// any error at all, including EACCES on an unreadable .membridge directory. With
// existsSync, "I could not look" and "it is gone" are the same answer, and since
// the caller DELETES on "gone" that would quietly destroy a live project's index
// whenever a permissions or I/O problem happened to be in the way. Same failure
// shape as reading an RLS-filtered empty list as "no restrictions": an empty
// result mistaken for an answer.
//
// Only ENOENT/ENOTDIR means unlinked. Every other errno is INCONCLUSIVE and
// returns true (leave it alone) — the rule teamsync's visibleProjectIds already
// applies before it drops local data.
//
// Split from the fs call so that branch is reachable in a test: a real EACCES
// cannot be staged portably (chmod is a no-op as root, which is how CI
// containers run), and an unreachable safety branch is one nobody can prove.
function classifyLink(statFn) {
  try {
    statFn();
    return true;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return false;
    return true;
  }
}

const isTeamLinked = projectPath =>
  classifyLink(() => fs.statSync(path.join(projectPath, DIR_NAME, 'team.json')));

function backfillProjects(state, now) {
  const rebuilt = [];
  const config = util.getConfig();
  const projects = state && state.projects && typeof state.projects === 'object' ? state.projects : {};
  for (const [key, proj] of Object.entries(projects)) {
    try {
      // Ordering is a cost decision: teamRowsFor is free and returns [] for a
      // revoked project, so a solo project (no rows, no index) leaves this loop
      // without touching the disk beyond the existsSync it already paid for.
      const teamRows = util.teamRowsFor(proj);
      const hasIndex = fs.existsSync(notesPath(key));
      if (!teamRows.length && !hasIndex) continue;
      // UNLINKED PROJECTS ARE NOT BACKFILLED, AND ARE ACTIVELY CLEANED UP.
      //
      // teamsync's unlinkProject deletes team.json and prunes the durable
      // archive, but it does NOT clear proj.teamEntries from state.json -- and
      // it never set teamAccessLost either, so util.teamRowsFor still hands
      // those rows out. This reconciler then read them and built a teammate-
      // notes index for a project that is no longer shared with anyone. Because
      // an existing index is never rewritten, that index was PERMANENT:
      // teammate decisions, gotchas and per-file notes kept being served into
      // every agent's context for a project the user had explicitly unlinked.
      //
      // EMPTIED, not deleted, and the same way the revoked branch below does it.
      // teamsync.unlinkProject already erases this index at the source, and its
      // comment is explicit about why it EMPTIES rather than removes: the guard
      // three lines down is "does an index file exist", so deleting the file
      // hands the very next pass permission to rebuild it from the rows unlink
      // left behind. Deleting here would re-open exactly that path.
      //
      // Which leaves this branch one job, and it is worth being precise about it
      // rather than claiming the whole fix: the source erase only runs when the
      // user unlinks on a build that has it. Anyone who unlinked BEFORE it
      // shipped still has both the stale rows and a FULL index on disk, and
      // unlinkProject will never run for them again. This is the pass that
      // reaches them. clearTeammateNotes is idempotent -- it returns false
      // without writing when the index is already empty -- so on every ordinary
      // unlinked project this costs one read and changes nothing.
      //
      // Re-linking refills the index through the pull path (afterTeamPull's
      // changed-project loop calls rebuildTeammateNotes unconditionally), not
      // through this backfill, which by design never writes over an index that
      // already exists.
      //
      // #55: the sibling copy — proj.teamEntries — is swept from THIS SAME
      // PASS, on the same "link file is missing" test.
      //
      // WHY IT LIVES HERE, NOT IN teamRowsFor. The prior audit named the two
      // options and left them for a ticket:
      //   1. give teamRowsFor(proj, projectPath) — six call sites, and every one
      //      is a hot reader (feed, search, digest, the injected block, hooks,
      //      MCP). teamRowsFor is called once per row set today; adding a
      //      filesystem stat to it makes every reader stat the disk once per
      //      call, and folds two different questions ("may this install still
      //      read the rows?" — a positive fact stamped in state — and "is this
      //      project still linked?" — a file on disk) into one function. Same
      //      defect class as #79's `Boolean(truncated && !exact)`: ANDing two
      //      independent bits at the boundary hides which one is doing the
      //      work.
      //   2. sweep proj.teamEntries in this pass, on the same guard the notes
      //      erase already uses. Signature stability, no per-read stat, one
      //      pass that owns both derived copies of a project's team content.
      // 2 wins on all three counts. Same reasoning `notes-store` already used
      // for the derived notes index one branch over — extend, do not diverge.
      //
      // pruneTeamEntries is lazily required to match teamsync's own lazy
      // require of THIS module (its comment near unlinkProject says so). The
      // pair keeps the dependency one-way at load time; both directions use the
      // primitive at run time. Fail-open per project — a broken state read on
      // one project must not stop the sweep for the rest.
      if (!isTeamLinked(key)) {
        if (hasIndex && clearTeammateNotes(key, now)) {
          util.log(`teammate notes: erased the index for ${key} — no longer linked to a team`);
        }
        if (teamRows.length) {
          try {
            if (require('./teamsync').pruneTeamEntries(key)) {
              util.log(`team rows: pruned ${teamRows.length} stale entr${teamRows.length === 1 ? 'y' : 'ies'} for ${key} — no longer linked to a team`);
            }
          } catch { /* best-effort, next project */ }
        }
        continue;
      }
      if (proj && proj.teamAccessLost) {
        if (hasIndex) clearTeammateNotes(key, now);
        continue;
      }
      if (!teamRows.length || hasIndex) continue;
      // Defense in depth, not the load-bearing gate: lib/hooks-notes.js and
      // lib/hooks-recall.js are what actually stop a paused/excluded project's
      // decisions reaching a session, and fixing those two makes this index
      // inert on its own. Gated anyway, because a file of teammates' decisions
      // materialising inside a project the user excluded is wrong on its own
      // terms, and the next person to add a reader of this index has no reason
      // to know delivery was the only thing holding it back.
      if (util.isProjectOff(key, config)) continue;
      if (rebuildTeammateNotes(key, teamRows, now)) rebuilt.push(key);
    } catch { /* next project */ }
  }
  return rebuilt;
}


// afterTeamPull(changed) -- the ONE post-pull entry point, shared by every
// sync loop. There are two of those: bin/membridge.js's CLI daemon/`sync`
// paths, and app/main.js's in-process tray-app tick. The first version of this
// logic lived as glue inside bin/, and the tray app -- the normal install --
// simply never ran it: no index was ever built for app users while every test
// and the CLI path were green. Found live during Task 13 dogfooding. Logic
// that both loops need lives HERE, and the loops call it; neither reimplements
// it.
//
// Kill switch inside, not at the callers, so a future third loop cannot forget
// it. Fail-open per project; a broken state read changes nothing.
function afterTeamPull(changed) {
  const config = util.getConfig();
  if (!notes.isNotesEnabled(config)) return; // opted out: write nothing at all
  const nowIso = new Date().toISOString();
  let state;
  try {
    state = util.loadState();
  } catch (err) {
    try { util.log(`teammate notes: cannot read state (${err.message})`); } catch {}
    return;
  }
  try {
    const rebuilt = backfillProjects(state, nowIso);
    if (rebuilt.length) util.log(`teammate notes: backfilled ${rebuilt.length} project(s) with existing team entries`);
  } catch (err) {
    try { util.log(`teammate notes backfill: ${err.message}`); } catch {}
  }
  for (const key of Array.isArray(changed) ? changed : []) {
    try {
      const proj = (state.projects || {})[key];
      // No project is a broken read, NOT "the teammates said nothing" --
      // rebuildTeammateNotes refuses non-arrays on purpose.
      if (!proj) continue;
      rebuildTeammateNotes(key, util.teamRowsFor(proj), nowIso);
    } catch (err) {
      try { util.log(`teammate notes: ${key}: ${err.message}`); } catch {}
    }
  }
}

module.exports = {
  notesPath, read, write, update, rebuildTeammateNotes, clearTeammateNotes,
  backfillProjects, afterTeamPull,
  // Exported for the regression suite only, same convention as teamsync's
  // _oauthStates: the "inconclusive errno must not read as unlinked" branch
  // guards a DELETE, and a real EACCES cannot be staged portably (chmod is a
  // no-op as root, which is how CI containers run). Driving the classifier with
  // the errnos statSync would raise is the only way to prove that branch holds.
  _isTeamLinkedForTest: classifyLink,
};
