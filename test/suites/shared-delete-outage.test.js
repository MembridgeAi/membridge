'use strict';
// Deleting a SHARED project while the backend is unreachable must not unlink
// your machine, and must not blame your permissions.
//
// The bug. lib/server.js archiveSharedProject decided the branch with
//
//     const teams = await teamsync.listTeams(config).catch(() => []);
//     const team = (teams || []).find(t => t.team_id === link.teamId);
//     const isManager = !!team && ['owner', 'admin'].includes(team.role);
//     if (!isManager) { const unlinked = teamsync.unlinkProject(key); ... }
//
// so a dead network or an expired refresh token produced isManager === false,
// took the PLAIN-MEMBER branch — which deletes .membridge/team.json and prunes
// the durable teammate archive — and told the owner it was a PERMISSIONS
// problem. Fail-open plus a confident wrong explanation: the user goes to check
// their role while the actual cause is their connection, and for an adopted
// shared project team.json is a file committed to the repo, so it also shows up
// as a deleted tracked file in their working tree.
//
// The window is not a race. canEditAccess reads a cached settings.team.role and
// useSettings has NO poll (staleTime 15_000 and nothing else,
// ui/src/data/queries.ts), so a mounted Projects grid keeps offering a live
// Delete button for as long as the user stays on that screen — and this project
// has documented multi-day "JWT expired" states.
//
// THE RULE these checks pin: "you are not a manager" and "we could not
// determine whether you are a manager" are different answers, and only the
// first may take a destructive local action.
//
// Run directly, or via `node test/run.js shared-delete-outage`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, waitForHttp, post } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const memorydb = require('../../lib/memorydb');
const teamsync = require('../../lib/teamsync');
const teamArchive = require('../../lib/team-archive');
const { startServer } = require('../../lib/server');
const { createMockSupabase } = require('../mock-supabase');

const MOCK_PORT = P(63);
const DASH_PORT = P(64);
// Nothing listens here. backend() re-reads MEMBRIDGE_TEAM_URL on every call, so
// pointing at this port is an outage that lasts exactly as long as we want.
const DEAD_PORT = P(65);
const LIVE_URL = `http://127.0.0.1:${MOCK_PORT}`;
const DEAD_URL = `http://127.0.0.1:${DEAD_PORT}`;

async function deleteProjectOverRoute(projectKey) {
  const srv = startServer(DASH_PORT, { retries: 0 });
  try {
    await waitForHttp(`http://127.0.0.1:${DASH_PORT}/api/status`);
    const res = await post(`http://127.0.0.1:${DASH_PORT}/api/team/archive-project`, { path: projectKey });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise(r => srv.close(r));
  }
}

// An owner's linked project, tracked in state, with a durable teammate archive
// on disk — so a wrongful unlink is visible in three places at once.
async function makeSharedProject(name, teamId, teamName) {
  const key = path.join(ROOT, 'projects', name);
  fs.mkdirSync(key, { recursive: true });
  const st = util.loadState();
  st.projects = { ...(st.projects || {}), [key]: { events: [] } };
  util.saveState(st);
  const link = await teamsync.linkProject(util.getConfig(), key, teamId, teamName);
  teamArchive.appendRows(link.projectId, [{
    author: 'Andrew', ts: '2026-08-04T09:00:00.000Z', source: 'Claude Code',
    session: 'theirs', summary: 'archive row that must survive an outage', files: [],
  }]);
  return { key, link };
}

const teamJsonExists = key => fs.existsSync(path.join(key, memorydb.DIR_NAME, 'team.json'));
const archiveExists = projectId => fs.existsSync(teamArchive.archivePath(projectId));

