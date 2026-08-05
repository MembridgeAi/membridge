'use strict';
// /api/team/insights — the truncation and lookback contract on the wire.
//
// WHAT USED TO SHIP AND WHY IT WAS WRONG. `truncated` was masked before it left
// this module:
//
//   truncated: Boolean(truncated && !(exactCurrent && exactPrior))
//
// The two flags describe DIFFERENT things and one silenced the other. `exact`
// covers the two headline COUNTS (sessions and entries), which 027 counts in the
// database and is now always true in production. `truncated` covers the FEED
// FETCH, whose 10-page cap still limits everything BUILT from those pages —
// perPerson, topProjects, byTool, concentration, membersSyncing, problems. With
// 027 applied on production, the mask made `truncated` always false, and the
// UI's honesty layer sat behind it and never fired.
//
// Two related sentences overstated in the same way. `concentration.detail` said
// "only X has worked on this project in the last 30d" against rows that reached
// 12d back; the silent-teammate scale sentence used to have the same defect and
// was already bounded to `lookbackDays`, this is the same rule applied one
// sentence over. And `severityOf`'s `minor` branch is unreachable through the
// silent-teammate builder (the grace-period `continue` refuses every
// `sinceHours < 24` case before severityOf is called), so the call is now
// hardcoded to 'broken' rather than routed through a helper that pretends the
// answer might vary.
//
// WHAT THESE CANNOT PROVE. `lookbackDays` and `oldestTs` are computed off the
// row set fetchSince returned; a real backend disagreeing with the mock about
// what rows exist inside a time bound is not observable here. And these test the
// wire, not the client — the UI's own reading of these fields is
// InsightsPage.test.tsx's job.
//
// Run directly, or via `node test/run.js insights-truncation`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const teamsync = require('../../lib/teamsync');
const apiInsights = require('../../lib/api-insights');
const { TEAM_FEED_PAGE, MAX_PAGES } = apiInsights;
const DAY = 86400000;

// A fake team backend, enough for insightsPayload. `rows` are the team_feed
// rows; everything else is one-line canned. Records every call so the ordering
// checks in other suites can share the shape if useful.
function stubTeam(rows, opts = {}) {
  const restore = {
    getAccessToken: teamsync.getAccessToken, listTeams: teamsync.listTeams,
    listMembers: teamsync.listMembers, teamFeedCounts: teamsync.teamFeedCounts,
    teamFeed: teamsync.teamFeed,
  };
  const SELF = opts.selfId || 'me';
  const members = opts.members || [
    { user_id: SELF, display_name: 'Me', role: 'owner',
      joined_at: new Date(Date.now() - 200 * DAY).toISOString() },
    { user_id: 'quiet', display_name: 'Quiet Person', role: 'member',
      joined_at: new Date(Date.now() - 200 * DAY).toISOString() },
  ];
  const calls = [];
  teamsync.getAccessToken = async () => ({ userId: SELF, accessToken: 'a' });
  teamsync.listTeams = async () => [{ team_id: 'T', name: 'T', role: 'owner' }];
  teamsync.listMembers = async () => members;
  teamsync.teamFeedCounts = async () => (opts.exact === false ? null : { sessions: 0, entries: rows.length });
  teamsync.teamFeed = async (config, teamId, o = {}) => {
    calls.push({ since: o.since || null, until: o.until || null,
      before: o.beforeCreatedAt || null, limit: o.limit });
    const since = o.since ? Date.parse(o.since) : -Infinity;
    const until = o.until ? Date.parse(o.until) : Infinity;
    const before = o.beforeCreatedAt ? Date.parse(o.beforeCreatedAt) : Infinity;
    return rows
      .filter(r => Date.parse(r.ts) >= since && Date.parse(r.ts) <= until
        && Date.parse(r.created_at) < before)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, o.limit || 50);
  };
  return { calls, restore: () => Object.assign(teamsync, restore) };
}

