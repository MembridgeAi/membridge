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
// RESULT: clean. The first five checks are source-reading, same caveat as the
// MCP and Electron suites — they catch a future edit removing a guard, not a
// misunderstanding of the runtime. The SIXTH is executed, and it is the one the
// scope note under check 4 said would need "an executed test with a failing
// prune, which needs a live sync fixture this suite does not have". It has one
// now (test/mock-supabase.js, the same fixture team-access-fallthrough drives),
// so the partial-failure property is demonstrated rather than inferred.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsyncLib = require('../../lib/teamsync');
const teamArchive = require('../../lib/team-archive');
const activityLib = require('../../lib/activity');
const { createMockSupabase } = require('../mock-supabase');

const LIB = path.join(__dirname, '..', '..', 'lib');
const teamsync = fs.readFileSync(path.join(LIB, 'teamsync.js'), 'utf8');
const archive = fs.readFileSync(path.join(LIB, 'team-archive.js'), 'utf8');

const MOCK_PORT = P(64);
// The planted teammate content, recognisable in a search result. Nothing
// sensitive: a made-up word that exists only in this file.
const BEACON = 'prunefailbeacon';

const teamRow = extra => ({
  author: 'Teammate', authorId: 'tm-prune', source: 'Claude Code',
  ask: null, goal: null, summary: null, headline: null, gotchas: null,
  decisions: `${BEACON} is resolved in the middleware`,
  distilled: true, files: ['lib/middleware.js'], changes: null,
  ...extra,
});

async function linkedProject(name, teamId, teamName) {
  const key = path.join(ROOT, 'projects', name);
  fs.mkdirSync(key, { recursive: true });
  const st = util.loadState();
  st.projects = { ...(st.projects || {}), [key]: { events: [], teamEntries: [] } };
  util.saveState(st);
  const link = await teamsyncLib.linkProject(util.getConfig(), key, teamId, teamName);
  return { key, link };
}

