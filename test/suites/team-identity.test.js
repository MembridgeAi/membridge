'use strict';
// Author identity on team rows: the stable `author_id` must survive the whole
// way from memory_entries to a person filter, and nothing on that path may key
// on the display name instead.
//
// Why this suite exists. memory_entries.author_name is a snapshot stamped
// client-side at push time and it is NOT stable per account: in production one
// account (author_id e6469edf-...) holds 114 rows as 'andrewludwigbrown' and
// 100 as 'Andrew Brown', over OVERLAPPING date ranges — two installs of one
// account configured with different display names, pushing concurrently. So
// anything that filters, groups or dedupes on the name silently splits one
// human in two. author_id is the only stable key.
//
// The bug this pins: author_id was dropped at four points (the pull's select
// list, mapPulledRow, activity.mapTeamRow, and normalizeLocal's meta for the
// viewer's own rows), while three layers downstream were already written
// expecting it. Every row therefore surfaced with authorId null, so a uuid
// person filter matched nothing and a negated one (`!<uuid>` — what the app's
// "Hide mine" sends) excluded nothing.
//
// Run directly, or via `node test/run.js team-identity`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createMockSupabase } = require('../mock-supabase');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const activity = require('../../lib/activity');
const feed = require('../../lib/feed');

const TEAMMATE_ID = '11111111-2222-3333-4444-555555555555';

