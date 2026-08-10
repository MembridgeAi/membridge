'use strict';
// Two guarantees search_memory (and its twin, the dashboard's /api/search)
// must keep, both of which it silently broke:
//
// 1. PROJECT VISIBILITY. Every other memory surface honours the four controls
//    a user has for making a project stop answering — a `.membridge-off`
//    marker, config.exclude (what Pause writes), Archive (which writes both),
//    and outright deletion. search_memory honoured none of them: it read the
//    FTS5 index, and the index had no visibility predicate at all. A deleted
//    project's ask, summary, decisions, gotchas and file paths kept coming
//    back after list_projects reported zero projects.
//
//    There are two halves to this and BOTH are tested here, because they fail
//    independently: a predicate at query time (a stale row can never be
//    served, whatever is on disk) and a purge (the index does not grow forever
//    with rows nothing can reach). The predicate is the SAFETY property; the
//    purge is HYGIENE, and they are not interchangeable.
//
//    A purge alone is not enough — it would leave every row servable in the
//    window before it runs, and to any future reader that skips the freshener.
//    Nor does the purge even attempt to cover every case: it runs at delete
//    time (lib/server.js purgeSearchIndex) with searchIndex.pruneUntracked as
//    a backstop, and pruneUntracked deliberately spares projects that are
//    merely PAUSED or marked `.membridge-off`, since those are projects the
//    user still has. Their rows stay on disk on purpose. The predicate is the
//    only thing making that safe, which is precisely why it is tested against
//    the index directly rather than through the freshener.
//
// 2. DATE BOUNDS. `since`/`until` were lexical prefix compares — the stored
//    timestamp sliced to the argument's length and string-compared. That is
//    only correct for zero-padded input, so ordinary model output like
//    "2026-8-01" silently emptied the result set and "2026-6-30" silently
//    ignored the bound and returned August rows. Both failures are invisible
//    to the caller, which is what makes them worse than an error.
//
// Run directly, or via `node test/run.js search-visibility`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// One teamEntries row, defaulted; cases override only what they search on.
function row(overrides) {
  return {
    author: 'Teammate', ts: '2026-07-01T00:00:00.000Z', source: 'Claude Code',
    session: null, ask: null, goal: null, summary: null, decisions: null,
    gotchas: null, headline: null, distilled: true, files: [], changes: null,
    ...overrides,
  };
}

