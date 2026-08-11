'use strict';
// Deleting a project must not leave its memory searchable.
// Run via `node test/run.js delete-search-orphans`, or directly.
//
// WHY THIS SUITE EXISTS. Until this was fixed, lib/server.js deleteProject
// stripped the injected blocks, removed <project>/.membridge, pruned the
// durable team archive, dropped the key from state.projects and tombstoned the
// path -- and never touched <homeDir>/search.db. The only writer that removes
// a project's rows is lib/activity.js freshenProject, reached from
// freshenIndex, which iterates trackedProjectEntries(state, config); a deleted
// project is by definition not in that set, so its rows were never visited
// again.
//
// That is a derived cache outliving the rule its source obeyed. Summaries,
// decisions, gotchas and the user's own VERBATIM prompt text stayed in
// search.db and kept being served -- by /api/search, by the MCP search_memory
// tool an agent queries without a human ever seeing the query or the answer,
// and by the PreToolUse Grep hook, which injected a deleted project's memory
// into any session run in that directory. Reproduced in a fixture before it
// was fixed; every "is gone" check below failed against the code this was
// written on (6597551).
//
// THE TWO CHECKS THAT MATTER MOST are the ones that are not about the leak:
//
//   - the SURVIVOR project. Every assertion here is of the shape "these rows
//     are gone", and a purge that emptied the whole index would satisfy all of
//     them while destroying every other project's memory. The survivor is what
//     makes them mean "scoped to the deleted project".
//   - the PAUSED project. The reconciliation sweep must key off
//     Object.keys(state.projects), never freshenIndex's own
//     trackedProjectEntries set, which filters out paused and archived
//     projects. Getting that wrong deletes the searchable memory of every
//     project a user merely paused.
//
// NO_UNOWNED_FILE_READS: fixtures live under ROOT (test/harness.js), never the real home
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P } = h;
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const SRV_PORT = P(92);

// Nonsense tokens: they cannot appear in any other fixture, in the redaction
// defaults, or in a stray real file, so a hit is unambiguously ours.
const DOOMED = 'zqvorbital';
const SURVIVOR = 'plkxantheon';

function mkProject(dir, token, opts = {}) {
  const p = path.join(ROOT, 'projects', dir);
  fs.mkdirSync(path.join(p, '.membridge'), { recursive: true });
  fs.writeFileSync(path.join(p, 'CLAUDE.md'), `# ${dir}\n`);
  if (opts.projectId) {
    fs.writeFileSync(path.join(p, '.membridge', 'team.json'),
      JSON.stringify({ projectId: opts.projectId, teamId: 'team-1', teamName: 'T' }));
  }
  const proj = {
    // A real captured session: a prompt event carrying the user's verbatim ask,
    // and the distilled summary event that answers it. Going through the real
    // event shapes matters -- memorydb.buildEntries is what turns these into
    // the indexed row, and a hand-built entry would prove nothing about what
    // the product actually stores.
    events: [
      { kind: 'prompt', ts: '2026-07-01T00:00:00.000Z', session: `sess-${dir}`, source: 'Claude Code',
        text: `wire up the ${token} launch codes endpoint before the acquisition closes` },
      { kind: 'summary', ts: '2026-07-01T00:05:00.000Z', session: `sess-${dir}`, source: 'Distilled',
        distilled: true, highlights: [],
        text: `Rewired the ${token} launch codes handler and rotated the shared secret.`,
        headline: `${token} launch codes rewired`,
        goal: `ship the ${token} endpoint`,
        decisions: `Keep ${token} secrets off the wire`,
        gotchas: `${token} tokens expire silently` },
    ],
  };
  if (opts.projectId) {
    proj.teamProjectId = opts.projectId;
    proj.teamEntries = [{
      author: 'Teammate', author_id: 'uuid-teammate', ts: '2026-07-02T00:00:00.000Z',
      source: 'Claude Code', session: `sess-${dir}-team`,
      ask: null, goal: null, summary: `Teammate note about ${token} rotation cadence.`,
      decisions: `${token} rotates weekly`, gotchas: null, headline: `${token} rotation`,
      distilled: true, files: ['lib/launch-codes.js'], changes: null,
      project_id: opts.projectId,
    }];
  }
  return { path: p, proj };
}

