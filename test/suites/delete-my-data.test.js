'use strict';
// Self-serve deletion of your OWN synced entries: migration 035's two RPCs,
// the two daemon routes in front of them, and -- the reason this file exists
// -- the deletion watermark that stops the next sync pass putting everything
// back.
//
// THE REGRESSION THIS GUARDS. A server-side delete removes rows from
// memory_entries and touches nothing on this disk: local .membridge/memory.json
// still holds every entry that was just erased. pushProject's second loop
// ("heal stale backend copies") re-sends any already-pushed entry whose
// recorded signature does not match, and an entry with NO recorded signature
// re-sends once by design. A deletion clears teamPushSig, so without a
// watermark every deleted entry looks exactly like a stale backend copy in
// need of healing, and merge-duplicates puts it straight back with a bumped
// created_at -- resurfacing it at the top of every teammate's feed. The
// deletion would appear to work and silently undo itself on the next tick.
// `the drift pass never re-uploads deleted entries` below is that guard, and
// it is the check to look at first if this file ever goes red.
//
// A new suite rather than a run-tests.js section: it needs its own backend
// fixture (an owner and a plain member, one shared project, a real push) and
// the legacy monolith is one sequential story whose sections share state on
// purpose.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, jsonl, waitForHttp, post } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const { syncOnce } = require('../../lib/scan');
const { startServer } = require('../../lib/server');
const { createMockSupabase, pgTimestamptz } = require('../mock-supabase');

const HOME_OWNER = path.join(ROOT, 'home-del-owner');
const HOME_MEMBER = path.join(ROOT, 'home-del-member');
const homeFor = { owner: HOME_OWNER, member: HOME_MEMBER };
const portFor = { owner: P(64), member: P(65) };

// One project per identity, each with its own machine-local memory. The
// member's is the one that gets deleted and then pushed again.
const PROJ_OWNER = path.join(ROOT, 'projects', 'del-owner-app');
const PROJ_MEMBER = path.join(ROOT, 'projects', 'del-member-app');
// Linked to the same team, holding real local history, and NEVER synced. The
// deletion removes nothing of its, so nothing about it may be watermarked --
// see markTeamDataDeleted. This is the project the old scalar-return code
// silently and permanently muted.
const PROJ_MEMBER_UNSYNCED = path.join(ROOT, 'projects', 'del-member-unsynced');

// Fixed, in the past, so `first_ts`/`last_ts` are assertable and every entry
// sits below the deletion watermark (which is wall-clock now).
const T = n => `2026-06-0${n}T10:00:00.000Z`;

function seedSessions(slug, projectPath, asks) {
  const dir = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(projectPath, '.membridge'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess.jsonl'), jsonl(asks.map(([text, ts]) => (
    { type: 'user', message: { role: 'user', content: text }, cwd: projectPath, timestamp: ts }
  ))));
}

