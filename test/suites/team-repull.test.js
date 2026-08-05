'use strict';
// `membridge team repull` — the only thing that makes the identity work
// retroactive, and the only thing that must not corrupt anything doing it.
//
// WHY. Rows pulled before the daemon carried author_id through
// (lib/teamsync.js mapPulledRow) have no stable identity on this disk, and both
// features built on that id — filtering search by person, and resolving one
// account's several display names to one person — are forward-only by
// construction. Only a full re-walk gives those rows an id.
//
// WHAT IT MUST NOT DO. Before lib/team-archive.js compacted on duplicate keys,
// this walk re-appended every row it re-fetched and roughly doubled the
// .ndjson, permanently. The archive-growth check below is the one that keeps
// those two shipped in the right order.
//
// INTERRUPTION IS THE NORMAL CASE — a user will Ctrl-C this. The checks pin the
// property that makes that safe: each page merges into both stores BEFORE the
// cursor advances, and both stores are keyed merges, so a partial walk leaves a
// partially healed store rather than an inconsistent one, and re-running
// resumes instead of restarting. Note also what is deliberately absent: there
// is NO "repull done" flag anywhere. Nothing records success, so nothing can
// record it wrongly — this repo's signature defect is a flag asserting work the
// code never did.
//
// Run directly, or via `node test/run.js team-repull`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const teamArchive = require('../../lib/team-archive');
const activity = require('../../lib/activity');
const { createMockSupabase } = require('../mock-supabase');

const MOCK_PORT = P(67);
const TEAMMATE_ID = '99999999-8888-7777-6666-555555555555';

