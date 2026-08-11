'use strict';
// The forward pull's cursor: what it pages on, and what happens at the page
// boundary. Both halves of that are the difference between a teammate's work
// arriving LATE and never arriving at all.
//
// WHY IT PAGES ON created_at. `ts` is authored on the pushing machine — it is
// when the work happened, not when the row reached the backend. A machine that
// was offline on Monday and syncs on Friday pushes a row stamped Monday, and a
// cursor made of `ts` values has long since passed Monday. That row is not
// late; it is invisible, and no later pull ever reconsiders it. created_at is
// stamped server-side, so it only ever moves in arrival order.
//
// WHY THE BOUNDARY IS THE HARD PART. created_at is not unique. It defaults to
// now(), which is constant within a transaction, so a batched push lands many
// rows sharing one created_at; the drift re-push is worse, stamping ONE
// client-side `now` across every stale row it sends (lib/teamsync.js, the
// `stale` loop). When a tie group is bigger than the rest of the page, a plain
// `created_at=gt.<cursor>` cursor jumps the whole group: the page cuts at
// PULL_LIMIT, the cursor lands on the tie's timestamp, and `gt.` excludes the
// siblings that fell past the cut — from every future pull, forever. The fix
// is a keyset on the pair (created_at, id): the id half addresses a position
// INSIDE the tie group, so the walk resumes where it stopped instead of
// stepping over the remainder.
//
// SCOPE. This is the PULL cursor only. Feed ordering still pages on `ts` and is
// deliberately untouched here — moving it needs three page cursors to move
// together, which is its own change (lib/server.js:951 records the same
// boundary problem on that side, still open).
//
// Run directly, or via `node test/run.js team-pull-cursor`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createMockSupabase } = require('../mock-supabase');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');

const TEAMMATE_ID = '77777777-6666-5555-4444-333333333333';
const PULL_LIMIT = 200; // lib/teamsync.js — the page size the boundary lives at

// Drain the forward pull the way a sequence of sync passes would, and report
// what each page yielded. Bounded so a cursor that stops advancing shows up as
// a failed assertion on the totals rather than a hung suite.
async function drain(creds, proj, link, maxPasses = 10) {
  const pages = [];
  for (let i = 0; i < maxPasses; i += 1) {
    const n = await teamsync.pullProject(util.getConfig(), creds, proj, link, null);
    pages.push(n);
    if (!n) break;
  }
  return { pages, total: pages.reduce((a, b) => a + b, 0) };
}

