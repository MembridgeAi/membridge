'use strict';
// A user's ONE control for "stop putting my other team's thinking into agent
// sessions running here" is the per-project pause/exclude switch:
// `.membridge-off` or config.exclude. archiveProject strips the injected
// block and stops team pulls, and the UI tells the user new teammate
// activity stops arriving. But the two delivery points that inject
// teammates' notes into an agent's context -- lib/hooks-notes.js
// buildSessionOutput (SessionStart) and lib/hooks-recall.js buildNotesOutput
// (PreToolUse) -- checked notes.isNotesEnabled and util.mayServeTeammateNotes
// (the REVOCATION gate) but never util.isProjectOff, and no caller checked it
// for them. A paused/excluded project kept receiving teammates' decisions,
// gotchas and per-file warnings forever: the SessionStart hook has no
// matcher, so it fired on every session start in the archived folder with no
// self-heal.
//
// lib/hooks-recall.js already computed the right boolean for its OWN serve
// path (`tracked = !isProjectOff && !isRecallPausedForProject`, see that
// file) but never threaded it -- or isProjectOff alone -- into the notes
// call sitting a few lines above it.
//
// mayServeTeammateNotes (revocation) and isProjectOff (pause/exclude) are
// TWO INDEPENDENT gates. This suite proves both apply, independently: a
// paused-but-not-revoked project is silent, and a revoked-but-not-paused
// project is (still) silent -- proving the untouched revocation gate was
// never disturbed by this fix.
//
// Also covers the hygiene line: lib/teammate-notes-store.js backfillProjects
// must not write a fresh teammate-notes.json index into a paused/excluded
// project. It serves nothing on its own -- delivery is what this suite's
// first four sections cover -- but a materialized index in an archived repo
// is wrong on its own terms.
//
// Run directly, or via `node test/run.js teammate-notes-pause-gate`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
// Belt and braces beyond MEMBRIDGE_HOME: an earlier probe of this exact area
// called scan.syncOnce({}) with only MEMBRIDGE_HOME isolated, left HOME real,
// and it walked the operator's actual Claude transcripts and rewrote
// CLAUDE.md across six real projects. This suite never calls scan or a sync
// path -- it calls the hook builder functions directly against fixture
// state, same as test/suites/teammate-notes-revocation.test.js -- but HOME is
// pinned anyway rather than relying on that being true forever.
process.env.HOME = require('path').join(h.ROOT, 'home-real');
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const memorydb = require('../../lib/memorydb');
const teamsync = require('../../lib/teamsync');
const notesStore = require('../../lib/teammate-notes-store');
const hooksNotes = require('../../lib/hooks-notes');
const hooksRecall = require('../../lib/hooks-recall');

const NOW = '2026-08-12T12:00:00.000Z';
const SESSION = 'sess-pause-gate-1';

// One pulled teammate row, in the STORED shape (lib/teamsync.js's pull
// renames author_name -> author before it lands in state.projects[].teamEntries).
// Carries both note kinds so each delivery point has something to leak.
const TEAM_ROW = {
  author: 'Andrew',
  authorId: '11111111-2222-3333-4444-555555555555',
  ts: '2026-08-12T09:00:00.000Z',
  source: 'Claude Code',
  session: 'their-session',
  ask: 'rework the pause switch',
  summary: 'Reworked the pause switch.',
  decisions: 'archived projects stop receiving teammate notes now',
  gotchas: '',
  files: ['lib/teamsync.js'],
  changes: [{ file: 'lib/teamsync.js', note: 'do not widen the dirty filter here' }],
};

