'use strict';
// Account deletion vs the audit trail — 049_team_audit_actor_set_null.sql.
//
// A REGRESSION FROM THIS SESSION, pinned by the lane that caused it.
// `team_audit.actor_id references auth.users (id)` was declared with no
// on-delete action (024:44). Before 046 a plain member had no audit rows at
// all — the trail recorded invite churn, role changes and removals, all
// written by managers — so that constraint never touched them. 046 gives every
// member a `member-joined` row naming them as actor, which pins their account
// open.
//
// THE SCOPE OF THAT CLAIM IS THE POINT OF HALF THIS FILE. Account deletion is
// blocked by six foreign keys, five of which predate today, and
// memory_entries.author_id alone blocks it for anyone who has ever synced a
// single entry — which is every real user. So 046 did not break account
// deletion in general; it removed the last population that could still be
// deleted, someone who joined a team and did nothing else. 050 restores that
// population and nothing more, and the counter-checks below exist so this
// suite can never be read as claiming otherwise.
//
// The mock models the blocking constraints, not only the cascading ones, and
// throws with the offending constraint name exactly as Postgres does — so
// these checks assert WHICH constraint refused, not merely that something did.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, waitForHttp, post } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const { startServer } = require('../../lib/server');
const { createMockSupabase } = require('../mock-supabase');

const HOME_OWNER = path.join(ROOT, 'home-del-owner');
const HOME_QUIET = path.join(ROOT, 'home-del-quiet');
const HOME_BUSY = path.join(ROOT, 'home-del-busy');
const homeFor = { owner: HOME_OWNER, quiet: HOME_QUIET, busy: HOME_BUSY };
const portFor = { owner: P(85), quiet: P(86), busy: P(87) };

