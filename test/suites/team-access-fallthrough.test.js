'use strict';
// A project syncTeams already CONFIRMED revoked must not be pushed, pulled or
// backfilled on a later pass whose visibility probe could not answer.
//
// The control flow. lib/teamsync.js syncTeams asks teamsync.visibleProjectIds
// once per team per pass and then branches:
//
//     const visible = link.teamId ? visibleByTeam.get(link.teamId) : null;
//     if (visible && !visible.has(String(link.projectId))) { ...revoke...; continue; }
//     if (visible && proj.teamAccessLost) { ...restore... }
//     // push, pull, backfill
//
// BOTH branches require `visible`. So the pass where the probe returns null and
// proj.teamAccessLost is ALREADY set matched neither, and fell straight through
// to push/pull/backfill for a project this install had been told it may not
// read. Nothing about that state is exotic: visibleProjectIds returns null for
// an EMPTY project_stats result on purpose (an empty list is inconclusive, not
// "you may see nothing"), which is exactly what a member revoked from every
// project in a team gets back from a perfectly healthy backend.
//
// This was not a leak — util.teamRowsFor still refuses on the flag, the notes
// reconciler still erases the derived index, and the backend's own policy
// returns nothing anyway. It read as though "revoked" were terminal when it was
// not, which is how the next person adds a local write to that path.
//
// The two checks below are a matched pair, and the second is the one that stops
// the fix from being "skip every project whose probe was inconclusive":
//   - a FLAGGED project is skipped entirely on an inconclusive pass
//   - an UNFLAGGED project in the same team, on the same inconclusive pass,
//     still pushes exactly as before
//
// Run directly, or via `node test/run.js team-access-fallthrough`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const { createMockSupabase } = require('../mock-supabase');

const MOCK_PORT = P(66);

// One prompt + summary pair, which is what buildEntries needs to yield a
// pushable entry. `token` is what the pushed row is recognised by.
function localEvents(token, session) {
  return [
    { ts: '2026-08-04T10:00:00.000Z', source: 'Claude Code', kind: 'prompt', session, text: `wire up the ${token} path` },
    {
      ts: '2026-08-04T10:05:00.000Z', source: 'Distilled', kind: 'summary', session,
      text: `The ${token} path is wired.`, headline: `${token} is wired`,
      goal: '', decisions: '', gotchas: '', highlights: [],
    },
  ];
}

async function makeLinkedProject(name, teamId, teamName, token) {
  const key = path.join(ROOT, 'projects', name);
  fs.mkdirSync(key, { recursive: true });
  const st = util.loadState();
  st.projects = { ...(st.projects || {}), [key]: { events: localEvents(token, `sess-${name}`) } };
  util.saveState(st);
  const link = await teamsync.linkProject(util.getConfig(), key, teamId, teamName);
  return { key, link };
}

const projRecord = key => (util.loadState().projects || {})[key];
const pushedRowsFor = (mock, projectId) => mock.entries.filter(e => e.project_id === projectId);

async function main() {
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(MOCK_PORT, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

  try {
    util.ensureConfig();
    // The documented escape hatch, as every other team suite uses: keeps the
    // mock round trip off the real macOS keychain.
    const cfg = util.loadUserConfig();
    cfg.team = { ...(cfg.team || {}), encrypt: false };
    util.saveUserConfig(cfg);

    await teamsync.signup(util.getConfig(), 'fallthrough@test.dev', 'pw-f', 'Faller');
    const team = await teamsync.createTeam(util.getConfig(), 'FallCo');

    const revoked = await makeLinkedProject('revoked-app', team.team_id, 'FallCo', 'revokedbeacon');
    const healthy = await makeLinkedProject('healthy-app', team.team_id, 'FallCo', 'healthybeacon');

    // Make the probe INCONCLUSIVE for the whole team: project_stats lists no
    // rows for a team whose every project is archived, and visibleProjectIds
    // turns an empty list into null rather than "you may see nothing". Same
    // answer a member revoked from every project in the team gets.
    for (const p of mock.projects) if (p.teamId === team.team_id) p.archivedAt = new Date().toISOString();

    // Exactly what the confirmed-revoked branch leaves behind for `revoked`:
    // the flag, no cached rows, no forward cursor. `healthy` gets no flag.
    {
      const st = util.loadState();
      st.projects[revoked.key].teamAccessLost = '2026-08-03T00:00:00.000Z';
      st.projects[revoked.key].teamEntries = [];
      st.projects[revoked.key].teamPullTs = null;
      util.saveState(st);
    }

    assert.strictEqual(pushedRowsFor(mock, revoked.link.projectId).length, 0,
      'fixture: nothing should have been pushed for either project yet');
    assert.strictEqual(pushedRowsFor(mock, healthy.link.projectId).length, 0,
      'fixture: nothing should have been pushed for either project yet');

    const res = await teamsync.syncTeams({});

    check('inconclusive probe + confirmed revocation: the project is skipped entirely', () => {
      assert.deepStrictEqual(pushedRowsFor(mock, revoked.link.projectId), [],
        'entries were published for a project this install was told it may not read');
      assert.ok(!res.synced.includes(revoked.key),
        `a skipped project was still reported as synced: ${JSON.stringify(res.synced)}`);
      assert.deepStrictEqual(res.errors, [],
        `the skip was reported as an error rather than a skip: ${JSON.stringify(res.errors)}`);
    });

    check('inconclusive probe + confirmed revocation: the flag is neither cleared nor re-stamped', () => {
      assert.strictEqual(projRecord(revoked.key).teamAccessLost, '2026-08-03T00:00:00.000Z',
        'an inconclusive pass rewrote the revocation timestamp — recovery must need a POSITIVE answer, and the original moment is the audit trail');
      assert.deepStrictEqual(util.teamRowsFor(projRecord(revoked.key)), [],
        'the skipped pass repopulated the cached teammate rows');
    });

    // The other half of the pair: the skip must be keyed on the FLAG, not on
    // the probe. Same pass, same inconclusive probe, no flag — unchanged.
    check('inconclusive probe alone does not stop an unflagged project from syncing', () => {
      assert.ok(pushedRowsFor(mock, healthy.link.projectId).length > 0,
        'an inconclusive visibility probe stopped a project that was never revoked from pushing');
      assert.ok(res.synced.includes(healthy.key),
        `an unflagged project dropped out of synced: ${JSON.stringify(res.synced)}`);
    });

    // And recovery still works: the moment the probe can answer, the flag goes
    // and the project resumes. This is why skipping does not strand anything.
    for (const p of mock.projects) if (p.teamId === team.team_id) delete p.archivedAt;
    const second = await teamsync.syncTeams({});
    check('recovery: the next pass that CAN answer clears the flag and resumes the project', () => {
      assert.ok(!projRecord(revoked.key).teamAccessLost,
        'a positive visibility answer did not clear the revocation flag');
      assert.ok(second.synced.includes(revoked.key),
        `the restored project did not resume: ${JSON.stringify(second.synced)}`);
      assert.ok(pushedRowsFor(mock, revoked.link.projectId).length > 0,
        'the restored project never published its held entries');
    });
  } finally {
    h.noEgress.resetTeamEnv(); // NOT `delete`: an absent env var falls through to the BAKED production backend
    await new Promise(r => mock.server.close(r));
  }

  h.finish();
}

main();
