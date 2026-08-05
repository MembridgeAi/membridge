'use strict';
// The durable archive's dedupe key holds a RAW ts string, and it stays that way.
//
// WHY THIS SUITE EXISTS. lib/feed.js and lib/server.js both shipped a real
// defect from comparing a raw ts string against its own synced-back twin: a
// local ts is a JS toISOString() Z-form string pushed verbatim into a
// timestamptz column, and PostgREST renders its reads through Postgres's own
// to_json, which does not return the string that went up. Verified against
// Postgres 17 (Supabase runs 17.6.1):
//
//   input:   '2026-08-05T12:00:00.550Z'::timestamptz
//   to_json: "2026-08-05T12:00:00.55+00:00"
//
// lib/team-archive.js rowKey is (author, ts, source) on the raw string, so it
// looks like the same bug. It is not, and the audit that established that is
// worth keeping executable rather than re-derived. The archive is append-only
// NDJSON deduped at PARSE time with no repair path, so if it ever doubled it
// would stay doubled, which is why the answer here had to be a measurement,
// not a reading.
//
// THE INVARIANT. Every ts this key ever compares comes out of ONE renderer:
// appendRows' only production callers are lib/teamsync.js pullProject and
// backfillArchivePage, and both feed it mapPulledRow's output, whose ts is a
// PostgREST read of memory_entries.ts. So the key never meets a local spelling
// at all. The way to break it is a THIRD writer fed by anything local, and
// these checks are what would catch that.
//
// NOT the reason, and checked so nobody re-derives it wrongly: the
// author_id=neq.<self> filter on both pull queries. That is what protects the
// feed's twin dedupe; here a self row would fold correctly anyway, and a
// TEAMMATE row in the local spelling would double the archive. The last check
// pins that fragility on purpose, so the invariant above reads as load-bearing
// rather than decorative.
//
// Run directly, or via `node test/run.js team-archive-instant`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const teamArchive = require('../../lib/team-archive');
const { createMockSupabase, pgTimestamptz } = require('../mock-supabase');

const MOCK_PORT = P(71);
const TEAMMATE_ID = '11111111-2222-3333-4444-555555555555';
// A fraction with a TRAILING ZERO, so the local spelling and the round-tripped
// one genuinely differ. Any other value makes every check below vacuous.
const LOCAL_TS = '2026-08-05T12:00:01.550Z';
const BACKEND_TS = '2026-08-05T12:00:01.55+00:00';

const physicalLines = projectId => {
  try {
    return fs.readFileSync(teamArchive.archivePath(projectId), 'utf8').split('\n').filter(l => l.trim()).length;
  } catch {
    return 0;
  }
};

async function linkedProject(name, teamId) {
  const key = path.join(ROOT, 'projects', name);
  fs.mkdirSync(key, { recursive: true });
  const st = util.loadState();
  st.projects = { ...(st.projects || {}), [key]: { events: [] } };
  util.saveState(st);
  return { key, link: await teamsync.linkProject(util.getConfig(), key, teamId, 'InstantCo') };
}

