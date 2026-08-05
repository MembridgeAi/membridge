'use strict';
// A project this machine may no longer read must stop injecting its teammates'
// decisions -- through the DERIVED index as well as through the rows.
//
// Why this suite exists. lib/util.js's teamRowsFor is documented as "the ONLY
// supported way to read a project's pulled teammate rows", and it fails closed
// on proj.teamAccessLost. But <project>/.membridge/teammate-notes.json is not
// a reader of those rows -- it is a derived on-disk COPY of them, written once
// per pull -- so teamRowsFor structurally cannot cover it. Emptying
// proj.teamEntries in the access-lost branch left that copy on disk and
// serving, through three ungated readers:
//
//   1. lib/hooks-notes.js  buildSessionOutput  -- SessionStart injection
//   2. lib/hooks-recall.js buildNotesOutput    -- PreToolUse, on file contact
//   3. lib/server.js       projectDetail       -- the project page's notes card
//
// And the leak has no expiry. An undelivered prose decision is deliverable
// forever (lib/teammate-notes.js selectProse has no age filter, on purpose),
// and a file note re-fires on contact for REFIRE_DAYS past its own timestamp
// -- never past the revocation. Both self-heal routes were closed too:
// backfillProjects reads teamRowsFor (empty for a revoked project) and
// afterTeamPull only visits `changed`, which a revoked project never enters
// because the access-lost branch `continue`s before the pull.
//
// The unlink half is the same defect with a different trigger and a worse
// tell: teamsync.unlinkProject drops team.json and prunes the durable archive
// but left the index behind, so the Projects grid read "Private - Only you"
// while every session in that project still received teammate content.
//
// THE TWO HALVES ARE FIXED DIFFERENTLY, on purpose, and the checks below pin
// which mechanism covers which:
//   - revoked: the readers are gated on util.mayServeTeammateNotes (keyed on
//     teamAccessLost, beside teamRowsFor), AND the index is erased at the source
//     by syncTeams' access-lost branch and by the backfill reconciler. The gate
//     is what protects the machine that never checks in again.
//   - unlinked: no flag is ever stamped for an unlinked project, so the reader
//     gate structurally cannot see it. teamsync.unlinkProject erases the index
//     itself, exactly as it already pruned the durable archive.
//
// Run directly, or via `node test/run.js teammate-notes-revocation`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
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
const server = require('../../lib/server');
// The ROW readers (section 7): the machine-local search corpus, and the MCP
// teammate slice that get_project_memory serves and the injected block renders.
const activity = require('../../lib/activity');
const mcp = require('../../lib/mcp');

const NOW = '2026-08-04T12:00:00.000Z';
const SESSION = 'sess-revocation-1';

// One pulled teammate row, in the STORED shape (lib/teamsync.js's pull renames
// author_name -> author before it lands in state.projects[].teamEntries).
// Carries both note kinds so each delivery point has something to leak.
const TEAM_ROW = {
  author: 'Andrew',
  authorId: '11111111-2222-3333-4444-555555555555',
  ts: '2026-08-04T09:00:00.000Z',
  source: 'Claude Code',
  session: 'their-session',
  ask: 'rework the pull cursor',
  summary: 'Reworked the pull cursor.',
  decisions: 'the pull cursor is now per project, not per team',
  gotchas: '',
  files: ['lib/teamsync.js'],
  changes: [{ file: 'lib/teamsync.js', note: 'do not widen the dirty filter here' }],
};

// A tracked project that looks exactly like a shared one: a checkout (so
// repo-root.wireKeyFor can answer, which is what byFile is keyed by), a
// team.json, one pulled teammate row in state, and a built index.
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

// The three readers, each asked "would you serve this project's teammate
// content right now?". Every call is fresh: state is re-read so a flag written
// between calls is seen, and no note is ever marked delivered (nothing here
// calls commit()), so a wrongly-refused note is only deferred, never lost.
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
  const detail = server.projectDetail(key);
  return {
    session: sessionOut && sessionOut.text ? sessionOut.text : null,
    file: fileOut && fileOut.text ? fileOut.text : null,
    card: detail ? detail.teammateNotes : null,
  };
}

const onDisk = key => notesStore.read(key);
const indexIsEmpty = ix =>
  !!ix && !(ix.prose || []).length && !Object.keys(ix.byFile || {}).length;

