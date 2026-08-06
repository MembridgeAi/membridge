'use strict';
// Invite, join and credential lifetime — the surface where "holds a token" is
// mistaken for "is still a member", and where the audit trail records the
// wrong team or nothing at all.
//
// Every check below is written the way the system is SUPPOSED to behave and
// currently FAILS. Each one is a security finding pinned as a test so the fix
// has a target and a regression guard. Nothing here is a phantom: none of it
// depends on wall-clock timing, render scheduling, or machine load — the
// assertions are on returned data and on which HTTP calls the daemon made.
//
// A new file rather than a run-tests.js section: this needs its own backend
// fixture (an owner in TWO teams, a plain member who then gets removed), and
// the legacy suite is one sequential story whose sections share state.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, waitForHttp, post } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const { startServer } = require('../../lib/server');
const { createMockSupabase } = require('../mock-supabase');

// Two identities, each with its own MEMBRIDGE_HOME and dashboard port —
// siblings of the harness's throwaway home so its leak guards still cover them.
const HOME_OWNER = path.join(ROOT, 'home-lifetime-owner');
const HOME_MEMBER = path.join(ROOT, 'home-lifetime-member');
const homeFor = { owner: HOME_OWNER, member: HOME_MEMBER };
const portFor = { owner: P(69), member: P(70) };

