'use strict';
// Recording a join — 046_audit_member_joined.sql.
//
// The finding itself (a join cannot be audited at all: team_audit's insert
// policy is manager-only, a joiner is always role 'member', and recordAudit
// swallows the refusal) is pinned in test/suites/invite-lifetime.test.js on
// branch agent-hunt. This file covers what that suite cannot say, and — more
// importantly — the ways a fix for it could be WRONG.
//
// The fix moves the write into an AFTER INSERT trigger on team_members, which
// means the daemon no longer writes the row and no caller supplies any part of
// it. Three specific wrong versions of that are cheap to write and would pass
// a naive "is the join recorded?" test:
//
//   * a trigger with no `when (new.role <> 'owner')` gate, which records every
//     team's founder as having joined their own team at creation;
//   * a write hung off the RPC rather than the INSERT, which records a second
//     event when someone joins a team they are already on (`on conflict do
//     nothing` makes that a no-op that still reaches the end of the function);
//   * the tempting shortcut of widening team_audit's insert POLICY so a member
//     can POST their own row — which does not gain the trail one row, it gains
//     it every row any member cares to compose.
//
// Each has a check below, and the last two pass BEFORE the fix as well as
// after, so they cannot be satisfied by the fix itself.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, waitForHttp, post } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const { startServer } = require('../../lib/server');
const { createMockSupabase } = require('../mock-supabase');

const HOME_OWNER = path.join(ROOT, 'home-join-owner');
const HOME_MEMBER = path.join(ROOT, 'home-join-member');
const homeFor = { owner: HOME_OWNER, member: HOME_MEMBER };
const portFor = { owner: P(77), member: P(78) };