async function main() {
  // encrypt:false is the explicit escape hatch that keeps the mock-Supabase
  // round trip off the real macOS keychain, exactly as redaction.test.js does.
  util.ensureConfig();
  const cfg = util.loadUserConfig();
  cfg.team = { ...(cfg.team || {}), encrypt: false };
  util.saveUserConfig(cfg);

  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(P(3), '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(3)}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

  try {
    const proj = path.join(ROOT, 'projects', 'identity-app');
    fs.mkdirSync(proj, { recursive: true });
    await teamsync.signup(util.getConfig(), 'identity@test.dev', 'pw-id', 'Me');
    const team = await teamsync.createTeam(util.getConfig(), 'IdentityTeam');
    await teamsync.linkProject(util.getConfig(), proj, team.team_id, 'IdentityTeam');
    const creds = await teamsync.getAccessToken(util.getConfig());
    const link = teamsync.loadTeamLink(proj);
    const selfId = teamsync.loadCredentials().userId;

    let nextId = 5000;
    const plant = over => {
      const row = {
        project_id: link.projectId,
        author_id: TEAMMATE_ID,
        author_name: 'andrewludwigbrown',
        ts: '2026-07-01T10:00:00.000Z',
        source: 'Claude Code',
        session: 'their-session',
        ask: null,
        summary: 'v1 line',
        distilled: false,
        files: [],
        changes: null,
        goal: null,
        decisions: null,
        gotchas: null,
        headline: null,
        id: nextId++,
        created_at: new Date(Date.now() + nextId).toISOString(),
        ...over,
      };
      mock.entries.push(row);
      return row;
    };

    // --- 1. the pull carries author_id onto the stored row ---
    // `author_id` appeared in pullProject's WHERE (`author_id=neq.<self>`) long
    // before it appeared in the select list, and a predicate is not a
    // projection: r.author_id was undefined inside mapPulledRow.
    {
      plant({});
      const p = { teamEntries: [], teamPullTs: undefined };
      await teamsync.pullProject(util.getConfig(), creds, p, link, null);
      check('pull: a stored team row carries the author uuid, not just the name', () => {
        assert.strictEqual(p.teamEntries.length, 1, 'row was not pulled');
        assert.strictEqual(p.teamEntries[0].authorId, TEAMMATE_ID,
          'authorId missing from the stored row — the id was dropped on the way in');
        assert.strictEqual(p.teamEntries[0].author, 'andrewludwigbrown',
          'the display name must still be stored alongside it');
      });
    }

    // --- 2. a re-push under a CHANGED display name replaces, never duplicates ---
    // The pull's dedupe key used to be author|ts|source. A drift re-push from
    // an install configured with a different display name missed that key
    // entirely and appended a SECOND copy of the same work. The id-preferring
    // key agrees with the backend, whose on_conflict key is
    // (project_id, author_id, ts, source).
    {
      const p = { teamEntries: [], teamPullTs: undefined };
      const row = plant({ ts: '2026-07-02T10:00:00.000Z', session: 'drift-session' });
      await teamsync.pullProject(util.getConfig(), creds, p, link, null);
      const before = p.teamEntries.filter(e => e.session === 'drift-session').length;
      // Same author_id, same ts/source. Only the configured name changed.
      const idx = mock.entries.findIndex(e => e.id === row.id);
      mock.entries[idx] = {
        ...mock.entries[idx],
        author_name: 'Andrew Brown',
        summary: 'v2 the fuller brief',
        created_at: new Date(Date.now() + 90000).toISOString(),
      };
      await teamsync.pullProject(util.getConfig(), creds, p, link, null);
      check('pull: a re-push under a changed display name replaces the stored copy', () => {
        assert.strictEqual(before, 1, 'precondition: v1 stored exactly once');
        const got = p.teamEntries.filter(e => e.session === 'drift-session');
        assert.strictEqual(got.length, 1,
          `one account under two names stored as ${got.length} rows — the key still splits on the name`);
        assert.strictEqual(got[0].summary, 'v2 the fuller brief', 'the stale copy survived');
        assert.strictEqual(got[0].author, 'Andrew Brown', 'the newer name did not land');
      });
    }

    // --- 3. migration: an id-less stored row is found by name and gains the id ---
    // Every row already on disk predates authorId, so stored rows are
    // registered under both keys and looked up id-first, name-second. Without
    // the name fallback these would duplicate instead of healing.
    {
      const row = plant({ ts: '2026-07-03T10:00:00.000Z', session: 'legacy-session' });
      const p = {
        // Exactly what an old install has on disk: no authorId at all.
        teamEntries: [{
          author: 'andrewludwigbrown',
          ts: '2026-07-03T10:00:00.000Z',
          source: 'Claude Code',
          session: 'legacy-session',
          ask: null,
          summary: 'stale local copy',
          files: [],
        }],
        teamPullTs: undefined,
      };
      await teamsync.pullProject(util.getConfig(), creds, p, link, null);
      check('pull: an id-less stored row is replaced in place and gains its author uuid', () => {
        const got = p.teamEntries.filter(e => e.session === 'legacy-session');
        assert.strictEqual(got.length, 1,
          `the id-less stored row duplicated instead of healing (${got.length} copies)`);
        assert.strictEqual(got[0].authorId, TEAMMATE_ID, 'the replacement did not carry the id');
        assert.strictEqual(got[0].summary, 'v1 line', 'the stale copy survived the pull');
        assert.ok(row, 'planted row unused');
      });
    }

    // --- 4. mapTeamRow forwards the id (the offline read path) ---
    // This layer omitted author_id on the reasoning that it was "only known at
    // live-fetch time". True of the backend row id; never true of this.
    {
      check('activity: mapTeamRow forwards the stored author uuid to the normalizer', () => {
        const out = activity.mapTeamRow(
          { author: 'Andrew Brown', authorId: TEAMMATE_ID, ts: '2026-07-01T10:00:00.000Z', source: 'Codex', files: [] },
          'identity-app', t => t, link.projectId);
        assert.strictEqual(out.authorId, TEAMMATE_ID, 'authorId dropped between the cache and the entry');
        assert.strictEqual(out.self, false, 'a pulled team row is never the viewer’s own');
      });
      check('feed: normalizeTeam reads author_id, which is the field that was never written', () => {
        assert.strictEqual(feed.normalizeTeam({ author_id: TEAMMATE_ID, files: [] }, {}).authorId, TEAMMATE_ID);
        assert.strictEqual(feed.normalizeTeam({ files: [] }, {}).authorId, null);
      });
    }

    // --- 5. end to end through search: both filters, on one corpus ---
    // The measured symptom on Marco's machine: no filter -> 27 results, filter
    // by a teammate's uuid -> 0, `!<own uuid>` -> 27 with nothing hidden.
    {
      const st = util.loadState();
      st.projects[proj] = {
        events: [
          { ts: '2026-07-05T10:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'mine', text: 'wire up the hookbeacon path' },
          {
            ts: '2026-07-05T10:05:00.000Z', source: 'Distilled', kind: 'summary', session: 'mine',
            text: 'The hookbeacon path now fires on session boundaries.',
            headline: 'hookbeacon fires on boundaries', goal: '', decisions: '', gotchas: '', highlights: [],
          },
        ],
        teamEntries: [{
          author: 'Andrew Brown',
          authorId: TEAMMATE_ID,
          ts: '2026-07-04T09:00:00.000Z',
          source: 'Codex',
          session: 'theirs',
          ask: 'trace the hookbeacon registration',
          summary: 'Found the hookbeacon owner check.',
          files: [],
        }],
      };
      util.saveState(st);

      const ids = res => res.results.map(r => r.authorId);
      const all = activity.searchMemory({ query: 'hookbeacon', limit: 25 });
      const byTeammate = activity.searchMemory({ query: 'hookbeacon', limit: 25, author: TEAMMATE_ID });
      const hideMine = activity.searchMemory({ query: 'hookbeacon', limit: 25, author: `!${selfId}` });
      const onlyMine = activity.searchMemory({ query: 'hookbeacon', limit: 25, author: selfId });

      check('search: the unfiltered corpus holds both the viewer’s row and the teammate’s', () => {
        assert.strictEqual(all.results.length, 2, `expected 2 results, got ${all.results.length}`);
        assert.ok(ids(all).includes(TEAMMATE_ID), 'the teammate row surfaced without an author id');
        assert.ok(ids(all).includes(selfId), 'the viewer’s own row surfaced without an author id');
      });

      check('search: filtering by a teammate uuid returns their row, not zero', () => {
        assert.strictEqual(byTeammate.results.length, 1,
          `a teammate uuid matched ${byTeammate.results.length} rows (the reported symptom was 0)`);
        assert.strictEqual(byTeammate.results[0].authorId, TEAMMATE_ID);
      });

      check('search: "Hide mine" (!<own uuid>) hides the viewer’s rows and keeps the team’s', () => {
        assert.strictEqual(hideMine.results.length, 1,
          `!<self> returned ${hideMine.results.length} of 2 rows — nothing was hidden`);
        assert.strictEqual(hideMine.results[0].authorId, TEAMMATE_ID, 'the wrong row survived');
      });

      check('search: filtering by the viewer’s own uuid returns only their row', () => {
        assert.strictEqual(onlyMine.results.length, 1, `expected 1 own row, got ${onlyMine.results.length}`);
        assert.strictEqual(onlyMine.results[0].authorId, selfId);
        assert.strictEqual(onlyMine.results[0].self, true, 'the viewer’s own row is not flagged self');
      });

      // Name matching is a documented MCP contract (search_memory takes human
      // input like "andrew") and external tooling passes names. The id fix must
      // not have narrowed it.
      check('search: name-substring matching still works alongside the uuid dialect', () => {
        const byName = activity.searchMemory({ query: 'hookbeacon', limit: 25, author: 'andrew' });
        assert.strictEqual(byName.results.length, 1, `name filter matched ${byName.results.length} rows`);
        assert.strictEqual(byName.results[0].authorId, TEAMMATE_ID);
      });
    }

    // --- 6. display names resolved at serve time (item 4) ---
    // One account whose two installs push different display names must render
    // as ONE person. The resolver keys on author_id and takes the newest
    // snapshot, so the older spelling stops reaching backwards through history.
    {
      const st = util.loadState();
      st.projects[proj].teamEntries = [
        // Older row, older spelling. Same account as the row below.
        {
          author: 'andrewludwigbrown', authorId: TEAMMATE_ID,
          ts: '2026-07-04T09:00:00.000Z', source: 'Codex', session: 'older',
          ask: 'trace the hookbeacon registration', summary: 'Older work.', files: [],
        },
        // Newer row, newer spelling — this is the name every row should render.
        {
          author: 'Andrew Brown', authorId: TEAMMATE_ID,
          ts: '2026-07-06T09:00:00.000Z', source: 'Codex', session: 'newer',
          ask: 'finish the hookbeacon work', summary: 'Newer work.', files: [],
        },
        // A row from BEFORE author_id was carried through: no id at all. It
        // cannot be resolved, and the honest outcome is that it keeps its own
        // frozen snapshot rather than being guessed at by name.
        {
          author: 'andrewludwigbrown',
          ts: '2026-07-02T09:00:00.000Z', source: 'Codex', session: 'legacy-noid',
          ask: 'early hookbeacon spike', summary: 'Legacy work.', files: [],
        },
      ];
      util.saveState(st);

      check('display: authorNames picks the NEWEST snapshot per author uuid', () => {
        const names = activity.authorNames(util.loadState(), util.getConfig());
        assert.strictEqual(names.get(TEAMMATE_ID), 'Andrew Brown',
          'the older spelling won — the map is not ordering on ts');
      });

      check('display: both id-carrying rows render under one name, not two', () => {
        const res = activity.searchMemory({ query: 'hookbeacon', limit: 25, author: TEAMMATE_ID });
        const rendered = [...new Set(res.results.map(r => r.author))];
        assert.strictEqual(res.results.length, 2, `expected the account's 2 id-carrying rows, got ${res.results.length}`);
        assert.deepStrictEqual(rendered, ['Andrew Brown'],
          `one account still renders as ${rendered.length} people: ${rendered.join(' + ')}`);
      });

      check('display: an id-less row keeps its frozen name and is NOT guessed at', () => {
        const all = activity.searchMemory({ query: 'hookbeacon', limit: 25 });
        const legacy = all.results.find(r => r.session === 'legacy-noid');
        assert.ok(legacy, 'the id-less row did not survive into the corpus');
        assert.strictEqual(legacy.authorId, null, 'precondition: the row has no author id');
        assert.strictEqual(legacy.author, 'andrewludwigbrown',
          'an id-less row was renamed — that would be name-based inference, which is deliberately out');
      });

      check('display: the viewer’s own rows still render as "You"', () => {
        const all = activity.searchMemory({ query: 'hookbeacon', limit: 25 });
        const mine = all.results.filter(r => r.self);
        assert.ok(mine.length >= 1, 'the viewer’s own row vanished');
        for (const r of mine) assert.strictEqual(r.author, 'You', 'a self row was overwritten by the resolver');
      });

      check('display: resolution is idempotent — re-serving does not compound', () => {
        const names = activity.authorNames(util.loadState(), util.getConfig());
        const entries = [{ authorId: TEAMMATE_ID, author: 'andrewludwigbrown', self: false }];
        activity.applyAuthorNames(entries, names);
        activity.applyAuthorNames(entries, names);
        assert.strictEqual(entries[0].author, 'Andrew Brown');
      });

      check('display: a revoked project contributes no names (teamRowsFor gate)', () => {
        const stR = util.loadState();
        stR.projects[proj].teamAccessLost = true;
        util.saveState(stR);
        const names = activity.authorNames(util.loadState(), util.getConfig());
        assert.strictEqual(names.has(TEAMMATE_ID), false,
          'a project this machine may no longer read still supplied a display name');
        const stU = util.loadState();
        delete stU.projects[proj].teamAccessLost;
        util.saveState(stU);
      });
    }
  } finally {
    h.noEgress.resetTeamEnv(); // NOT `delete`: an absent env var falls through to the BAKED production backend
    await new Promise(r => mock.server.close(r));
  }

  h.finish();
}

main();
