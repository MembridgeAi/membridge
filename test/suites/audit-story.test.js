'use strict';
// Does the audit trail tell a coherent story? — REM-9.
//
// The rest of this lane made the trail RECORD things. This file reads it back
// as a person would. Two kinds of check, and the first is the durable one:
//
//   1. COVERAGE, structurally. Every action string a writer can emit must have
//      a sentence in the renderer. This is a source-shape check across three
//      places that have no reason to know about each other — lib/server.js and
//      lib/api-access.js write some actions, migrations write others from
//      inside RPCs and triggers, and ui/.../auditText.ts renders them. Nothing
//      connected those sets before, which is exactly how `own-data-deleted`
//      shipped rendering as "own-data-deleted member 8f21c0de-…": it is
//      written from SQL (035 §3), so grepping the CLIENT for audit actions
//      never finds it. `member-left` had the same gap when 049 added it.
//
//   2. THE STORY. A team's whole life, read end to end, asserting that every
//      row a manager sees names a person and an action rather than a uuid or
//      a bare action string.
//
// Deliberately NOT here: whether an event that does not exist SHOULD. Several
// consequential actions leave no row at all (see the report accompanying this
// commit) and adding one is a product decision about what gets recorded about
// people — Marco's call, not a test's.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, waitForHttp, post, readSource } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const { startServer } = require('../../lib/server');
const { createMockSupabase } = require('../mock-supabase');

const REPO = path.join(__dirname, '..', '..');
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// The actions the renderer knows, read out of its own source. A `case '…':`
// in auditSentence IS the list — there is no export to read, and adding one
// requires touching this exact syntax, so the source is the honest source.
function renderedActions() {
  const src = readSource(path.join(REPO, 'ui/src/features/members/auditText.ts'));
  const body = src.slice(src.indexOf('export function auditSentence'));
  return new Set([...body.matchAll(/case '([^']+)'/g)].map(m => m[1]));
}

// The actions the daemon can write. `action:` in a recordAudit/writeAudit
// argument, including the two written as a ternary (access-granted /
// access-revoked and the access-default pair).
function daemonActions() {
  const src = ['lib/server.js', 'lib/api-access.js']
    .map(f => readSource(path.join(REPO, f))).join('\n');
  const out = new Set();
  for (const m of src.matchAll(/action:\s*[^,\n]*\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) {
    out.add(m[1]); out.add(m[2]);
  }
  for (const m of src.matchAll(/action:\s*'([^']+)'/g)) out.add(m[1]);
  return out;
}

// The actions a migration writes from inside an RPC or a trigger. These are
// the ones no amount of reading lib/ will find.
function migrationActions() {
  const dir = path.join(REPO, 'supabase/migrations');
  const out = new Set();
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql'))) {
    const text = readSource(path.join(dir, file));
    // Each insert names its columns, then lists values one per line; the
    // action is the literal sitting where `action` was declared.
    for (const m of text.matchAll(/insert into public\.team_audit\s*\(([^)]*)\)[\s\S]{0,400}?values\s*\(([\s\S]{0,400}?)\n\s*\);/g)) {
      const cols = m[1].split(',').map(s => s.trim());
      const idx = cols.indexOf('action');
      if (idx === -1) continue;
      const vals = m[2].split('\n').map(s => s.trim().replace(/,$/, '')).filter(Boolean);
      const v = vals[idx];
      if (v && /^'[a-z-]+'$/.test(v)) out.add(v.slice(1, -1));
    }
  }
  return out;
}

const HOME_OWNER = path.join(ROOT, 'home-story-owner');
const HOME_ALICE = path.join(ROOT, 'home-story-alice');
const HOME_BOB = path.join(ROOT, 'home-story-bob');
const homeFor = { owner: HOME_OWNER, alice: HOME_ALICE, bob: HOME_BOB };
const portFor = { owner: P(89), alice: P(90), bob: P(91) };