// Run the real CLI verb, in a child process, against the same fixture home —
// the point is to exercise the shipped command, not a copy of its loop.
//
// spawn + await, NEVER spawnSync: the mock backend runs in THIS process, so
// blocking this event loop would stop serving the very HTTP requests the child
// is waiting on — a deadlock, not a slow test. (Cost one five-minute timeout to
// learn; leaving the reason here so it is not re-learned.)
function repull(extraArgs = []) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [h.BIN, 'team', 'repull', ...extraArgs], {
      env: {
        ...process.env,
        MEMBRIDGE_TEAM_URL: `http://127.0.0.1:${MOCK_PORT}`,
        MEMBRIDGE_TEAM_ANON_KEY: 'anon-test',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

const physicalLines = projectId => {
  try {
    return fs.readFileSync(teamArchive.archivePath(projectId), 'utf8').split('\n').filter(l => l.trim()).length;
  } catch {
    return 0;
  }
};
const archiveRows = projectId => teamArchive.loadArchive(projectId).rows;
const projRecord = key => (util.loadState().projects || {})[key];

async function main() {
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(MOCK_PORT, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

  try {
    util.ensureConfig();
    const cfg = util.loadUserConfig();
    cfg.team = { ...(cfg.team || {}), encrypt: false }; // documented hatch: keeps the mock off the real keychain
    util.saveUserConfig(cfg);

    await teamsync.signup(util.getConfig(), 'repull-me@test.dev', 'pw-r', 'Me');
    const team = await teamsync.createTeam(util.getConfig(), 'RepullCo');

    const key = path.join(ROOT, 'projects', 'repull-app');
    fs.mkdirSync(key, { recursive: true });
    {
      const st = util.loadState();
      st.projects = { ...(st.projects || {}), [key]: { events: [] } };
      util.saveState(st);
    }
    const link = await teamsync.linkProject(util.getConfig(), key, team.team_id, 'RepullCo');

    // A teammate's history on the backend, bigger than one page (PULL_LIMIT is
    // 200) so the walk genuinely takes several passes. Seeded straight onto the
    // mock's rows array with explicit id/created_at, ascending, because the
    // forward pull pages on `created_at=gt.<cursor>` and a deterministic order
    // is the difference between testing the walk and testing storage order.
    //
    // EVERY row carries author_id: the column is NOT NULL on the live backend
    // and a count there found zero rows without one, so a re-pull recovers an
    // id for every row it re-fetches. The fixture must not imply otherwise.
    const HISTORY = 450;
    for (let i = 0; i < HISTORY; i += 1) {
      mock.entries.push({
        id: i + 1,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 60_000).toISOString(),
        project_id: link.projectId,
        author_id: TEAMMATE_ID,
        author_name: 'Andrew Brown',
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 60_000).toISOString(),
        source: 'Codex',
        session: `theirs-${i}`,
        ask: null,
        summary: `historybeacon entry ${i}`,
        files: [],
        distilled: false,
      });
    }

    // THE PRE-STATE this exists to heal: rows already on disk with no author id
    // and a cursor parked past all of them, exactly as an install that pulled
    // this history under an older build would look.
    const stale = archiveRowsFromBackend(mock, link.projectId).map(r => ({ ...r, authorId: undefined }));
    teamArchive.appendRows(link.projectId, stale, { source: 'forward' });
    {
      const st = util.loadState();
      st.projects[key].teamEntries = stale.slice(-100);
      st.projects[key].teamPullTs = new Date(Date.now() + 60_000).toISOString(); // parked past everything
      util.saveState(st);
    }
    const before = {
      lines: physicalLines(link.projectId),
      rows: archiveRows(link.projectId).length,
      withId: archiveRows(link.projectId).filter(r => r.authorId).length,
    };
    assert.strictEqual(before.withId, 0, 'fixture: the pre-state must have no author ids at all');
    assert.strictEqual(before.rows, HISTORY, `fixture: expected ${HISTORY} stale rows, got ${before.rows}`);

    // ---- 1. a partial walk: interrupt after the first page ----
    // Simulated the way a user actually interrupts — the cursor reset lands,
    // one pass runs, and then nothing more. Driven through the same syncTeams
    // pass the CLI loops, because a child process cannot be stopped mid-page
    // deterministically.
    {
      const st = util.loadState();
      st.projects[key].teamPullTs = null; // the CLI's one narrow reset
      util.saveState(st);
      await teamsync.syncTeams({ project: key });

      check('partial: one page in, the cursor honestly describes only what landed', () => {
        const cursor = projRecord(key).teamPullTs;
        assert.ok(cursor, 'the cursor was left null after a page landed — the next run would redo work it had done');
        const rows = archiveRows(link.projectId);
        const healed = rows.filter(r => r.authorId).length;
        assert.ok(healed > 0, 'the first page healed nothing');
        assert.ok(healed < HISTORY, `the first page healed everything (${healed}) — the fixture is not multi-page`);
        // The cursor must not OVERSTATE progress: the row it names has to be one
        // that actually landed. That is the whole basis for resuming from it.
        const atCursor = rows.find(r => String(r.ts) === String(cursor));
        assert.ok(atCursor, `the cursor names a row that is not in the archive: ${cursor}`);
        assert.ok(atCursor.authorId,
          'the cursor advanced past a row that was never healed — a resume would skip it permanently');
        // NOT asserted, deliberately, because it is false: that every row NEWER
        // than the cursor is still unhealed. syncTeams also runs the BACKWARD
        // archive backfill (teamsync.backfillArchivePage), which walks history
        // newest-first and archives rows carrying their author id — so a second,
        // independent healer is at work and rows past the forward cursor can
        // legitimately already be healed. Asserting otherwise measures the
        // fixture, not the contract.
      });

      check('partial: no store is left inconsistent, and nothing records success', () => {
        assert.strictEqual(physicalLines(link.projectId), archiveRows(link.projectId).length,
          'the partial walk left duplicate lines in the archive');
        const rec = projRecord(key);
        assert.ok(!('repullDone' in rec) && !('repullAt' in rec),
          'the walk stamped a completion flag in state — nothing must be able to claim a success it did not finish');
      });
    }

    // ---- 2. re-running finishes the job, through the real CLI ----
    const run = await repull(['--project', key]);

    check('the CLI completes the walk and every archived row gains its author id', () => {
      assert.strictEqual(run.status, 0, `team repull exited ${run.status}: ${run.stderr}`);
      const rows = archiveRows(link.projectId);
      assert.strictEqual(rows.length, HISTORY, `the archive holds ${rows.length} rows, expected ${HISTORY}`);
      const withId = rows.filter(r => r.authorId === TEAMMATE_ID).length;
      assert.strictEqual(withId, HISTORY,
        `only ${withId} of ${HISTORY} rows carry the author id — the walk did not reach all of history`);
    });

    check('the archive did not grow: compaction is doing its job under a re-pull', () => {
      assert.strictEqual(physicalLines(link.projectId), HISTORY,
        `the .ndjson holds ${physicalLines(link.projectId)} lines for ${HISTORY} distinct rows — ` +
        'a re-pull is doubling the archive, which is exactly what compaction had to land first to prevent');
      assert.strictEqual(teamArchive.backfillStatus(link.projectId).rowCount, HISTORY,
        'the sidecar row count drifted from the deduped set');
    });

    check('the walk is what makes the person filter reach history', () => {
      const byPerson = activity.searchMemory({ query: 'historybeacon', limit: 500, author: TEAMMATE_ID });
      assert.ok(byPerson.results.length > 0,
        'filtering by the teammate’s uuid still returns nothing — the id never reached the searchable corpus');
    });

    check('the CLI tells the user what it did, and that interrupting does not fully stop it', () => {
      assert.ok(/pass 1/.test(run.stdout), `no per-pass progress was printed:\n${run.stdout}`);
      assert.ok(/with an author id/.test(run.stdout), `no per-project summary was printed:\n${run.stdout}`);
      assert.ok(/interrupt/i.test(run.stdout) && /one page per sync tick/i.test(run.stdout),
        `the user is not told the daemon keeps walking after a Ctrl-C:\n${run.stdout}`);
    });

    // ---- 3. idempotence: running it again costs nothing and breaks nothing ----
    {
      const second = await repull(['--project', key]);
      check('running it a second time is a no-op, not a second copy', () => {
        assert.strictEqual(second.status, 0, `the re-run exited ${second.status}: ${second.stderr}`);
        assert.strictEqual(archiveRows(link.projectId).length, HISTORY, 'the re-run changed the distinct row count');
        assert.strictEqual(physicalLines(link.projectId), HISTORY,
          `the re-run grew the file to ${physicalLines(link.projectId)} lines`);
      });
    }

    // ---- 4. it refuses the cases where it has nothing to do ----
    {
      const unlinked = path.join(ROOT, 'projects', 'not-linked-app');
      fs.mkdirSync(unlinked, { recursive: true });
      const st = util.loadState();
      st.projects[unlinked] = { events: [] };
      util.saveState(st);
      const r = await repull(['--project', unlinked]);
      check('an unlinked project is refused with a reason, not walked', () => {
        assert.notStrictEqual(r.status, 0, 'repull claimed to walk a project with no team link');
        assert.ok(/not linked/i.test(r.stdout + r.stderr), `the refusal does not say why: ${r.stdout}${r.stderr}`);
      });
    }
  } finally {
    h.noEgress.resetTeamEnv(); // NOT `delete`: an absent env var falls through to the BAKED production backend
    await new Promise(r => mock.server.close(r));
  }

  h.finish();
}

// The stored (mapped) shape of everything the backend holds for this project —
// used only to build the "pulled under an older build" pre-state.
function archiveRowsFromBackend(mock, projectId) {
  return mock.entries
    .filter(e => e.project_id === projectId)
    .map(e => ({
      author: e.author_name,
      authorId: e.author_id,
      ts: e.ts,
      source: e.source,
      session: e.session,
      ask: e.ask || null,
      summary: e.summary || null,
      files: [],
    }));
}

main();