async function main() {
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(P(76), '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(76)}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

  // One dashboard server per identity, started and closed around each call:
  // util.getConfig()/loadCredentials read process.env.MEMBRIDGE_HOME fresh on
  // every call, so this is only safe while the two are never concurrent.
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

  try {
    for (const dir of Object.values(homeFor)) fs.mkdirSync(dir, { recursive: true });

    process.env.MEMBRIDGE_HOME = HOME_OWNER;
    util.ensureConfig();
    const ownerCreds = await teamsync.signup(util.getConfig(), 'join-owner@test.dev', 'pw-o', 'Owner');
    const alpha = await teamsync.createTeam(util.getConfig(), 'Alpha');

    process.env.MEMBRIDGE_HOME = HOME_MEMBER;
    util.ensureConfig();
    const memberCreds = await teamsync.signup(util.getConfig(), 'join-member@test.dev', 'pw-m', 'Member');

    const auditOf = async teamId => {
      const res = await apiAs('owner', 'GET', `/api/team/audit?teamId=${teamId}`);
      return (res.body && res.body.events) || [];
    };
    const joinsOn = async teamId => (await auditOf(teamId)).filter(e => e.action === 'member-joined');

    // COUNTER-CHECK, and it runs BEFORE anyone joins so it cannot be confused
    // with one. create_team inserts the founder's own row into team_members
    // with role 'owner'; a trigger without the role gate would fire on it and
    // stamp every team with a join event at the instant of creation, before
    // there is anybody to have joined. Green before 046 (no rows at all) and
    // green after (the gate excludes it) — so only a MISSING gate turns it red.
    await check('creating a team does not record its founder as having joined', async () => {
      const joins = await joinsOn(alpha.team_id);
      assert.deepStrictEqual(joins, [],
        `a team's creator is not a joiner; got ${JSON.stringify(joins)}`);
    });

    const invite = await asOwner(cfg => teamsync.createInvite(cfg, alpha.team_id, {}));
    const joined = await apiAs('member', 'POST', '/api/team/join', { inviteCode: invite.token });
    assert.strictEqual(joined.status, 200, `fixture: the join must succeed, got ${joined.status}`);

    await check('a join is recorded in the team\'s audit trail', async () => {
      const joins = await joinsOn(alpha.team_id);
      assert.strictEqual(joins.length, 1,
        'the one event that records somebody GAINING access to the team\'s memory must land. ' +
        'team_audit\'s insert policy is is_team_manager(team_id) and actor_id = auth.uid() ' +
        '(024 §5, tightened by 025 §5) and a fresh joiner is always role \'member\', so the ' +
        `client-side write was refused and swallowed on every join. got ${JSON.stringify(joins)}`);
    });

    // The row has to be READABLE, not merely present. A join event whose actor
    // is a raw uuid answers "somebody joined", which the invite-created row
    // already implied.
    await check('the join event names the joiner, as both actor and subject', async () => {
      const [row] = await joinsOn(alpha.team_id);
      assert.ok(row, 'fixture: need the join row');
      assert.strictEqual(row.actorName, 'Member',
        `the actor of a join is the joiner, got ${JSON.stringify(row.actorName)}`);
      assert.strictEqual(row.targetName, 'Member',
        'the subject is captured on the row so it stays readable after they leave, ' +
        `got ${JSON.stringify(row.targetName)}`);
      assert.strictEqual(row.objectLabel, memberCreds.userId,
        `object_key must be the joiner's user id, got ${JSON.stringify(row.objectLabel)}`);
    });

    // Idempotence, and the reason the write belongs on the INSERT rather than
    // at the end of the RPC. Joining a team you are already on is a deliberate
    // no-op — join_team and redeem_invite both `on conflict do nothing` and
    // then run to completion — so anything hung off the FUNCTION fires again
    // and records an arrival that did not happen. A row-level AFTER INSERT
    // trigger cannot: no row inserted, no trigger.
    await check('joining a team you are already on records nothing further', async () => {
      const again = await apiAs('member', 'POST', '/api/team/join', { inviteCode: invite.token });
      assert.strictEqual(again.status, 200, `fixture: a repeat join is a no-op, not an error (${again.status})`);
      const joins = await joinsOn(alpha.team_id);
      assert.strictEqual(joins.length, 1,
        `a repeat join must not add an event; got ${joins.length}`);
    });

    // And the count is not simply pinned at one: a genuine second arrival, via
    // a fresh invite after a removal, is a second event. Without this, a
    // trigger that fired once per team would satisfy everything above.
    await check('a genuine re-join after removal records a second event', async () => {
      const removed = await apiAs('owner', 'POST', '/api/team/remove-member',
        { teamId: alpha.team_id, userId: memberCreds.userId });
      assert.strictEqual(removed.status, 200, `fixture: removal must succeed, got ${removed.status}`);
      // A FRESH invite: 044 §1 rotated the code and revoked every outstanding
      // link at the removal, so the old one is dead by design.
      const reinvite = await asOwner(cfg => teamsync.createInvite(cfg, alpha.team_id, {}));
      const rejoined = await apiAs('member', 'POST', '/api/team/join', { inviteCode: reinvite.token });
      assert.strictEqual(rejoined.status, 200, `fixture: a re-invited person can re-join, got ${rejoined.status}`);
      const joins = await joinsOn(alpha.team_id);
      assert.strictEqual(joins.length, 2,
        `two real arrivals must be two events; got ${joins.length}`);
    });

    // COUNTER-CHECKS for the shortcut this fix exists to avoid. Both pass
    // before AND after 046: the definer path gains the trail exactly one row
    // it can produce, and gains no member the ability to compose one.
    await check('a member still cannot POST an audit row of their own', async () => {
      process.env.MEMBRIDGE_HOME = HOME_MEMBER;
      const creds = teamsync.loadCredentials();
      assert.ok(creds && creds.accessToken, 'fixture: need the member\'s token');
      const before = mock.teamAudit.length;
      const res = await fetch(`${process.env.MEMBRIDGE_TEAM_URL}/rest/v1/team_audit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: 'anon-test',
          Authorization: `Bearer ${creds.accessToken}`,
        },
        body: JSON.stringify({
          team_id: alpha.team_id, actor_id: memberCreds.userId,
          action: 'member-joined', object_type: 'member', object_key: ownerCreds.userId, detail: null,
        }),
      });
      assert.notStrictEqual(res.status, 201,
        'widening team_audit_insert so a member can write their own row would not add one row ' +
        'to the trail, it would add every row any member cares to compose');
      assert.strictEqual(mock.teamAudit.length, before,
        'the refused POST still landed a row');
    });

    await check('a member still cannot read the audit trail', async () => {
      const res = await apiAs('member', 'GET', `/api/team/audit?teamId=${alpha.team_id}`);
      const events = (res.body && res.body.events) || [];
      assert.deepStrictEqual(events, [],
        `team_audit_select is manager-only (024 §5); a member read must come back empty, got ${JSON.stringify(events)}`);
    });

    // -----------------------------------------------------------------------
    // Naming an actor who has since left.
    // -----------------------------------------------------------------------
    // readAudit resolves actor_id against the CURRENT roster. Before 046 that
    // gap was reachable only through 035's own-data-deleted (whose actor is
    // often an ex-member by design) and was never exercised; 046 makes it
    // routine, because every departed member now has a join row naming them as
    // its actor. "Unknown joined the team" would be the most common line in
    // the trail of anyone who has left — on the one question the trail exists
    // to answer about them.
    //
    // The fix reuses the name captured on the row, but ONLY when the row's
    // actor IS its subject. The pair below is what makes that guard mean
    // something: an ADMIN who removes someone and then leaves produces a row
    // whose actor is off the roster and whose captured name is the person they
    // removed. Borrowing it there would attribute the removal to its victim —
    // the same blame-shifting 025 §5 pinned actor_id to prevent, reintroduced
    // at the rendering layer where no policy can catch it.
    const ADMIN_HOME = path.join(ROOT, 'home-join-admin');
    homeFor.admin = ADMIN_HOME;
    portFor.admin = P(79);
    fs.mkdirSync(ADMIN_HOME, { recursive: true });
    process.env.MEMBRIDGE_HOME = ADMIN_HOME;
    util.ensureConfig();
    const adminCreds = await teamsync.signup(util.getConfig(), 'join-admin@test.dev', 'pw-a', 'Admin');
    const adminInvite = await asOwner(cfg => teamsync.createInvite(cfg, alpha.team_id, {}));
    const adminJoined = await apiAs('admin', 'POST', '/api/team/join', { inviteCode: adminInvite.token });
    assert.strictEqual(adminJoined.status, 200, `fixture: Admin must join, got ${adminJoined.status}`);
    const promoted = await apiAs('owner', 'POST', '/api/team/set-role',
      { teamId: alpha.team_id, userId: adminCreds.userId, role: 'admin' });
    assert.strictEqual(promoted.status, 200, `fixture: promotion must succeed, got ${promoted.status}`);
    // Admin removes Member, then leaves. Both rows now name an actor who is
    // gone; only one of them is ABOUT that actor.
    const byAdmin = await apiAs('admin', 'POST', '/api/team/remove-member',
      { teamId: alpha.team_id, userId: memberCreds.userId });
    assert.strictEqual(byAdmin.status, 200, `fixture: an admin can remove a member, got ${byAdmin.status}`);
    const adminLeft = await apiAs('admin', 'POST', '/api/team/leave', { teamId: alpha.team_id });
    assert.strictEqual(adminLeft.status, 200, `fixture: an admin can leave, got ${adminLeft.status}`);

    await check('a departed member\'s own join row still names them', async () => {
      const row = (await auditOf(alpha.team_id))
        .find(e => e.action === 'member-joined' && e.objectLabel === adminCreds.userId);
      assert.ok(row, 'fixture: Admin\'s join must be on the trail');
      assert.strictEqual(row.actorName, 'Admin',
        'the actor of a join IS its subject, and the subject\'s name is captured on the row, ' +
        `so leaving must not turn it into "Unknown"; got ${JSON.stringify(row.actorName)}`);
    });

    // COUNTER-CHECK for the guard. Fails loudly if the actor === subject
    // condition is ever dropped in favour of "just use targetName".
    await check('a row about someone else is never attributed to them', async () => {
      const row = (await auditOf(alpha.team_id))
        .find(e => e.action === 'member-removed' && e.objectLabel === memberCreds.userId);
      assert.ok(row, 'fixture: the admin-performed removal must be on the trail');
      assert.notStrictEqual(row.actorName, 'Member',
        'this row says Member was removed; naming Member as the actor would credit them with ' +
        'their own removal — the blame-shifting 025 §5 pinned actor_id to prevent');
      assert.strictEqual(row.actorName, 'Unknown',
        `an actor who has left and is not the row's subject has no name to borrow, got ${JSON.stringify(row.actorName)}`);
      assert.strictEqual(row.targetName, 'Member',
        `the SUBJECT is still named from the row's captured detail, got ${JSON.stringify(row.targetName)}`);
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