async function main() {
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(P(63), '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(63)}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  // Plaintext push: this suite is about which ROWS exist on the backend, not
  // about the crypto layer, and an encrypted push would hold every batch when
  // no keychain is available in CI.
  const plaintext = home => {
    process.env.MEMBRIDGE_HOME = home;
    util.ensureConfig();
    const cfg = util.loadUserConfig();
    cfg.team = { ...(cfg.team || {}), encrypt: false };
    util.saveUserConfig(cfg);
  };

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

  const mineOnBackend = userId => mock.entries.filter(e => e.author_id === userId);

  try {
    fs.mkdirSync(HOME_OWNER, { recursive: true });
    fs.mkdirSync(HOME_MEMBER, { recursive: true });

    // ---- owner: team + their own shared project ----
    plaintext(HOME_OWNER);
    const ownerCreds = await teamsync.signup(util.getConfig(), 'del-owner@test.dev', 'pw-o', 'Owner');
    const team = await teamsync.createTeam(util.getConfig(), 'DeleteCo');
    seedSessions('slug-del-owner', PROJ_OWNER, [['Owner wires the billing page', T(1)]]);
    syncOnce();
    await teamsync.linkProject(util.getConfig(), PROJ_OWNER, team.team_id, 'DeleteCo');
    await teamsync.syncTeams({ project: PROJ_OWNER });
    const ownerRowCount = mineOnBackend(ownerCreds.userId).length;

    // ---- member: joins, links their own project, pushes ----
    plaintext(HOME_MEMBER);
    const memberCreds = await teamsync.signup(util.getConfig(), 'del-member@test.dev', 'pw-m', 'Member');
    await teamsync.joinTeam(util.getConfig(), team.invite_code);
    seedSessions('slug-del-member', PROJ_MEMBER, [
      ['Member adds the export button', T(2)],
      ['Member fixes the export filename', T(3)],
    ]);
    syncOnce();
    await teamsync.linkProject(util.getConfig(), PROJ_MEMBER, team.team_id, 'DeleteCo');
    await teamsync.syncTeams({ project: PROJ_MEMBER });

    const pushedByMember = mineOnBackend(memberCreds.userId).length;
    // The newest entry ts this machine actually pushed. Captured BEFORE the
    // deletion moves the cursor, because the instant-vs-string watermark check
    // below needs a watermark sitting exactly on an entry, which is the only
    // place the two comparisons disagree.
    const lastPushedTs = util.loadState().projects[PROJ_MEMBER].teamPushTs;
    await check('fixture: the plain member actually pushed entries to the backend', () => {
      assert.ok(pushedByMember > 0, 'the member pushed nothing, so nothing below proves anything');
      assert.ok(ownerRowCount > 0, 'the owner pushed nothing, so the "teammate rows survive" check is vacuous');
    });

    // ---- member: a SECOND project, linked to the same team, never synced ----
    // Linked and left alone deliberately: no syncTeams for it, so it has local
    // history, a team link, and no push cursor at all.
    seedSessions('slug-del-member-unsynced', PROJ_MEMBER_UNSYNCED, [
      ['Member drafts the offline importer', T(4)],
    ]);
    syncOnce();
    await teamsync.linkProject(util.getConfig(), PROJ_MEMBER_UNSYNCED, team.team_id, 'DeleteCo');
    await check('fixture: the second project is linked, has local history, and has never pushed', () => {
      const proj = util.loadState().projects[PROJ_MEMBER_UNSYNCED];
      assert.ok(proj, `${PROJ_MEMBER_UNSYNCED} is not in state`);
      assert.ok(!proj.teamPushTs, 'fixture: it has already pushed, so it cannot prove anything below');
      const local = JSON.parse(fs.readFileSync(path.join(PROJ_MEMBER_UNSYNCED, '.membridge', 'memory.json'), 'utf8'));
      assert.ok((local.entries || []).length > 0, 'fixture: it holds no local entries to be stranded');
    });

    // -----------------------------------------------------------------------
    // Preview
    // -----------------------------------------------------------------------
    await check('GET /api/team/my-data counts the member\'s own backend rows, per project', async () => {
      const res = await apiAs('member', 'GET', `/api/team/my-data?teamId=${team.team_id}`);
      assert.strictEqual(res.status, 200, `status ${res.status}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.total, pushedByMember,
        `total ${res.body.total} disagrees with the ${pushedByMember} rows the member has on the backend`);
      assert.strictEqual(res.body.projects.length, 1,
        `expected one project, got ${JSON.stringify(res.body.projects)}`);
      const p = res.body.projects[0];
      assert.strictEqual(p.entries, pushedByMember);
      assert.ok(p.firstTs && p.lastTs, 'the date range the confirmation prints is missing');
      assert.ok(p.firstTs <= p.lastTs, `first_ts ${p.firstTs} is after last_ts ${p.lastTs}`);
    });

    // The preview must describe the caller, not the machine or the team. An
    // owner asking the same question about the same team gets their OWN rows.
    await check('the preview is scoped to the caller, never to the team', async () => {
      const res = await apiAs('owner', 'GET', `/api/team/my-data?teamId=${team.team_id}`);
      assert.strictEqual(res.body.total, ownerRowCount,
        `the owner was shown ${res.body.total} entries but authored ${ownerRowCount}`);
    });

    await check('the preview names a local folder for a project this machine has', async () => {
      const res = await apiAs('member', 'GET', `/api/team/my-data?teamId=${team.team_id}`);
      assert.ok(res.body.projects[0].path, 'no local path resolved, so the CLI could not print a folder');
      assert.strictEqual(path.resolve(res.body.projects[0].path), path.resolve(PROJ_MEMBER));
    });

    // -----------------------------------------------------------------------
    // The confirmation gate
    // -----------------------------------------------------------------------
    await check('POST /api/team/delete-my-data refuses without confirm: DELETE, and deletes nothing', async () => {
      const before = mineOnBackend(memberCreds.userId).length;
      const res = await apiAs('member', 'POST', '/api/team/delete-my-data', { teamId: team.team_id });
      assert.strictEqual(res.status, 400, `status ${res.status}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(mineOnBackend(memberCreds.userId).length, before,
        'rows were deleted by a request that was rejected');
    });

    await check('a near-miss confirmation is still a refusal', async () => {
      const before = mineOnBackend(memberCreds.userId).length;
      const res = await apiAs('member', 'POST', '/api/team/delete-my-data',
        { teamId: team.team_id, confirm: 'delete' });
      assert.strictEqual(res.status, 400, `lowercase "delete" was accepted: ${JSON.stringify(res.body)}`);
      assert.strictEqual(mineOnBackend(memberCreds.userId).length, before);
    });

    // -----------------------------------------------------------------------
    // The deletion
    // -----------------------------------------------------------------------
    let deleteRes;
    await check('a PLAIN MEMBER can delete their own synced entries', async () => {
      deleteRes = await apiAs('member', 'POST', '/api/team/delete-my-data',
        { teamId: team.team_id, confirm: 'DELETE' });
      assert.strictEqual(deleteRes.status, 200, `status ${deleteRes.status}: ${JSON.stringify(deleteRes.body)}`);
      assert.strictEqual(deleteRes.body.deleted, pushedByMember,
        `reported ${deleteRes.body.deleted} deleted, expected ${pushedByMember}`);
      assert.strictEqual(mineOnBackend(memberCreds.userId).length, 0,
        'the member still has rows on the backend after a confirmed deletion');
    });

    await check('a teammate\'s rows are untouched: this deletes an AUTHOR\'s data, not a project\'s', () => {
      assert.strictEqual(mineOnBackend(ownerCreds.userId).length, ownerRowCount,
        'the owner lost rows to somebody else\'s deletion');
    });

    // 035's header calls this out as the tempting, catastrophic tidy-up:
    // memory_entries cascades on projects, so deleting a now-empty project row
    // would take every OTHER member's entries in it with it.
    await check('no project row is dropped to tidy an emptied namespace', () => {
      const stillThere = mock.projects.some(p => p.teamId === team.team_id);
      assert.ok(stillThere, 'a project row disappeared -- projects cascades into memory_entries');
    });

    await check('the deletion is recorded in the team audit trail, by the RPC itself', () => {
      const row = mock.teamAudit.find(r => r.action === 'own-data-deleted');
      assert.ok(row, 'nothing was logged: owners and admins would never see this happened');
      assert.strictEqual(row.actor_id, memberCreds.userId);
      assert.strictEqual(row.object_type, 'member');
      // detail.memberId is what lib/api-access.js readAudit resolves into a
      // NAME; without it the trail shows a bare uuid and answers nobody.
      assert.strictEqual(row.detail.memberId, memberCreds.userId,
        'detail.memberId missing, so the trail would render a raw uuid');
      assert.strictEqual(row.detail.deleted, pushedByMember);
    });

    await check('the audit row is readable by the team owner', async () => {
      const res = await apiAs('owner', 'GET', '/api/team/audit');
      const row = (res.body.events || []).find(e => e.action === 'own-data-deleted');
      assert.ok(row, `owner cannot see the deletion: ${JSON.stringify(res.body)}`);
      assert.strictEqual(row.targetName, 'Member',
        `the trail shows "${row.targetName}" rather than the member's name`);
    });

    // -----------------------------------------------------------------------
    // THE RESURRECTION GUARD -- the check this whole file is for.
    // -----------------------------------------------------------------------
    await check('the deletion sets a per-project watermark on this machine', () => {
      process.env.MEMBRIDGE_HOME = HOME_MEMBER;
      const proj = util.loadState().projects[PROJ_MEMBER];
      assert.ok(proj, `${PROJ_MEMBER} is not in state`);
      assert.ok(proj.teamDeletedThroughTs, 'no watermark: the next sync would re-upload everything');
      assert.strictEqual(proj.teamPushTs, proj.teamDeletedThroughTs,
        'the push cursor was not moved with the watermark');
      assert.ok(!proj.teamPushSig, 'the signature map survived, describing rows that no longer exist');
    });

    // THE OTHER HALF OF THE WATERMARK, and the one that had no test. The RPC
    // reports what it removed PER PROJECT (035 §3), so a project it emptied
    // nothing in is left exactly as it was. While it returned a bare total the
    // caller could not tell, and marked every linked project of the team:
    // deletedThrough = now on a project that had never pushed a row, which
    // means every entry it holds is below the watermark, which means it can
    // never push its history again. Silent, and there is no way back.
    await check('a linked project the deletion never touched keeps its cursor', () => {
      process.env.MEMBRIDGE_HOME = HOME_MEMBER;
      const proj = util.loadState().projects[PROJ_MEMBER_UNSYNCED];
      assert.ok(!proj.teamDeletedThroughTs,
        `${PROJ_MEMBER_UNSYNCED} was watermarked (${proj.teamDeletedThroughTs}) by a deletion that removed nothing of its`);
      assert.ok(!proj.teamPushTs, 'its push cursor was moved by somebody else\'s deletion');
    });

    // THE WATERMARK IS AN INSTANT, NOT A STRING.
    //
    // Every value the watermark is compared against is produced locally today
    // (a JS toISOString Z-form), so a lexicographic compare happens to agree
    // with an instant compare. That is a coincidence of who writes the value,
    // not a property of the data, and it inverts the moment a
    // backend-rendered timestamptz reaches the field: '...T10:00:00+00:00'
    // sorts BELOW '...T10:00:00.000Z' -- the SAME instant -- because '+' is
    // below '.' and below every digit in ASCII. Under a string compare the
    // entry then reads as ABOVE the watermark and the drift pass re-uploads
    // it. Same defect class as the feed's self-twin dedupe
    // (test/suites/feed-twin-dedupe.test.js).
    //
    // THE WATERMARK MUST SIT ON THE SAME INSTANT AS AN ENTRY for this to bite,
    // and that is the realistic value, not a contrived one: the watermark is
    // max(now, teamPushTs), and teamPushTs IS the newest pushed entry's ts, so
    // any machine whose clock is not ahead of its own session files lands
    // exactly here. An earlier cut of this check used the wall-clock watermark
    // (August) against June entries, where the month decides the comparison
    // before the spelling ever matters -- it passed with the string compare
    // restored, which is to say it tested nothing.
    await check('the watermark suppresses on the INSTANT, whatever spelling it is written in', async () => {
      process.env.MEMBRIDGE_HOME = HOME_MEMBER;
      const state = util.loadState();
      const proj = state.projects[PROJ_MEMBER];
      const restore = proj.teamDeletedThroughTs;
      const pgForm = pgTimestamptz(lastPushedTs);
      assert.notStrictEqual(pgForm, lastPushedTs, 'fixture: the two spellings must differ, or this proves nothing');
      assert.ok(pgForm < lastPushedTs,
        'fixture: the backend spelling must sort BELOW the Z-form of the same instant');
      proj.teamDeletedThroughTs = pgForm;
      delete proj.teamPushSig;
      util.saveState(state);
      try {
        await teamsync.syncTeams({ project: PROJ_MEMBER });
        assert.strictEqual(mineOnBackend(memberCreds.userId).length, 0,
          'a watermark in the backend\'s own timestamp spelling suppressed nothing -- deleted rows came back');
      } finally {
        // Put the real watermark back so the later checks see the state the
        // actual deletion produced.
        const s2 = util.loadState();
        s2.projects[PROJ_MEMBER].teamDeletedThroughTs = restore;
        util.saveState(s2);
      }
    });

    // THE WATERMARK DOES NOT LEAN ON THE PUSH CURSOR. markTeamDataDeleted moves
    // teamPushTs to the same instant, so in the state a deletion leaves behind
    // `e.ts > cursor` alone already excludes every deleted entry and the
    // watermark clause in the fresh-entry loop looks redundant. It is not:
    // teamPushTs is a MOVING cursor that any later push rewrites, while
    // teamDeletedThroughTs is a fact that never moves backwards. Clearing the
    // cursor is the isolating case -- it routes every entry into the fresh
    // loop, where the watermark clause is then the only thing standing between
    // a deletion and a full re-upload. Without this check that clause is
    // untested and a future edit deletes it as dead code.
    await check('the fresh-entry loop refuses deleted entries even with no push cursor at all', async () => {
      process.env.MEMBRIDGE_HOME = HOME_MEMBER;
      const state = util.loadState();
      const proj = state.projects[PROJ_MEMBER];
      const restore = proj.teamPushTs;
      delete proj.teamPushTs;
      delete proj.teamPushSig;
      util.saveState(state);
      try {
        await teamsync.syncTeams({ project: PROJ_MEMBER });
        assert.strictEqual(mineOnBackend(memberCreds.userId).length, 0,
          'with the cursor gone the fresh loop re-uploaded every deleted entry: the watermark clause is not doing its job');
      } finally {
        const s2 = util.loadState();
        s2.projects[PROJ_MEMBER].teamPushTs = restore;
        util.saveState(s2);
      }
    });

    await check('local memory is untouched: this deletes the BACKEND copy only', () => {
      process.env.MEMBRIDGE_HOME = HOME_MEMBER;
      const local = JSON.parse(fs.readFileSync(path.join(PROJ_MEMBER, '.membridge', 'memory.json'), 'utf8'));
      assert.ok((local.entries || []).length > 0,
        'the machine-local memory log was wiped, which no part of this feature is allowed to do');
    });

    await check('a plain sync pass after the deletion uploads nothing', async () => {
      process.env.MEMBRIDGE_HOME = HOME_MEMBER;
      await teamsync.syncTeams({ project: PROJ_MEMBER });
      assert.strictEqual(mineOnBackend(memberCreds.userId).length, 0,
        'the ordinary push loop re-uploaded deleted entries');
    });

    await check('the drift pass never re-uploads deleted entries', async () => {
      process.env.MEMBRIDGE_HOME = HOME_MEMBER;
      // Force the exact condition that resurrects rows. The drift loop
      // re-sends every already-pushed entry whose recorded signature does not
      // match what it would send now, and treats a MISSING signature as
      // "stale backend copy, heal it". Clearing the map by hand reproduces
      // that for every entry at once -- and it is not a contrived state: it is
      // precisely what markTeamDataDeleted leaves behind, and also what any
      // client predating the signature map has. Only the watermark stands
      // between this and a full re-upload.
      const state = util.loadState();
      delete state.projects[PROJ_MEMBER].teamPushSig;
      util.saveState(state);
      const insertsBefore = mock.stats.inserts;

      await teamsync.syncTeams({ project: PROJ_MEMBER });

      assert.strictEqual(mineOnBackend(memberCreds.userId).length, 0,
        'DELETED ENTRIES CAME BACK: the drift re-push healed rows the user had erased');
      assert.strictEqual(mock.stats.inserts, insertsBefore,
        `the drift pass inserted ${mock.stats.inserts - insertsBefore} row(s) after a deletion`);
    });

    // The consequence of the check above, at the level a user would feel it:
    // the untouched project can still push the history it has been holding all
    // along. Run after the two "nothing came back" checks, which are scoped to
    // PROJ_MEMBER, so this is the first push of anything since the deletion.
    await check('a project the deletion never touched can still push its history', async () => {
      process.env.MEMBRIDGE_HOME = HOME_MEMBER;
      await teamsync.syncTeams({ project: PROJ_MEMBER_UNSYNCED });
      assert.ok(mineOnBackend(memberCreds.userId).length > 0,
        'a project that had nothing deleted was muted forever by somebody else\'s deletion');
    });

    await check('work done AFTER the deletion still syncs: the watermark is not a mute switch', async () => {
      process.env.MEMBRIDGE_HOME = HOME_MEMBER;
      const dir = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-del-member');
      fs.appendFileSync(path.join(dir, 'sess.jsonl'), jsonl([
        { type: 'user', message: { role: 'user', content: 'Member starts fresh after deleting' }, cwd: PROJ_MEMBER, timestamp: new Date(Date.now() + 1000).toISOString() },
      ]));
      syncOnce();
      await teamsync.syncTeams({ project: PROJ_MEMBER });
      assert.ok(mineOnBackend(memberCreds.userId).length > 0,
        'nothing new ever pushes again: the watermark permanently disabled this project');
    });

    // -----------------------------------------------------------------------
    // Ungated by role, which is the whole point of not putting this in
    // lib/api-access.js.
    // -----------------------------------------------------------------------
    await check('the routes stay open to a member who was just demoted from admin', async () => {
      process.env.MEMBRIDGE_HOME = HOME_OWNER;
      await teamsync.setRole(util.getConfig(), team.team_id, memberCreds.userId, 'admin');
      await teamsync.setRole(util.getConfig(), team.team_id, memberCreds.userId, 'member');
      const res = await apiAs('member', 'GET', `/api/team/my-data?teamId=${team.team_id}`);
      assert.strictEqual(res.status, 200, `a demoted member was refused: ${JSON.stringify(res.body)}`);
    });

    // The one case a membership-gated predicate would break, and the reason
    // 035 §1 scopes the DELETE policy on author_id ALONE. Someone who has left
    // the team is exactly who most wants their data gone.
    await check('someone who has LEFT the team can still delete what they pushed', async () => {
      process.env.MEMBRIDGE_HOME = HOME_MEMBER;
      const leftBehind = mineOnBackend(memberCreds.userId).length;
      assert.ok(leftBehind > 0, 'fixture: the member has nothing on the backend to leave behind');
      await teamsync.leaveTeam(util.getConfig(), team.team_id);
      const res = await apiAs('member', 'POST', '/api/team/delete-my-data',
        { teamId: team.team_id, confirm: 'DELETE' });
      assert.strictEqual(res.status, 200, `an ex-member was refused: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.deleted, leftBehind);
      assert.strictEqual(mineOnBackend(memberCreds.userId).length, 0,
        'an ex-member is stranded with their data on the backend forever');
      assert.strictEqual(mineOnBackend(ownerCreds.userId).length, ownerRowCount,
        'the owner lost rows to the ex-member\'s deletion');
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
