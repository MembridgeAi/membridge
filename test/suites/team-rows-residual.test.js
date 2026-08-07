'use strict';
// #55 — proj.teamEntries left behind by a pre-fix unlink is now swept from the
// same reconciler pass that already empties the derived teammate-notes index.
//
// THE FAILURE. #42/#43 taught `unlinkProject` to prune `proj.teamEntries` at
// the source, and taught `backfillProjects` to empty the derived notes index
// on the next sync pass for any project unlinked before that fix landed. That
// second half addressed the DERIVED index; the SOURCE rows on disk were left
// for a follow-up ticket, which the notes-store comment names explicitly:
//
//   "This deliberately does NOT try to clear proj.teamEntries as well. Every
//    other reader of those rows has the same problem, and fixing it there
//    means either changing util.teamRowsFor's signature or changing
//    unlinkProject -- a wider change than this reconciler, and its own ticket."
//
// This suite is that ticket. It fixes the residual through option 2 — extend
// the reconciler pass to sweep the rows on the same "link file is missing"
// test that already empties the index — and pins the four hot readers of the
// row cache that were still serving stale data:
//
//   * FTS search (activity.searchMemory)
//   * MCP get_project_memory (mcp.getProjectMemory -> teamInjectSlice)
//   * the injected CLAUDE.md/AGENTS.md block (digest.renderBlock)
//   * project stats + the session detail page (server.projectDetail, etc.)
//
// WHY OPTION 2 WINS over changing teamRowsFor's signature: teamRowsFor is
// called from six hot readers; giving it a path parameter turns every single
// call site into a filesystem stat, and folds two independent questions ("may
// this install still read these rows?" — a fact in state — and "is the
// project still linked?" — a file on disk) into one function. Same defect
// class as #79's `Boolean(truncated && !exact)`. See lib/teammate-notes-
// store.js's inline note for the full argument.
//
// WHAT THESE CANNOT PROVE. jsdom-level tests of the UI feed. This checks the
// daemon-side readers only. The wire shape stays constant — no field renamed,
// no readers moved — so this is not a client-facing change.
//
// Run directly, or via `node test/run.js team-rows-residual`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const memorydb = require('../../lib/memorydb');
const teamsync = require('../../lib/teamsync');
const notesStore = require('../../lib/teammate-notes-store');
const activity = require('../../lib/activity');
const digest = require('../../lib/digest');
const mcp = require('../../lib/mcp');
const server = require('../../lib/server');

// Real time, not a literal — for the reason documented at the top of
// test/suites/teammate-notes-revocation.test.js. Two of the readers this suite
// pins (mcp.getProjectMemory and digest.renderBlock) go through
// digest.teamInjectSlice, which drops rows older than config.teamMaxAgeHours
// (default 72) against `Date.now()` and takes no injected clock. Pinned to
// 2026-08-05T12:00Z, this suite's "before the sweep the stale rows ARE served"
// premise would have started failing at 2026-08-08T12:00Z and on every run
// after — a green suite with an expiry date. A couple of hours old is what a
// row fresh off the wire is in production.
const NOW = new Date(Date.now() - 2 * 3600000).toISOString();
const SESSION = 'sess-mate';
// A pushed teammate row in wire shape, with every field the four readers
// consult — enough for a decision, a file note, a search hit, and a block line.
const TEAM_ROW = {
  id: 'r1', ts: NOW, created_at: NOW,
  author_id: 'mate', author_name: 'Mate', author: 'Mate',
  source: 'Claude Code', session: SESSION,
  project_id: 'proj-stale', project_name: 'stale',
  ask: 'draft the release notes for 0.4.0',
  summary: 'Release notes drafted for 0.4.0.',
  headline: 'release notes drafted',
  decisions: 'do not widen the dirty filter — synced projects still have events',
  gotchas: 'the pull cursor is now per project',
  files: ['lib/teamsync.js'],
  changes: [{ file: 'lib/teamsync.js', action: 'edited', note: 'reorganized the pull loop' }],
};