function main() {
  util.ensureConfig();

  // ---- 0. the precondition every check below is the negation of ----
  // Without this, a fix that simply broke teammate notes outright would pass
  // the whole suite.
  {
    const key = makeProject('healthy');
    const out = served(key);
    check('baseline: a linked project delivers its teammate decision, file note and card', () => {
      assert.ok(out.session && /the pull cursor is now per project/.test(out.session),
        'SessionStart injection carried no teammate decision — the fixture is wrong, not the code');
      assert.ok(out.file && /do not widen the dirty filter/.test(out.file),
        'the on-contact file note did not fire for the fixture file');
      assert.strictEqual(out.card.total, 1, 'the project page card showed no teammate decision');
    });
  }

  // ---- 1. revoked server-side: every delivery point goes quiet ----
  // proj.teamAccessLost is stamped by lib/teamsync.js the moment the backend
  // stops listing the project for this member. The rows are gone from state by
  // then; these three read the derived copy instead.
  {
    const key = makeProject('revoked');
    const st = util.loadState();
    st.projects[key].teamAccessLost = NOW;
    st.projects[key].teamEntries = [];   // exactly what the access-lost branch leaves
    st.projects[key].teamPullTs = null;
    util.saveState(st);

    const out = served(key);
    check('revoked: the SessionStart injection carries no teammate decision', () => {
      assert.strictEqual(out.session, null,
        `a revoked project injected teammate content into an agent session:\n${out.session}`);
    });
    check('revoked: an on-contact file note does not fire', () => {
      assert.strictEqual(out.file, null,
        `a revoked project served a teammate note on file contact:\n${out.file}`);
    });
    check('revoked: the project page notes card is empty', () => {
      assert.deepStrictEqual(out.card, { fresh: [], total: 0 },
        'the project page still showed a revoked project’s teammate decisions');
    });
  }

  // ---- 2. unlinked locally: same three, no flag involved ----
  // syncTeams skips a project with no team.json entirely (`if (!link ||
  // !link.projectId) continue`), so teamAccessLost is NEVER stamped for an
  // unlinked project and the stale teamEntries stay in state. The indicator and
  // the behaviour pointed in opposite directions: "Private · Only you" in the
  // grid, teammate content in every session.
  {
    const key = makeProject('unlinked');
    assert.ok(teamsync.unlinkProject(key), 'fixture: unlinkProject reported no team.json to remove');

    const out = served(key);
    check('unlinked: no teammate decision reaches a session', () => {
      assert.strictEqual(out.session, null,
        `an unlinked project injected teammate content into an agent session:\n${out.session}`);
    });
    check('unlinked: no file note fires on contact', () => {
      assert.strictEqual(out.file, null,
        `an unlinked project served a teammate note on file contact:\n${out.file}`);
    });
    check('unlinked: the project page notes card is empty', () => {
      assert.deepStrictEqual(out.card, { fresh: [], total: 0 },
        'the project page still showed an unlinked project’s teammate decisions');
    });
    check('unlinked: unlinkProject erases the derived index at the source', () => {
      assert.ok(indexIsEmpty(onDisk(key)),
        'teammate-notes.json survived the unlink — the gate is the only thing stopping the leak');
    });
  }

  // ---- 3. the source clear, and the two self-heal routes ----
  // Gating the readers is not enough on its own: the file has to stop existing
  // as servable content, or the next reader anyone adds inherits the leak.
  {
    const key = makeProject('reconcile');
    const st = util.loadState();
    st.projects[key].teamAccessLost = NOW;
    st.projects[key].teamEntries = [];
    util.saveState(st);
    assert.ok(!indexIsEmpty(onDisk(key)), 'fixture: the index should still be full here');

    notesStore.afterTeamPull([]); // the shared post-pull entry point both loops call
    check('reconcile: a revoked project’s index is emptied on the next sync pass', () => {
      assert.ok(indexIsEmpty(onDisk(key)),
        'the derived index survived a full sync pass after access was lost');
    });
    check('reconcile: emptying it does not resurrect it from the stale rows', () => {
      notesStore.afterTeamPull([]);
      assert.ok(indexIsEmpty(onDisk(key)), 'a later pass rebuilt the index for a revoked project');
    });
  }

  // A cleared index must not be rebuilt from the teamEntries an unlink leaves
  // behind. backfillProjects' guard is `does an index file exist` — so the
  // eraser has to leave an EMPTY index rather than delete the file, or the very
  // next pass conjures the leak back.
  {
    const key = makeProject('unlink-then-sync');
    teamsync.unlinkProject(key);
    notesStore.afterTeamPull([]);
    check('reconcile: an unlinked project’s index is not rebuilt from its stale rows', () => {
      const ix = onDisk(key);
      assert.ok(indexIsEmpty(ix),
        'the backfill rebuilt a teammate-notes index for a project with no team link');
      assert.deepStrictEqual(served(key).card, { fresh: [], total: 0 },
        'and the card came back with it');
    });
  }

  // ---- 4. restored access resumes, without re-delivering what was read ----
  // The flag is cleared by the same pass that notices the project is visible
  // again, and the pull refills the index. `seen` is carried through the erase
  // so nothing already read is shown twice.
  {
    const key = makeProject('restored');
    const st = util.loadState();
    st.projects[key].teamAccessLost = NOW;
    st.projects[key].teamEntries = [];
    util.saveState(st);
    notesStore.afterTeamPull([]);
    assert.ok(indexIsEmpty(onDisk(key)), 'fixture: the index should be empty at this point');

    const back = util.loadState();
    delete back.projects[key].teamAccessLost;
    back.projects[key].teamEntries = [TEAM_ROW];
    util.saveState(back);
    notesStore.afterTeamPull([key]); // a pull that brought rows marks the project changed

    check('restored: re-granted access refills the index and delivers again', () => {
      assert.ok(!indexIsEmpty(onDisk(key)), 'the index was not refilled after access came back');
      const out = served(key);
      assert.ok(out.session && /the pull cursor is now per project/.test(out.session),
        'a re-granted project stayed silent');
      assert.strictEqual(out.card.total, 1, 'the card stayed empty after access came back');
    });
  }

  // ---- 5. the gate itself: fails CLOSED, and agrees with teamRowsFor ----
  // It lives beside teamRowsFor in lib/util.js and must answer the same way for
  // the same reasons; two notions of "may no longer read this project" that can
  // disagree is how the original single-reader guard came to miss four readers.
  {
    const key = makeProject('gate');
    check('gate: an unrevoked project serves', () => {
      assert.strictEqual(util.mayServeTeammateNotes(key, projRecord(key)), true);
    });
    check('gate: a revoked record is refused, whether passed or looked up', () => {
      assert.strictEqual(util.mayServeTeammateNotes(key, { ...projRecord(key), teamAccessLost: NOW }), false,
        'a revoked record was served');
      // Omitting the record must NOT be a way past the gate: it is resolved
      // from state instead of assumed innocent. This is the whole reason the
      // path is a parameter.
      const st = util.loadState();
      st.projects[key].teamAccessLost = NOW;
      util.saveState(st);
      assert.strictEqual(util.mayServeTeammateNotes(key), false,
        'omitting the project record let a revoked project through');
      const back = util.loadState();
      delete back.projects[key].teamAccessLost;
      util.saveState(back);
      assert.strictEqual(util.mayServeTeammateNotes(key), true,
        'the looked-up path refuses an unrevoked project too');
    });
    check('gate: it never contradicts teamRowsFor on access grounds', () => {
      const cases = [
        null, {},
        { teamEntries: [TEAM_ROW] },
        { teamEntries: [TEAM_ROW], teamAccessLost: NOW },
        { teamEntries: [], teamAccessLost: NOW },
      ];
      for (const proj of cases) {
        // teamRowsFor answering [] does NOT imply "do not serve" — a project
        // with no rows yet is fine. But every record it refuses on ACCESS
        // grounds must be refused here too; teamAccessLost is the shared reason,
        // and two notions of it that can disagree is how the original guard
        // came to cover one reader of five.
        if (!util.mayServeTeammateNotes(key, proj)) {
          assert.deepStrictEqual(util.teamRowsFor(proj), [],
            `teamRowsFor served rows for a record the notes gate refuses: ${JSON.stringify(proj)}`);
        }
      }
    });
  }

  // ---- 6. status honesty (the fold-in) ----
  // bin/membridge.js read proj.teamEntries directly instead of through
  // util.teamRowsFor, so `membridge status` over-reported a revoked project's
  // stale local cache as teammate work still waiting to be injected.
  {
    check('status: a revoked project is not described as having teammate entries to inject', () => {
      const src = h.readSource(path.join(__dirname, '..', '..', 'bin', 'membridge.js'));
      const i = src.indexOf('function emptyProjectDetail');
      assert.ok(i !== -1, 'bin/membridge.js emptyProjectDetail not found');
      const body = src.slice(i, src.indexOf('\n}', i));
      assert.ok(/teamRowsFor/.test(body),
        'emptyProjectDetail still counts proj.teamEntries directly — util.teamRowsFor is the only supported reader');
      assert.ok(!/proj\.teamEntries/.test(body),
        'emptyProjectDetail still reaches into proj.teamEntries');
    });
  }

  // ---- 7. unlinked locally: the cached ROWS go too, not just the index ----
  // Section 2 above fixed the DERIVED copy. The rows it was derived FROM stayed
  // in proj.teamEntries, so util.teamRowsFor — "the ONLY supported way to read a
  // project's pulled teammate rows" — kept handing them to search, to
  // get_project_memory (the MCP teammate slice, which is also what the injected
  // block renders) and to the project page, while the Projects grid described
  // the project as private. Same indicator-versus-behaviour split, one copy over.
  //
  // Fixed at the SOURCE (teamsync.unlinkProject prunes them) rather than by
  // teaching teamRowsFor about link presence: that wrapper answers a different
  // question, keyed on the positive `teamAccessLost` fact, and rows-with-no-
  // team.json is a shape the existing fixtures rely on.
  {
    const key = makeProject('unlinked-rows');
    // This section searches, so its rows need identities of their own. The
    // shared TEAM_ROW is byte-identical across every fixture project above, and
    // activity.eventKey is (session, author, ts, source) — so the same row in
    // seven projects is seven index rows with ONE key, which the corpus then
    // serves as duplicate hits. Impossible in production (a session belongs to
    // one project) and purely a fixture artifact, but it makes a count
    // assertion meaningless, so this row gets its own session and timestamp.
    //
    // A LOCAL entry goes in alongside it, because the danger of pruning at the
    // source is pruning too much: this user's own work must survive an unlink.
    const OWN_ROW = {
      ...TEAM_ROW,
      session: 'their-unlinked-rows-session',
      ts: '2026-08-04T09:30:00.000Z',
      ask: 'rework the pullstamp cursor',
      summary: 'Reworked the pullstamp cursor.',
      decisions: 'the pullstamp cursor is now per project',
    };
    {
      const st = util.loadState();
      st.projects[key] = {
        events: [
          { ts: '2026-08-04T10:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'mine', text: 'trace the cursorbeacon path' },
          {
            ts: '2026-08-04T10:05:00.000Z', source: 'Distilled', kind: 'summary', session: 'mine',
            text: 'The cursorbeacon path is per project now.',
            headline: 'cursorbeacon is per project', goal: '', decisions: '', gotchas: '', highlights: [],
          },
        ],
        teamEntries: [OWN_ROW],
        teamPullTs: NOW,
      };
      util.saveState(st);
    }
    const rowsFor = () => util.teamRowsFor(projRecord(key));
    const hits = q => activity.searchMemory({ query: q, limit: 50 }).results
      .filter(r => r.project === path.basename(key) || r.projectPath === key);
    const teamSlice = () => mcp.getProjectMemory(key).teammates;

    check('baseline: the fixture serves its teammate row through every row reader', () => {
      assert.strictEqual(rowsFor().length, 1, 'fixture: the cached teammate row is missing from state');
      assert.strictEqual(teamSlice().length, 1, 'fixture: get_project_memory served no teammate slice');
      assert.strictEqual(hits('pullstamp').filter(r => r.origin === 'team').length, 1,
        'fixture: search did not find the teammate row before the unlink');
      assert.strictEqual(hits('cursorbeacon').filter(r => r.origin === 'local').length, 1,
        'fixture: search did not find the user’s own local entry');
    });

    assert.ok(teamsync.unlinkProject(key), 'fixture: unlinkProject reported no team.json to remove');

    check('unlinked: the cached teammate rows are pruned from state', () => {
      assert.deepStrictEqual(rowsFor(), [],
        'proj.teamEntries survived the unlink — teamRowsFor still serves an unlinked project’s teammates');
      assert.strictEqual(projRecord(key).teamPullTs, null,
        'the forward pull cursor outlived the rows: a later re-link would pull only newer rows and never re-fetch the history behind it');
    });

    check('unlinked: the MCP/injected teammate slice is empty', () => {
      assert.deepStrictEqual(teamSlice(), [],
        'get_project_memory still serves an unlinked project’s teammate rows — this slice is what the injected block renders');
    });

    check('unlinked: search stops serving the row, and keeps the user’s own work', () => {
      assert.deepStrictEqual(hits('pullstamp').filter(r => r.origin === 'team'), [],
        'search still returns a teammate row for a project with no team link');
      assert.strictEqual(hits('cursorbeacon').filter(r => r.origin === 'local').length, 1,
        'the prune took the user’s OWN local entries with it — unlinking is not deleting');
    });

    check('unlinked: pruning is idempotent and never mints a state record', () => {
      teamsync.unlinkProject(key); // no team.json left; must still be a safe no-op
      assert.deepStrictEqual(rowsFor(), [], 'a second unlink disturbed the pruned rows');
      // An untracked path must not gain a project record just because someone
      // ran unlink in it — that would put a folder the daemon does not watch
      // into state.
      const ghost = path.join(h.ROOT, 'projects', 'never-tracked-unlink');
      fs.mkdirSync(ghost, { recursive: true });
      teamsync.unlinkProject(ghost);
      assert.ok(!(util.loadState().projects || {})[ghost],
        'unlinking an untracked path created a project record in state');
    });
  }

  h.finish();
}

main();