async function main() {
  // -----------------------------------------------------------------------
  // 1. Coverage. No server needed — this is about source, and it is the check
  // that would have caught both of this lane's rendering defects before a
  // human noticed them.
  // -----------------------------------------------------------------------
  const rendered = renderedActions();
  const fromDaemon = daemonActions();
  const fromSql = migrationActions();

  check('the renderer has a sentence for every action the DAEMON can write', () => {
    const missing = [...fromDaemon].filter(a => !rendered.has(a)).sort();
    assert.deepStrictEqual(missing, [],
      'these actions fall through auditSentence to the raw shape, which prints the action ' +
      `string and a uuid instead of a sentence: ${JSON.stringify(missing)}`);
  });

  check('the renderer has a sentence for every action a MIGRATION can write', () => {
    assert.ok(fromSql.size >= 3,
      `the migration scan found ${fromSql.size} actions; it should see member-joined, ` +
      'member-left and own-data-deleted at least — if it found none the regex has drifted ' +
      'from the SQL and this check is vacuous');
    const missing = [...fromSql].filter(a => !rendered.has(a)).sort();
    assert.deepStrictEqual(missing, [],
      'actions written from inside an RPC or trigger are invisible to anyone grepping lib/, ' +
      `which is how own-data-deleted shipped rendering raw: ${JSON.stringify(missing)}`);
  });

  // The counter-check for the two above: they are only worth anything if the
  // scans actually see the writers. A regex that matches nothing makes an
  // empty "missing" list and passes forever.
  check('the action scans are not vacuous', () => {
    assert.ok(fromDaemon.has('member-removed') && fromDaemon.has('invite-created'),
      `the daemon scan missed known actions: ${JSON.stringify([...fromDaemon].sort())}`);
    assert.ok(fromSql.has('member-joined') && fromSql.has('own-data-deleted'),
      `the migration scan missed known actions: ${JSON.stringify([...fromSql].sort())}`);
    assert.ok(rendered.size >= 10,
      `the renderer scan found only ${rendered.size} cases`);
  });

  // -----------------------------------------------------------------------
  // 2. The story.
  // -----------------------------------------------------------------------
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(P(88), '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(88)}`;
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
  const joinFresh = async (role, teamId) => {
    const inv = await asOwner(cfg => teamsync.createInvite(cfg, teamId, {}));
    const res = await apiAs(role, 'POST', '/api/team/join', { inviteCode: inv.token });
    assert.strictEqual(res.status, 200, `fixture: ${role} must join, got ${res.status}`);
  };

  try {
    for (const dir of Object.values(homeFor)) fs.mkdirSync(dir, { recursive: true });

    process.env.MEMBRIDGE_HOME = HOME_OWNER;
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'story-owner@test.dev', 'pw-o', 'Owner');
    const team = await teamsync.createTeam(util.getConfig(), 'Acme');

    process.env.MEMBRIDGE_HOME = HOME_ALICE;
    util.ensureConfig();
    const aliceCreds = await teamsync.signup(util.getConfig(), 'story-alice@test.dev', 'pw-a', 'Alice');

    process.env.MEMBRIDGE_HOME = HOME_BOB;
    util.ensureConfig();
    const bobCreds = await teamsync.signup(util.getConfig(), 'story-bob@test.dev', 'pw-b', 'Bob');

    // A team's life: two joins, an invite minted and revoked, a promotion, a
    // rename, a removal, a departure, and somebody erasing their own history.
    await joinFresh('alice', team.team_id);
    await joinFresh('bob', team.team_id);
    // Through the ROUTE, not teamsync.createInvite: the invite-created row is
    // written by the daemon route, so minting one directly (which joinFresh
    // does, to keep the fixture terse) leaves no audit row at all. That
    // difference is itself worth knowing — a manager who mints an invite from
    // the CLI leaves no record, and only the dashboard route logs it.
    const minted = await apiAs('owner', 'POST', '/api/team/invite', { teamId: team.team_id });
    assert.strictEqual(minted.status, 200, `fixture: mint must succeed, got ${minted.status}`);
    await apiAs('owner', 'POST', '/api/team/revoke-invite', { token: minted.body.token });
    await apiAs('owner', 'POST', '/api/team/set-role', { teamId: team.team_id, userId: aliceCreds.userId, role: 'admin' });
    await apiAs('owner', 'POST', '/api/team/rename', { teamId: team.team_id, name: 'Acme AI' });
    // Bob erases his own entries, then Alice removes him, then Alice leaves.
    // The entry needs a project that belongs to THIS team — delete_my_entries
    // joins through projects.team_id, so an entry with a null project_id is
    // invisible to it and the deletion silently removes nothing.
    const proj = { id: require('crypto').randomUUID(), teamId: team.team_id, name: 'app', repoUrl: null };
    mock.projects.push(proj);
    mock.entries.push({
      id: 1, project_id: proj.id, author_id: bobCreds.userId, author_name: 'Bob',
      ts: new Date().toISOString(), created_at: new Date().toISOString(), source: 'Claude Code',
    });
    await apiAs('bob', 'POST', '/api/team/delete-my-data', { teamId: team.team_id, confirm: 'DELETE' });
    // Snapshot taken while Bob is STILL A MEMBER. The row about him erasing
    // his own history is readable now and stops being readable the moment he
    // leaves — 035's detail carries memberId but no targetName, so once the
    // roster lookup misses there is no captured name to fall back to and the
    // actor renders "Unknown". That is a data gap in the writer, not a
    // rendering defect, and fixing it means restating delete_my_entries in a
    // new migration — the same restate-a-function-another-lane-may-be-editing
    // hazard 046 exists to avoid, with 040 currently on memory_entries. It is
    // reported rather than built. This snapshot pins what IS true so the check
    // below is not vacuous.
    const eventsWhileMember = ((await apiAs('owner', 'GET', `/api/team/audit?teamId=${team.team_id}`)).body || {}).events || [];
    await apiAs('alice', 'POST', '/api/team/remove-member', { teamId: team.team_id, userId: bobCreds.userId });
    await apiAs('alice', 'POST', '/api/team/leave', { teamId: team.team_id });

    const events = ((await apiAs('owner', 'GET', `/api/team/audit?teamId=${team.team_id}`)).body || {}).events || [];

    await check('a team\'s whole life produces a trail with no unnamed rows', async () => {
      assert.ok(events.length >= 8, `expected the whole story, got ${events.length} rows`);
      const unnamed = events.filter(e => !e.actorName || UUID_RE.test(e.actorName));
      assert.deepStrictEqual(unnamed.map(e => e.action), [],
        `these rows do not name who acted: ${JSON.stringify(unnamed)}`);
    });

    await check('every row in the story is an action the renderer can put in words', async () => {
      const raw = events.map(e => e.action).filter(a => !rendered.has(a));
      assert.deepStrictEqual([...new Set(raw)], [],
        `these rows render as "<action> <objectType> <uuid>": ${JSON.stringify(raw)}`);
    });

    // The specific row this ticket found: somebody erasing their own history.
    // It is written from SQL, so it is the one nothing in lib/ names.
    await check('the erase-my-own-history row is present and describes itself', async () => {
      const row = events.find(e => e.action === 'own-data-deleted');
      assert.ok(row, 'deleting your own data must leave a record — it is a change to shared memory');
      assert.ok(rendered.has(row.action),
        'own-data-deleted has no case in auditSentence, so it renders as its own action string ' +
        'followed by the actor\'s uuid — the one row recording somebody erasing their own history');
      assert.strictEqual(row.objectType, 'member',
        `the row is about a person, got objectType ${JSON.stringify(row.objectType)}`);
      const named = eventsWhileMember.find(e => e.action === 'own-data-deleted');
      assert.strictEqual(named && named.actorName, 'Bob',
        `while the author is still on the team the row must name them, got ${JSON.stringify(named && named.actorName)}`);
    });

    // An invite has ONE identity across its life. The revoke route accepts a
    // whole invite URL as well as a bare token, and it used to file whatever
    // the caller pasted as the audit row's objectKey — so revoking by link
    // recorded `https://…/#kbmYFKG06w` against a creation row that recorded
    // `kbmYFKG06w`. Both rows are true and neither is connectable to the
    // other, which is the coherence failure this ticket is looking for: an
    // admin auditing a leak sees an invite created and, separately, some
    // unrelated-looking string revoked.
    await check('an invite is recorded under one identity whether revoked by token or by link', async () => {
      const fresh = await apiAs('owner', 'POST', '/api/team/invite', { teamId: team.team_id });
      assert.strictEqual(fresh.status, 200, `fixture: mint must succeed, got ${fresh.status}`);
      const pastedLink = `https://app.membridge.app/#${fresh.body.token}`;
      const rev = await apiAs('owner', 'POST', '/api/team/revoke-invite', { token: pastedLink });
      assert.strictEqual(rev.status, 200, `fixture: revoke-by-link must succeed, got ${rev.status}`);
      const rows = ((await apiAs('owner', 'GET', `/api/team/audit?teamId=${team.team_id}`)).body || {}).events || [];
      const created = rows.find(e => e.action === 'invite-created' && e.objectLabel === fresh.body.token);
      const revoked = rows.find(e => e.action === 'invite-revoked' && e.objectLabel === fresh.body.token);
      assert.ok(created, 'the creation row must record the bare token');
      assert.ok(revoked,
        'the revocation must be filed against the same token the creation was, not against the ' +
        `URL the admin happened to paste. rows: ${JSON.stringify(rows.filter(e => e.objectType === 'invite'))}`);
    });

    // COUNTER-CHECK, green before and after any rendering change: the trail
    // must still contain the events themselves. A "fix" that dropped rows it
    // could not render would satisfy every check above.
    await check('the story still contains every event it should', async () => {
      const actions = new Set(events.map(e => e.action));
      for (const expected of ['member-joined', 'member-left', 'member-removed',
        'invite-created', 'invite-revoked', 'role-changed', 'team-renamed', 'own-data-deleted']) {
        assert.ok(actions.has(expected),
          `the trail lost ${expected}; present: ${JSON.stringify([...actions].sort())}`);
      }
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
