'use strict';
// Revocation must survive a state.json rebuild.
//
// THE SHAPE. `proj.teamAccessLost` is the ONE fact that gates two on-disk
// caches of teammate content:
//
//   * <project>/.membridge/teammate-notes.json  -- gated by
//     util.mayServeTeammateNotes (lib/util.js:527), read by the SessionStart
//     injection, the on-contact file note, and the project page card.
//   * ~/.membridge/team-archive/<projectId>     -- gated by lib/activity.js:374
//     inside projectCorpus, which is what search_memory assembles from.
//
// Neither cache lives in state.json. The FLAG does. And lib/util.js loadState
// (:338, :342-346) deliberately DISCARDS the whole file and returns
// freshState() on two non-corruption conditions:
//
//   * state.version !== STATE_VERSION -- i.e. any future release that bumps
//     the stamp, and any downgrade;
//   * any project event lacking a `session` id (the pre-v2 heuristic).
//
// loadState's own header argues this is safe because "nothing is lost -- they
// are the source of truth", meaning the transcripts. That is true of local
// events, which a rescan rebuilds. It is NOT true of teamAccessLost: no
// transcript records a revocation, so the flag is simply gone, while the two
// caches it gates are untouched on disk.
//
// WHY IT DOES NOT SELF-HEAL. Recovery needs the next sync pass to CONFIRM the
// revocation again, and lib/teamsync.js visibleProjectIds (:1092-1112) returns
// null -- "skip the gate" -- for an empty visible set, which is exactly the
// state of a member revoked from their only shared project. Its own comment
// accepts that cost. Combined with this reset, the acceptance is no longer
// "revocation from a member's ONLY project is not detected here"; it is "an
// already-detected revocation is forgotten and never re-detected".
//
// This is the same defect class as the suite next door
// (teammate-notes-revocation.test.js), which pins that a REVOKED project goes
// quiet. It cannot catch this one, because it never rebuilds state.
//
// Run directly, or via `node test/run.js revocation-state-reset`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const digest = require('../../lib/digest');
const memorydb = require('../../lib/memorydb');
const teamsync = require('../../lib/teamsync');
const teamArchive = require('../../lib/team-archive');
const notesStore = require('../../lib/teammate-notes-store');
const hooksNotes = require('../../lib/hooks-notes');
const hooksRecall = require('../../lib/hooks-recall');
const activity = require('../../lib/activity');
const server = require('../../lib/server');

const NOW = '2026-08-05T12:00:00.000Z';
const SESSION = 'sess-reset-1';

// One pulled teammate row in the STORED shape (lib/teamsync.js's pull renames
// author_name -> author before it lands in proj.teamEntries / the archive).
const TEAM_ROW = {
  author: 'Andrew',
  authorId: '11111111-2222-3333-4444-555555555555',
  ts: '2026-08-05T09:00:00.000Z',
  source: 'Claude Code',
  session: 'their-session',
  ask: 'rework the payroll exporter',
  summary: 'Reworked the payroll exporter.',
  decisions: 'the payroll exporter now signs each batch with the escrowkey',
  gotchas: '',
  files: ['lib/payroll.js'],
  changes: [{ file: 'lib/payroll.js', note: 'never log the escrowkey' }],
};

const PROJECT_ID = 'proj-reset-fixture';