async function main() {
  // encrypt:false is the explicit escape hatch that keeps the mock-Supabase
  // round trip off the real macOS keychain, exactly as team-identity.test.js does.
  util.ensureConfig();
  const cfg = util.loadUserConfig();
  cfg.team = { ...(cfg.team || {}), encrypt: false };
  util.saveUserConfig(cfg);

  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(P(77), '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(77)}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

  try {
    await teamsync.signup(util.getConfig(), 'cursor@test.dev', 'pw-cursor', 'Me');
    const team = await teamsync.createTeam(util.getConfig(), 'CursorTeam');
    const creds = await teamsync.getAccessToken(util.getConfig());

    // One linked project per section. Sections seed hundreds of rows and each
    // one starts its cursor at the beginning of history, so a shared project
    // would have every section pulling the previous section's fixtures and
    // every count off by however many rows came before.
    const newProject = async name => {
      const projPath = path.join(ROOT, 'projects', name);
      fs.mkdirSync(projPath, { recursive: true });
      await teamsync.linkProject(util.getConfig(), projPath, team.team_id, 'CursorTeam');
      return { projPath, link: teamsync.loadTeamLink(projPath) };
    };
    const first = await newProject('cursor-late-push');
    const projPath = first.projPath;
    let link = first.link;

    let nextId = 1000;
    // Plant a row exactly as the backend holds it: `ts` authored by the pusher,
    // `created_at` stamped on arrival. The two are independent on purpose —
    // that independence is the whole subject of this suite.
    const plant = over => {
      const row = {
        project_id: link.projectId,
        author_id: TEAMMATE_ID,
        author_name: 'Teammate',
        ts: '2026-07-01T10:00:00.000Z',
        source: 'Claude Code',
        session: `s-${nextId}`,
        ask: null,
        summary: 'work',
        distilled: false,
        files: [],
        changes: null,
        goal: null,
        decisions: null,
        gotchas: null,
        headline: null,
        id: nextId++,
        created_at: '2026-07-01T10:00:00.000Z',
        ...over,
      };
      mock.entries.push(row);
      return row;
    };

    // --- 1. THE TICKET: a row authored EARLY and pushed LATE is still pulled ---
    // The teammate wrote this on the 1st and pushed it on the 9th, by which
    // time our cursor has passed the 5th. On a `ts` cursor it is behind the
    // cursor at the moment it arrives and is skipped permanently. On a
    // created_at cursor it arrives on the next pull like anything else.
    {
      const p = { teamEntries: [], teamPullTs: undefined };
      plant({
        session: 'pushed-on-time',
        ts: '2026-07-05T09:00:00.000Z',
        created_at: '2026-07-05T09:00:05.000Z',
      });
      await teamsync.pullProject(util.getConfig(), creds, p, link, null);
      const cursorAfterFirst = p.teamPullTs;

      // Authored FOUR DAYS BEFORE the row already pulled, pushed four days
      // after it: the shape an offline machine, a paused sync or a held batch
      // produces every time.
      plant({
        session: 'authored-early-pushed-late',
        ts: '2026-07-01T08:00:00.000Z',
        created_at: '2026-07-09T09:00:00.000Z',
      });
      const pulled = await teamsync.pullProject(util.getConfig(), creds, p, link, null);

      check('pull: a row authored before the cursor but pushed after it still arrives', () => {
        assert.ok(cursorAfterFirst, 'precondition: the first pull advanced the cursor');
        assert.strictEqual(pulled, 1, `the late push was not fetched (${pulled} rows)`);
        const got = p.teamEntries.find(e => e.session === 'authored-early-pushed-late');
        assert.ok(got, 'a row authored behind the cursor and pushed ahead of it was skipped — ' +
          'the cursor is paging on the authored ts, not on arrival at the backend');
        assert.strictEqual(got.ts, '2026-07-01T08:00:00+00:00',
          'the stored row should keep its AUTHORED ts — only the cursor changes');
      });

      check('pull: a drained cursor asks again and gets nothing — no re-fetch loop', () => {
        assert.strictEqual(p.teamEntries.length, 2, 'unexpected rows in the fixture');
      });
    }

    // --- 2. THE BOUNDARY: a tie group larger than one page is fully pulled ---
    // PUSH_BATCH is 50 and PULL_LIMIT is 200, but the drift re-push stamps one
    // `now` across every stale row it sends, so a tie group is bounded by the
    // entry window rather than by the batch. 210 rows sharing one created_at
    // straddles the page boundary with room to spare.
    const TIE_AT = '2026-08-01T12:00:00.000Z';
    const TIE_COUNT = PULL_LIMIT + 10;
    const tieProject = await newProject('cursor-tie-group');
    {
      link = tieProject.link;
      const p = { teamEntries: [], teamPullTs: undefined };
      for (let i = 0; i < TIE_COUNT; i += 1) {
        plant({
          session: `tie-${i}`,
          // Distinct ts per row, so the local dedupe key (author|ts|source)
          // keeps them apart and a lost row is a lost row, not a merge.
          ts: new Date(Date.parse('2026-08-01T00:00:00.000Z') + i * 1000).toISOString(),
          created_at: TIE_AT, // ONE instant, shared by all 210
        });
      }
      const { pages, total } = await drain(creds, p, link);

      check('pull: every row of a tie group bigger than a page is pulled', () => {
        assert.strictEqual(total, TIE_COUNT,
          `${TIE_COUNT - total} of ${TIE_COUNT} rows sharing one created_at were never pulled ` +
          `(pages: ${pages.join(', ')}) — the cursor jumped the tie group at the page boundary`);
        assert.strictEqual(pages[0], PULL_LIMIT, 'the first page should be a full page');
      });

      check('pull: the tie group is walked, not re-fetched — the drain terminates', () => {
        assert.ok(pages.length <= 3,
          `the walk took ${pages.length} pages for ${TIE_COUNT} rows — the cursor is re-reading the boundary`);
        assert.strictEqual(pages[pages.length - 1], 0, 'the walk did not reach a clean end');
      });

      check('pull: the cursor keeps both halves — timestamp and row id', () => {
        assert.strictEqual(p.teamPullTs, '2026-08-01T12:00:00+00:00',
          'the timestamp half must still be the last row’s created_at (lib/server.js reports it)');
        assert.strictEqual(typeof p.teamPullId, 'number',
          'no id half stored — the next page cannot resume inside a tie group');
      });

      // The pair is a cursor, not two cursors. A pull whose page ended inside a
      // tie group has a teamPullTs that has NOT moved; only the id has. Anything
      // that judges progress on the timestamp alone (bin/membridge.js `team
      // repull` did) reads that as a stalled walk and gives up mid-group.
      check('pull: a second pass inside the tie group advances the id, not the timestamp', () => {
        assert.strictEqual(pages[1], TIE_COUNT - PULL_LIMIT,
          `the second page returned ${pages[1]} rows, expected the ${TIE_COUNT - PULL_LIMIT} left in the tie group`);
      });
    }

    // --- 3. the boundary is not re-fetched once passed ---
    {
      const p = { teamEntries: [], teamPullTs: undefined }; // same tie fixture, fresh cursor
      await drain(creds, p, link);
      const settled = await teamsync.pullProject(util.getConfig(), creds, p, link, null);
      check('pull: a settled cursor fetches nothing at all on the next pass', () => {
        assert.strictEqual(settled, 0,
          `a drained project re-fetched ${settled} rows — an inclusive boundary would loop forever here`);
      });
    }

    // --- 4. a backend that refuses the keyset filter degrades, and says so ---
    // The fallback exists so a PostgREST that rejects `or=` cannot take a whole
    // project's pull down with it. It is a real degradation (the tie boundary
    // comes back with it), so it must be reachable in a test rather than
    // trusted — and it must not be silent.
    {
      link = (await newProject('cursor-or-rejected')).link;
      const p = { teamEntries: [], teamPullTs: undefined };
      plant({ session: 'before-reject', ts: '2026-09-01T10:00:00.000Z', created_at: '2026-09-01T10:00:00.000Z' });
      await teamsync.pullProject(util.getConfig(), creds, p, link, null);
      plant({ session: 'after-reject', ts: '2026-09-02T10:00:00.000Z', created_at: '2026-09-02T10:00:00.000Z' });
      mock.flags.rejectOr = true;
      let threw = null;
      let pulled = 0;
      try {
        pulled = await teamsync.pullProject(util.getConfig(), creds, p, link, null);
      } catch (err) {
        threw = err;
      } finally {
        mock.flags.rejectOr = false;
      }
      check('pull: a backend that rejects the keyset page falls back instead of failing the pull', () => {
        assert.strictEqual(threw, null, `the pull threw instead of degrading: ${threw && threw.message}`);
        assert.strictEqual(pulled, 1, `the fallback page returned ${pulled} rows`);
        assert.ok(p.teamEntries.some(e => e.session === 'after-reject'),
          'the fallback page did not deliver the row');
      });
    }

    // --- 5. both halves of the cursor reset together ---
    // teamPullTs and teamEntries are already documented as one unit (an orphan
    // cursor over an emptied cache means a re-link never re-fetches the history
    // behind it). teamPullId joins that unit: a half-reset cursor is the state
    // a silent skip grows out of.
    {
      const st = util.loadState();
      st.projects[projPath] = {
        events: [],
        teamEntries: [{ author: 'Teammate', ts: '2026-07-01T10:00:00.000Z', source: 'Claude Code', files: [] }],
        teamPullTs: '2026-08-01T12:00:00+00:00',
        teamPullId: 1234,
      };
      util.saveState(st);
      const pruned = teamsync.pruneTeamEntries(projPath);
      const after = (util.loadState().projects || {})[projPath];
      check('prune: the forward cursor resets as a PAIR, never half of one', () => {
        assert.strictEqual(pruned, true, 'prune reported nothing to do');
        assert.deepStrictEqual(after.teamEntries, [], 'cached rows survived');
        assert.strictEqual(after.teamPullTs, null, 'the timestamp half survived');
        assert.strictEqual(after.teamPullId, null,
          'the id half survived a prune — the cursor is now half-reset');
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