// A tracked, linked project with one pulled teammate row and a built index --
// exactly the shape a project has the moment before a user archives it.
function makeProject(name) {
  const key = path.join(h.ROOT, 'projects', name);
  fs.mkdirSync(path.join(key, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(key, '.git'), { recursive: true }); // checkoutRoot stats .git
  fs.writeFileSync(path.join(key, 'lib', 'teamsync.js'), '// fixture\n');
  fs.mkdirSync(path.join(key, memorydb.DIR_NAME), { recursive: true });
  fs.writeFileSync(teamsync.teamFilePath(key), JSON.stringify({
    projectId: `proj-${name}`, teamId: 'team-1', teamName: 'Team One',
    linkedBy: 'me@test.dev', linkedAt: NOW,
  }, null, 2));

  const st = util.loadState();
  st.projects = st.projects || {};
  st.projects[key] = { events: [], teamEntries: [TEAM_ROW], teamPullTs: NOW };
  util.saveState(st);

  notesStore.rebuildTeammateNotes(key, [TEAM_ROW], NOW);
  return key;
}

const projRecord = key => (util.loadState().projects || {})[key];

// Both delivery points, asked "would you serve this project's teammate
// content right now?" Fresh state each call, no commit() invoked, so a
// wrongly-refused note is only ever deferred, never lost by the test itself.
function served(key) {
  const proj = projRecord(key);
  const config = util.getConfig();
  const sessionOut = hooksNotes.buildSessionOutput({
    projectPath: key, sessionId: SESSION, source: 'startup', now: NOW, config, proj,
  });
  const fileOut = hooksRecall.buildNotesOutput({
    projectPath: key,
    absPath: path.join(key, 'lib', 'teamsync.js'),
    relPath: 'lib/teamsync.js',
    sessionId: SESSION, now: NOW, config, proj,
  });
  return {
    session: sessionOut && sessionOut.text ? sessionOut.text : null,
    file: fileOut && fileOut.text ? fileOut.text : null,
  };
}

const excludeConfig = key => {
  const raw = util.loadUserConfig();
  raw.exclude = [...(raw.exclude || []), key];
  util.saveUserConfig(raw);
};
const clearExclude = () => {
  const raw = util.loadUserConfig();
  raw.exclude = [];
  util.saveUserConfig(raw);
};
const writeOffMarker = key => fs.writeFileSync(path.join(key, '.membridge-off'), '');
const removeOffMarker = key => { try { fs.unlinkSync(path.join(key, '.membridge-off')); } catch {} };

function main() {
  util.ensureConfig();
  clearExclude();

  // ---- 0. baseline: the precondition every "goes silent" check below is the
  // negation of. Without this, a fix that broke notes outright (or a suite
  // whose fixture never worked) would pass every case that follows. ----
  {
    const key = makeProject('healthy');
    const out = served(key);
    check('baseline: an unpaused, unexcluded, unrevoked project delivers via both hooks', () => {
      assert.ok(out.session && /archived projects stop receiving teammate notes now/.test(out.session),
        'SessionStart injection carried no teammate decision — the fixture is wrong, not the code');
      assert.ok(out.file && /do not widen the dirty filter/.test(out.file),
        'the on-contact file note did not fire for the fixture file');
    });
  }

  // ---- 1. config.exclude: both hooks go quiet ----
  {
    const key = makeProject('excluded');
    excludeConfig(key);
    const out = served(key);
    check('excluded: the SessionStart injection carries no teammate decision', () => {
      assert.strictEqual(out.session, null,
        `an excluded project injected teammate content into an agent session:\n${out.session}`);
    });
    check('excluded: an on-contact file note does not fire', () => {
      assert.strictEqual(out.file, null,
        `an excluded project served a teammate note on file contact:\n${out.file}`);
    });
    clearExclude();
  }

  // ---- 2. .membridge-off marker: both hooks go quiet ----
  {
    const key = makeProject('off-marker');
    writeOffMarker(key);
    const out = served(key);
    check('.membridge-off: the SessionStart injection carries no teammate decision', () => {
      assert.strictEqual(out.session, null,
        `a paused (.membridge-off) project injected teammate content into an agent session:\n${out.session}`);
    });
    check('.membridge-off: an on-contact file note does not fire', () => {
      assert.strictEqual(out.file, null,
        `a paused (.membridge-off) project served a teammate note on file contact:\n${out.file}`);
    });
    removeOffMarker(key);
  }

  // ---- 3. revoked but NOT paused: the untouched revocation gate still fires,
  // independently of the new pause gate. Proves the two checks were not
  // collapsed into one -- mayServeTeammateNotes must keep refusing on its own
  // account, with isProjectOff false. ----
  {
    const key = makeProject('revoked-unpaused');
    const st = util.loadState();
    st.projects[key].teamAccessLost = NOW;
    st.projects[key].teamEntries = [];
    util.saveState(st);
    assert.ok(!util.isProjectOff(key, util.getConfig()),
      'fixture: this project must NOT be paused/excluded, or the check below proves nothing about the revocation gate');

    const out = served(key);
    check('revoked-unpaused: the SessionStart injection is still refused by the revocation gate', () => {
      assert.strictEqual(out.session, null,
        `a revoked (but unpaused) project injected teammate content into an agent session:\n${out.session}`);
    });
    check('revoked-unpaused: an on-contact file note is still refused by the revocation gate', () => {
      assert.strictEqual(out.file, null,
        `a revoked (but unpaused) project served a teammate note on file contact:\n${out.file}`);
    });
  }

  // ---- 4. paused but NOT revoked: the new gate alone is enough, with no
  // revocation involved. The paired case to section 3 -- together they prove
  // the two gates are independent in both directions. ----
  {
    const key = makeProject('paused-unrevoked');
    writeOffMarker(key);
    assert.strictEqual(util.mayServeTeammateNotes(key, projRecord(key)), true,
      'fixture: this project must NOT be revoked, or the check below proves nothing about the pause gate');

    const out = served(key);
    check('paused-unrevoked: the SessionStart injection is refused by the pause gate alone', () => {
      assert.strictEqual(out.session, null,
        `a paused (but unrevoked) project injected teammate content into an agent session:\n${out.session}`);
    });
    check('paused-unrevoked: an on-contact file note is refused by the pause gate alone', () => {
      assert.strictEqual(out.file, null,
        `a paused (but unrevoked) project served a teammate note on file contact:\n${out.file}`);
    });
    removeOffMarker(key);
  }

  // ---- 5. the hygiene line: backfillProjects must not write a fresh index
  // into a paused/excluded project. Fixture: rows exist in state, no index
  // file exists yet -- exactly the shape backfillProjects exists to fill in
  // for an unpaused project. ----
  const indexPath = key => path.join(key, memorydb.DIR_NAME, 'teammate-notes.json');
  // A linked project with pulled rows and NO index yet -- the shape
  // backfillProjects exists to fill in -- but without makeProject's own
  // notesStore.rebuildTeammateNotes call, since building one is exactly what
  // this section is testing.
  function makeBackfillFixture(name) {
    const key = path.join(h.ROOT, 'projects', name);
    fs.mkdirSync(path.join(key, '.git'), { recursive: true });
    fs.mkdirSync(path.join(key, memorydb.DIR_NAME), { recursive: true });
    fs.writeFileSync(teamsync.teamFilePath(key), JSON.stringify({
      projectId: `proj-${name}`, teamId: 'team-1', teamName: 'Team One',
      linkedBy: 'me@test.dev', linkedAt: NOW,
    }, null, 2));
    const st = util.loadState();
    st.projects = st.projects || {};
    st.projects[key] = { events: [], teamEntries: [TEAM_ROW], teamPullTs: NOW };
    util.saveState(st);
    return key;
  }
  {
    const key = makeBackfillFixture('backfill-excluded');
    excludeConfig(key);

    assert.ok(!fs.existsSync(indexPath(key)), 'fixture: no index should exist yet');
    notesStore.backfillProjects(util.loadState(), NOW);
    check('backfill: an excluded project with pending rows is not given a fresh index', () => {
      assert.ok(!fs.existsSync(indexPath(key)),
        'backfillProjects wrote a teammate-notes.json index into an excluded project');
    });
    clearExclude();
  }
  {
    const key = makeBackfillFixture('backfill-off');
    writeOffMarker(key);

    assert.ok(!fs.existsSync(indexPath(key)), 'fixture: no index should exist yet');
    notesStore.backfillProjects(util.loadState(), NOW);
    check('backfill: a paused (.membridge-off) project with pending rows is not given a fresh index', () => {
      assert.ok(!fs.existsSync(indexPath(key)),
        'backfillProjects wrote a teammate-notes.json index into a paused project');
    });
    removeOffMarker(key);
  }
  // Control: the same shape, unpaused, DOES get backfilled -- otherwise a
  // backfillProjects that silently stopped working for everyone would pass
  // both checks above for the wrong reason.
  {
    const key = makeBackfillFixture('backfill-healthy');

    assert.ok(!fs.existsSync(indexPath(key)), 'fixture: no index should exist yet');
    const rebuilt = notesStore.backfillProjects(util.loadState(), NOW);
    check('backfill: an unpaused project with pending rows IS given a fresh index', () => {
      assert.ok(rebuilt.includes(key),
        'backfillProjects did not report this healthy project as rebuilt — the fixture is wrong, not the code');
      assert.ok(fs.existsSync(indexPath(key)),
        'backfillProjects did not write a teammate-notes.json index for an unpaused project with pending rows');
    });
  }

  h.finish();
}

main();
