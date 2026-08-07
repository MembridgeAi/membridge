'use strict';
// A member revoked from their ONLY shared project must be detected.
//
// THE HOLE. lib/teamsync.js visibleProjectIds returned null — "inconclusive,
// skip the gate" — for an EMPTY project_stats result, so syncTeams matched
// neither the revoke branch nor the restore branch and fell through to a
// normal pass. For a member with one shared project, an empty result is
// exactly what revocation looks like, so that member's revocation was never
// detected at all. Not "detected then forgotten" (that is
// revocation-state-reset.test.js next door) — never detected, permanently.
//
// WHY IT IS NOW MEASURABLE RATHER THAN A GUESS. Half the ambiguity never
// existed: rest() throws on every non-2xx, so a missing view, a dead session
// and a network fault land in a catch and were never candidates for []. A
// 200 [] already means "the query ran and matched nothing"; the only open
// question was why. project_stats is filtered by archived_at AND
// can_see_project; the base `projects` table is filtered by is_team_member and
// nothing else. The two differ by exactly the predicate under test, so the
// empty case resolves by measurement:
//
//   base has a LIVE project -> member of a team with a project we cannot see
//                              -> REVOKED (empty set: "you may see nothing")
//   base empty / all archived / errored -> inconclusive -> null, as before
//
// The checks below are deliberately a matched set. The revocation check is the
// one that was failing; everything around it exists so the fix cannot be
// "treat empty as revoked", which would trade a silent leak for silent data
// destruction. Each counter-check drives the SAME empty project_stats result
// down a branch that must still refuse to destroy anything.
//
// Run directly, or via `node test/run.js revocation-empty-visibility`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const { createMockSupabase } = require('../mock-supabase');