// A tracked project that looks exactly like a shared one that has since been
// revoked: a checkout, a team.json, the derived notes index and the durable
// archive both on disk, and the flag set in state.
function makeRevokedProject(name) {
  const key = path.join(h.ROOT, 'projects', name);
  fs.mkdirSync(path.join(key, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(key, '.git'), { recursive: true }); // checkoutRoot stats .git
  fs.writeFileSync(path.join(key, 'lib', 'payroll.js'), '// fixture\n');
  fs.mkdirSync(path.join(key, memorydb.DIR_NAME), { recursive: true });
  fs.writeFileSync(teamsync.teamFilePath(key), JSON.stringify({
    projectId: PROJECT_ID, teamId: 'team-1', teamName: 'Team One',
    linkedBy: 'me@test.dev', linkedAt: NOW,
  }, null, 2));

  // Both derived caches, exactly as a pull leaves them. Neither is in state.
  notesStore.rebuildTeammateNotes(key, [TEAM_ROW], NOW);
  teamArchive.appendRows(PROJECT_ID, [TEAM_ROW], { source: 'forward' });

  const st = util.loadState();
  st.projects = st.projects || {};
  st.projects[key] = {
    // One local event of the user's own, so a rescan has something to rebuild
    // the project record from -- the state a revoked-but-still-tracked project
    // is actually in.
    events: [{ ts: '2026-08-05T10:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'mine', text: 'check the exporter' }],
    // Exactly what lib/teamsync.js's access-lost branch leaves behind:
    // the flag set, the rows emptied, the cursor cleared.
    teamAccessLost: NOW,
    teamEntries: [],
    teamPullTs: null,
  };
  util.saveState(st);
  return key;
}

const projRecord = key => (util.loadState().projects || {})[key];

// The three notes delivery points, each asked "would you serve this project's
// teammate content right now?". Nothing here calls commit(), so a wrongly
// refused note is only deferred, never lost.
function servedNotes(key) {
  const proj = projRecord(key);
  const config = util.getConfig();
  const sessionOut = hooksNotes.buildSessionOutput({
    projectPath: key, sessionId: SESSION, source: 'startup', now: NOW, config, proj,
  });
  const fileOut = hooksRecall.buildNotesOutput({
    projectPath: key,
    absPath: path.join(key, 'lib', 'payroll.js'),
    relPath: 'lib/payroll.js',
    sessionId: SESSION, now: NOW, config, proj,
  });
  const detail = server.projectDetail(key);
  return {
    session: sessionOut && sessionOut.text ? sessionOut.text : null,
    file: fileOut && fileOut.text ? fileOut.text : null,
    card: detail ? detail.teammateNotes : null,
  };
}

// The search corpus assembly, archive included -- the surface search_memory
// and the dashboard's /api/search are both built on.
function archiveTeamRows(key) {
  const config = util.getConfig();
  const regexes = digest.compileRedactions(config);
  const corpus = activity.projectCorpus(key, projRecord(key) || { events: [] }, config, regexes, { includeArchive: true });
  return corpus.team;
}

// Rewrite state.json in place through the raw file, bypassing saveState -- the
// point is what loadState does with a file it decides to discard.
function rewriteStateRaw(mutate) {
  const p = path.join(process.env.MEMBRIDGE_HOME, 'state.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  mutate(raw);
  fs.writeFileSync(p, JSON.stringify(raw, null, 2));
}

// What the daemon's next scan does after a discard: the project is still on
// disk and still tracked, so it comes back as a FRESH record -- local events
// rebuilt from the transcripts, and no teamAccessLost, because no transcript
// ever carried one.
function rescanProject(key) {
  const st = util.loadState();
  st.projects = st.projects || {};
  st.projects[key] = {
    events: [{ ts: '2026-08-05T10:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'mine', text: 'check the exporter' }],
  };
  util.saveState(st);
}

function main() {
  util.ensureConfig();

  // ---- 0. baseline: the flag works while state.json survives ----
  // Without this, a fix that broke teammate notes outright would pass below.
  {
    const key = makeRevokedProject('revoked-intact');
    const out = servedNotes(key);
    check('baseline: with state intact, a revoked project serves nothing', () => {
      assert.strictEqual(out.session, null, 'fixture: the revoked gate is not working even before the reset');
      assert.strictEqual(out.file, null, 'fixture: the revoked gate is not working even before the reset');
      assert.deepStrictEqual(out.card, { fresh: [], total: 0 }, 'fixture: the project page card served a revoked project');
      assert.deepStrictEqual(archiveTeamRows(key), [], 'fixture: the archive gate is not working even before the reset');
    });
    check('baseline: the two derived caches are still on disk (nothing erased them)', () => {
      const ix = notesStore.read(key);
      assert.ok(ix && (ix.prose || []).length, 'fixture: the notes index is gone, so nothing below can leak through it');
      assert.ok(teamArchive.loadArchive(PROJECT_ID).rows.length,
        'fixture: the durable archive is gone, so nothing below can leak through it');
    });
  }

  // ---- 1. a state VERSION bump discards the revocation ----
  // Any release that bumps STATE_VERSION, and any downgrade, hits this. The
  // file is read fine and parses fine; loadState returns freshState by design.
  {
    const key = makeRevokedProject('revoked-version-bump');
    rewriteStateRaw(s => { s.version = 999; });

    check('version bump: loadState really did discard the flag (precondition)', () => {
      assert.strictEqual(projRecord(key), undefined,
        'fixture: state survived the version bump, so this section is testing nothing');
    });

    const out = servedNotes(key);
    check('version bump: the SessionStart injection must not carry a revoked teammate decision', () => {
      assert.strictEqual(out.session, null,
        `a revoked project injected teammate content into an agent session after a state rebuild:\n${out.session}`);
    });
    check('version bump: an on-contact file note must not fire for a revoked project', () => {
      assert.strictEqual(out.file, null,
        `a revoked project served a teammate note on file contact after a state rebuild:\n${out.file}`);
    });
    check('version bump: mayServeTeammateNotes must still refuse', () => {
      assert.strictEqual(util.mayServeTeammateNotes(key), false,
        'util.mayServeTeammateNotes read a discarded state as "never revoked" — absence of the record is being '
        + 'treated as absence of the revocation, which is the readSettings shape applied to access control');
    });
  }

  // ---- 2. a single session-less event discards the revocation ----
  // loadState's pre-v2 heuristic scans EVERY event of EVERY project and bails
  // on the first one without a session id. One such event anywhere in the file
  // therefore erases the revocation flag of an unrelated project.
  {
    const key = makeRevokedProject('revoked-legacy-event');
    const other = path.join(h.ROOT, 'projects', 'unrelated');
    fs.mkdirSync(other, { recursive: true });
    rewriteStateRaw(s => {
      s.projects[other] = { events: [{ ts: NOW, source: 'Claude Code', kind: 'prompt', text: 'no session id here' }] };
    });

    check('legacy event: loadState really did discard the flag (precondition)', () => {
      assert.strictEqual(projRecord(key), undefined,
        'fixture: state survived the session-less event, so this section is testing nothing');
    });
    check('legacy event: an unrelated pre-v2 event must not un-revoke a project', () => {
      assert.strictEqual(util.mayServeTeammateNotes(key), false,
        'one session-less event in ANOTHER project erased this project’s revocation');
    });
  }

  // ---- 3. after the rescan, the durable archive comes back into search ----
  // The discard is not the end state. The daemon rescans, the project returns
  // as a fresh record with no flag, and ~/.membridge/team-archive still holds
  // every teammate row that was ever pulled -- so the machine resumes
  // answering questions about a project it was told it may not read.
  {
    const key = makeRevokedProject('revoked-rescan');
    rewriteStateRaw(s => { s.version = 999; });
    rescanProject(key);

    check('rescan: the archive must not re-enter the search corpus', () => {
      const rows = archiveTeamRows(key);
      assert.deepStrictEqual(rows, [],
        'the durable team archive of a revoked project is being served again after a state rebuild — '
        + `${rows.length} teammate row(s) came back, e.g. ${JSON.stringify((rows[0] || {}).summary || null)}`);
    });
    check('rescan: revokedProjects must still name this project', () => {
      assert.deepStrictEqual(activity.revokedProjects(util.loadState(), util.getConfig()), [key],
        'activity.revokedProjects no longer excludes the project, so the FTS index query drops its exclusion too');
    });
    check('rescan: the notes index must not resume injecting', () => {
      assert.strictEqual(servedNotes(key).session, null,
        'the derived notes index resumed injecting a revoked teammate’s decisions after a state rebuild');
    });
  }

  h.finish();
}

main();
