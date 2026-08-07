'use strict';
// Recording a departure — 049_audit_member_left.sql.
//
// 046 made arrivals recordable. Without this, the trail shows people arriving
// and never leaving, which is WORSE than showing neither: an admin auditing
// who has access sees five joins, no departures, and concludes five people are
// on the team.
//
// The instrument is the same as 046's for the same reasons (zero argument
// surface; cannot drift from the fact it records), but a DELETE trigger has
// two hazards an INSERT trigger does not, and both are what this file is
// mostly about:
//
//   1. IT FIRES ON REMOVALS TOO. The daemon already writes `member-removed`,
//      so an unguarded trigger gives every removal two rows saying different
//      things about one event. 049 fires only when the person who ended the
//      membership IS the person whose membership ended.
//
//   2. IT FIRES ON CASCADES. team_members hangs off teams and off auth.users,
//      both `on delete cascade`. And team_audit.team_id cascades from teams as
//      well — so a row written while a team is being deleted violates that
//      foreign key and ABORTS THE DELETE. An unguarded trigger here does not
//      make team deletion noisy, it makes team deletion fail.
//
// Both hazards get a counter-check that passes before AND after 049, so
// neither can be satisfied by the fix itself. New file rather than a section
// in join-audit.test.js: this needs a throwaway team to destroy and a
// four-identity fixture, and that suite is a single narrative about arrivals.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, waitForHttp, post } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const { startServer } = require('../../lib/server');
const { createMockSupabase } = require('../mock-supabase');

const HOME_OWNER = path.join(ROOT, 'home-dep-owner');
const HOME_LEAVER = path.join(ROOT, 'home-dep-leaver');
const HOME_REMOVED = path.join(ROOT, 'home-dep-removed');
const homeFor = { owner: HOME_OWNER, leaver: HOME_LEAVER, removed: HOME_REMOVED };
const portFor = { owner: P(81), leaver: P(82), removed: P(83) };