const MOCK_PORT = P(69);
const REPO_ROOT = path.join(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// THE PIN for the assumption this whole fix rests on.
//
// It is checked against the repo's SQL rather than the live catalog on
// purpose, and that is a strength here rather than a compromise. The failure
// being guarded against is not "production drifted" — it is "someone tightens
// projects_select", and that person's change arrives as SQL in this repo,
// where this check sees it and CI runs it on every push. A live-catalog probe
// would need network and credentials, would be skipped in CI, and a check that
// silently cannot run is the same class of bug as the one being fixed.
// (The live catalog WAS verified by hand when this landed: projects_select is
// `is_team_member(team_id)`, access-unfiltered, matching the SQL below.)
//
// Vacuity is the real risk for a scanner, so finding NO select policy on
// public.projects is a failure, not a pass.
function projectsSelectPolicies() {
  const files = [path.join(REPO_ROOT, 'supabase', 'schema.sql')];
  const migDir = path.join(REPO_ROOT, 'supabase', 'migrations');
  for (const f of fs.readdirSync(migDir).filter(n => n.endsWith('.sql')).sort()) {
    files.push(path.join(migDir, f));
  }
  const found = [];
  for (const file of files) {
    const sql = fs.readFileSync(file, 'utf8')
      .split('\n').filter(l => !/^\s*--/.test(l)).join('\n'); // strip comment lines
    const rx = /create\s+policy\s+(\w+)\s+on\s+public\.projects\b([\s\S]*?);/gi;
    let m;
    while ((m = rx.exec(sql))) {
      if (!/for\s+select/i.test(m[2])) continue;
      found.push({ file: path.relative(REPO_ROOT, file), name: m[1], body: m[2] });
    }
  }
  return found;
}

function localEvents(token, session) {
  return [
    { ts: '2026-08-04T10:00:00.000Z', source: 'Claude Code', kind: 'prompt', session, text: `wire up the ${token} path` },
    {
      ts: '2026-08-04T10:05:00.000Z', source: 'Distilled', kind: 'summary', session,
      text: `The ${token} path is wired.`, headline: `${token} is wired`,
      goal: '', decisions: '', gotchas: '', highlights: [],
    },
  ];
}

async function makeLinkedProject(name, teamId, teamName, token) {
  const key = path.join(ROOT, 'projects', name);
  fs.mkdirSync(key, { recursive: true });
  const st = util.loadState();
  st.projects = { ...(st.projects || {}), [key]: { events: localEvents(token, `sess-${name}`) } };
  util.saveState(st);
  const link = await teamsync.linkProject(util.getConfig(), key, teamId, teamName);
  return { key, link };
}

const projRecord = key => (util.loadState().projects || {})[key];

// Revoke this member from a project the way a manager does: an explicit
// project_access row with can_see = false, which is tier 1 of can_see_project.
function revoke(mock, projectId, memberId) {
  const row = mock.projectAccess.find(r => r.project_key === projectId && r.member_id === memberId);
  if (row) { row.can_see = false; return; }
  const p = mock.projects.find(x => x.id === projectId);
  mock.projectAccess.push({
    team_id: p.teamId, project_key: projectId, member_id: memberId,
    can_see: false, updated_at: new Date().toISOString(), updated_by: null,
  });
}

async function main() {
  // ---- 0. the pin: projects_select must stay membership-scoped ----
  check('PIN: projects_select is membership-scoped, not access-scoped', () => {
    const policies = projectsSelectPolicies();
    assert.ok(policies.length,
      'no SELECT policy on public.projects found in supabase/schema.sql or supabase/migrations/ — '
      + 'this scanner has gone blind, which is worse than a failure it can see. Fix the scan, do not delete it.');
    const last = policies[policies.length - 1];
    assert.ok(/is_team_member/i.test(last.body),
      `the last SELECT policy on public.projects (${last.name}, ${last.file}) no longer checks is_team_member`);
    assert.ok(!/can_see_project|project_access/i.test(last.body),
      `${last.name} in ${last.file} now filters public.projects by project access.\n`
      + 'lib/teamsync.js visibleProjectIds corroborates an empty project_stats against this table PRECISELY because '
      + 'it is not access-filtered. Once both queries apply can_see_project they return the same empty answer, every '
      + 'empty result becomes permanently inconclusive, and revocation from a member\'s only shared project silently '
      + 'stops being detected — with nothing else going red. Land the explicit per-project visibility RPC first '
      + '(see the note above this policy in supabase/schema.sql).');
  });

  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(MOCK_PORT, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

  try {
    util.ensureConfig();
    // The documented escape hatch every other team suite uses: keeps the mock
    // round trip off the real macOS keychain.
    const cfg = util.loadUserConfig();
    cfg.team = { ...(cfg.team || {}), encrypt: false };
    util.saveUserConfig(cfg);

    await teamsync.signup(util.getConfig(), 'solo@test.dev', 'pw-s', 'Solo');
    const me = mock.users.get('solo@test.dev').id; // users is a Map keyed by email

    // ---- 1. the ticket: one shared project, revoked ----
    {
      const team = await teamsync.createTeam(util.getConfig(), 'SoloCo');
      const only = await makeLinkedProject('solo-only', team.team_id, 'SoloCo', 'solobeacon');

      // Counter-check FIRST, on the same fixture: a healthy member of a team
      // with one visible project is untouched. This is the check that fails if
      // the fix is "empty means revoked" applied too eagerly, and it passes
      // both before and after the fix.
      await teamsync.syncTeams({});
      check('healthy: a visible project is never flagged', () => {
        assert.ok(!projRecord(only.key).teamAccessLost,
          'a project the backend still lists was marked revoked');
      });

      revoke(mock, only.link.projectId, me);
      const res = await teamsync.syncTeams({});

      check('revoked from the ONLY shared project: the revocation is detected', () => {
        assert.ok(projRecord(only.key).teamAccessLost,
          'a member revoked from their only shared project was not detected — project_stats returned [], and the '
          + 'empty result was read as "I could not ask" rather than corroborated against the base projects table');
        assert.deepStrictEqual(util.teamRowsFor(projRecord(only.key)), [],
          'the cached teammate rows survived a confirmed revocation');
        assert.deepStrictEqual(res.errors, [],
          `the revocation was reported as an error rather than a revocation: ${JSON.stringify(res.errors)}`);
      });
    }

    // ---- 2. counter-check: all projects archived stays inconclusive ----
    // Same empty project_stats, different reason. Archiving is not revoking,
    // and the base table says so.
    {
      const team = await teamsync.createTeam(util.getConfig(), 'ArchivedCo');
      const proj = await makeLinkedProject('archived-only', team.team_id, 'ArchivedCo', 'archbeacon');
      for (const p of mock.projects) if (p.teamId === team.team_id) p.archivedAt = new Date().toISOString();

      await teamsync.syncTeams({});
      check('counter: an archived-only team stays inconclusive, nothing is flagged', () => {
        assert.ok(!projRecord(proj.key).teamAccessLost,
          'archiving a project was mistaken for revoking access to it');
      });
    }

    // ---- 3. counter-check: a corroboration that cannot answer refuses ----
    // The branch that decides whether this fix is safe. The probe says empty,
    // the corroboration faults, and the only acceptable outcome is that
    // nothing is destroyed.
    {
      const team = await teamsync.createTeam(util.getConfig(), 'FaultCo');
      const proj = await makeLinkedProject('fault-only', team.team_id, 'FaultCo', 'faultbeacon');
      revoke(mock, proj.link.projectId, me);
      mock.flags.failProjectsList = true;
      try {
        await teamsync.syncTeams({});
      } finally {
        mock.flags.failProjectsList = false;
      }
      check('counter: a faulting corroboration must not authorize a revocation', () => {
        assert.ok(!projRecord(proj.key).teamAccessLost,
          'a backend fault on the corroborating read was treated as proof of revocation — this is the branch that '
          + 'turns a silent leak into silent data destruction, and it must fail safe');
      });
    }

    // ---- 4. the unit-level contract of the empty answer ----
    // Stated directly, because the three cases above reach it through
    // syncTeams and the distinction between "empty set" and "null" is the
    // whole interface: an empty SET means "you may see nothing" and authorizes
    // the caller to act; null means "I could not ask" and does not.
    {
      const creds = await teamsync.getAccessToken(util.getConfig());
      const team = await teamsync.createTeam(util.getConfig(), 'UnitCo');
      const proj = await makeLinkedProject('unit-only', team.team_id, 'UnitCo', 'unitbeacon');

      await check('contract: a visible project yields a set containing it', async () => {
        const visible = await teamsync.visibleProjectIds(util.getConfig(), creds, team.team_id);
        assert.ok(visible instanceof Set && visible.has(String(proj.link.projectId)));
      });

      revoke(mock, proj.link.projectId, me);
      await check('contract: revoked-from-everything yields an EMPTY SET, not null', async () => {
        const visible = await teamsync.visibleProjectIds(util.getConfig(), creds, team.team_id);
        assert.ok(visible instanceof Set,
          'an authoritative "you may see nothing" came back as null, which the caller reads as "skip the gate"');
        assert.strictEqual(visible.size, 0);
      });

      await check('contract: an unknown team yields null, not an empty set', async () => {
        const visible = await teamsync.visibleProjectIds(
          util.getConfig(), creds, '00000000-0000-4000-8000-000000000000');
        assert.strictEqual(visible, null,
          'a team this member is not on produced an authoritative-looking empty set — absence of membership is not '
          + 'evidence of revocation');
      });
    }
  } finally {
    mock.server.close();
  }

  h.finish();
}

main();