async function main() {
  // ---- flag: truncated no longer masked by exact -------------------------

  await check('CURRENT BACKEND (exact=true), untruncated fetch: truncated=false, both spans full', async () => {
    const now = Date.now();
    const rows = [{ id: 'r1', ts: new Date(now - 3 * DAY).toISOString(),
      created_at: new Date(now - 3 * DAY).toISOString(), author_id: 'me', author_name: 'Me' }];
    const stub = stubTeam(rows);
    try {
      const out = await apiInsights.insightsPayload({}, 30, {}, 'T');
      assert.strictEqual(out.exact, true, 'sanity: 027 counts are always exact on a current backend');
      assert.strictEqual(out.truncated, false, 'a short fetch is not truncated');
      assert.strictEqual(out.lookbackDays, 60, '30d window => the fetch spans priorStart..now = 60d, complete');
      assert.strictEqual(out.coveredDays, 60);
    } finally { stub.restore(); }
  });

  await check('CURRENT BACKEND (exact=true), CAPPED fetch: truncated=true, lookbackDays SHRINKS to what was reached', async () => {
    // THE REGRESSION THIS ENDPOINT WAS SHIPPING. Before the un-mask, the same
    // fixture returned truncated=false against a current backend, silencing the
    // UI's cap notice everywhere the fetch actually stopped short.
    const now = Date.now();
    // MAX_PAGES * TEAM_FEED_PAGE + a buffer, all clustered close together so the
    // paged walk fills every page and never runs out.
    const total = MAX_PAGES * TEAM_FEED_PAGE + 200;
    const rows = Array.from({ length: total }, (_, i) => {
      const t = new Date(now - i * 1000).toISOString();
      return { id: `r${i}`, ts: t, created_at: t, author_id: 'me', author_name: 'Me' };
    });
    const stub = stubTeam(rows);
    try {
      const out = await apiInsights.insightsPayload({}, 30, {}, 'T');
      assert.strictEqual(out.exact, true, 'sanity: 027 is applied');
      assert.strictEqual(out.truncated, true,
        'a fetch that filled every page must be reported truncated regardless of exact');
      assert.ok(out.lookbackDays >= 1 && out.lookbackDays < 60,
        `lookbackDays must be the smaller floor the fetch actually reached, got ${out.lookbackDays}`);
      assert.strictEqual(out.coveredDays, out.lookbackDays,
        'coveredDays and lookbackDays are the same number under two names');
    } finally { stub.restore(); }
  });

  await check('PRE-027 BACKEND (exact=false), CAPPED: still truncated=true (never regressed)', async () => {
    // The path that used to work by accident: with exact=false, the mask
    // collapsed to `truncated && true`. This is the same fixture as above with
    // the counts RPC stubbed to null, so this side keeps working.
    const now = Date.now();
    const total = MAX_PAGES * TEAM_FEED_PAGE + 200;
    const rows = Array.from({ length: total }, (_, i) => {
      const t = new Date(now - i * 1000).toISOString();
      return { id: `r${i}`, ts: t, created_at: t, author_id: 'me' };
    });
    const stub = stubTeam(rows, { exact: false });
    try {
      const out = await apiInsights.insightsPayload({}, 30, {}, 'T');
      assert.strictEqual(out.exact, false);
      assert.strictEqual(out.truncated, true);
      // On the paged fallback the caller reads the FLOOR — a lower bound. That
      // is what makes suppressing the delta correct: a starved prior window is
      // not a real baseline.
      assert.strictEqual(out.entriesShared.delta, null,
        'the paged fallback suppresses its delta on a truncated fetch — starved baseline');
    } finally { stub.restore(); }
  });

  // ---- serialisation: lookbackDays / coveredDays --------------------------

  await check('lookbackDays and coveredDays are on the wire and non-null on every populated path', async () => {
    const now = Date.now();
    const rows = [{ id: 'r1', ts: new Date(now - 3 * DAY).toISOString(),
      created_at: new Date(now - 3 * DAY).toISOString(), author_id: 'me', author_name: 'Me' }];
    const stub = stubTeam(rows);
    try {
      for (const w of [7, 30, 90]) {
        const out = await apiInsights.insightsPayload({}, w, {}, 'T');
        assert.strictEqual(typeof out.lookbackDays, 'number', `window=${w}: lookbackDays must be a number`);
        assert.strictEqual(typeof out.coveredDays, 'number', `window=${w}: coveredDays must be a number`);
        assert.strictEqual(out.lookbackDays, out.coveredDays);
        assert.strictEqual(out.coveredDays, w * 2, 'an untruncated fetch covers priorStart..now (2 windows)');
      }
    } finally { stub.restore(); }
  });

  await check('the empty (solo / signed-out) payload still carries the two spans', async () => {
    // Contract equality: a client-side shape check on Insights that mounts
    // solo-first must not have to tolerate two different payload shapes.
    const restore = {
      getAccessToken: teamsync.getAccessToken, listTeams: teamsync.listTeams,
    };
    teamsync.getAccessToken = async () => null;
    teamsync.listTeams = async () => [];
    try {
      const out = await apiInsights.insightsPayload({}, 30, {});
      assert.strictEqual(out.truncated, false);
      assert.strictEqual(out.lookbackDays, 60);
      assert.strictEqual(out.coveredDays, 60);
    } finally { Object.assign(teamsync, restore); }
  });

  // ---- the sentences ------------------------------------------------------

  await check('CONCENTRATION detail quotes coverage, not the requested window, on a truncated fetch', async () => {
    // The exact overstatement the ticket names: "in the last 30d" against rows
    // that reached 12d back. concentration lands when a project has one person.
    const now = Date.now();
    const total = MAX_PAGES * TEAM_FEED_PAGE + 200;
    const rows = Array.from({ length: total }, (_, i) => {
      const t = new Date(now - i * 1000).toISOString();
      return { id: `r${i}`, ts: t, created_at: t, author_id: 'me', author_name: 'Me',
        project_id: 'P1', project_name: 'One-owner' };
    });
    const stub = stubTeam(rows);
    try {
      const out = await apiInsights.insightsPayload({}, 30, {}, 'T');
      assert.strictEqual(out.truncated, true, 'precondition: the fetch stopped at the cap');
      const c = out.concentration.find(x => x.projectName === 'One-owner');
      assert.ok(c, `expected a concentration row, got ${JSON.stringify(out.concentration)}`);
      const m = /in the last (\d+)d/.exec(c.detail);
      assert.ok(m, `concentration.detail must quote a day count: ${c.detail}`);
      const quoted = Number(m[1]);
      assert.strictEqual(quoted, out.lookbackDays,
        `the sentence must quote lookbackDays (${out.lookbackDays}), got ${quoted} in "${c.detail}"`);
      assert.ok(quoted < 60,
        'and must never quote the full requested range on a truncated fetch');
    } finally { stub.restore(); }
  });

  await check('an UNTRUNCATED fetch still quotes the full requested lookback in concentration', async () => {
    // The other direction: coveredDays must not narrow a claim that was in fact
    // exhaustive. Regression guard against a rewrite that always uses the smaller.
    const now = Date.now();
    const rows = [{ id: 'r1', ts: new Date(now - 3 * DAY).toISOString(),
      created_at: new Date(now - 3 * DAY).toISOString(), author_id: 'me', author_name: 'Me',
      project_id: 'P1', project_name: 'One-owner' }];
    const stub = stubTeam(rows);
    try {
      const out = await apiInsights.insightsPayload({}, 30, {}, 'T');
      assert.strictEqual(out.truncated, false);
      const c = out.concentration.find(x => x.projectName === 'One-owner');
      assert.ok(c);
      assert.match(c.detail, /in the last 60d/,
        `a complete 30d fetch reaches priorStart..now = 60d: "${c.detail}"`);
    } finally { stub.restore(); }
  });

  // ---- severity: 'minor' unreachable through this problem builder ---------

  await check("silent-teammate severity is always 'broken' — the 'minor' branch is unreachable here", async () => {
    // Ticket finding: `severityOf`'s minor branch is dead through the
    // silent-teammate call site because the grace-period `continue` refuses
    // sinceHours < 24 before severityOf is called. Two arms: (1) a real absence
    // survives and reads 'broken'; (2) a member young enough to be minor is
    // filtered before reaching a problem at all. That is the whole
    // reachability argument.
    const now = Date.now();
    // (2) the grace-period filter: this member joined 10 hours ago and never
    // shared. severityOf({sinceHours:10, failing:1, population:2}) would return
    // 'minor', but the grace period skips them before the problem is built.
    const graced = { user_id: 'fresh', display_name: 'Fresh', role: 'member',
      joined_at: new Date(now - 10 * 3600 * 1000).toISOString() };
    // (1) a real absence: joined 200 days ago, no rows at all.
    const absent = { user_id: 'absent', display_name: 'Absent', role: 'member',
      joined_at: new Date(now - 200 * DAY).toISOString() };
    const self = { user_id: 'me', display_name: 'Me', role: 'owner',
      joined_at: new Date(now - 200 * DAY).toISOString() };
    const stub = stubTeam([], { members: [self, graced, absent] });
    try {
      const out = await apiInsights.insightsPayload({}, 30, {}, 'T');
      const problems = out.problems || [];
      const freshProblem = problems.find(p => p.id.endsWith(':fresh'));
      const absentProblem = problems.find(p => p.id.endsWith(':absent'));
      assert.strictEqual(freshProblem, undefined,
        'a member within the 24h grace period must not surface a problem at all');
      assert.ok(absentProblem, 'an absent-for-200-days member must surface a problem');
      assert.strictEqual(absentProblem.severity, 'broken',
        'and it must be broken, always — the minor branch is unreachable here');
    } finally { stub.restore(); }
  });

  await check("severityOf itself is unchanged: the 'minor' branch still works for future callers", async () => {
    // The dead-code fix must not remove the reusable helper. Same three
    // spec cases test/run-tests.js already runs, replayed here to pin that this
    // suite is not the one that broke them.
    assert.strictEqual(apiInsights.severityOf({ failing: 47, population: 47, sinceHours: 1 }), 'broken');
    assert.strictEqual(apiInsights.severityOf({ failing: 2, population: 412, sinceHours: 1 }), 'minor');
    assert.strictEqual(apiInsights.severityOf({ failing: 1, population: 100, sinceHours: 48 }), 'broken');
  });

  h.finish();
}

main().catch(err => { console.error(err); process.exit(1); });