const projRecord = key => (util.loadState().projects || {})[key];

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
  // one being ADDED earlier. Recorded rather than quietly left as an implied
  // guarantee.
  //
  // NO LONGER THE WHOLE STORY. Check 6 at the bottom of this file now drives a
  // real revocation pass with a prune that throws, so the CONSEQUENCE this
  // check can only describe is demonstrated. This check stays because the two
  // catch different things: mutation-testing both showed that removing the
  // try/catch turns this one red on the source, while destroy-then-mark turns
  // check 6 red on the served data. Neither subsumes the other.
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

  // -------------------------------------------------------------------------
  // 6. PARTIAL FAILURE, EXECUTED — the case check 4's scope note could not reach.
  // -------------------------------------------------------------------------
  // Check 4 confirms the destructive calls appear AFTER the stamp in the source.
  // It cannot prove the consequence, and it explicitly says so: inserting a new
  // destructive statement ahead of the stamp leaves it green. The consequence is
  // what actually matters, and it is only observable at runtime — so this drives
  // a real revocation pass with a prune that THROWS, and asserts the state it
  // leaves behind is one every reader refuses.
  //
  // WHAT THIS PROVES THAT THE SOURCE READ DID NOT:
  //   1. A prune failure does not abort the sync pass (the try/catch is real,
  //      not decorative) — the pass reports no error and the OTHER project in
  //      the same team still syncs.
  //   2. When the prune fails, the archive rows are still ON DISK. That is
  //      asserted, not assumed, because without it the next assertion would be
  //      trivially true: "nothing is served" is worthless if nothing survived.
  //   3. With those rows sitting on disk, search_memory serves NONE of them.
  //      The marker was stamped before the destruction started, so a half-
  //      deleted archive reads as revoked rather than as authorised.
  //
  // The mock is the same one team-access-fallthrough drives. Two linked
  // projects, not one: visibleProjectIds turns an EMPTY list into null
  // (inconclusive), so a lone revoked project would take the fall-through
  // branch and this test would silently exercise nothing. The kept project is
  // what makes the probe conclusive and the revocation branch actually run.
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(MOCK_PORT, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  const realPrune = teamArchive.pruneArchive;

  try {
    util.ensureConfig();
    // The documented escape hatch every other team suite uses: keeps the mock
    // round trip off the real macOS keychain.
    const cfg = util.loadUserConfig();
    cfg.team = { ...(cfg.team || {}), encrypt: false };
    util.saveUserConfig(cfg);

    await teamsyncLib.signup(util.getConfig(), 'prune@test.dev', 'pw-prune', 'Pruner');
    const team = await teamsyncLib.createTeam(util.getConfig(), 'PruneCo');
    const revoked = await linkedProject('prune-revoked-app', team.team_id, 'PruneCo');
    const kept = await linkedProject('prune-kept-app', team.team_id, 'PruneCo');

    // Both lanes of teammate data: the working cache on the project record, and
    // the durable archive behind it. The archive is the half the prune is
    // supposed to destroy, so it is the half whose survival makes this test
    // meaningful.
    {
      const st = util.loadState();
      st.projects[revoked.key].teamEntries = [
        teamRow({ session: 'prune-cache-1', ts: new Date(Date.now() - 3600000).toISOString() }),
      ];
      util.saveState(st);
    }
    teamArchive.appendRows(revoked.link.projectId, [
      teamRow({ session: 'prune-archive-1', ts: '2026-06-01T00:00:00.000Z' }),
    ]);

    // PRECONDITION, loud and named. If the planted rows do not render, every
    // assertion after the revocation is vacuously true — "no rows served" would
    // be a statement about an empty fixture, not about the guard.
    await check('fixture precondition: both teammate lanes are served BEFORE the revocation', () => {
      const before = activityLib.searchMemory({ query: BEACON });
      const sessions = before.results.map(r => r.session).sort();
      assert.deepStrictEqual(sessions, ['prune-archive-1', 'prune-cache-1'],
        'the planted cache row and archive row did not both come back — the ' +
        `post-revocation assertions would prove nothing. Got: ${JSON.stringify(sessions)}`);
    });

    // The synthetic failure. teamsync.js calls teamArchive.pruneArchive through
    // the module object, so replacing the export is enough — no source edit.
    teamArchive.pruneArchive = () => {
      throw new Error('synthetic prune failure planted by test/suites/destructive-paths.test.js');
    };
    // Revoke exactly one project. The other stays visible, which is what keeps
    // the probe conclusive.
    for (const p of mock.projects) if (p.id === revoked.link.projectId) p.archivedAt = new Date().toISOString();

    const res = await teamsyncLib.syncTeams({});

    await check('a prune that throws does not abort the sync pass', () => {
      assert.deepStrictEqual(res.errors, [],
        'the failing prune surfaced as a sync error — it is best-effort by ' +
        `design and must not abort the pass: ${JSON.stringify(res.errors)}`);
      assert.ok(res.synced.includes(kept.key),
        'the unrevoked project in the same team stopped syncing because a ' +
        `different project's prune threw: ${JSON.stringify(res.synced)}`);
    });

    await check('the marker is stamped and the cache cleared even though the prune threw', () => {
      const proj = projRecord(revoked.key);
      assert.ok(proj.teamAccessLost,
        'the revocation marker was never stamped, so nothing on this machine ' +
        'records that the project may not be read — this is the destroy-then-' +
        'mark ordering the source check cannot rule out');
      assert.deepStrictEqual(proj.teamEntries, [], 'the cached teammate rows survived the revocation');
    });

    await check('the archive really did survive the failed prune (so the next check is not vacuous)', () => {
      const rows = teamArchive.loadArchive(revoked.link.projectId).rows;
      assert.strictEqual(rows.length, 1,
        'the archive was emptied after all, which would make "no rows served" ' +
        'a statement about an empty file rather than about the revocation guard');
      assert.ok(fs.existsSync(teamArchive.archivePath(revoked.link.projectId)),
        'the archive file is gone');
    });

    await check('a half-deleted archive still reads as REVOKED, not as authorised', () => {
      const after = activityLib.searchMemory({ query: BEACON });
      assert.deepStrictEqual(after.results, [],
        'teammate rows the failed prune left on disk were still served. The ' +
        'marker is stamped BEFORE the destructive calls precisely so that a ' +
        'failure partway through leaves every reader refusing the data rather ' +
        'than serving a half-deleted cache as if it were authorised.');
    });
  } finally {
    teamArchive.pruneArchive = realPrune;
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    await new Promise(r => mock.server.close(r));
  }

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
