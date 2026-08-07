'use strict';
// project_stats carries "archived" and "you may not see this" as TWO facts,
// not as one absence — and the team hub keeps showing exactly what it showed.
//
// THE CONFLATION. The view's WHERE is `archived_at is null and
// can_see_project(p.id)`, so a project drops out of a member's result for
// either reason and the client cannot tell which. Two unrelated callers read
// that same absence: the team hub (which wants archived projects hidden) and
// the revocation path (lib/teamsync.js visibleProjectIds, which treats absence
// as "you may not see this" and drops cached rows, prunes the durable archive
// and stops MCP search answering). One signal, two meanings, and the security
// caller is the one that pays: a member genuinely revoked from a team whose
// projects are archived cannot be distinguished from one whose projects are
// merely archived, so that revocation is never detected.
//
// 041_project_stats_carry_archived.sql moves `archived_at` out of the WHERE
// and into the SELECT. Presence then means exactly "you may see this"; the
// archived bit rides as a column.
//
// WHAT THIS SUITE PINS is the ordering that makes that migration safe to
// apply: the hub's exclusion of archived projects must live in the JS, so it
// holds against BOTH backends. Ship the tolerant client first, migrate second,
// and applying 041 changes nothing a user sees. The mock serves both shapes
// (flags.projectStatsCarriesArchived) because "correct against the backend we
// have" and "correct against the backend we are about to have" are two claims
// and this change needs both.
//
// Run directly, or via `node test/run.js project-stats-archived`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createMockSupabase } = require('../mock-supabase');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const server = require('../../lib/server');

async function main() {
  util.ensureConfig();
  const cfg = util.loadUserConfig();
  cfg.team = { ...(cfg.team || {}), encrypt: false };
  util.saveUserConfig(cfg);

  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(P(80), '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(80)}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

  try {
    const livePath = path.join(ROOT, 'projects', 'hub-live');
    const archivedPath = path.join(ROOT, 'projects', 'hub-archived');
    for (const p of [livePath, archivedPath]) fs.mkdirSync(p, { recursive: true });

    await teamsync.signup(util.getConfig(), 'hub@test.dev', 'pw-hub', 'Me');
    const team = await teamsync.createTeam(util.getConfig(), 'HubTeam');
    await teamsync.linkProject(util.getConfig(), livePath, team.team_id, 'HubTeam');
    await teamsync.linkProject(util.getConfig(), archivedPath, team.team_id, 'HubTeam');
    const liveId = teamsync.loadTeamLink(livePath).projectId;
    const archivedId = teamsync.loadTeamLink(archivedPath).projectId;

    // Archived on the backend, exactly as `membridge team archive` leaves it.
    const archivedRow = mock.projects.find(p => p.id === archivedId);
    archivedRow.archivedAt = '2026-08-01T00:00:00.000Z';

    const hubIds = async () => (await server.teamProjectsPayload(team.team_id)).map(r => r.project_id);
    const rawIds = async () => (await teamsync.projectStats(util.getConfig(), team.team_id))
      .map(r => r.project_id);

    // --- 1. today's backend (pre-041): the view hides archived, hub agrees ---
    {
      const hub = await hubIds();
      check('hub: an archived project is not listed (pre-041 backend)', () => {
        assert.deepStrictEqual(hub, [liveId], `hub listed ${hub.length} projects, expected only the live one`);
      });
    }

    // --- 2. migrated backend (041 applied): the hub is UNCHANGED ---
    // The view now returns the archived project. Nothing a user sees may move
    // because of that, which is the whole reason this filter ships first.
    {
      mock.flags.projectStatsCarriesArchived = true;
      const raw = await rawIds();
      const hub = await hubIds();
      check('wire: the migrated view returns the archived project — the bit is carried, not swallowed', () => {
        assert.ok(raw.includes(archivedId),
          'the post-041 view still dropped the archived project — the fixture is not modelling the migration');
        assert.ok(raw.includes(liveId), 'the live project vanished');
      });
      check('hub: applying 041 does not change what the hub lists', () => {
        assert.deepStrictEqual(hub, [liveId],
          `an archived project reached the hub after the migration (${hub.length} listed) — ` +
          'the exclusion is still relying on the view, so 041 is a user-visible change');
      });
    }

    // --- 3. the point of the migration: absence now means ONE thing ---
    // Revoke access to the archived project. On a pre-041 backend it was
    // already absent (archived), so revocation was invisible. Post-041 the two
    // are distinguishable: visible-and-archived is a row with archived_at set;
    // revoked is no row at all.
    {
      mock.flags.projectStatsCarriesArchived = true;
      const withAccess = await teamsync.projectStats(util.getConfig(), team.team_id);
      const archivedBefore = withAccess.find(r => r.project_id === archivedId);

      const me = teamsync.loadCredentials().userId;
      const grant = mock.projectAccess.find(r => r.project_key === archivedId && r.member_id === me);
      grant.can_see = false;
      const afterRevoke = (await teamsync.projectStats(util.getConfig(), team.team_id))
        .map(r => r.project_id);

      check('wire: archived-and-visible is a ROW carrying archived_at, not an absence', () => {
        assert.ok(archivedBefore, 'the archived project was absent while access was intact');
        assert.strictEqual(archivedBefore.archived_at, '2026-08-01T00:00:00.000Z',
          'archived_at did not ride along as a column, so the two facts are still collapsed');
      });

      check('wire: revoking the SAME archived project removes the row — the two are now distinguishable', () => {
        assert.ok(!afterRevoke.includes(archivedId),
          'a revoked project still appeared — presence no longer means "you may see this"');
        assert.ok(afterRevoke.includes(liveId), 'revoking one project hid an unrelated one');
      });

      // Restore, so the checks below read a clean fixture.
      grant.can_see = true;
      mock.flags.projectStatsCarriesArchived = false;
    }

    // --- 4. counter-check: a pre-041 backend sends NO archived_at at all ---
    // Absent is not null. A filter written as `'archived_at' in row` rather
    // than a truthiness test would hide every project on today's backend, and
    // the hub would go blank — a worse bug than the one being fixed.
    {
      const raw = await teamsync.projectStats(util.getConfig(), team.team_id);
      const hub = await hubIds();
      check('compat: a pre-041 row carries no archived_at, and the hub still lists the live project', () => {
        assert.ok(raw.length >= 1, 'the pre-041 view returned nothing');
        for (const r of raw) {
          assert.ok(!('archived_at' in r),
            'the pre-041 fixture is leaking a column the real view does not have');
        }
        assert.deepStrictEqual(hub, [liveId], 'the hub lost the live project against a pre-041 backend');
      });
    }
  } finally {
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    await new Promise(r => mock.server.close(r));
  }

  h.finish();
}

main();