async function main() {
  const util = require('../../lib/util');
  const activity = require('../../lib/activity');
  const searchIndex = require('../../lib/search-index');
  const server = require('../../lib/server');
  const mcp = require('../../lib/mcp');

  const doomed = mkProject('doomed-app', DOOMED, { projectId: '11111111-1111-1111-1111-111111111111' });
  const survivor = mkProject('survivor-app', SURVIVOR);
  {
    const state = util.loadState();
    state.projects[doomed.path] = doomed.proj;
    state.projects[survivor.path] = survivor.proj;
    util.saveState(state);
  }

  // --- index helpers: the settling query, asked of the file itself ---------
  const withDb = fn => {
    const db = searchIndex.open();
    try { return fn(db); } finally { searchIndex.close(db); }
  };
  const distinctProjects = () => withDb(db =>
    db.prepare('select distinct project from entries where project != \'\' order by project').all().map(r => r.project));
  const rowsFor = p => withDb(db =>
    db.prepare('select key, origin, ask, summary, headline, decisions from entries where project = ?').all(p));
  const fingerprintFor = p => withDb(db => searchIndex.projectFingerprint(db, p));

  const rawGet = p => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: SRV_PORT, path: p, method: 'GET' }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(body); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    req.end();
  });

  const srv = server.startServer(SRV_PORT, { retries: 0 });
  await h.waitForHttp(`http://127.0.0.1:${SRV_PORT}/api/status`);
  try {
    // ---- THE PREMISE -----------------------------------------------------
    // Without this, every "it is gone" assertion below is satisfied by an
    // index that never held the rows in the first place.
    await check('fixture: before the delete, the doomed project\'s own prompt AND its teammate\'s row are indexed and served', async () => {
      const found = activity.searchMemory({ query: DOOMED, limit: 50 });
      assert.ok(found.results.length >= 2,
        `expected the local entry and the team row, got ${found.results.length}`);
      const origins = found.results.map(r => r.origin).sort();
      assert.deepStrictEqual(origins, ['local', 'team'],
        `both halves of the corpus must be reachable, got ${JSON.stringify(origins)}`);
      assert.ok(distinctProjects().includes(doomed.path),
        'the doomed project must have rows in search.db before the delete');
      const over = await rawGet(`/api/search?q=${DOOMED}`);
      assert.strictEqual(over.status, 200);
      assert.ok(over.body.results.length >= 2, 'GET /api/search must serve them before the delete');
    });

    // ---- THE DELETE, through the product's own code path ------------------
    const deleted = server.deleteProject(doomed.path);
    await check('deleteProject reports success and the project is gone from state.projects', () => {
      assert.strictEqual(deleted.path, doomed.path);
      assert.strictEqual(deleted.deleted, true);
      const tracked = Object.keys(util.loadState().projects || {});
      assert.ok(!tracked.includes(doomed.path), 'the deleted path must not remain tracked');
      assert.ok(tracked.includes(survivor.path), 'the survivor must still be tracked');
      assert.strictEqual(fs.existsSync(path.join(doomed.path, '.membridge')), false,
        'the on-disk memory directory is removed -- which is exactly why the index copy is invisible');
    });

    // ---- THE SETTLING CHECK ----------------------------------------------
    await check('deleteProject reports the index purge as a COUNT it read, never as an assumed success', () => {
      // This codebase's signature defect is a flag recording a success the
      // code never achieved, and a deletion that claims to have deleted is its
      // worst form. The count must be a real number read from the database,
      // and the failure shape must be unmistakably different.
      assert.strictEqual(deleted.searchRowsPurged, 2,
        `expected the two indexed rows to be reported as purged, got ${JSON.stringify(deleted)}`);
      assert.ok(!('searchPurgeFailed' in deleted),
        'a successful purge must not carry the failure marker');
    });

    await check('a purge that FAILS reports the failure and never reports a row count', () => {
      // The whole point of the field split. Forced by pointing the index at a
      // path that cannot be opened as a database, which is the shape a locked
      // or corrupt search.db takes.
      const other = mkProject('purge-fails-app', 'wqmzephyr');
      {
        const s = util.loadState();
        s.projects[other.path] = other.proj;
        util.saveState(s);
      }
      activity.searchMemory({ query: 'wqmzephyr', limit: 5 });
      const realOpen = searchIndex.open;
      searchIndex.open = () => { throw new Error('database is locked'); };
      let out;
      try { out = server.deleteProject(other.path); } finally { searchIndex.open = realOpen; }
      assert.strictEqual(out.deleted, true, 'the destructive work already happened; the delete still succeeded');
      assert.strictEqual(out.searchPurgeFailed, true, 'the index failure must be surfaced, not swallowed');
      assert.ok(!('searchRowsPurged' in out),
        `a failed purge must not report a row count, got ${JSON.stringify(out)}`);
      assert.match(String(out.searchPurgeError), /locked/);
      // And the rows really are still there -- the report was honest.
      assert.ok(rowsFor(other.path).length > 0,
        'the fixture must leave real orphans behind, or the honesty check proves nothing');
      // The sweep is the backstop for exactly this: one freshen and they go.
      activity.refreshSearchIndex();
      assert.deepStrictEqual(rowsFor(other.path), [],
        'the reconciliation sweep must clean up after a failed purge');
    });

    await check('search.db holds no rows for a project state.json no longer tracks', () => {
      const tracked = Object.keys(util.loadState().projects || {});
      const orphans = distinctProjects().filter(p => !tracked.includes(p));
      assert.deepStrictEqual(orphans, [],
        `search.db still indexes ${orphans.length} untracked project(s): ${JSON.stringify(orphans)}`);
    });

    await check('the deleted project\'s rows -- prompt text and summaries included -- are gone from the index', () => {
      const rows = rowsFor(doomed.path);
      assert.deepStrictEqual(rows, [],
        `${rows.length} row(s) survived the delete, carrying: ${JSON.stringify(rows.map(r => ({ origin: r.origin, ask: r.ask, summary: r.summary })))}`);
    });

    await check('the deleted project\'s per-project fingerprint is gone too', () => {
      // Left behind, it is a claim that the index is up to date for a project
      // it holds nothing for -- and the value a re-add compares against.
      assert.strictEqual(fingerprintFor(doomed.path), null,
        'a fingerprint for a project with no rows asserts freshness nothing can honour');
    });

    await check('GET /api/search no longer returns the deleted project\'s memory', async () => {
      const over = await rawGet(`/api/search?q=${DOOMED}`);
      assert.strictEqual(over.status, 200);
      assert.deepStrictEqual(over.body.results, [],
        `the app still serves ${over.body.results.length} result(s) from a deleted project`);
    });

    await check('the MCP search_memory tool no longer returns the deleted project\'s memory', () => {
      // A different caller from /api/search, and the one that matters most:
      // an agent consumes this answer with no human reading the query.
      const viaMcp = mcp.searchMemory({ query: DOOMED, limit: 50 });
      assert.deepStrictEqual(viaMcp.results, [],
        `search_memory still serves ${viaMcp.results.length} result(s) from a deleted project`);
    });

    await check('the PreToolUse Grep hook\'s scoped index read finds nothing for the deleted path', () => {
      // lib/hooks-search.js rankForHook queries the index with
      // `project: <path>` and falls back to the in-memory scorer ONLY when the
      // project has no fingerprint. deleteProject removes neither, so the hook
      // keeps injecting a deleted project's memory into sessions run in that
      // directory.
      const hits = withDb(db => searchIndex.search(db, { terms: [DOOMED], minTerms: 1, project: doomed.path }));
      assert.deepStrictEqual(hits, [],
        `the hook path still resolves ${hits.length} row(s) for the deleted project`);
    });

    // ---- SCOPE: the purge must not be a wipe -----------------------------
    await check('the survivor project is untouched: its memory is still indexed and still served', async () => {
      const found = activity.searchMemory({ query: SURVIVOR, limit: 50 });
      assert.ok(found.results.length >= 1,
        'deleting one project must not cost another project its searchable memory');
      assert.ok(distinctProjects().includes(survivor.path),
        'the survivor must still have indexed rows');
      const over = await rawGet(`/api/search?q=${SURVIVOR}`);
      assert.strictEqual(over.status, 200);
      assert.ok(over.body.results.length >= 1, 'GET /api/search must still serve the survivor');
    });

    // ---- NOTHING LATER CLEANS UP ------------------------------------------
    await check('later daemon ticks and unrelated refills do not bring the deleted rows back', () => {
      // refreshSearchIndex is the daemon's entire contribution to the index.
      // Running it repeatedly, and churning an unrelated project so a real
      // refill happens, must not be mistaken for eventual cleanup.
      for (let i = 0; i < 3; i++) activity.refreshSearchIndex();
      const s = util.loadState();
      s.projects[survivor.path].events.push({
        kind: 'prompt', ts: '2026-07-04T00:00:00.000Z', session: 'sess-churn',
        source: 'Claude Code', text: `more ${SURVIVOR} work`,
      });
      util.saveState(s);
      activity.searchMemory({ query: SURVIVOR, limit: 50 });
      const tracked = Object.keys(util.loadState().projects || {});
      const orphans = distinctProjects().filter(p => !tracked.includes(p));
      assert.deepStrictEqual(orphans, [],
        'ticks and unrelated refills never visit an untracked project, so nothing prunes it');
    });

    // ---- THE SWEEP MUST NOT EAT A PAUSED PROJECT --------------------------
    await check('PAUSING a project does not cost it its searchable memory', () => {
      // The single most dangerous way to get the reconciliation sweep wrong.
      // freshenIndex's own refill loop iterates trackedProjectEntries, which
      // filters out paused and archived projects via isProjectOff. Keying the
      // sweep off that same set -- the obvious, natural thing to do, since it
      // is right there in the function -- would silently and permanently
      // delete the searchable memory of every project the user merely paused.
      // That is destruction of data nobody asked to lose, shipped inside a fix
      // for a data-retention bug. The sweep keys off Object.keys(state.projects)
      // for exactly this reason, and this check is what holds it there.
      const paused = mkProject('paused-app', 'jjntlumen');
      {
        const s = util.loadState();
        s.projects[paused.path] = paused.proj;
        util.saveState(s);
      }
      activity.searchMemory({ query: 'jjntlumen', limit: 5 });
      assert.ok(rowsFor(paused.path).length > 0, 'fixture: the project must be indexed before it is paused');

      const toggled = server.toggleProject(paused.path);
      assert.strictEqual(toggled.paused, true, `pausing must succeed: ${JSON.stringify(toggled)}`);
      assert.strictEqual(util.isProjectOff(paused.path, util.getConfig()), true,
        'fixture: the project must really be paused, or this check proves nothing');
      // It is still a project the user has -- just not one being captured.
      assert.ok(Object.keys(util.loadState().projects || {}).includes(paused.path),
        'a paused project is still in state.projects; that is what makes it distinguishable from a deleted one');

      for (let i = 0; i < 3; i++) activity.refreshSearchIndex();
      assert.ok(rowsFor(paused.path).length > 0,
        'the sweep reaped a PAUSED project -- it is keyed off the wrong set');
    });
    // ---- THE SWEEP MUST NOT WIPE THE INDEX ON A DISCARDED state.json ------
    await check('the sweep refuses to reap when the machine reports NO projects at all', () => {
      // util.loadState returns a FRESH, empty state on a STATE_VERSION
      // mismatch and on the pre-v2 sessionless-event discard. That shape --
      // "no projects" alongside a fully populated index -- is an upgrade or a
      // rebuilt state.json far more often than a user who really deleted
      // everything. Reaping on it would destroy every project's searchable
      // memory in a single pass, silently, on upgrade.
      const before = distinctProjects();
      assert.ok(before.length > 0, 'fixture: the index must hold rows for this to prove anything');
      const dropped = withDb(db => searchIndex.pruneUntracked(db, []));
      assert.deepStrictEqual(dropped, [], 'an empty project set is inconclusive and must reap nothing');
      assert.deepStrictEqual(distinctProjects(), before,
        'the index must be byte-for-byte untouched when the project set is empty');
    });

    await check('the sweep skips its full scan when the project set has not moved', () => {
      // `select distinct project` is a full scan of the content table (29ms
      // against 50k rows) and this runs on the freshen in front of every
      // search. It is sound to skip: rows only enter through replaceProject or
      // replaceAll, both of which write tracked projects, so an orphan cannot
      // appear while the set holds still.
      const known = Object.keys(util.loadState().projects || {});
      withDb(db => searchIndex.pruneUntracked(db, known)); // settle the signature
      let scans = 0;
      const realIndexed = searchIndex.indexedProjects;
      searchIndex.indexedProjects = db => { scans += 1; return realIndexed(db); };
      try {
        withDb(db => searchIndex.pruneUntracked(db, known));
        assert.strictEqual(scans, 0, 'an unchanged project set must not pay for the scan');
        // ...and a set that DID move still sweeps, or the gate is just an off switch.
        const moved = withDb(db => searchIndex.pruneUntracked(db, known.slice(0, -1)));
        assert.strictEqual(moved.length, 1,
          `a changed project set must still reap, got ${JSON.stringify(moved)}`);
      } finally { searchIndex.indexedProjects = realIndexed; }
    });
  } finally {
    await new Promise(r => srv.close(r));
  }

  h.finish();
}

main().catch(err => { console.error(err); process.exit(1); });