async function main() {
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(MOCK_PORT, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = LIVE_URL;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

  try {
    util.ensureConfig();
    // encrypt:false is the documented escape hatch that keeps the mock round
    // trip off the real macOS keychain, as the other team suites do.
    const cfg = util.loadUserConfig();
    cfg.team = { ...(cfg.team || {}), encrypt: false };
    util.saveUserConfig(cfg);

    await teamsync.signup(util.getConfig(), 'outage-owner@test.dev', 'pw-o', 'Owner');
    const team = await teamsync.createTeam(util.getConfig(), 'OutageCo');

    // ---- 1. the outage case: refuse, change nothing, blame the right thing ----
    {
      const { key, link } = await makeSharedProject('outage-app', team.team_id, 'OutageCo');
      assert.ok(teamJsonExists(key), 'fixture: team.json should exist before the delete');
      assert.ok(archiveExists(link.projectId), 'fixture: the durable archive should exist before the delete');

      process.env.MEMBRIDGE_TEAM_URL = DEAD_URL; // backend goes away mid-session
      const { status, body } = await deleteProjectOverRoute(key);
      process.env.MEMBRIDGE_TEAM_URL = LIVE_URL;

      check('outage: the delete is refused rather than silently downgraded', () => {
        assert.strictEqual(status, 200, 'the route changed status code, which the UI reads as a transport error');
        assert.strictEqual(body.archived, false, 'the project must not be reported as archived for the team');
        assert.notStrictEqual(body.deleted, true, 'an unreachable backend must never report a completed delete');
      });

      check('outage: nothing local is destroyed — team.json survives', () => {
        assert.notStrictEqual(body.unlinked, true,
          'the response claims the machine was unlinked during an outage');
        assert.ok(teamJsonExists(key),
          'team.json was deleted because the ROLE CHECK failed — for an adopted project this is a committed file');
      });

      check('outage: the durable teammate archive survives', () => {
        assert.ok(archiveExists(link.projectId),
          'the durable teammate archive was pruned on a network failure');
      });

      check('outage: the project itself is still tracked', () => {
        assert.ok(util.loadState().projects[key], 'the project fell out of local state during an outage');
      });

      check('outage: the reason given is the connection, NOT the user’s permissions', () => {
        assert.ok(body.message, 'a refusal with no message tells the user nothing');
        assert.ok(!/owners? or (managers?|admins?)|permission|role/i.test(body.message) ||
          /could not|couldn’t|couldn't|unreachable|reach|connection|sign in/i.test(body.message),
          `the refusal reads as a permissions problem: ${body.message}`);
        assert.ok(/could not|couldn’t|couldn't|reach|connection|sign in|expired/i.test(body.message),
          `the refusal does not point at the real cause: ${body.message}`);
      });

      // The same distinction, asked of the code rather than the copy: the two
      // outcomes must not collapse into one string again.
      check('outage: its message differs from the genuine not-a-manager refusal', () => {
        assert.notStrictEqual(body.message,
          'only owners or managers can delete a shared project for the team',
          'an outage still reports the permissions message');
      });

      // ...and the distinction has to be readable by the CODE drawing the
      // dialog, not only by the person reading it. Prose is the wrong channel:
      // matching on the sentence makes a copy edit a behaviour change, so the
      // envelope carries a discriminator. `refusal` is the contract;
      // `retryable` is derived from it in one place (lib/server.js
      // RETRYABLE_REFUSALS) so a client can gate a "Try again" affordance
      // without hard-coding the value list — and so a future fourth
      // determinate refusal is correctly non-retryable for a client that has
      // never heard of it.
      check('outage: the refusal is machine-readable as indeterminate and retryable', () => {
        assert.strictEqual(body.refusal, 'role-unknown',
          `an outage carries no indeterminate discriminator: ${JSON.stringify(body)}`);
        assert.strictEqual(body.retryable, true,
          'the one refusal that is entirely retryable is not marked retryable');
      });
    }

    // ---- 2. positive control: with the backend up, the owner delete works ----
    // Without this a fix that simply refused every shared delete would pass.
    {
      const { key, link } = await makeSharedProject('healthy-app', team.team_id, 'OutageCo');
      const { body } = await deleteProjectOverRoute(key);
      check('control: an owner’s delete still archives for the team and cleans up locally', () => {
        assert.strictEqual(body.scope, 'team', `expected a team-scoped delete, got ${JSON.stringify(body)}`);
        assert.strictEqual(body.archived, true, 'the owner path stopped archiving');
        assert.ok(mock.projects.find(p => p.id === link.projectId).archivedAt,
          'the backend project was not archived');
        assert.ok(!teamJsonExists(key), 'team.json survived a real delete');
        assert.ok(!util.loadState().projects[key], 'the project survived a real delete in local state');
      });
      // The discriminator means "this delete did not happen". A success body
      // that carried it would make it a second, weaker answer to a question
      // `archived`/`deleted` already answer positively.
      check('control: a SUCCESS body carries no refusal discriminator at all', () => {
        assert.strictEqual(body.refusal, undefined, `a completed delete reported a refusal: ${JSON.stringify(body)}`);
        assert.strictEqual(body.retryable, undefined, 'a completed delete reported a retryable flag');
      });
    }

    // ---- 3. the retry after the outage clears succeeds ----
    // The refusal has to be recoverable: the whole point of not unlinking is
    // that the user can try again once their connection is back.
    {
      const { key, link } = await makeSharedProject('retry-app', team.team_id, 'OutageCo');
      process.env.MEMBRIDGE_TEAM_URL = DEAD_URL;
      const first = await deleteProjectOverRoute(key);
      process.env.MEMBRIDGE_TEAM_URL = LIVE_URL;
      const second = await deleteProjectOverRoute(key);
      check('recovery: the same delete succeeds once the backend is reachable again', () => {
        assert.strictEqual(first.body.archived, false, 'precondition: the first attempt was refused');
        assert.strictEqual(second.body.archived, true,
          `the retry did not archive: ${JSON.stringify(second.body)}`);
        assert.ok(mock.projects.find(p => p.id === link.projectId).archivedAt,
          'the retry did not reach the backend');
      });
    }

    // ---- 4. a signed-out machine is told to sign in, and still loses nothing ----
    // listTeams throws "not logged in" rather than failing a fetch, which is a
    // different classifyAuthFailure reason and a different instruction to the
    // user — but the same refusal to touch local data.
    {
      const { key, link } = await makeSharedProject('signedout-app', team.team_id, 'OutageCo');
      // Back up the credentials FILE rather than round-tripping through
      // loginWithTokens: the stored record carries more than that call takes.
      const credsFile = teamsync.credentialsPath();
      const saved = fs.readFileSync(credsFile, 'utf8');
      teamsync.clearCredentials();
      const { body } = await deleteProjectOverRoute(key);
      fs.writeFileSync(credsFile, saved); // restore for the blocks after this one

      check('signed out: refused, nothing destroyed, and the message says to sign in', () => {
        assert.strictEqual(body.archived, false, 'a signed-out machine reported a completed archive');
        assert.notStrictEqual(body.unlinked, true, 'a signed-out machine unlinked itself');
        assert.ok(teamJsonExists(key), 'team.json was deleted because the account was signed out');
        assert.ok(archiveExists(link.projectId), 'the durable archive was pruned for a signed-out account');
        assert.ok(/sign in|signed in|log in|logged in/i.test(body.message || ''),
          `the message does not tell the user to sign in: ${body.message}`);
      });

      // A dead session is a DIFFERENT instruction to the user and the SAME
      // machine-readable answer: the role is unknown, and signing back in makes
      // the identical delete work.
      check('signed out: also machine-readable as indeterminate and retryable', () => {
        assert.strictEqual(body.refusal, 'role-unknown',
          `a signed-out refusal carries no indeterminate discriminator: ${JSON.stringify(body)}`);
        assert.strictEqual(body.retryable, true, 'a signed-out refusal is not marked retryable');
      });
    }

    // ---- 5. the genuine plain-member refusal is UNCHANGED ----
    // The determinate case must keep behaving exactly as it did: a real member
    // of the team who is not a manager unlinks their own machine and is told
    // why. Breaking this would trade one wrong answer for another.
    {
      const HOME_MEMBER = path.join(ROOT, 'home-outage-member');
      fs.mkdirSync(HOME_MEMBER, { recursive: true });
      const invite = await teamsync.createInvite(util.getConfig(), team.team_id, { expiresAt: null, maxUses: null });
      const HOME_OWNER = process.env.MEMBRIDGE_HOME;

      process.env.MEMBRIDGE_HOME = HOME_MEMBER;
      util.ensureConfig();
      const mcfg = util.loadUserConfig();
      mcfg.team = { ...(mcfg.team || {}), encrypt: false };
      util.saveUserConfig(mcfg);
      await teamsync.signup(util.getConfig(), 'outage-member@test.dev', 'pw-m', 'Member');
      await teamsync.join(util.getConfig(), invite.token);
      const { key } = await makeSharedProject('member-app', team.team_id, 'OutageCo');
      const { body } = await deleteProjectOverRoute(key);
      process.env.MEMBRIDGE_HOME = HOME_OWNER;

      check('member: a real non-manager still unlinks locally and is told why', () => {
        assert.strictEqual(body.scope, 'local', `expected a local-scoped refusal, got ${JSON.stringify(body)}`);
        assert.strictEqual(body.archived, false, 'a plain member archived for the whole team');
        assert.strictEqual(body.unlinked, true, 'the member path stopped unlinking this machine');
        assert.ok(!teamJsonExists(key), 'the member path left team.json behind');
        assert.ok(/only owners or managers/i.test(body.message || ''),
          `the determinate refusal lost its explanation: ${body.message}`);
      });

      check('member: the determinate refusal is machine-readable and NOT retryable', () => {
        assert.strictEqual(body.refusal, 'not-manager',
          `the genuine permissions refusal carries no discriminator: ${JSON.stringify(body)}`);
        assert.strictEqual(body.retryable, false,
          'a definitive "you are not a manager" invites the user to retry forever');
      });
    }

    // ---- 6. linked to a team you are not in at all ----
    // The THIRD refusal, and the reason it is not folded into 'not-manager':
    // the two send the user to two different places, which is why they already
    // have two different sentences. team.json is hand-written here because
    // linkProject refuses a team you are not a member of — which is exactly the
    // state a stale committed team.json leaves a fresh clone in.
    {
      const key = path.join(ROOT, 'projects', 'foreign-app');
      fs.mkdirSync(path.join(key, memorydb.DIR_NAME), { recursive: true });
      const st = util.loadState();
      st.projects = { ...(st.projects || {}), [key]: { events: [] } };
      util.saveState(st);
      fs.writeFileSync(path.join(key, memorydb.DIR_NAME, 'team.json'), JSON.stringify({
        projectId: 'foreign-project-id', teamId: 'team-nobody-here', teamName: 'SomeoneElseCo',
      }, null, 2));

      const { body } = await deleteProjectOverRoute(key);
      check('foreign team: unlinked locally, not retryable, and told apart from not-a-manager', () => {
        assert.strictEqual(body.archived, false, 'a foreign team’s project was archived for that team');
        assert.strictEqual(body.unlinked, true, 'the foreign-team path stopped unlinking this machine');
        assert.strictEqual(body.refusal, 'not-a-member',
          `the foreign-team refusal is not distinguishable from a role refusal: ${JSON.stringify(body)}`);
        assert.strictEqual(body.retryable, false, 'a foreign-team refusal invites a pointless retry');
        assert.ok(!/only owners or managers/i.test(body.message || ''),
          'the foreign-team case still argues about permissions in a team the user cannot see');
      });
    }
    // ---- 7. the two branches BEFORE any of the above ----
    //
    // Sections 1-6 all enter archiveSharedProject with a tracked, linked
    // project and argue about what happens after listTeams. The two guards
    // that decide whether execution ever GETS there had no coverage at all:
    //
    //   lib/server.js:1734  if (!key) return { error: 'unknown project' };
    //   lib/server.js:1736  if (!link || !link.projectId) { ...local delete... }
    //
    // Both were found by GUARD-DELETION mutation (`node test/mutate.js
    // --target lib/server.js --mode guard`), and both survived the full suite
    // including the monolith. Operator mutation is structurally blind to them
    // — an `if (!x) return y;` has no operator to flip — which is why a clean
    // operator-mode sample over this same region said nothing about them.
    {
      const untracked = path.join(ROOT, 'projects', 'never-tracked-app');
      fs.mkdirSync(untracked, { recursive: true });
      const stBefore = util.loadState();
      const trackedBefore = Object.keys(stBefore.projects || {});

      const { status, body } = await deleteProjectOverRoute(untracked);
      check('unknown project: refused as unknown, with a 404 and nothing touched', () => {
        assert.strictEqual(body && body.error, 'unknown project',
          `an untracked path was not refused: ${JSON.stringify(body)}`);
        assert.strictEqual(status, 404, `an unknown project must 404, got ${status}`);
        const after = Object.keys(util.loadState().projects || {});
        assert.deepStrictEqual(after.sort(), trackedBefore.sort(),
          'a delete for an UNTRACKED path changed the set of tracked projects');
        // The discriminating assertion, and the reason this guard is not
        // merely redundant with deleteProject's identical one. Delete it and
        // execution falls through to `{ ...deleteProject(null), scope: 'local' }`
        // — deleteProject refuses the same way, so the error and the 404 are
        // unchanged, but the refusal now carries `scope: 'local'`. That is a
        // response claiming a local deletion happened when nothing was
        // deleted: this repo's signature defect, a field asserting a success
        // the code never achieved. A refusal states no scope.
        assert.ok(!('scope' in body),
          `an "unknown project" refusal claimed a deletion scope, so it reads as though something was deleted: ${JSON.stringify(body)}`);
      });
    }

    {
      // Tracked, but never linked to a team: the local-only path. This is the
      // ordinary "delete a personal project" case, and deleting its guard sends
      // it into the team machinery instead — listTeams, role checks, refusal
      // payloads — for a project that has no team at all.
      const local = path.join(ROOT, 'projects', 'purely-local-app');
      fs.mkdirSync(path.join(local, memorydb.DIR_NAME), { recursive: true });
      const st = util.loadState();
      st.projects = { ...(st.projects || {}), [local]: { events: [] } };
      util.saveState(st);
      assert.ok(!fs.existsSync(path.join(local, memorydb.DIR_NAME, 'team.json')),
        'fixture: this project must have NO team link, or it tests the wrong branch');

      const { status, body } = await deleteProjectOverRoute(local);
      check('unlinked project: deleted locally, scoped local, and never treated as shared', () => {
        assert.strictEqual(status, 200, `a local delete must succeed, got ${status}: ${JSON.stringify(body)}`);
        assert.strictEqual(body.scope, 'local',
          `an unlinked project was not scoped local: ${JSON.stringify(body)}`);
        // A project with no team cannot produce a TEAM refusal. If the guard is
        // gone, this is where the fall-through shows: the code reaches the
        // role logic and answers with a permissions verdict about a team that
        // does not exist.
        assert.strictEqual(body.refusal, undefined,
          `a project with no team link came back with a team refusal: ${JSON.stringify(body)}`);
        assert.ok(!('archived' in body) || body.archived === false,
          `an unlinked project reported a TEAM archive: ${JSON.stringify(body)}`);
        assert.ok(!util.loadState().projects[local], 'the local project was not actually deleted');
      });
    }
  } finally {
    h.noEgress.resetTeamEnv(); // NOT `delete`: an absent env var falls through to the BAKED production backend
    await new Promise(r => mock.server.close(r));
  }

  h.finish();
}

main();