async function main() {
  const util = require('../../lib/util');
  const activity = require('../../lib/activity');
  const idx = require('../../lib/search-index');

  const projectAt = name => path.join(ROOT, 'projects', name);

  // Four projects, each with a vocabulary no other project uses, so a hit can
  // only have come from that project. Every one is visible and tracked at
  // this point.
  const PROJECTS = {
    'vis-open': 'quokka',      // stays visible throughout — the control
    'vis-off': 'narwhal',      // gets a .membridge-off marker
    'vis-paused': 'axolotl',   // goes into config.exclude (Pause / Archive)
    'vis-gone': 'pangolin',    // gets deleted from state, as deleteProject does
  };
  {
    const state = util.loadState();
    for (const [name, word] of Object.entries(PROJECTS)) {
      const p = projectAt(name);
      fs.mkdirSync(path.join(p, '.membridge'), { recursive: true });
      state.projects[p] = {
        events: [],
        teamEntries: [row({
          session: `s-${name}`,
          ask: `investigate the ${word} regression`,
          summary: `the ${word} pipeline was rewritten`,
          decisions: `${word} rollout goes behind a flag`,
          gotchas: `${word} retries are not idempotent`,
          files: [`lib/${word}.js`],
        })],
      };
    }
    util.saveState(state);
  }

  const found = word => activity.searchMemory({ query: word, limit: 20 }).results;

  // Baseline: all four answer while visible. This also warms the index, which
  // is the precondition for the bug — the stale rows under test are only
  // stale because they were legitimately indexed first.
  check('search visibility: every tracked project answers before it is hidden', () => {
    for (const [name, word] of Object.entries(PROJECTS)) {
      assert.strictEqual(found(word).length, 1, `${name} did not answer while visible`);
    }
  });

  // Now hide three of them, one per control.
  fs.writeFileSync(path.join(projectAt('vis-off'), '.membridge-off'), '');
  {
    const raw = util.loadUserConfig();
    raw.exclude = [...(raw.exclude || []), projectAt('vis-paused')];
    util.saveUserConfig(raw);
  }
  {
    // What deleteProject leaves behind: the state row is gone and the path is
    // tombstoned. It never touched search.db.
    const state = util.loadState();
    delete state.projects[projectAt('vis-gone')];
    state.deletedProjects = { ...(state.deletedProjects || {}), [projectAt('vis-gone')]: new Date().toISOString() };
    util.saveState(state);
  }

  check('search visibility: a .membridge-off project serves nothing', () => {
    assert.deepStrictEqual(found('narwhal'), [],
      'a project with a .membridge-off marker still answered search_memory');
  });

  check('search visibility: a paused/excluded project serves nothing', () => {
    // Same rule the search HOOK already keeps ("a paused project must serve
    // nothing", run-tests.js) — this is the MCP tool finally keeping it too.
    assert.deepStrictEqual(found('axolotl'), [],
      'a paused (config.exclude) project still answered search_memory');
  });

  check('search visibility: a deleted project serves nothing', () => {
    assert.deepStrictEqual(found('pangolin'), [],
      'a deleted project still answered search_memory');
  });

  check('search visibility: hiding three projects does not silence the fourth', () => {
    assert.strictEqual(found('quokka').length, 1,
      'the visibility predicate over-matched and took a visible project with it');
  });

  // --- half one: the purge (hygiene) ---
  check('search visibility: a project this machine no longer has is reaped; a merely hidden one is NOT', () => {
    // This check used to assert that all three hidden projects lost their rows,
    // because the purge lived in freshenIndex and keyed on the TRACKED set.
    // That placement was retired in favour of searchIndex.pruneUntracked, which
    // keys on state.projects — because the tracked set excludes paused and
    // archived projects, and reaping those destroys the searchable memory of a
    // project the user still has and expects back when they unpause it.
    //
    // So the three controls now split into two genuinely different cases, and
    // the split is the thing worth pinning:
    //
    //   vis-gone   — deleted, so out of state.projects entirely. Reaped.
    //   vis-off    — a `.membridge-off` marker. Still the user's project.
    //   vis-paused — config.exclude. Still the user's project.
    //
    // Retaining rows for the latter two is DELIBERATE, not a leak, and it is
    // safe only because of the predicate asserted in half two below: the rows
    // sit on disk unreachable. The three checks above already prove they serve
    // nothing. Do not "fix" this by reaping them — that is the bug, not the fix.
    const db = idx.open();
    try {
      const rows = name => db.prepare('select count(*) as n from entries where project = ?')
        .get(projectAt(name)).n;

      assert.strictEqual(rows('vis-gone'), 0,
        'a project deleted from state.projects kept its rows — pruneUntracked did not reap it');
      assert.strictEqual(idx.projectFingerprint(db, projectAt('vis-gone')), null,
        'vis-gone kept its fingerprint, so a re-add would look already-fresh and never refill');

      for (const name of ['vis-off', 'vis-paused']) {
        assert.ok(rows(name) > 0,
          `${name} lost its rows: a hidden-but-still-present project must keep its memory ` +
          'so unpausing restores it — only the query predicate may hide it');
      }

      assert.ok(rows('vis-open') > 0, 'the reap took the visible project too');
    } finally {
      idx.close(db);
    }
  });

  // --- half two: the predicate (safety) ---
  check('search-index: a query scoped to visible projects cannot serve any other row', () => {
    // The purge above is best-effort hygiene running on a schedule; this is
    // the property that holds regardless. Written against the index directly
    // so a stale row genuinely EXISTS when the query runs — which is exactly
    // the state the freshener has not caught up with yet.
    const db = idx.open();
    try {
      const mk = (key, project, word) => ({
        key,
        entry: {
          ts: '2026-07-01T00:00:00.000Z', author: 'T', source: 'Claude Code',
          session: key, origin: 'team', projectPath: project, project: path.basename(project),
          summary: `${word} handling rewritten`, files: [],
        },
      });
      idx.replaceProject(db, '/p/live', [mk('live-1', '/p/live', 'wombat')], 'fp-live');
      idx.replaceProject(db, '/p/stale', [mk('stale-1', '/p/stale', 'wombat')], 'fp-stale');

      const ungated = idx.search(db, { terms: ['wombat'] }).map(r => r.key).sort();
      assert.deepStrictEqual(ungated, ['live-1', 'stale-1'],
        'fixture is wrong: both rows must be matchable before the predicate is applied');

      const gated = idx.search(db, { terms: ['wombat'], projects: ['/p/live'] }).map(r => r.key);
      assert.deepStrictEqual(gated, ['live-1'],
        'the visible-projects predicate did not keep a stale row out of the results');

      // Fail CLOSED: an empty allow-list means nothing is visible, and must
      // not be read as "no filter requested". That distinction is the whole
      // difference between a fresh install serving nothing and serving
      // everything it has ever indexed.
      assert.deepStrictEqual(idx.search(db, { terms: ['wombat'], projects: [] }), [],
        'an empty visible-projects list served rows — the predicate fails open');

      // The file-graph backfill runs a SECOND query against the same index.
      // A predicate on only the lexical one would let backfilled rows walk
      // straight past it.
      const nb = idx.neighboursByFiles(db, { files: ['lib/wombat.js'], projects: ['/p/live'] });
      assert.ok(nb.every(r => r.projectPath === '/p/live'),
        'neighboursByFiles ignored the visible-projects predicate');
    } finally {
      idx.close(db);
    }
  });

  // -----------------------------------------------------------------------
  // Date bounds
  // -----------------------------------------------------------------------
  {
    const state = util.loadState();
    const p = projectAt('dates');
    fs.mkdirSync(path.join(p, '.membridge'), { recursive: true });
    state.projects[p] = {
      events: [],
      teamEntries: [
        row({ session: 'd-jun', ts: '2026-06-15T09:00:00.000Z', summary: 'capybara index rebuilt' }),
        row({ session: 'd-jul', ts: '2026-07-20T09:00:00.000Z', summary: 'capybara index rebuilt' }),
        row({ session: 'd-aug', ts: '2026-08-05T09:00:00.000Z', summary: 'capybara index rebuilt' }),
      ],
    };
    util.saveState(state);
  }
  const dates = args => activity.searchMemory({ query: 'capybara', limit: 20, ...args });

  check('date bounds: a well-formed bare since keeps that whole day onward', () => {
    const got = dates({ since: '2026-06-15' }).results.map(r => r.session).sort();
    assert.deepStrictEqual(got, ['d-aug', 'd-jul', 'd-jun'],
      'the boundary day must be INCLUDED, not sorted out by an instant compare');
  });

  check('date bounds: a well-formed bare until keeps that whole day and earlier', () => {
    const got = dates({ until: '2026-07-20' }).results.map(r => r.session).sort();
    assert.deepStrictEqual(got, ['d-jul', 'd-jun'],
      'the boundary day must be INCLUDED — 09:00 on that day is not after it');
  });

  check('date bounds: a full ISO instant compares as an instant', () => {
    const got = dates({ since: '2026-07-20T12:00:00.000Z' }).results.map(r => r.session);
    assert.deepStrictEqual(got, ['d-aug'],
      'an instant bound must exclude the same-day row that precedes it');
  });

  check('date bounds: an unpadded since is a loud error, not an empty result', () => {
    // Measured before the fix: "2026-8-01" dropped ALL THREE rows, because
    // "2026-08" < "2026-8-". Ordinary model output, silently answered wrong.
    const res = dates({ since: '2026-8-01' });
    assert.ok(res.error, 'a malformed since must be rejected, not silently applied');
    assert.ok(/since/.test(res.error), `the error must name the offending argument: ${res.error}`);
    assert.ok(!res.results || !res.results.length, 'a rejected search must not also return results');
  });

  check('date bounds: an unpadded until is a loud error, not a silently ignored bound', () => {
    // Measured before the fix: "2026-6-30" returned all three rows including
    // August, because "2026-08" > "2026-6-" is false. Worse than empty — it
    // answers with rows the caller explicitly excluded.
    const res = dates({ until: '2026-6-30' });
    assert.ok(res.error, 'a malformed until must be rejected, not silently ignored');
    assert.ok(/until/.test(res.error), `the error must name the offending argument: ${res.error}`);
  });

  check('date bounds: a non-date string is rejected too', () => {
    assert.ok(dates({ since: 'last tuesday' }).error, 'free text was accepted as a date bound');
    assert.ok(dates({ since: '2026-13-01' }).error, 'month 13 was accepted as a date bound');
    assert.ok(dates({ until: '2026-02-30' }).error, 'February 30th was accepted as a date bound');
  });

  check('date bounds: the MCP schema rejects a malformed date at the boundary', () => {
    // The HTTP surface (/api/search) has no zod, so the check above has to
    // live in activity.js. The MCP surface gets it at the schema edge as
    // well, where the caller sees a protocol-level validation error naming
    // the field rather than a result object it has to inspect.
    const mcp = require('../../lib/mcp');
    const schema = mcp._searchDateSchemaForTests;
    assert.ok(schema, 'lib/mcp.js must expose the date schema it validates with');
    assert.ok(schema.safeParse('2026-06-01').success, 'a bare ISO date must be accepted');
    assert.ok(schema.safeParse('2026-06-01T09:00:00.000Z').success, 'a full ISO instant must be accepted');
    assert.ok(!schema.safeParse('2026-8-01').success, 'an unpadded date must fail the schema');
    assert.ok(!schema.safeParse('last tuesday').success, 'free text must fail the schema');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