async function main() {
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(MOCK_PORT, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

  try {
    util.ensureConfig();
    // encrypt:false is the documented hatch that keeps the mock round trip off
    // the real macOS keychain, as the other team suites do.
    const cfg = util.loadUserConfig();
    cfg.team = { ...(cfg.team || {}), encrypt: false };
    util.saveUserConfig(cfg);

    await teamsync.signup(util.getConfig(), 'instant-me@test.dev', 'pw-i', 'Me');
    const team = await teamsync.createTeam(util.getConfig(), 'InstantCo');
    const creds = await teamsync.getAccessToken(util.getConfig());

    check('fixture: the mock renders a timestamptz the way Postgres actually does', () => {
      // Without this the suite cannot observe the defect class at all, and
      // every check below would pass against a format that does not exist.
      assert.strictEqual(pgTimestamptz(LOCAL_TS), BACKEND_TS);
      assert.notStrictEqual(LOCAL_TS, BACKEND_TS, 'the two spellings must differ or nothing here proves anything');
    });

    // ---- the real round trip ----
    {
      const { key, link } = await linkedProject('instant-app', team.team_id);
      // MY OWN row, already on the backend the way a real push leaves it...
      mock.entries.push({
        id: 1, created_at: '2026-08-05T12:00:00.550Z', project_id: link.projectId,
        author_id: creds.userId, author_name: 'Me', ts: '2026-08-05T12:00:00.550Z',
        source: 'Claude Code', session: 'mine', ask: null,
        summary: 'my own work coming back', files: [], distilled: false,
      });
      // ...and a teammate's.
      mock.entries.push({
        id: 2, created_at: LOCAL_TS, project_id: link.projectId,
        author_id: TEAMMATE_ID, author_name: 'Marco', ts: LOCAL_TS,
        source: 'Codex', session: 'theirs', ask: null,
        summary: 'teammate work', files: [], distilled: false,
      });

      // Three passes. Each one runs the FORWARD pull and the BACKWARD backfill
      // walker, and the walker re-fetches rows the forward pull already
      // archived, so a key that could not fold two spellings of one instant
      // would grow the file on every tick, not just once.
      await teamsync.syncTeams({ project: key });
      await teamsync.syncTeams({ project: key });
      await teamsync.syncTeams({ project: key });

      check('every ts the archive holds is the BACKEND spelling, never a local one', () => {
        const rows = teamArchive.loadArchive(link.projectId).rows;
        assert.ok(rows.length > 0, 'nothing was archived at all: the round trip did not run');
        const local = rows.filter(r => /Z$/.test(String(r.ts)));
        assert.deepStrictEqual(local, [],
          'a local Z-form ts reached the archive: appendRows has gained a writer that did not come ' +
          'back through PostgREST, and this key cannot fold it against the round-tripped spelling');
        assert.ok(rows.some(r => r.ts === BACKEND_TS),
          `expected the round-tripped spelling ${BACKEND_TS} on disk, got ${rows.map(r => r.ts).join(', ')}`);
      });

      check('repeated syncs do not grow the archive: one logical row, one line', () => {
        const rows = teamArchive.loadArchive(link.projectId).rows;
        assert.strictEqual(rows.length, 1,
          `the archive holds ${rows.length} rows for 1 teammate row: two spellings of one instant were stored twice`);
        assert.strictEqual(physicalLines(link.projectId), 1,
          `the .ndjson holds ${physicalLines(link.projectId)} lines for 1 distinct row`);
      });

      check('a self row never enters the archive at all (both pull queries exclude it)', () => {
        // True, and deliberately NOT the reason the key is safe. See the
        // header and the last check. Pinned because it is what makes the
        // archive a teammate store rather than a second copy of your own work.
        const mine = teamArchive.loadArchive(link.projectId).rows.filter(r => r.authorId === creds.userId);
        assert.deepStrictEqual(mine, [], 'the viewer\'s own row was archived as if it were a teammate\'s');
      });
    }

    // ---- the inverse guard: what the invariant is actually protecting ----
    {
      const { key, link } = await linkedProject('instant-fragile-app', team.team_id);
      mock.entries.push({
        id: 3, created_at: LOCAL_TS, project_id: link.projectId,
        author_id: TEAMMATE_ID, author_name: 'Marco', ts: LOCAL_TS,
        source: 'Codex', session: 'theirs', ask: null,
        summary: 'teammate work', files: [], distilled: false,
      });
      // Stand in for the change this is all guarding against: a writer that
      // hands appendRows the SAME logical row in the local spelling.
      teamArchive.appendRows(link.projectId, [{
        author: 'Marco', authorId: TEAMMATE_ID, ts: LOCAL_TS, source: 'Codex',
        session: 'theirs', summary: 'teammate work', files: [],
      }], { source: 'forward' });
      await teamsync.syncTeams({ project: key });

      check('the key IS string-fragile, so single-renderer is load-bearing, not decorative', () => {
        // This asserts the CURRENT behaviour of a state production cannot
        // reach, and it is here for one reason: if this ever folded on its own,
        // the checks above would keep passing for a reason nobody chose, and
        // the comment on rowKey would be defending something that no longer
        // needs defending. A doubled archive has no repair path, so the cost of
        // finding this out late is permanent.
        const rows = teamArchive.loadArchive(link.projectId).rows;
        assert.strictEqual(rows.length, 2,
          'two spellings of one instant folded together: rowKey is no longer a raw string compare, ' +
          'so update the comment on rowKey in lib/team-archive.js rather than deleting this check');
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
