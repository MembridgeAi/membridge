'use strict';
// Display-name changes: uniqueness within a team, atomicity across teams, and
// the rule that credentials.json is written ONLY after the backend agrees.
// Run directly, or via `node test/run.js display-name`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, waitForHttp, post } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const { startServer } = require('../../lib/server');
const { createMockSupabase } = require('../mock-supabase');

const HOME_A = path.join(ROOT, 'home-name-a');
const HOME_B = path.join(ROOT, 'home-name-b');
// C never joins a team: the teamless case has its own credential-writing rule.
const HOME_C = path.join(ROOT, 'home-name-c');
// D exists only to prove the auto-suffix trigger against a REAL collision:
// Ada already holds "Ada" on Acme, so D joining and asking for "Ada" must
// land as "Ada 2".
const HOME_D = path.join(ROOT, 'home-name-d');
const homeFor = { a: HOME_A, b: HOME_B, c: HOME_C, d: HOME_D };
const portFor = { a: P(88), b: P(89), c: P(91), d: P(92) };

async function main() {
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(P(90), '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(90)}`;

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
  const credsOf = role =>
    JSON.parse(fs.readFileSync(path.join(homeFor[role], 'credentials.json'), 'utf8'));

  try {
    for (const dir of Object.values(homeFor)) fs.mkdirSync(dir, { recursive: true });

    process.env.MEMBRIDGE_HOME = HOME_A;
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'a@test.dev', 'pw-a', 'Ada');
    const team = await teamsync.createTeam(util.getConfig(), 'Acme');

    process.env.MEMBRIDGE_HOME = HOME_B;
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'b@test.dev', 'pw-b', 'Bo');
    const joined = await apiAs('b', 'POST', '/api/team/join', { inviteCode: team.invite_code });
    assert.strictEqual(joined.status, 200, 'fixture: Bo must join Acme');

    await check('a rename Bo does not clash with is accepted and stored locally', async () => {
      const res = await apiAs('b', 'POST', '/api/team/set-display-name', { name: 'Bodhi', avatar: 'ring' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.displayName, 'Bodhi');
      assert.strictEqual(credsOf('b').displayName, 'Bodhi');
      assert.strictEqual(credsOf('b').avatar, 'ring');
    });

    await check('taking a teammate name is a 409 that names the team', async () => {
      const res = await apiAs('b', 'POST', '/api/team/set-display-name', { name: 'Ada', avatar: null });
      assert.strictEqual(res.status, 409);
      assert.match(res.body.error, /Acme/);
    });

    await check('a refused rename leaves credentials.json untouched', () => {
      // This repo's characteristic bug is a fail-open path plus an
      // unconditional success flag. credentials.json IS the flag here: a
      // machine that records a rename the server refused goes on stamping the
      // refused name onto every entry it pushes.
      assert.strictEqual(credsOf('b').displayName, 'Bodhi');
    });

    await check('case and spacing alone do not make a name distinct', async () => {
      const res = await apiAs('b', 'POST', '/api/team/set-display-name', { name: '  aDa ', avatar: null });
      assert.strictEqual(res.status, 409);
    });

    await check('changing only your own capitalisation is allowed', async () => {
      const res = await apiAs('b', 'POST', '/api/team/set-display-name', { name: 'BODHI', avatar: 'ring' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(credsOf('b').displayName, 'BODHI');
    });

    await check('a name that trims to empty never reaches the network, and carries MB002', async () => {
      // Refused inside the route itself (lib/server.js), before
      // teamsync.setDisplayName ever calls the RPC -- so this is the one
      // rejection MB002 has to cover that the database never sees. Without
      // `code` on THIS response too, a caller (Task 6's dialog) could
      // distinguish a collision from a malformed avatar/colour only when the
      // rejection happened to come from SQL, and would see no code at all
      // for the two most common local rejections (empty name, over-length
      // name).
      const res = await apiAs('b', 'POST', '/api/team/set-display-name', { name: '   ', avatar: null });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, 'MB002');
      assert.strictEqual(credsOf('b').displayName, 'BODHI');
    });

    await check('a name over 80 characters is refused locally too, and also carries MB002', async () => {
      const res = await apiAs('b', 'POST', '/api/team/set-display-name', { name: 'x'.repeat(81), avatar: null });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, 'MB002');
      assert.strictEqual(credsOf('b').displayName, 'BODHI');
    });

    await check('a teamless account keeps its name instead of being nulled out', async () => {
      // set_display_name reports what it WROTE, so an account on no teams gets
      // back (null, null, null, 0). Writing those nulls to credentials.json
      // would erase the name of every signed-in user who has not joined a
      // team.
      process.env.MEMBRIDGE_HOME = HOME_C;
      util.ensureConfig();
      await teamsync.signup(util.getConfig(), 'c@test.dev', 'pw-c', 'Solo');
      const res = await apiAs('c', 'POST', '/api/team/set-display-name', { name: 'Solozz', avatar: 'halo', avatarColor: null });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.teams, 0);
      assert.strictEqual(credsOf('c').displayName, 'Solozz');
      assert.strictEqual(credsOf('c').avatar, 'halo');
    });

    await check('clearing the avatar stores null, not the previous mark', async () => {
      const res = await apiAs('b', 'POST', '/api/team/set-display-name', { name: 'BODHI', avatar: null });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(credsOf('b').avatar, null);
    });

    await check('a colour round-trips into credentials.json', async () => {
      // Avatars are TWO independent choices (glyph + colour), so avatarColor
      // must survive the round trip exactly like avatar does.
      const res = await apiAs('b', 'POST', '/api/team/set-display-name', { name: 'BODHI', avatar: 'ring', avatarColor: '#AABBCC' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.avatarColor, '#AABBCC');
      assert.strictEqual(credsOf('b').avatarColor, '#AABBCC');
    });

    await check('clearing the colour stores null, not the previous mark', async () => {
      const res = await apiAs('b', 'POST', '/api/team/set-display-name', { name: 'BODHI', avatar: 'ring', avatarColor: null });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.avatarColor, null);
      assert.strictEqual(credsOf('b').avatarColor, null);
    });

    await check('a malformed colour is a 400/MB002, not a stored value', async () => {
      const res = await apiAs('b', 'POST', '/api/team/set-display-name', { name: 'BODHI', avatar: 'ring', avatarColor: 'not-a-color' });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, 'MB002');
      assert.strictEqual(credsOf('b').avatarColor, null, 'the prior clear must stand — nothing was written');
    });

    await check('a malformed RPC result is rejected, not laundered into teamless success', async () => {
      // rest() returns null on a 204 and on a 200 whose body fails to parse.
      // Without a shape guard, setDisplayName's old `row.teams` truthiness
      // check would read that null (or an empty array, or a row missing
      // `teams`) as "wrote nothing, teamless — store what I asked for", and
      // stamp the REQUESTED name onto credentials.json even though nothing is
      // known to have been written server-side. Exercised directly against
      // teamsync.setDisplayName because the malformed shape is a daemon-level
      // concern, not an HTTP-route one — Task 3's route doesn't exist yet.
      process.env.MEMBRIDGE_HOME = HOME_B;
      const before = credsOf('b');
      mock.flags.malformedSetDisplayName = true;
      let threw = null;
      try {
        await teamsync.setDisplayName(util.getConfig(), 'Should Never Land', null, null);
      } catch (err) {
        threw = err;
      } finally {
        mock.flags.malformedSetDisplayName = false;
      }
      assert.ok(threw, 'setDisplayName must reject a malformed RPC result');
      assert.match(threw.message, /no usable result/);
      const after = credsOf('b');
      assert.strictEqual(after.displayName, before.displayName, 'credentials.json must be untouched');
      assert.strictEqual(after.avatar, before.avatar);
      assert.strictEqual(after.avatarColor, before.avatarColor);
    });

    await check('joining under a taken name auto-suffixes instead of failing', async () => {
      // The mock's memberInsertTrigger runs uniqueName on every insert (the
      // 057 BEFORE INSERT trigger). Ada already holds "Ada" on Acme; D joins
      // and explicitly asks for "Ada" too, and must land as "Ada 2" rather
      // than being turned away or silently colliding.
      process.env.MEMBRIDGE_HOME = HOME_D;
      util.ensureConfig();
      const dCreds = await teamsync.signup(util.getConfig(), 'd@test.dev', 'pw-d', 'Ada');
      const joinedD = await apiAs('d', 'POST', '/api/team/join', { inviteCode: team.invite_code });
      assert.strictEqual(joinedD.status, 200, 'fixture: D must join Acme');
      const dRow = mock.members.find(m => m.teamId === team.team_id && m.userId === dCreds.userId);
      assert.ok(dRow, 'D must be present on the team');
      assert.strictEqual(dRow.displayName, 'Ada 2');
    });

    await check('GET /api/team reports the avatar alongside the name', async () => {
      await apiAs('b', 'POST', '/api/team/set-display-name', { name: 'BODHI', avatar: 'wave' });
      const res = await apiAs('b', 'GET', '/api/team');
      assert.strictEqual(res.body.user.avatar, 'wave');
    });
  } finally {
    mock.server.close();
  }

  h.finish();
}

main();
