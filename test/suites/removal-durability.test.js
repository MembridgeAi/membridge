'use strict';
// Removal durability — 041_removal_rotates_invite_code.sql, and the daemon
// side of it.
//
// The findings themselves are pinned in test/suites/invite-lifetime.test.js
// (agent-hunt, fcab31a). This file covers the parts of the FIX that suite
// cannot express, and the parts that a fix could get wrong in the other
// direction:
//
//   * the standing invite code stops reaching ordinary members at all. The
//     other suite's fixture has to read that code to prove the re-join, so it
//     cannot also assert the read is closed; that assertion lives here.
//   * removal rotates the code and revokes outstanding invite links for
//     EVERYONE, not only for the person removed. That blast radius is the
//     deliberate cost of an unconditional rotation and is asserted here so
//     nobody "fixes" it into a conditional one without a failing test.
//   * COUNTER-CHECKS, which pass both before and after the fix: a manager can
//     still read the code, an unrelated team's credentials are untouched by
//     another team's removal, and revoking an invite still revokes it. These
//     are what separate "the hole is closed" from "the feature is broken" —
//     the cheapest wrong fix here is one that nulls invite_code for everybody
//     or rotates every team at once, and every check above would still pass.
//
// New file rather than a section in the other suite: this needs a THIRD
// identity (a bystander who tries the rotated credentials) and a second team
// that must be proved untouched, and the other suite is a single narrative
// whose steps depend on each other.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, waitForHttp, post } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const { startServer } = require('../../lib/server');
const { createMockSupabase } = require('../mock-supabase');

// Three identities, each with its own MEMBRIDGE_HOME and dashboard port —
// siblings of the harness's throwaway home so its leak guards still cover them.
const HOME_OWNER = path.join(ROOT, 'home-removal-owner');
const HOME_MEMBER = path.join(ROOT, 'home-removal-member');
const HOME_BYSTANDER = path.join(ROOT, 'home-removal-bystander');
const homeFor = { owner: HOME_OWNER, member: HOME_MEMBER, bystander: HOME_BYSTANDER };
const portFor = { owner: P(73), member: P(74), bystander: P(75) };