async function main() {
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(P(84), '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(84)}`;
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
  const joinFresh = async (role, teamId) => {
    const inv = await asOwner(cfg => teamsync.createInvite(cfg, teamId, {}));
    const res = await apiAs(role, 'POST', '/api/team/join', { inviteCode: inv.token });
    assert.strictEqual(res.status, 200, `fixture: ${role} must join, got ${res.status}`);
  };
  const deleteFails = userId => {
    try {
      mock.deleteUserCascade(userId);
      return null;
    } catch (err) {
      return err.message;
    }
  };

  try {
    for (const dir of Object.values(homeFor)) fs.mkdirSync(dir, { recursive: true });

    process.env.MEMBRIDGE_HOME = HOME_OWNER;
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'del-owner@test.dev', 'pw-o', 'Owner');
    const alpha = await teamsync.createTeam(util.getConfig(), 'Alpha');

    // QUIET joined a team and did nothing else. Before 046 this account was
    // deletable; it is the entire population the regression cost.
    process.env.MEMBRIDGE_HOME = HOME_QUIET;
    util.ensureConfig();
    const quietCreds = await teamsync.signup(util.getConfig(), 'del-quiet@test.dev', 'pw-q', 'Quiet');

    // BUSY joined and pushed one memory entry, standing in for every real user.
    process.env.MEMBRIDGE_HOME = HOME_BUSY;
    util.ensureConfig();
    const busyCreds = await teamsync.signup(util.getConfig(), 'del-busy@test.dev', 'pw-b', 'Busy');

    await joinFresh('quiet', alpha.team_id);
    await joinFresh('busy', alpha.team_id);
    mock.entries.push({
      id: 1, project_id: null, author_id: busyCreds.userId, author_name: 'Busy',
      ts: new Date().toISOString(), created_at: new Date().toISOString(), source: 'Claude Code',
    });

    // Quiet is promoted and then acts ON SOMEONE ELSE. This is the row that
    // decides set-null against cascade: its actor is the account about to be
    // deleted, but its subject is a colleague who is still here, and it
    // records a decision that still affects them.
    const promoted = await apiAs('owner', 'POST', '/api/team/set-role',
      { teamId: alpha.team_id, userId: quietCreds.userId, role: 'admin' });
    assert.strictEqual(promoted.status, 200, `fixture: promotion must succeed, got ${promoted.status}`);
    const removedBusy = await apiAs('quiet', 'POST', '/api/team/remove-member',
      { teamId: alpha.team_id, userId: busyCreds.userId });
    assert.strictEqual(removedBusy.status, 200, `fixture: the admin must remove Busy, got ${removedBusy.status}`);

    await check('a member who only ever joined can have their account deleted', async () => {
      const refusal = deleteFails(quietCreds.userId);
      assert.strictEqual(refusal, null,
        'a join row must not pin an account open. team_audit.actor_id references auth.users ' +
        'with no on-delete action (024:44), and since 046 every member has a member-joined row ' +
        `naming them as actor. refused with: ${refusal}`);
      assert.strictEqual(mock.members.some(m => m.userId === quietCreds.userId), false,
        'the membership rows did not cascade away with the account');
    });

    // COUNTER-CHECK, green before AND after 050, and it is here to stop this
    // suite being read as "050 makes account deletion work". It does not.
    // memory_entries.author_id is NOT NULL with no on-delete (schema.sql:46),
    // so anyone who has ever synced one entry is still blocked — by a
    // constraint that predates this session by a long way. Making deletion
    // actually work is a feature (delete_my_entries first, then five more
    // foreign keys), not a constraint tweak.
    await check('a member who has synced anything is still blocked, by a different constraint', async () => {
      const refusal = deleteFails(busyCreds.userId);
      assert.ok(refusal, 'a user with synced entries must still be refused');
      assert.match(refusal, /memory_entries_author_id_fkey/,
        `050 must not be mistaken for making account deletion work; got: ${refusal}`);
      assert.doesNotMatch(refusal, /team_audit_actor_id_fkey/,
        'the audit trail should no longer be the constraint that refuses');
    });

    // ---------------------------------------------------------------------
    // SET NULL, not cascade.
    // ---------------------------------------------------------------------
    // The rows an actor wrote are not all ABOUT that actor. A manager who
    // removes someone is the actor on a row about the person they removed.
    // Cascading their deletion would erase that record — so "delete my
    // account" would become a way to unmake decisions imposed on colleagues.
    // Green before 050 (the deletion is refused, so nothing is erased) and
    // after (set null keeps the row); RED only under `on delete cascade`.
    await check('deleting an account keeps the rows recording what they did to others', async () => {
      const row = (await auditOf(alpha.team_id))
        .find(e => e.action === 'member-removed' && e.objectLabel === busyCreds.userId);
      assert.ok(row,
        'the deleted admin was the ACTOR on this row, but its SUBJECT is a colleague and it ' +
        'records a decision that still affects them. `on delete cascade` would erase it, making ' +
        '"delete my account" a way to unmake decisions imposed on other people — which is why ' +
        '050 is `on delete set null`');
      assert.strictEqual(row.targetName, 'Busy',
        `the subject must still be named on the surviving row, got ${JSON.stringify(row.targetName)}`);
      assert.strictEqual(row.actorName, 'A deleted account',
        `the row survives with the link dropped, not the row, got ${JSON.stringify(row.actorName)}`);
    });

    // ---------------------------------------------------------------------
    // What the trail renders afterwards.
    // ---------------------------------------------------------------------
    // A null actor_id is a POSITIVE fact — the account was deleted — not a
    // failure to resolve a name. Collapsing it into 'Unknown' is the bug this
    // branch already fixed once, reached by a new route.
    await check('a deleted account\'s row says so, rather than "Unknown"', async () => {
      const row = (await auditOf(alpha.team_id))
        .find(e => e.action === 'member-joined' && e.objectLabel === quietCreds.userId);
      assert.ok(row, 'fixture: the deleted member\'s join row must survive the deletion');
      assert.strictEqual(row.actorName, 'A deleted account',
        `a null actor_id means the account was erased, which the trail can state exactly; got ${JSON.stringify(row.actorName)}`);
    });

    // COUNTER-CHECK for the erasure property, and the specific wrong fix it
    // guards: readAudit has a self-acting fallback that reuses the name
    // captured on the row, which is right for a member who LEFT and exactly
    // wrong for an account that was erased. If the null branch were removed —
    // or moved below the fallback — this row would announce who it was and the
    // deletion would be cosmetic.
    await check('a deleted account is not re-identified from the row\'s own captured name', async () => {
      const row = (await auditOf(alpha.team_id))
        .find(e => e.action === 'member-joined' && e.objectLabel === quietCreds.userId);
      assert.notStrictEqual(row.actorName, 'Quiet',
        'the captured display name must not be reused for an account that was deleted — ' +
        'that fallback exists for a member who left, who still exists and still has a name');
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