async function main() {
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(P(68), '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(68)}`;
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
  const asMember = fn => { process.env.MEMBRIDGE_HOME = HOME_MEMBER; return fn(util.getConfig()); };

  try {
    fs.mkdirSync(HOME_OWNER, { recursive: true });
    fs.mkdirSync(HOME_MEMBER, { recursive: true });

    process.env.MEMBRIDGE_HOME = HOME_OWNER;
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'life-owner@test.dev', 'pw-o', 'Owner');
    // TWO teams, created in this order. my_teams orders by joined_at, so
    // teams[0] is Alpha for the rest of this file — which is exactly the
    // assumption lib/server.js firstTeamId() bakes in.
    const alpha = await teamsync.createTeam(util.getConfig(), 'Alpha');
    const beta = await teamsync.createTeam(util.getConfig(), 'Beta');

    process.env.MEMBRIDGE_HOME = HOME_MEMBER;
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'life-member@test.dev', 'pw-m', 'Member');

    // -----------------------------------------------------------------------
    // 1. The audit trail cannot record the one event that grants access.
    // -----------------------------------------------------------------------
    // POST /api/team/join writes a `member-joined` row AFTER the join, and the
    // comment there says the row "lands on a team the caller is now a member
    // of — team_audit's RLS insert policy requires exactly that". The policy
    // requires MANAGER, not member (024:98, tightened by 025:144 to
    // `is_team_manager(team_id) and actor_id = auth.uid()`), and a fresh
    // joiner is always role 'member'. So the insert is refused, recordAudit
    // swallows the refusal by design, and the join leaves no trace anywhere.
    //
    // This is the event that matters most: it is the moment someone GAINED
    // access to the team's memory. An audit trail that records invite churn
    // but never records anyone arriving cannot answer "who joined and when".
    const joinInvite = await asOwner(cfg => teamsync.createInvite(cfg, alpha.team_id, {}));
    await check('joining a team is recorded in that team\'s audit trail', async () => {
      const joined = await apiAs('member', 'POST', '/api/team/join', { inviteCode: joinInvite.token });
      assert.strictEqual(joined.status, 200, `join status ${joined.status}: ${JSON.stringify(joined.body)}`);
      const audit = await apiAs('owner', 'GET', `/api/team/audit?teamId=${alpha.team_id}`);
      assert.strictEqual(audit.status, 200, `audit status ${audit.status}: ${JSON.stringify(audit.body)}`);
      const joins = audit.body.events.filter(e => e.action === 'member-joined');
      assert.strictEqual(joins.length, 1,
        'a join must leave exactly one member-joined event; the RLS insert policy is manager-only ' +
        `so a joining member's own row is refused and silently dropped. events: ${JSON.stringify(audit.body.events)}`);
    });

    // -----------------------------------------------------------------------
    // 2. invite-revoked is filed against the wrong team.
    // -----------------------------------------------------------------------
    // POST /api/team/revoke-invite takes only a token. The invite names its own
    // team, and revoke_invite gates on THAT team's manager role — but the audit
    // row is filed against firstTeamId() (lib/server.js:1240-1244), which is
    // simply teams[0]. Revoke a Beta invite and the event lands on Alpha.
    //
    // Both halves are wrong, and the second is the dangerous one: Beta's audit
    // trail shows no revocation ever happened, while Alpha's shows one against
    // a token that was never Alpha's. An admin auditing Beta after a leak sees
    // a live invite and no record of anybody killing it.
    const betaInvite = await asOwner(cfg => teamsync.createInvite(cfg, beta.team_id, {}));
    await check('revoking an invite is recorded against the invite\'s OWN team', async () => {
      const rev = await apiAs('owner', 'POST', '/api/team/revoke-invite', { token: betaInvite.token });
      assert.strictEqual(rev.status, 200, `revoke status ${rev.status}: ${JSON.stringify(rev.body)}`);
      const betaAudit = await apiAs('owner', 'GET', `/api/team/audit?teamId=${beta.team_id}`);
      const onBeta = betaAudit.body.events.filter(e => e.action === 'invite-revoked' && e.objectLabel === betaInvite.token);
      assert.strictEqual(onBeta.length, 1,
        `Beta's own invite revocation must appear in Beta's trail, got ${JSON.stringify(betaAudit.body.events)}`);
    });

    await check('revoking a Beta invite writes nothing into Alpha\'s audit trail', async () => {
      const alphaAudit = await apiAs('owner', 'GET', `/api/team/audit?teamId=${alpha.team_id}`);
      const strays = alphaAudit.body.events.filter(e => e.objectLabel === betaInvite.token);
      assert.strictEqual(strays.length, 0,
        'an invite that never belonged to Alpha must not produce an Alpha audit event; ' +
        `firstTeamId() files it there regardless. events: ${JSON.stringify(alphaAudit.body.events)}`);
    });

    // -----------------------------------------------------------------------
    // 3. Removal is not durable: the permanent invite_code re-admits anyone.
    // -----------------------------------------------------------------------
    // teams.invite_code never expires, has no use cap, cannot be revoked on its
    // own, and is handed to EVERY member: my_teams returns it whatever the role
    // (006:14,27) and GET /api/team spreads the whole row into its payload
    // (lib/server.js:2349,2360). join_team (029:109) accepts it forever and is
    // granted to `authenticated` on the live backend.
    //
    // So removing a member removes a row and nothing else. The credential they
    // already read as a member still works, and nothing in the removal path
    // calls rotate_invite. Below: the member reads the code while still on the
    // team, the owner removes them, and they walk straight back in.
    //
    // FIXTURE REPAIR (044, agent-removal lane — flagged to the lead, revert on
    // request). This block read the code through the MEMBER's dashboard,
    // because that is what the daemon served every member at the time it was
    // written. 044 §2 stops it: my_teams returns invite_code to managers only,
    // and lib/server.js teamPayload nulls it for a non-manager row, so the
    // member-side read now correctly yields null and this `assert.ok` — which
    // is fixture scaffolding, not one of the eight pinned checks — aborted the
    // whole file before checks 4-8 could run, including the two the credential
    // -lifetime lane owns.
    //
    // Read through the OWNER instead. Nothing about the checks below changes:
    // closing the member-side READ narrows how a member obtains the code, it
    // does not retract a copy they already hold — from the dashboard before
    // 044, from an onboarding doc, or from the manager who pasted it into a
    // channel they can still read. `seenCode` stands in for exactly that copy,
    // which is the credential "a removed member cannot re-join with the invite
    // code they saw as a member" is about. The member-side read returning null
    // is pinned on its own in test/suites/removal-durability.test.js, so the
    // behaviour this line used to assert is still covered — with the opposite
    // expectation, which is the point.
    const seenCode = await (async () => {
      const res = await apiAs('owner', 'GET', '/api/team');
      const t = (res.body.teams || []).find(x => x.team_id === alpha.team_id);
      return t ? t.invite_code : null;
    })();
    assert.ok(seenCode, 'fixture: the code the removed member is holding must be readable, or this test proves nothing');

    await check('a removed member cannot re-join with the invite code they saw as a member', async () => {
      const removed = await apiAs('owner', 'POST', '/api/team/remove-member',
        { teamId: alpha.team_id, userId: mock.members.find(m => m.displayName === 'Member').userId });
      assert.strictEqual(removed.status, 200, `remove status ${removed.status}: ${JSON.stringify(removed.body)}`);
      const rejoin = await apiAs('member', 'POST', '/api/team/join', { inviteCode: seenCode });
      assert.notStrictEqual(rejoin.status, 200,
        'removal must invalidate the credential the removed member holds; the permanent ' +
        'teams.invite_code has no expiry, no use cap and no per-code revocation, and the ' +
        'removal path never rotates it, so the removed member re-joins unaided');
    });

    // The same failure said as a fact about state rather than about a response
    // code, so a fix that only changes the HTTP status cannot satisfy it.
    await check('a removed member is not back on the roster after using the old code', async () => {
      const stillThere = mock.members.some(m =>
        m.teamId === alpha.team_id && m.displayName === 'Member');
      assert.strictEqual(stillThere, false,
        'the removed member is on the roster again, with member role and — via 029\'s ' +
        'materialization — access to every project whose default_access is true');
    });

    // AMENDED — SUPERSEDED BY REM-1, ruled on by the lead 2026-08-05, not
    // weakened. This check was written as "a re-join after removal is recorded
    // in the audit trail" and asserted TWO member-joined events, because at the
    // time it was written the re-join was possible and therefore ought to have
    // left a record. Migration 044 §1 makes the re-join impossible, so a second
    // member-joined event can never exist — the original assertion now says
    // that a security hole still functions, which is the opposite of what it
    // was for.
    //
    // BOTH HALVES ARE KEPT. They fail independently and belong to different
    // lanes:
    //
    //   Half B (REM-1, agent-removal — GREEN here) asserts the re-join is
    //     refused and leaves the roster alone. It is checked FIRST and reads
    //     nothing from the audit trail, so it keeps discriminating while half A
    //     is red — otherwise a REM-1 regression would hide behind the audit bug
    //     (a re-join that succeeds but is never audited yields zero join events,
    //     exactly like a re-join that never happened).
    //
    //   Half A (the join-audit lane — still RED) asserts the ONE join that
    //     really happened is recorded. team_audit_insert is
    //     `is_team_manager(team_id) and actor_id = auth.uid()` (024:98,
    //     tightened by 025:144) and a fresh joiner is always role 'member', so
    //     the insert is refused and recordAudit swallows it. Not this lane's to
    //     fix, and deliberately not deleted just because REM-1 made its
    //     original fixture unreachable.
    //
    // The count is 1, and it is failable in both directions: 0 means the join
    // was never audited (half A today), 2 means a re-join happened and was
    // recorded (a REM-1 regression).
    await check('the join that happened is audited, and a post-removal re-join is refused', async () => {
      // Half B first — independent of the audit trail on purpose.
      const rejoin = await apiAs('member', 'POST', '/api/team/join', { inviteCode: seenCode });
      assert.notStrictEqual(rejoin.status, 200,
        'REM-1: the credential a removed member holds must be dead, so a re-join attempt ' +
        `must not succeed. got ${rejoin.status}: ${JSON.stringify(rejoin.body)}`);
      assert.strictEqual(
        mock.members.some(m => m.teamId === alpha.team_id && m.displayName === 'Member'), false,
        'REM-1: the removed member is back on the roster, so the refusal above was cosmetic');
      // Half A — the join-audit lane's, still failing at this commit.
      const audit = await apiAs('owner', 'GET', `/api/team/audit?teamId=${alpha.team_id}`);
      const joins = audit.body.events.filter(e => e.action === 'member-joined');
      assert.strictEqual(joins.length, 1,
        'exactly one member-joined event must exist: the real join must be recorded (the RLS ' +
        'insert policy is manager-only, so a joining member\'s own row is refused and silently ' +
        'dropped — join-audit lane), and the refused re-join must not appear (REM-1). ' +
        `events: ${JSON.stringify(audit.body.events)}`);
    });

    // -----------------------------------------------------------------------
    // 4. Signing out is local-only — the session stays valid at the backend.
    // -----------------------------------------------------------------------
    // POST /api/team/logout calls teamsync.clearCredentials(), which is a single
    // fs.unlinkSync (lib/teamsync.js:104-111). No POST /auth/v1/logout, so the
    // refresh token is never revoked. Anything that copied the credentials file
    // before the sign-out — a backup, a synced folder, another process on the
    // machine — can keep minting fresh access tokens from it indefinitely, and
    // the person who clicked "sign out" has no way to tell.
    // Captured BEFORE the sign-out, standing in for any copy of the file that
    // existed at that moment — a Time Machine snapshot, a synced folder, a
    // second process that read it. Nothing exotic: 0600 protects it from other
    // UNIX users, not from anything running as this one.
    const stolen = asMember(() => teamsync.loadCredentials());
    assert.ok(stolen && stolen.refreshToken, 'fixture: need the pre-logout credentials');

    await check('signing out revokes the session at the backend, not just on disk', async () => {
      const before = mock.stats.logoutCalls;
      const out = await apiAs('member', 'POST', '/api/team/logout', {});
      assert.strictEqual(out.status, 200, `logout status ${out.status}: ${JSON.stringify(out.body)}`);
      assert.strictEqual(mock.stats.logoutCalls, before + 1,
        'sign-out must call POST /auth/v1/logout so the refresh token stops working; ' +
        'clearCredentials only deletes the local file, leaving a copied credentials ' +
        'file replayable for as long as the refresh token lives');
    });

    // The consequence, asserted directly rather than inferred from the call
    // count: a credentials file captured before sign-out still refreshes.
    await check('a credentials copy taken before sign-out stops working after it', async () => {
      const res = await fetch(`${process.env.MEMBRIDGE_TEAM_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: 'anon-test' },
        body: JSON.stringify({ refresh_token: stolen.refreshToken }),
      });
      assert.notStrictEqual(res.status, 200,
        'the refresh token survives sign-out and still mints a valid session');
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