async function main() {
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(P(72), '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(72)}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

  // One dashboard server per identity, started and closed around each call:
  // util.getConfig()/loadCredentials read process.env.MEMBRIDGE_HOME fresh on
  // every call, so this is only safe while the three are never concurrent.
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
  const teamRowFor = async (role, teamId) => {
    const res = await apiAs(role, 'GET', '/api/team');
    return ((res.body && res.body.teams) || []).find(t => t.team_id === teamId) || null;
  };

  try {
    for (const dir of Object.values(homeFor)) fs.mkdirSync(dir, { recursive: true });

    process.env.MEMBRIDGE_HOME = HOME_OWNER;
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'rem-owner@test.dev', 'pw-o', 'Owner');
    // TWO teams. Beta exists to prove a removal in Alpha does not rotate it —
    // an over-wide fix (rotate every team the actor manages) would otherwise
    // look identical to a correct one.
    const alpha = await teamsync.createTeam(util.getConfig(), 'Alpha');
    const beta = await teamsync.createTeam(util.getConfig(), 'Beta');

    process.env.MEMBRIDGE_HOME = HOME_MEMBER;
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'rem-member@test.dev', 'pw-m', 'Member');

    process.env.MEMBRIDGE_HOME = HOME_BYSTANDER;
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'rem-bystander@test.dev', 'pw-b', 'Bystander');

    const joinLink = await asOwner(cfg => teamsync.createInvite(cfg, alpha.team_id, {}));
    const joined = await apiAs('member', 'POST', '/api/team/join', { inviteCode: joinLink.token });
    assert.strictEqual(joined.status, 200, `fixture: member must join Alpha, got ${joined.status}`);

    // -----------------------------------------------------------------------
    // 1. The standing code is a manager credential, not a member one.
    // -----------------------------------------------------------------------
    // teams.invite_code never expires, has no use cap and cannot be revoked on
    // its own. A plain member can neither mint an invite (create_invite is
    // is_team_manager-gated) nor revoke one, so there is no operation they
    // have that needs it — it is a credential they can spend but not manage.
    // 041 §2 returns null in that column for a non-manager row, and
    // teamPayload restates the rule daemon-side so a backend without 041 does
    // not leak through the client either.
    await check('an ordinary member is not handed the team\'s standing invite code', async () => {
      const row = await teamRowFor('member', alpha.team_id);
      assert.ok(row, 'fixture: the member must see Alpha in their team list');
      assert.strictEqual(row.invite_code == null, true,
        `my_teams/teamPayload must not return invite_code to a role '${row.role}', got ${JSON.stringify(row.invite_code)}`);
    });

    await check('the top-level inviteCode is null for an ordinary member', async () => {
      // teams[0].invite_code and the flattened `inviteCode` are two separate
      // reads of the same secret in teamPayload; closing one and leaving the
      // other open would publish it to exactly the same screen.
      const res = await apiAs('member', 'GET', '/api/team');
      assert.strictEqual(res.body.inviteCode, null,
        `the flattened inviteCode is a second copy of the same credential, got ${JSON.stringify(res.body.inviteCode)}`);
    });

    // COUNTER-CHECK — passes before AND after 041. The cheapest wrong fix is
    // to null invite_code for everyone, which closes every leak and also
    // removes the only way to invite anybody.
    await check('a manager still reads the standing invite code', async () => {
      const row = await teamRowFor('owner', alpha.team_id);
      assert.ok(row && row.invite_code,
        `an owner must still be able to copy the invite code, got ${JSON.stringify(row && row.invite_code)}`);
      const res = await apiAs('owner', 'GET', '/api/team');
      assert.ok(res.body.inviteCode, 'the flattened inviteCode must survive for a manager');
    });

    // -----------------------------------------------------------------------
    // 2. Removal rotates — unconditionally, and for everybody.
    // -----------------------------------------------------------------------
    // Captured while the member is still on the team: the standing code, a
    // SECOND outstanding invite link that has nothing to do with them, and
    // Beta's equivalents. After the removal the first two must be dead and the
    // last two must be untouched.
    const alphaCodeBefore = (await teamRowFor('owner', alpha.team_id)).invite_code;
    const betaCodeBefore = (await teamRowFor('owner', beta.team_id)).invite_code;
    const bystanderLink = await asOwner(cfg => teamsync.createInvite(cfg, alpha.team_id, {}));
    const betaLink = await asOwner(cfg => teamsync.createInvite(cfg, beta.team_id, {}));

    const removed = await apiAs('owner', 'POST', '/api/team/remove-member',
      { teamId: alpha.team_id, userId: mock.members.find(m => m.displayName === 'Member').userId });
    assert.strictEqual(removed.status, 200, `fixture: removal must succeed, got ${removed.status}`);

    await check('removing a member rotates the team\'s standing invite code', async () => {
      const after = (await teamRowFor('owner', alpha.team_id)).invite_code;
      assert.notStrictEqual(after, alphaCodeBefore,
        'remove_member must rotate teams.invite_code: the departing member may be holding it, ' +
        'and there is no way to tell from the database whether they are');
    });

    // The consequence stated as a fact about a THIRD party, not about the
    // removed member: the rotation is deliberately indiscriminate. Anyone
    // mid-join with the old code is cut off, and that is the accepted cost —
    // a conditional rotation is a rotation that can be reasoned into not
    // happening. If this check ever needs "fixing", the fix is a fresh invite,
    // not a narrower rotation.
    await check('the pre-removal code stops working for an uninvolved bystander too', async () => {
      const rejoin = await apiAs('bystander', 'POST', '/api/team/join', { inviteCode: alphaCodeBefore });
      assert.notStrictEqual(rejoin.status, 200,
        'the old standing code must be dead for EVERYONE after a removal, not only for the ' +
        'person removed — see the CONSEQUENCE block in migration 041');
    });

    await check('removing a member revokes the team\'s outstanding invite links', async () => {
      // create_invite defaults expires_at and max_uses to null, so a link a
      // departing member holds redeems forever. Rotating only the standing
      // code would leave that door open and look fixed.
      const redeem = await apiAs('bystander', 'POST', '/api/team/join', { inviteCode: bystanderLink.token });
      assert.notStrictEqual(redeem.status, 200,
        'an invite link minted before the removal must not still redeem afterwards');
    });

    // COUNTER-CHECKS — pass before AND after 041. A rotation scoped to "every
    // team the actor manages", or to the whole invites table, would satisfy
    // every check above and quietly lock a second team out.
    await check('a removal in one team does not rotate another team\'s invite code', async () => {
      const after = (await teamRowFor('owner', beta.team_id)).invite_code;
      assert.strictEqual(after, betaCodeBefore,
        'Beta had no removal; its standing code must be byte-identical');
    });

    await check('a removal in one team does not revoke another team\'s invite links', async () => {
      const redeem = await apiAs('bystander', 'POST', '/api/team/join', { inviteCode: betaLink.token });
      assert.strictEqual(redeem.status, 200,
        `Beta's outstanding link must still redeem, got ${redeem.status}: ${JSON.stringify(redeem.body)}`);
    });

    // -----------------------------------------------------------------------
    // 3. Revocation still revokes.
    // -----------------------------------------------------------------------
    // COUNTER-CHECK for the audit-team fix: resolving the invite's own team
    // for the audit row must not disturb the revocation itself. The audit
    // lookup runs after the mutation and swallows its own failures, so a
    // regression here would be silent — the invite would look revoked in the
    // trail and still redeem.
    await check('revoking an invite still stops it redeeming', async () => {
      const live = await asOwner(cfg => teamsync.createInvite(cfg, beta.team_id, {}));
      const rev = await apiAs('owner', 'POST', '/api/team/revoke-invite', { token: live.token });
      assert.strictEqual(rev.status, 200, `revoke status ${rev.status}: ${JSON.stringify(rev.body)}`);
      const redeem = await apiAs('bystander', 'POST', '/api/team/join', { inviteCode: live.token });
      assert.notStrictEqual(redeem.status, 200, 'a revoked invite must not redeem');
    });

    // -----------------------------------------------------------------------
    // 4. The audit trail names people, not user ids.
    // -----------------------------------------------------------------------
    // readAudit resolves detail.memberId against the CURRENT roster, and
    // lib/server.js reads a member's display name off the roster BEFORE
    // removing them and stores it as detail.targetName for exactly this
    // reason — its own comment says the event would otherwise "render as a
    // bare user id forever". That capture was dead code: the ternary read
    // `nameById.get(detail.memberId) || detail.memberId`, so a detail carrying
    // both fields never reached the targetName branch.
    //
    // Latent until the rotation landed. Before it, a removed member usually
    // walked back in with the standing code and was back on the roster by the
    // time anyone read the trail, so the lookup happened to succeed. Making
    // removal durable made the fallback reachable — the one row that describes
    // somebody LOSING access is the row that stopped naming them.
    const keeperJoin = await asOwner(cfg => teamsync.createInvite(cfg, alpha.team_id, {}));
    process.env.MEMBRIDGE_HOME = HOME_BYSTANDER;
    const keeperJoined = await apiAs('bystander', 'POST', '/api/team/join', { inviteCode: keeperJoin.token });
    assert.strictEqual(keeperJoined.status, 200, `fixture: bystander must join Alpha, got ${keeperJoined.status}`);
    const bystanderId = mock.members.find(m => m.displayName === 'Bystander').userId;
    const roleChanged = await apiAs('owner', 'POST', '/api/team/set-role',
      { teamId: alpha.team_id, userId: bystanderId, role: 'admin' });
    assert.strictEqual(roleChanged.status, 200, `fixture: set-role must succeed, got ${roleChanged.status}`);
    const alphaAudit = async () => {
      const res = await apiAs('owner', 'GET', `/api/team/audit?teamId=${alpha.team_id}`);
      return (res.body && res.body.events) || [];
    };

    await check('a removed member is still named in the audit trail, not shown as a user id', async () => {
      const row = (await alphaAudit()).find(e => e.action === 'member-removed');
      assert.ok(row, 'fixture: the removal must have produced an audit row');
      assert.strictEqual(row.targetName, 'Member',
        'the name captured with the event must be used once the roster lookup misses; ' +
        `got ${JSON.stringify(row.targetName)}, and the detail carries it: ${row.detail}`);
    });

    // The class, not the instance: a user id rendered where a person's name
    // belongs answers nothing, and it is the failure the surrounding comment in
    // lib/api-access.js already forbids for object_key. Written as a sweep so a
    // future action that grows a memberId detail cannot reintroduce it quietly.
    await check('no audit row renders a raw user id where a person\'s name belongs', async () => {
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const offenders = (await alphaAudit()).filter(e => e.targetName && UUID.test(e.targetName));
      assert.deepStrictEqual(offenders.map(e => e.action), [],
        `these rows show a uuid as a person: ${JSON.stringify(offenders)}`);
    });

    // COUNTER-CHECKS — pass before AND after. The roster lookup is the primary
    // source and must stay primary: a "fix" that always prefers the captured
    // name would freeze a display name at the moment of the event and quietly
    // stop tracking renames, and one that broke the shared nameById map would
    // take actorName down with it.
    await check('a member still on the roster is named from the roster', async () => {
      const row = (await alphaAudit()).find(e => e.action === 'role-changed');
      assert.ok(row, 'fixture: the role change must have produced an audit row');
      assert.strictEqual(row.targetName, 'Bystander',
        `a current member's name comes from the live roster, got ${JSON.stringify(row.targetName)}`);
    });

    await check('the actor on every audit row is still resolved to a name', async () => {
      const rows = await alphaAudit();
      assert.ok(rows.length > 0, 'fixture: Alpha must have audit rows by now');
      const unresolved = rows.filter(e => !e.actorName || e.actorName === 'Unknown');
      assert.deepStrictEqual(unresolved.map(e => e.action), [],
        `every one of these rows was written by Owner: ${JSON.stringify(unresolved)}`);
    });

    // -----------------------------------------------------------------------
    // 5. REM-4: leaving is the same door (042).
    // -----------------------------------------------------------------------
    // leave_team (002:252) deleted the caller's own row and nothing else, so a
    // voluntary departure walked around everything 041 closed. The leaver here
    // is an ADMIN, which is the case that decides it: after 041 §2 the standing
    // code reaches managers only, so an admin who resigns is the person most
    // certain to be holding it, and they are never "removed" — they leave. If
    // only removal rotated, the highest-risk departure would be the one that
    // left the credential live.
    //
    // "Member" stands in for the outsider trying the old credentials: they were
    // removed from Alpha in section 2, still have working sign-in, and are not
    // on the roster.
    const alphaCodeBeforeLeave = (await teamRowFor('owner', alpha.team_id)).invite_code;
    const betaCodeBeforeLeave = (await teamRowFor('owner', beta.team_id)).invite_code;
    const linkBeforeLeave = await asOwner(cfg => teamsync.createInvite(cfg, alpha.team_id, {}));
    const left = await apiAs('bystander', 'POST', '/api/team/leave', { teamId: alpha.team_id });
    assert.strictEqual(left.status, 200, `fixture: the admin must be able to leave, got ${left.status}`);

    await check('leaving a team rotates its standing invite code', async () => {
      const after = (await teamRowFor('owner', alpha.team_id)).invite_code;
      assert.notStrictEqual(after, alphaCodeBeforeLeave,
        'leave_team must rotate teams.invite_code: a departing admin holds it, and revoking ' +
        'only their own outstanding invites would close nothing — the standing code is the ' +
        "team's, not theirs, and an ordinary member cannot mint invites at all");
    });

    await check('the code held before a departure stops working after it', async () => {
      const rejoin = await apiAs('member', 'POST', '/api/team/join', { inviteCode: alphaCodeBeforeLeave });
      assert.notStrictEqual(rejoin.status, 200,
        'the standing code a departing member was holding must be dead, whichever door they used');
    });

    await check('leaving revokes the team\'s outstanding invite links', async () => {
      const redeem = await apiAs('member', 'POST', '/api/team/join', { inviteCode: linkBeforeLeave.token });
      assert.notStrictEqual(redeem.status, 200,
        'a link minted before the departure must not still redeem afterwards — create_invite ' +
        'defaults to no expiry and no use cap, so the link they joined with outlives them');
    });

    // COUNTER-CHECKS — pass before AND after 042.
    await check('a departure from one team does not rotate another team\'s invite code', async () => {
      const after = (await teamRowFor('owner', beta.team_id)).invite_code;
      assert.strictEqual(after, betaCodeBeforeLeave,
        'nobody left Beta; its standing code must be byte-identical');
    });

    // 042 restates leave_team's body verbatim and adds two statements. The
    // owner guard lives inside that body, so a transcription slip would drop
    // it silently and hand every team an unrecoverable state (no owner, and
    // set_role cannot mint one). Cheap to assert, catastrophic to lose.
    await check('the owner still cannot leave their own team', async () => {
      const res = await apiAs('owner', 'POST', '/api/team/leave', { teamId: alpha.team_id });
      assert.notStrictEqual(res.status, 200,
        'leave_team must still refuse the owner; 042 restates its body and must not drop the guard');
      assert.ok(mock.members.some(m => m.teamId === alpha.team_id && m.displayName === 'Owner'),
        'the owner is off their own roster — the team now has nobody who can manage it');
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
