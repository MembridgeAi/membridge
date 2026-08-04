// GET /api/team/invites -- the pending-invites listing behind the Members
// page's InvitesSection.
//
// NOTE ON SHAPE: this suite is meant to `require('../harness')` and end with
// h.finish(). That harness does not exist in this repo yet (no test/harness.js,
// no test/run.js, no other file under test/suites/, on any branch or ref), so
// it carries its own minimal check()/tally instead of requiring a module that
// would throw MODULE_NOT_FOUND. It still prints the "N/N checks passed" tally
// and still exits nonzero on any failure, so it is runnable today via
//   node test/suites/team-invites.js
// Swapping the six lines under "self-contained tally" for the harness require
// is all that should be needed once it lands.
//
// Deliberately NOT added to test/run-tests.js: that file is one sequential
// story whose sections share state on purpose, and this needs its own backend
// fixture with a revoked invite in it.
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { createMockSupabase } = require('../mock-supabase');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const { startServer } = require('../../lib/server');

// ---- self-contained tally (replace with require('../harness')) ----
let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}
function finish() {
  const total = passed + failed;
  console.log(`\n${passed}/${total} checks passed`);
  process.exit(failed ? 1 : 0);
}

// Ports are probed and only used once confirmed free. A hardcoded port would
// collide with the installed MemBridge daemon (7437 is the INSTALLED app, not
// this checkout) or with a parallel suite, and a bind failure here would crash
// before the tally printed -- which reads as a pass to anything grepping output
// for "FAIL" rather than checking the tally and the exit code.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try { await fetch(url); return; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  throw new Error(`server never came up: ${url}`);
}