async function main() {
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(P(80), '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(80)}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

  async function apiAs(role, method, pathname, body) {
    process.env.MEMBRIDGE_HOME = homeFor[role];
    const port = portFor[role];
    const srv = startServer(port, { retries: 0 });
    try {
      await waitForHttp(`http://127.0.0.1:${port}/api/status`);
      const url = `http://127.0.0.1:${port}${pathname}`;
      const res = method === 'GET' ? await fetch(url) : await post(url, body);
      return { status: res.status, body: await res.json().catch(() => null) };
    } finally {
      await new Promise(r => srv.close(r));
    }
  }

  const asOwner = fn => { process.env.MEMBRIDGE_HOME = HOME_OWNER; return fn(util.getConfig()); };
  const auditOf = async teamId => {
    const res = await apiAs('owner', 'GET', `/api/team/audit?teamId=${teamId}`);
    return (res.body && res.body.events) || [];
  };
  // Every join needs a freshly minted invite: 044 §1 and 045 rotate the code
  // and revoke outstanding links on every removal and every departure, so a
  // token captured earlier in this fixture is dead by design.
  const joinFresh = async (role, teamId) => {
    const inv = await asOwner(cfg => teamsync.createInvite(cfg, teamId, {}));
    const res = await apiAs(role, 'POST', '/api/team/join', { inviteCode: inv.token });
    assert.strictEqual(res.status, 200, `fixture: ${role} must join, got ${res.status}: ${JSON.stringify(res.body)}`);
  };

  try {
    for (const dir of Object.values(homeFor)) fs.mkdirSync(dir, { recursive: true });

    process.env.MEMBRIDGE_HOME = HOME_OWNER;
    util.ensureConfig();
    const ownerCreds = await teamsync.signup(util.getConfig(), 'dep-owner@test.dev', 'pw-o', 'Owner');
    const alpha = await teamsync.createTeam(util.getConfig(), 'Alpha');
    // A second team that exists to be destroyed, so the cascade check cannot
    // disturb the team every other check reads.
    const doomed = await teamsync.createTeam(util.getConfig(), 'Doomed');

    process.env.MEMBRIDGE_HOME = HOME_LEAVER;
    util.ensureConfig();
    const leaverCreds = await teamsync.signup(util.getConfig(), 'dep-leaver@test.dev', 'pw-l', 'Leaver');

    process.env.MEMBRIDGE_HOME = HOME_REMOVED;
    util.ensureConfig();
    const removedCreds = await teamsync.signup(util.getConfig(), 'dep-removed@test.dev', 'pw-r', 'Removed');

    await joinFresh('leaver', alpha.team_id);
    const left = await apiAs('leaver', 'POST', '/api/team/leave', { teamId: alpha.team_id });
    assert.strictEqual(left.status, 200, `fixture: the leave must succeed, got ${left.status}`);

    await check('leaving a team is recorded in its audit trail', async () => {
      const rows = (await auditOf(alpha.team_id)).filter(e => e.action === 'member-left');
      assert.strictEqual(rows.length, 1,
        'a voluntary departure must land. The leaver cannot write it from the client — ' +
        'team_audit\'s insert policy is manager-only (024 §5, tightened by 025 §5) and by the ' +
        'time the row would be written they are not even a member — so nothing recorded it. ' +
        `got ${JSON.stringify(rows)}`);
    });

    // The row's one chance to capture the name: the instant the trigger
    // returns, nothing in the database knows what that person was called, and
    // readAudit's roster lookup misses forever. old.display_name is the only
    // place it still exists.
    await check('the departure row names the leaver, who is by definition gone', async () => {
      const [row] = (await auditOf(alpha.team_id)).filter(e => e.action === 'member-left');
      assert.ok(row, 'fixture: need the departure row');
      assert.strictEqual(row.targetName, 'Leaver',
        `the subject is captured off the deleted row, got ${JSON.stringify(row.targetName)}`);
      assert.strictEqual(row.actorName, 'Leaver',
        'the actor of a departure IS its subject, so the captured name names them too; ' +
        `got ${JSON.stringify(row.actorName)}`);
      assert.strictEqual(row.objectLabel, leaverCreds.userId,
        `object_key must be the leaver's user id, got ${JSON.stringify(row.objectLabel)}`);
    });

    // ---------------------------------------------------------------------
    // HAZARD 1 — the trigger fires on removals too.
    // ---------------------------------------------------------------------
    // COUNTER-CHECK, green before AND after 049: before, no member-left row
    // exists anywhere; after, the WHEN clause excludes a delete whose actor is
    // not its subject. Only DROPPING that clause turns this red, which is
    // exactly the wrong fix it guards — a removal that produces both a
    // `member-removed` and a `member-left` describes one event twice, in two
    // voices, and inflates any count of departures.
    await joinFresh('removed', alpha.team_id);
    const removed = await apiAs('owner', 'POST', '/api/team/remove-member',
      { teamId: alpha.team_id, userId: removedCreds.userId });
    assert.strictEqual(removed.status, 200, `fixture: removal must succeed, got ${removed.status}`);

    await check('a removal is recorded once, as a removal, never also as a departure', async () => {
      const rows = await auditOf(alpha.team_id);
      const aboutThem = rows.filter(e => e.objectLabel === removedCreds.userId && e.action !== 'member-joined');
      assert.deepStrictEqual(aboutThem.map(e => e.action), ['member-removed'],
        'a removal must produce exactly one row and it must say they were removed; a delete ' +
        `trigger without the actor = subject condition adds a second. got ${JSON.stringify(aboutThem)}`);
    });

    await check('a departure and a removal stay distinguishable', async () => {
      const rows = await auditOf(alpha.team_id);
      const leftRows = rows.filter(e => e.action === 'member-left').map(e => e.objectLabel);
      const removedRows = rows.filter(e => e.action === 'member-removed').map(e => e.objectLabel);
      assert.deepStrictEqual(leftRows, [leaverCreds.userId],
        `only the leaver left, got ${JSON.stringify(leftRows)}`);
      assert.deepStrictEqual(removedRows, [removedCreds.userId],
        `only the removed member was removed, got ${JSON.stringify(removedRows)}`);
    });

    // ---------------------------------------------------------------------
    // HAZARD 2 — the trigger fires on cascades.
    // ---------------------------------------------------------------------
    // COUNTER-CHECK, green before AND after 049. mock.deleteTeamCascade models
    // `delete from public.teams where id = ...` in Postgres' order: the parent
    // row first, then the referencing rows — which is why the trigger sees a
    // team that no longer exists. The mock enforces team_audit's team_id
    // foreign key by THROWING, because that is what the database does, and the
    // consequence is the point: this is not noise, it is a failed deletion.
    //
    // The WHEN clause already excludes every member except one during such a
    // cascade (their user_id is not the deleter's). This exists for the
    // residue — the deleting owner's OWN membership row, where auth.uid()
    // equals old.user_id and the trigger would otherwise fire.
    await joinFresh('leaver', doomed.team_id);

    await check('deleting a team does not abort on the audit trail it cascades away', async () => {
      const before = mock.teamAudit.length;
      assert.doesNotThrow(() => mock.deleteTeamCascade(doomed.team_id, ownerCreds.userId),
        'the delete trigger wrote a team_audit row for a team being deleted, which violates ' +
        'team_audit_team_id_fkey and aborts the whole deletion — 049\'s teams-existence guard ' +
        'is what prevents this');
      assert.strictEqual(mock.teams.has(doomed.team_id), false, 'the team survived its own deletion');
      assert.ok(mock.teamAudit.length <= before, 'the cascade added audit rows instead of removing them');
    });

    await check('a team deletion emits no departure events for its members', async () => {
      const strays = mock.teamAudit.filter(r => r.team_id === doomed.team_id);
      assert.deepStrictEqual(strays, [],
        `a team that no longer exists cannot have a trail; got ${JSON.stringify(strays)}`);
      // And the surviving team's trail was not touched by another team's death.
      const alphaRows = await auditOf(alpha.team_id);
      assert.ok(alphaRows.length > 0, 'Alpha\'s own trail was collateral damage');
    });

    // ---------------------------------------------------------------------
    // COUNTER-CHECK: a refused operation writes nothing.
    // ---------------------------------------------------------------------
    // leave_team raises before it deletes when the caller is the owner
    // (002:258), so there is no delete and therefore no trigger. Green in both
    // directions; red if a future version ever writes the row before, or
    // independently of, the delete succeeding.
    await check('an owner cannot leave, and the refusal records nothing', async () => {
      const before = (await auditOf(alpha.team_id)).length;
      const res = await apiAs('owner', 'POST', '/api/team/leave', { teamId: alpha.team_id });
      assert.notStrictEqual(res.status, 200, 'leave_team must still refuse the owner');
      assert.ok(mock.members.some(m => m.teamId === alpha.team_id && m.displayName === 'Owner'),
        'the owner is off their own roster — the team now has nobody who can manage it');
      assert.strictEqual((await auditOf(alpha.team_id)).length, before,
        'a refused departure wrote an audit row anyway');
    });
  } finally {
    await new Promise(r => mock.server.close(r));
  }

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
