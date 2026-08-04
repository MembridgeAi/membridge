'use strict';
// GET /api/team/invites -- the pending-invites listing behind the Members
// page's InvitesSection.
//
// The endpoint shipped with no coverage at all: nothing in run-tests.js
// exercised it and the mock backend had no /rest/v1/invites handler, so the
// route, its manager gate, and the token-as-id contract the Revoke button
// depends on were all unverified end to end.
//
// A new file rather than a run-tests.js section: this needs its own backend
// fixture (an owner, a plain member, and an already-revoked invite), and the
// legacy suite is one sequential story whose sections share state on purpose.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, waitForHttp, post } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const { startServer } = require('../../lib/server');
const { createMockSupabase } = require('../mock-supabase');

// Two identities, each with its own MEMBRIDGE_HOME and dashboard port. The
// harness points MEMBRIDGE_HOME at one throwaway home; these are siblings of
// it under the same ROOT, so its leak guards still cover them.
const HOME_OWNER = path.join(ROOT, 'home-invites-owner');
const HOME_MEMBER = path.join(ROOT, 'home-invites-member');
const homeFor = { owner: HOME_OWNER, member: HOME_MEMBER };
const portFor = { owner: P(61), member: P(62) };

async function main() {
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(P(60), '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(60)}`;
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

  try {
    fs.mkdirSync(HOME_OWNER, { recursive: true });
    fs.mkdirSync(HOME_MEMBER, { recursive: true });

    process.env.MEMBRIDGE_HOME = HOME_OWNER;
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'inv-owner@test.dev', 'pw-o', 'Owner');
    const team = await teamsync.createTeam(util.getConfig(), 'InviteCo');

    // Three invites covering the states the UI must tell apart: the default
    // never-expiring/unlimited link, a capped one, and a revoked one.
    const forever = await teamsync.createInvite(util.getConfig(), team.team_id, { expiresAt: null, maxUses: null });
    const capped = await teamsync.createInvite(util.getConfig(), team.team_id,
      { expiresAt: '2099-01-01T00:00:00.000Z', maxUses: 3 });
    const revoked = await teamsync.createInvite(util.getConfig(), team.team_id, { expiresAt: null, maxUses: null });
    await teamsync.revokeInvite(util.getConfig(), revoked.token);

    process.env.MEMBRIDGE_HOME = HOME_MEMBER;
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'inv-member@test.dev', 'pw-m', 'Member');
    await teamsync.joinTeam(util.getConfig(), team.invite_code);

    await check('GET /api/team/invites lists this team\'s invites, newest first', async () => {
      const res = await apiAs('owner', 'GET', '/api/team/invites');
      assert.strictEqual(res.status, 200, `status ${res.status}: ${JSON.stringify(res.body)}`);
      const ids = res.body.invites.map(i => i.id);
      assert.deepStrictEqual(ids, [revoked.token, capped.token, forever.token],
        `expected all three newest-first, got ${JSON.stringify(ids)}`);
    });

    // `id` MUST be the token. The whole revoke path is
    // onRevoke(invite.id) -> POST /api/team/revoke-invite { token: id } ->
    // revoke_invite(p_token), which matches on nothing else, so any other
    // value here breaks every Revoke button with "unknown invite" while the
    // list on screen still looks perfectly healthy.
    await check('each row is identified by its token, and carries expiry and uses', async () => {
      const res = await apiAs('owner', 'GET', '/api/team/invites');
      const row = res.body.invites.find(i => i.id === capped.token);
      assert.ok(row, 'the capped invite must be listed under its token as id');
      assert.strictEqual(row.maxUses, 3);
      // A real 0 must survive rather than being coerced to null, or
      // "0 of 3 used" silently becomes "unknown".
      assert.strictEqual(row.useCount, 0);
      assert.strictEqual(row.expiresAt, '2099-01-01T00:00:00.000Z');
      assert.ok(row.createdAt, 'createdAt must be present');
    });

    // Null expiry and null max-uses are the DEFAULT the app mints (POST
    // /api/team/invite sends null for both when given no expiresDays/maxUses),
    // so these are the common case, not an edge one. Fabricating a date here
    // would make the most common invite in the system read as expiring.
    await check('a never-expiring invite reports null rather than a fabricated expiry', async () => {
      const res = await apiAs('owner', 'GET', '/api/team/invites');
      const row = res.body.invites.find(i => i.id === forever.token);
      assert.strictEqual(row.expiresAt, null);
      assert.strictEqual(row.maxUses, null);
    });

    // Revoked rows are listed WITH a flag rather than filtered out, so an
    // admin chasing a link that stopped working can still find it. The flag is
    // the only thing distinguishing it from a live one, so it has to be right.
    await check('a revoked invite is listed as revoked, not as live', async () => {
      const res = await apiAs('owner', 'GET', '/api/team/invites');
      const row = res.body.invites.find(i => i.id === revoked.token);
      assert.ok(row, 'a revoked invite must still be findable');
      assert.strictEqual(row.revoked, true);
      assert.strictEqual(res.body.invites.find(i => i.id === forever.token).revoked, false);
    });

    // The token IS the join secret. A member who cannot mint or revoke (both
    // are is_team_manager-only in 002_team_v2.sql) must not be able to
    // enumerate live secrets either. The invites_select RLS policy is wider
    // than this on purpose, so THIS gate is what actually stops them.
    await check('GET /api/team/invites is refused for a member role', async () => {
      const res = await apiAs('member', 'GET', '/api/team/invites');
      assert.strictEqual(res.status, 403, `status ${res.status}: ${JSON.stringify(res.body)}`);
    });

    // The round trip that makes the already-written Revoke button real rather
    // than decorative: the id the listing hands out must be the exact value
    // the revoke route accepts, and the row must then report itself revoked.
    await check('the listed id is the one revoke-invite accepts, and the row flips to revoked', async () => {
      const before = (await apiAs('owner', 'GET', '/api/team/invites')).body.invites;
      assert.strictEqual(before.find(i => i.id === forever.token).revoked, false);
      const rev = await apiAs('owner', 'POST', '/api/team/revoke-invite', { token: forever.token });
      assert.strictEqual(rev.status, 200, `revoke status ${rev.status}: ${JSON.stringify(rev.body)}`);
      const after = (await apiAs('owner', 'GET', '/api/team/invites')).body.invites;
      assert.strictEqual(after.find(i => i.id === forever.token).revoked, true,
        'the revoked invite must report itself revoked on the next read');
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