(async () => {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'membridge-invites-'));
  const ORIGINAL_HOME = process.env.MEMBRIDGE_HOME;
  const HOME_OWNER = path.join(ROOT, 'home-owner');
  const HOME_MEMBER = path.join(ROOT, 'home-member');
  const homeFor = { owner: HOME_OWNER, member: HOME_MEMBER };
  const portFor = { owner: await freePort(), member: await freePort() };

  // One dashboard server per identity, started and closed around each call:
  // util.getConfig()/loadCredentials read process.env.MEMBRIDGE_HOME fresh on
  // every call, so this is only safe while identities are never concurrent.
  async function apiAs(role, method, pathname, body) {
    process.env.MEMBRIDGE_HOME = homeFor[role];
    const port = portFor[role];
    const srv = startServer(port, { retries: 0 });
    try {
      await waitForHttp(`http://127.0.0.1:${port}/api/status`);
      const res = method === 'GET'
        ? await fetch(`http://127.0.0.1:${port}${pathname}`)
        : await fetch(`http://127.0.0.1:${port}${pathname}`, {
          method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
        });
      return { status: res.status, body: await res.json().catch(() => null) };
    } finally {
      await new Promise(r => srv.close(r));
    }
  }

  const mock = createMockSupabase();
  const mockPort = await freePort();
  await new Promise(r => mock.server.listen(mockPort, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${mockPort}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

  try {
    process.env.MEMBRIDGE_HOME = HOME_OWNER;
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'inv-owner@test.dev', 'pw-o', 'Owner');
    const team = await teamsync.createTeam(util.getConfig(), 'InviteCo');

    // Three invites covering the three states the UI must tell apart: a
    // default never-expiring/unlimited link, a capped one, and a revoked one
    // that must NOT appear.
    const forever = await teamsync.createInvite(util.getConfig(), team.team_id, { expiresAt: null, maxUses: null });
    const capped = await teamsync.createInvite(util.getConfig(), team.team_id,
      { expiresAt: '2099-01-01T00:00:00.000Z', maxUses: 3 });
    const revoked = await teamsync.createInvite(util.getConfig(), team.team_id, { expiresAt: null, maxUses: null });
    await teamsync.revokeInvite(util.getConfig(), revoked.token);

    process.env.MEMBRIDGE_HOME = HOME_MEMBER;
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'inv-member@test.dev', 'pw-m', 'Member');
    await teamsync.joinTeam(util.getConfig(), team.invite_code);

    await check('GET /api/team/invites lists outstanding invites, newest first', async () => {
      const res = await apiAs('owner', 'GET', '/api/team/invites');
      assert.strictEqual(res.status, 200, `status ${res.status}: ${JSON.stringify(res.body)}`);
      const tokens = res.body.invites.map(i => i.token);
      assert.deepStrictEqual(tokens, [capped.token, forever.token],
        `expected the two live invites newest-first, got ${JSON.stringify(tokens)}`);
    });

    // The revoked row is the whole point of the filter: leaving it in would
    // render a Revoke button whose only possible outcome is a silent no-op,
    // since revoke_invite's UPDATE is already guarded by `revoked_at is null`.
    await check('a revoked invite never appears in the listing', async () => {
      const res = await apiAs('owner', 'GET', '/api/team/invites');
      assert.ok(!res.body.invites.some(i => i.token === revoked.token),
        'a revoked invite must not be offered for revoking again');
    });

    // Every field the UI renders must survive the trip. use_count in
    // particular must arrive as a real 0 and not be dropped or coerced to
    // null, or "0 of 3 used" silently becomes "unknown".
    await check('each row carries the id, created, expiry and uses the UI renders', async () => {
      const res = await apiAs('owner', 'GET', '/api/team/invites');
      const row = res.body.invites.find(i => i.token === capped.token);
      assert.ok(row, 'the capped invite must be listed');
      assert.strictEqual(row.max_uses, 3);
      assert.strictEqual(row.use_count, 0);
      assert.strictEqual(row.expires_at, '2099-01-01T00:00:00.000Z');
      assert.ok(row.created_at, 'created_at must be present');
    });

    await check('a never-expiring invite reports null rather than a fabricated expiry', async () => {
      const res = await apiAs('owner', 'GET', '/api/team/invites');
      const row = res.body.invites.find(i => i.token === forever.token);
      assert.strictEqual(row.expires_at, null);
      assert.strictEqual(row.max_uses, null);
    });

    // The token IS the join secret. A member who cannot mint or revoke (both
    // are is_team_manager-only in 002_team_v2.sql) must not be able to
    // enumerate live secrets either. The invites_select RLS policy is wider
    // than this on purpose, so THIS gate is what actually stops them.
    await check('GET /api/team/invites is refused for a member role', async () => {
      const res = await apiAs('member', 'GET', '/api/team/invites');
      assert.strictEqual(res.status, 403, `status ${res.status}: ${JSON.stringify(res.body)}`);
    });

    // Revoke must round-trip against the token the listing hands out: this is
    // the exact value InviteRow puts in onRevoke(invite.id), and the one thing
    // that makes the already-written Revoke button real rather than decorative.
    await check('the listed token is the one revoke-invite accepts, and it leaves the list', async () => {
      const before = (await apiAs('owner', 'GET', '/api/team/invites')).body.invites.map(i => i.token);
      assert.ok(before.includes(forever.token));
      const rev = await apiAs('owner', 'POST', '/api/team/revoke-invite', { token: forever.token });
      assert.strictEqual(rev.status, 200, `revoke status ${rev.status}: ${JSON.stringify(rev.body)}`);
      const after = (await apiAs('owner', 'GET', '/api/team/invites')).body.invites.map(i => i.token);
      assert.deepStrictEqual(after, [capped.token], `revoked invite still listed: ${JSON.stringify(after)}`);
    });
  } finally {
    await new Promise(r => mock.server.close(r));
    if (ORIGINAL_HOME === undefined) delete process.env.MEMBRIDGE_HOME;
    else process.env.MEMBRIDGE_HOME = ORIGINAL_HOME;
    fs.rmSync(ROOT, { recursive: true, force: true });
  }

  finish();
})().catch(err => { console.error(err); process.exit(1); });
