'use strict';
// searchMemory's FILTERS: not which entries rank highest, but which ones are
// allowed to be answers at all. Run directly, or via
// `node test/run.js search-filters`.
//
// WHY THIS SUITE EXISTS. Both checks below were written from mutation
// survivors, found with:
//
//   node test/mutate.js --target lib/activity.js --mode ops \
//     --suites search,core --filter "@686,@806"
//
// Three mutants survived the ENTIRE suite -- 30 suites, the legacy monolith
// included. lib/search.js's ranking is covered thoroughly (test/suites/
// search.test.js is 227 lines of it), and searchMemory's plumbing is covered
// by retrievals and search-eval, but nothing asserted that a filter EXCLUDES
// anything. A filter that silently matches everything returns a confident,
// well-ranked, wrong answer -- and this is the MCP surface other agents
// query, so the wrong answer is consumed without a human ever seeing the
// query that produced it.
//
// The shape of both: an assertion that the filter includes what it should is
// satisfied by a filter that includes EVERYTHING. Each check below therefore
// plants a decoy that must be absent, and asserts the absence. An inclusion
// assertion alone cannot fail against a broken filter.
//
// NO_UNOWNED_FILE_READS: fixtures live under ROOT (test/harness.js), never the real home
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function main() {
  const util = require('../../lib/util');
  const activity = require('../../lib/activity');

  const TOKEN = 'filterscopetoken';

  // Two linked projects, each with its own shared project id, each holding a
  // team row that matches the same query. Team rows carry projectId and NEVER
  // projectPath (lib/feed.js normalizeTeam pins it null on purpose -- a
  // teammate's checkout lives elsewhere), so the linked-id arm of
  // matchesProject is the ONLY thing that can scope them. That is exactly the
  // arm the surviving mutants were in.
  const mk = (dir, projectId, file) => {
    const p = path.join(ROOT, 'projects', dir);
    fs.mkdirSync(path.join(p, '.membridge'), { recursive: true });
    fs.writeFileSync(path.join(p, '.membridge', 'team.json'),
      JSON.stringify({ projectId, teamId: 'team-1', teamName: 'T' }));
    const state = util.loadState();
    state.projects[p] = {
      events: [],
      teamProjectId: projectId,
      teamEntries: [{
        author: 'Teammate', ts: '2026-07-01T00:00:00.000Z', source: 'Claude Code',
        session: 's-' + dir, ask: null, goal: null, summary: null,
        decisions: `${TOKEN} in ${dir}`, gotchas: null, headline: null,
        distilled: true, files: [file], changes: null, project_id: projectId,
      }],
    };
    util.saveState(state);
    return p;
  };

  const projA = mk('filters-app-a', '11111111-1111-1111-1111-111111111111', 'alpha.js');
  const projB = mk('filters-app-b', '22222222-2222-2222-2222-222222222222', 'beta.js');

  // The premise. Every scoping assertion below is "these results are a proper
  // SUBSET"; if the unfiltered query cannot see both rows, a filter that
  // returns nothing would satisfy every one of them.
  const unfiltered = activity.searchMemory({ query: TOKEN, limit: 50 });
  check('fixture: the unfiltered query reaches BOTH projects\' rows', () => {
    const files = unfiltered.results.flatMap(r => r.files || []);
    assert.ok(unfiltered.results.length >= 2,
      `expected at least 2 rows unfiltered, got ${unfiltered.results.length} -- the scoping checks below would prove nothing`);
    assert.ok(files.includes('alpha.js') && files.includes('beta.js'),
      `both projects must be reachable before scoping means anything, got ${JSON.stringify(files)}`);
  });

  check('searchMemory: a project filter EXCLUDES another project\'s team rows', () => {
    // lib/activity.js:686 -- `entry.projectId === filter.linkedId`. Two mutants
    // there survived the full suite: `!==` makes the filter select the WRONG
    // project's rows, and `&&`->`||` makes `!!filter.linkedId` alone satisfy
    // the arm so EVERY team row matches whatever project you asked for. Both
    // hand the caller another project's history under the name of the one they
    // scoped to.
    const out = activity.searchMemory({ query: TOKEN, project: projA, limit: 50 });
    const files = out.results.flatMap(r => r.files || []);
    assert.ok(files.includes('alpha.js'),
      `the scoped project's own row is missing -> ${JSON.stringify(files)}`);
    assert.ok(!files.includes('beta.js'),
      `another project's row was served under a scope the caller set explicitly -> ${JSON.stringify(files)}`);
    // ...and the mirror, so a filter that happens to return only-A for some
    // unrelated reason (ordering, limit) cannot satisfy the check above.
    const outB = activity.searchMemory({ query: TOKEN, project: projB, limit: 50 });
    const filesB = outB.results.flatMap(r => r.files || []);
    assert.ok(filesB.includes('beta.js') && !filesB.includes('alpha.js'),
      `scoping to B did not select B's rows and only B's -> ${JSON.stringify(filesB)}`);
  });

  check('searchMemory: a file filter EXCLUDES entries that do not touch that file', () => {
    // lib/activity.js:806 -- `if (args.file && !matches) return false;`. Flipped
    // to `return true`, a NON-matching entry short-circuits passesFilters as a
    // PASS, so the filter admits everything it was asked to exclude. Survived
    // the full suite: nothing anywhere asserted that `file:` removes a row.
    const out = activity.searchMemory({ query: TOKEN, file: 'alpha', limit: 50 });
    const files = out.results.flatMap(r => r.files || []);
    assert.ok(files.includes('alpha.js'), `the matching row is missing -> ${JSON.stringify(files)}`);
    assert.ok(!files.includes('beta.js'),
      `a row that does not touch the requested file was served -> ${JSON.stringify(files)}`);
    const outBeta = activity.searchMemory({ query: TOKEN, file: 'beta', limit: 50 });
    const filesBeta = outBeta.results.flatMap(r => r.files || []);
    assert.ok(filesBeta.includes('beta.js') && !filesBeta.includes('alpha.js'),
      `the mirror filter did not select only beta -> ${JSON.stringify(filesBeta)}`);
    // A filter naming a file nobody touched must return NOTHING, not fall back
    // to the unfiltered set. "No results" and "here is everything" are the two
    // answers a broken filter picks between, and only one of them is loud.
    const none = activity.searchMemory({ query: TOKEN, file: 'nosuchfile', limit: 50 });
    assert.strictEqual(none.results.length, 0,
      `a file filter matching nothing returned ${none.results.length} rows`);
  });

  h.finish();
}

main().catch(err => { console.error(err); process.exit(1); });