// A tracked project that WAS on a team once, now unlinked but with the pre-fix
// residual in state.json: teamEntries carrying a real teammate row, no
// team.json on disk, teamAccessLost NEVER set (unlink sets no flag — that is
// the whole point of the ticket).
function makeStale(name) {
  const key = path.join(h.ROOT, 'projects', name);
  fs.mkdirSync(path.join(key, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(key, '.git'), { recursive: true });
  fs.writeFileSync(path.join(key, 'lib', 'teamsync.js'), '// fixture\n');
  fs.mkdirSync(path.join(key, memorydb.DIR_NAME), { recursive: true });
  // NO team.json. That is the pre-fix residual — the link file is gone and
  // the rows are still cached in state.
  const st = util.loadState();
  st.projects[key] = { events: [], teamEntries: [TEAM_ROW], teamPullTs: NOW };
  util.saveState(st);
  return key;
}

// Servable-from-stale-rows readers. Each one goes through util.teamRowsFor
// (search) or teamInjectSlice(teamRowsFor(...)) (MCP + block) or
// teamRowsFor directly (project detail). The suite asserts each answers
// UNCHANGED right after unlinking, then EMPTY after the reconciler pass —
// the whole surface the ticket names.
function readAll(key) {
  const state = util.loadState();
  const config = util.getConfig();
  const proj = state.projects[key];
  // Search via activity.allActivity, the function the FTS index freshens off
  // and searchMemory reads through. A hit against the teammate row's text is
  // what a stale row still surfaces.
  const regexes = digest.compileRedactions(config);
  const { team } = activity.allActivity(state, config, regexes, { selfUserId: 'me' });
  // MCP get_project_memory: the tool with the tightest contract about the
  // block, queryable — teamInjectSlice at 128 above.
  const mem = mcp.getProjectMemory(key);
  // The injected context block. renderBlock reads teamRowsFor and formats
  // "Teammates' AI activity", so a stale row shows up as a line under that
  // heading.
  const block = digest.renderBlock(key, proj, config, 'CLAUDE.md',
    digest.sessionGroups(key, proj, config), []);
  // /api/project — projectDetail reads teamRowsFor directly for the card at
  // the top of a project page.
  const detail = server.projectDetail(key);
  return {
    // Team rows from normalizeTeam carry projectPath=null (lib/feed.js:160) —
    // the field is only stamped for LOCAL entries. So a stale-row hit is
    // detected on projectId, which mapTeamRow carries through from the row.
    searchHits: team.filter(r => r.projectId === TEAM_ROW.project_id).length,
    mcpTeammates: mem && Array.isArray(mem.teammates) ? mem.teammates.length : -1,
    // "Teammates' AI activity" is the heading renderBlock uses (lib/digest.js
    // teamInjectSlice section). Its presence proves stale rows reached the
    // block; its absence proves the sweep removed them.
    blockHasTeammates: /Teammates' AI activity/.test(block),
    // projectDetail exposes the row list itself, not a separate count field.
    // (The `teammateActivity` counter lives on projectsPayload, not here.)
    detailTeamCount: detail && Array.isArray(detail.teamEntries) ? detail.teamEntries.length : -1,
  };
}

function main() {
  util.ensureConfig();

  const key = makeStale('stale');

  check('precondition: all four readers serve the stale teammate row before the sweep runs', () => {
    // Sanity — an unlinked project WITH cached rows in state is exactly what
    // the ticket describes, and every reader still fires. If any of these are
    // already zero, the fixture is wrong and every "went quiet" assertion
    // below would pass for the wrong reason.
    const out = readAll(key);
    assert.strictEqual(out.searchHits, 1, `search must see the stale row; got ${out.searchHits}`);
    assert.strictEqual(out.mcpTeammates, 1, `MCP must see the stale row; got ${out.mcpTeammates}`);
    assert.strictEqual(out.blockHasTeammates, true, 'the block must include a "Teammates\' AI activity" section');
    assert.strictEqual(out.detailTeamCount, 1, `project detail must list the stale row; got ${out.detailTeamCount}`);
  });

  check('precondition: teamRowsFor still serves the cached row (the pre-fix state)', () => {
    // The row cache is state — teamRowsFor is a pure function of proj, and
    // this is the "no gate has fired" branch. If this ever answered [] before
    // the sweep, teamRowsFor grew a filesystem check and the whole design
    // argument changed shape.
    const proj = (util.loadState().projects || {})[key];
    assert.strictEqual(util.teamRowsFor(proj).length, 1,
      'teamRowsFor must return the cached row until something writes state — that is what makes option 1 costly');
  });

  // ---- the fix: one reconciler pass on the shared afterTeamPull entry ---
  notesStore.afterTeamPull([]);

  check('after the sweep: teamEntries is emptied in state.json', () => {
    const proj = (util.loadState().projects || {})[key];
    assert.ok(proj, 'the project record must survive — this is a prune, not an unlink');
    assert.deepStrictEqual(proj.teamEntries, [], 'stale rows must be cleared');
    // teamPullTs is one unit with teamEntries: leaving a forward cursor over an
    // emptied cache means a later RE-LINK pulls only rows newer than the
    // cursor and silently never re-fetches the history behind it. Same
    // invariant pruneTeamEntries's own header asserts.
    assert.strictEqual(proj.teamPullTs, null,
      'teamPullTs must be nulled alongside teamEntries — the two are one unit');
  });

  check('after the sweep: FTS search returns no teammate hits for this project', () => {
    const out = readAll(key);
    assert.strictEqual(out.searchHits, 0,
      'search_memory read teamRowsFor; with the rows gone the hit must be gone too');
  });

  check('after the sweep: MCP get_project_memory reports zero teammates', () => {
    const out = readAll(key);
    assert.strictEqual(out.mcpTeammates, 0,
      'the block-queryable tool must not describe a project as having teammate activity');
  });

  check('after the sweep: the injected context block no longer carries a "Teammates\' AI activity" section', () => {
    const out = readAll(key);
    assert.strictEqual(out.blockHasTeammates, false,
      'renderBlock reads teamRowsFor(proj); with the rows gone the section drops');
  });

  check('after the sweep: /api/project detail reports zero teammate activity', () => {
    const out = readAll(key);
    assert.strictEqual(out.detailTeamCount, 0);
  });

  // ---- the invariants a broken sweep would violate --------------------
  check('the sweep does not touch a LINKED project (nothing to prune, no state write)', () => {
    // The rule is "no team.json on disk", not "has cached rows". A linked
    // project with cached rows must survive the pass unchanged, or every
    // healthy team install would lose its cache on the first sync.
    const linked = path.join(h.ROOT, 'projects', 'linked');
    fs.mkdirSync(path.join(linked, '.git'), { recursive: true });
    fs.mkdirSync(path.join(linked, memorydb.DIR_NAME), { recursive: true });
    fs.writeFileSync(teamsync.teamFilePath(linked), JSON.stringify({
      projectId: 'proj-linked', teamId: 'team-1', teamName: 'Team',
      linkedBy: 'me@test.dev', linkedAt: NOW,
    }));
    const st = util.loadState();
    st.projects[linked] = { events: [], teamEntries: [TEAM_ROW], teamPullTs: NOW };
    util.saveState(st);

    notesStore.afterTeamPull([]);

    const after = (util.loadState().projects || {})[linked];
    assert.strictEqual(after.teamEntries.length, 1, 'a linked project must keep its cached rows');
    assert.strictEqual(after.teamPullTs, NOW, 'and its pull cursor');
  });

  check('the sweep is idempotent: a second pass does not resurrect anything and writes nothing', () => {
    // Two passes over the same project must land in exactly the same state.
    // A double-emptied teamEntries stays [], and pruneTeamEntries reports
    // false on the no-op call — matching the header invariant on that
    // primitive (no save, no window).
    const before = fs.statSync(util.statePath()).mtimeMs;
    notesStore.afterTeamPull([]);
    const after = fs.statSync(util.statePath()).mtimeMs;
    assert.strictEqual(after, before, 'a second reconciler pass must not touch state.json');
    const proj = (util.loadState().projects || {})[key];
    assert.deepStrictEqual(proj.teamEntries, []);
    assert.strictEqual(proj.teamPullTs, null);
  });

  check('teamRowsFor stayed signature-stable — the win the argument is built on', () => {
    // Option 1 would have widened this to teamRowsFor(proj, projectPath).
    // Six call sites and a filesystem stat per read is the cost that made
    // option 2 win, and if a future change slips a path parameter in
    // silently, this check trips on the arity.
    assert.strictEqual(util.teamRowsFor.length, 1,
      'teamRowsFor accepts one argument (proj); a second parameter is the option-1 shape');
  });

  h.finish();
}

main();
