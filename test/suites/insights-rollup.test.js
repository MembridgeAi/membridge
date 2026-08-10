'use strict';
// /api/team/insights — the SERVER-SIDE aggregation path (055_team_insights_rollup).
//
// WHAT WAS WRONG. 027 moved the two headline counts (sessions, entries) into the
// database, and they have been exact ever since. The six BREAKDOWNS underneath
// them — perPerson, topProjects, byTool, concentration, membersSyncing and the
// silent-teammate check — kept being folded on this machine from rows pulled by
// paging team_feed, which stops at MAX_PAGES * TEAM_FEED_PAGE = 2,000 rows and,
// because paging walks BACKWARDS from newest, drops the OLDEST ones.
//
// Measured against production on 2026-08-08: 2,641 rows in a 30-day window,
// oldest 2026-07-13. So roughly a quarter of the data never reached those six.
// Three of them name a person to a manager — a teammate's own shared total,
// "only X has worked on this project", and "nothing has arrived from X" — so
// the cap did not produce a vaguely-low chart, it produced confident false
// sentences about named colleagues.
//
// THE SHAPE OF THESE CHECKS. One fixture row set, read two ways: a `teamFeed`
// stub that honours the real 200-row page ceiling and keyset paging, and a
// `teamInsightsRollup` stub that aggregates the same rows with no cap, standing
// in for the SQL. Anything that is true of the rows must survive both readers,
// and the capped one is allowed to say so.
//
// WHAT THESE CANNOT PROVE, STATED UP FRONT:
//   * Offline. The rollup stub here and test/mock-supabase.js's are JavaScript
//     stand-ins; neither exercises PL/pgSQL, and no offline test can tell you
//     that can_see_project or is_team_member behave in production the way the
//     migration assumes.
//   * They cannot tell you 055 is applied. Nothing offline can. The verify
//     query lives in supabase/MIGRATION-STATE.md.
//   * The `Distilled -> Codex` fold is pinned two ways below, and only one of
//     them can see the migration's own SQL text. See that check's comment.
//
// Opens no ports and starts no server, so it claims no harness port offset.
//
// Run directly, or via `node test/run.js insights-rollup`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const teamsync = require('../../lib/teamsync');
const apiInsights = require('../../lib/api-insights');
const { TEAM_FEED_PAGE, MAX_PAGES } = apiInsights;
const DAY = 86400000;
const CAP = MAX_PAGES * TEAM_FEED_PAGE; // 2,000 — the wall these checks are about

// ---------------------------------------------------------------------------
// The fixture backend. `rows` is the truth; both readers are derived from it,
// so a check comparing them is comparing two views of one fact rather than two
// hand-written expectations that could both be wrong together.
// ---------------------------------------------------------------------------
function stubTeam(rows, opts = {}) {
  const restore = {
    getAccessToken: teamsync.getAccessToken, listTeams: teamsync.listTeams,
    listMembers: teamsync.listMembers, teamFeedCounts: teamsync.teamFeedCounts,
    teamInsightsRollup: teamsync.teamInsightsRollup, teamFeed: teamsync.teamFeed,
  };
  const SELF = opts.selfId || 'me';
  const members = opts.members || [
    { user_id: SELF, display_name: 'Me', role: 'owner',
      joined_at: new Date(Date.now() - 200 * DAY).toISOString() },
  ];
  teamsync.getAccessToken = async () => ({ userId: SELF, accessToken: 'a' });
  teamsync.listTeams = async () => [{ team_id: 'T', name: 'T', role: 'owner' }];
  teamsync.listMembers = async () => members;
  teamsync.teamFeedCounts = async (config, teamId, o = {}) => {
    if (opts.exact === false) return null; // a backend predating 027
    const win = inWindow(rows, o.since, o.until);
    return { entries: win.length, sessions: sessionsOf(win) };
  };

  // Reader 1: the real page ceiling. 200 rows per call, keyset-paged, newest
  // first — the same shape team_feed enforces server-side at 013:64 / 025:134.
  teamsync.teamFeed = async (config, teamId, o = {}) => {
    const since = o.since ? Date.parse(o.since) : -Infinity;
    const before = o.beforeCreatedAt ? Date.parse(o.beforeCreatedAt) : Infinity;
    return rows
      .filter(r => Date.parse(r.ts) >= since && Date.parse(r.created_at) < before)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, Math.min(o.limit || 50, TEAM_FEED_PAGE));
  };

  // Reader 2: the rollup. NO cap — that is the entire point — and it is the
  // shape 055 returns. `opts.rollup === false` makes it answer null, which is
  // how lib/teamsync.js reports a backend that predates the migration.
  teamsync.teamInsightsRollup = async (config, teamId, o = {}) => {
    if (opts.rollup === false) return null;
    const win = inWindow(rows, o.since, o.until);
    return {
      by_author: group(win, r => r.author_id).map(([author_id, list]) => ({
        author_id, entries: list.length, sessions: sessionsOf(list),
      })),
      by_project: group(win, r => r.project_id).map(([project_id, list]) => ({
        project_id,
        project_name: list[0].project_name,
        sessions: sessionsOf(list),
        people: new Set(list.filter(r => r.author_id).map(r => r.author_id)).size,
        recent_author_name: [...list].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0].author_name,
      })),
      // The fold happens INSIDE the grouping, as the migration's
      // `case when source = 'Distilled' then 'Codex'` does — never after.
      by_source: group(win, r => (r.source === 'Distilled' ? 'Codex' : (r.source || '')))
        .map(([tool, list]) => ({ tool, sessions: sessionsOf(list) })),
      // Unbounded by the window, as 055's last_shared CTE is.
      last_shared: group(rows, r => r.author_id).map(([author_id, list]) => ({
        author_id, ts: [...list].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0].ts,
      })),
      earliest_ts: rows.length
        ? [...rows].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))[0].ts
        : null,
    };
  };
  return { restore: () => Object.assign(teamsync, restore) };
}

const inWindow = (rows, since, until) => rows.filter(r => {
  const t = Date.parse(r.ts);
  return (!since || t >= Date.parse(since)) && (!until || t <= Date.parse(until));
});
// 027's expression: distinct sessions, plus session-less rows as one unit each.
const sessionsOf = list =>
  new Set(list.filter(r => r.session).map(r => r.session)).size
  + list.filter(r => !r.session).length;
function group(rows, keyOf) {
  const out = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (k === null || k === undefined) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return [...out];
}

// A row set that comfortably exceeds the 2,000-row cap, spread over `spanDays`
// so a window can slice it. Three authors, three projects, two sources.
const AUTHORS = [
  { id: 'me', name: 'Me' },
  { id: 'ana', name: 'Ana' },
  { id: 'bo', name: 'Bo' },
];
function bigFixture({ total = CAP + 641, spanDays = 26, now = Date.now() } = {}) {
  return Array.from({ length: total }, (_, i) => {
    // Newest first by index, spread evenly across the span.
    const ts = new Date(now - Math.floor((i / total) * spanDays * DAY) - 60000).toISOString();
    const a = AUTHORS[i % AUTHORS.length];
    return {
      id: `r${i}`, ts, created_at: ts,
      author_id: a.id, author_name: a.name,
      project_id: `P${i % 3}`, project_name: `Project ${i % 3}`,
      source: i % 2 ? 'Claude Code' : 'Codex',
      session: `s${Math.floor(i / 4)}`,
    };
  });
}

// What the fixture ACTUALLY contains for a window, computed straight off the
// rows. Deliberately not reusing the payload's own helpers: an expectation
// derived from the code under test proves only that the code agrees with itself.
function truthFor(rows, windowDays, now) {
  const win = inWindow(rows, new Date(now - windowDays * DAY).toISOString(), new Date(now).toISOString());
  return {
    entries: win.length,
    perAuthor: new Map(group(win, r => r.author_id)
      .map(([id, list]) => [id, { entries: list.length, sessions: sessionsOf(list) }])),
    authorsActive: new Set(win.map(r => r.author_id)).size,
  };
}

async function main() {
  // -------------------------------------------------------------------------
  // 1. THE RED PROOF. Over the cap, the breakdowns are totals, not floors.
  // -------------------------------------------------------------------------
  await check('OVER THE 2,000-ROW CAP: per-person totals are the real totals, and nothing is truncated', async () => {
    const now = Date.now();
    const rows = bigFixture({ now });
    assert.ok(rows.length > CAP,
      `precondition: the fixture must exceed the cap (${rows.length} vs ${CAP})`);
    const members = AUTHORS.map(a => ({
      user_id: a.id, display_name: a.name, role: a.id === 'me' ? 'owner' : 'member',
      joined_at: new Date(now - 200 * DAY).toISOString(),
    }));
    const stub = stubTeam(rows, { members });
    try {
      const out = await apiInsights.insightsPayload({}, 30, {}, 'T');
      const truth = truthFor(rows, 30, now);

      assert.strictEqual(out.truncated, false,
        'the rollup has no row limit, so there is nothing left to truncate');

      // The load-bearing assertion. Against the paged fold these come back
      // short by whatever fell off the tail past row 2,000.
      for (const a of AUTHORS) {
        const got = out.perPerson.find(p => p.id === a.id);
        const want = truth.perAuthor.get(a.id);
        assert.strictEqual(got.shared, want.entries,
          `${a.name}: shared must be the real total, got ${got.shared} want ${want.entries}`);
        assert.strictEqual(got.sessions, want.sessions,
          `${a.name}: sessions must be the real total, got ${got.sessions} want ${want.sessions}`);
      }
      // And the per-person totals must add up to the headline the DB counted,
      // which is the cross-check that would catch a plausible-but-wrong fold.
      const summed = out.perPerson.reduce((n, p) => n + p.shared, 0);
      assert.strictEqual(summed, out.entriesShared.count,
        `perPerson must sum to entriesShared (${summed} vs ${out.entriesShared.count})`);
      assert.strictEqual(summed, truth.entries,
        `and both must equal the fixture's real entry count (${truth.entries})`);

      assert.strictEqual(out.membersSyncing.ok, truth.authorsActive,
        'membersSyncing counts everyone with an entry in the window');
      const projectSessions = out.topProjects.reduce((n, p) => n + p.sessions, 0);
      assert.ok(projectSessions > 0 && out.topProjects.length === 3,
        `all three projects must be present, got ${JSON.stringify(out.topProjects)}`);
    } finally { stub.restore(); }
  });

  // -------------------------------------------------------------------------
  // 2. Window size is not a correctness variable any more.
  // -------------------------------------------------------------------------
  await check('a 90-day window is exactly as correct as a 7-day one', async () => {
    const now = Date.now();
    // 120 days of history so a 90-day window has something to be wrong about.
    const rows = bigFixture({ total: CAP + 1500, spanDays: 120, now });
    const members = AUTHORS.map(a => ({
      user_id: a.id, display_name: a.name, role: a.id === 'me' ? 'owner' : 'member',
      joined_at: new Date(now - 400 * DAY).toISOString(),
    }));
    const stub = stubTeam(rows, { members });
    try {
      for (const w of [7, 30, 90]) {
        const out = await apiInsights.insightsPayload({}, w, {}, 'T');
        const truth = truthFor(rows, w, now);
        assert.strictEqual(out.truncated, false, `window=${w}: nothing to truncate`);
        const summed = out.perPerson.reduce((n, p) => n + p.shared, 0);
        assert.strictEqual(summed, truth.entries,
          `window=${w}: per-person totals must equal the real total (${summed} vs ${truth.entries})`);
        for (const a of AUTHORS) {
          assert.strictEqual(out.perPerson.find(p => p.id === a.id).sessions,
            truth.perAuthor.get(a.id).sessions, `window=${w}: ${a.name}'s session count`);
        }
      }
    } finally { stub.restore(); }
  });

  // -------------------------------------------------------------------------
  // 3. A young team is fully covered, not short.
  // -------------------------------------------------------------------------
  await check('a team younger than the window reports FULL coverage, not invented missing days', async () => {
    // The live case, reduced: 26 days of history, a 30-day window. The old
    // payload reported "30 requested, 25 reached" — and four of those five
    // missing days had never existed, because the team was only 26 days old.
    // Measuring coverage against real earliest activity instead would still
    // report 26 against 30: the same false shortfall, one size smaller. What
    // the banner actually asks is "did we search everywhere we were asked to",
    // and an uncapped aggregate did.
    const now = Date.now();
    const rows = bigFixture({ total: CAP + 641, spanDays: 26, now });
    const members = AUTHORS.map(a => ({
      user_id: a.id, display_name: a.name, role: a.id === 'me' ? 'owner' : 'member',
      joined_at: new Date(now - 26 * DAY).toISOString(),
    }));
    const stub = stubTeam(rows, { members });
    try {
      const out = await apiInsights.insightsPayload({}, 30, {}, 'T');
      assert.strictEqual(out.truncated, false);
      assert.strictEqual(out.coveredDays, 60,
        'a complete read covers the whole requested span, however young the team is');
      assert.strictEqual(out.lookbackDays, out.coveredDays);
      assert.ok(out.coveredDays >= out.window,
        `coverage must never read as a shortfall against the window ` +
        `(covered ${out.coveredDays}, window ${out.window})`);
    } finally { stub.restore(); }
  });

  await check('the sentences that NAME A PERSON are bounded by the team\'s real history', async () => {
    // The other half of the young-team problem, and the higher-stakes half.
    // coveredDays is 60 above; quoting 60 in "0 entries shared in the last Nd"
    // about a named teammate, on a team that has existed for 26 days,
    // overstates their silence by more than the team has been alive.
    const now = Date.now();
    const rows = bigFixture({ total: 400, spanDays: 26, now })
      // One project only ever touched by Me, so concentration has something to
      // say; and Quiet is a member with no rows at all.
      .concat([{
        id: 'solo', ts: new Date(now - 2 * DAY).toISOString(),
        created_at: new Date(now - 2 * DAY).toISOString(),
        author_id: 'me', author_name: 'Me',
        project_id: 'PSOLO', project_name: 'Solo project',
        source: 'Codex', session: 'ssolo',
      }]);
    const members = [
      ...AUTHORS.map(a => ({ user_id: a.id, display_name: a.name,
        role: a.id === 'me' ? 'owner' : 'member',
        joined_at: new Date(now - 26 * DAY).toISOString() })),
      { user_id: 'quiet', display_name: 'Quiet Person', role: 'member',
        joined_at: new Date(now - 26 * DAY).toISOString() },
    ];
    const stub = stubTeam(rows, { members });
    try {
      const out = await apiInsights.insightsPayload({}, 30, {}, 'T');
      assert.strictEqual(out.coveredDays, 60, 'precondition: the read was complete');

      const silent = out.problems.find(p => p.id === 'silent:quiet');
      assert.ok(silent, `expected a silent-teammate problem, got ${JSON.stringify(out.problems)}`);
      const said = Number(/0 entries shared in the last (\d+)d/.exec(silent.scale)[1]);
      assert.ok(said <= 26,
        `a silence claim may not outrun the team's own history: said ${said}d, team is 26d old`);

      const conc = out.concentration.find(c => c.projectName === 'Solo project');
      assert.ok(conc, `expected a concentration row, got ${JSON.stringify(out.concentration)}`);
      const cSaid = Number(/in the last (\d+)d/.exec(conc.detail)[1]);
      assert.ok(cSaid <= 26,
        `an exclusivity claim may not outrun the team's own history: said ${cSaid}d`);
      // ...and never wider than the window the group was built from either.
      assert.ok(cSaid <= out.window,
        `nor the window it was computed over: said ${cSaid}d for a ${out.window}d window`);
    } finally { stub.restore(); }
  });

  // -------------------------------------------------------------------------
  // 4. The flag still tells the truth when the read really is incomplete.
  // -------------------------------------------------------------------------
  await check('PRE-055 BACKEND: a genuinely capped read still reports truncated', async () => {
    // The honesty half. `truncated: false` above must be earned by the rollup
    // actually running, not hardcoded — so the same fixture on a backend
    // without the function must come back the old way and SAY it is a floor.
    const now = Date.now();
    const rows = bigFixture({ total: CAP + 641, spanDays: 26, now });
    const members = AUTHORS.map(a => ({
      user_id: a.id, display_name: a.name, role: a.id === 'me' ? 'owner' : 'member',
      joined_at: new Date(now - 200 * DAY).toISOString(),
    }));
    const stub = stubTeam(rows, { members, rollup: false });
    try {
      const out = await apiInsights.insightsPayload({}, 30, {}, 'T');
      assert.strictEqual(out.truncated, true,
        'a fetch that filled every page is a floor, and must say so');
      assert.ok(out.coveredDays < 60,
        `and coverage drops to the real floor of what was read, got ${out.coveredDays}`);
      const summed = out.perPerson.reduce((n, p) => n + p.shared, 0);
      assert.ok(summed <= CAP,
        `precondition: the paged path really is capped (${summed} rows folded)`);
      assert.ok(summed < truthFor(rows, 30, now).entries,
        'and it really is short of the truth — which is the whole reason for 055');
    } finally { stub.restore(); }
  });

  await check('055 WITHOUT 027: the headline counts are real, never a fabricated zero', async () => {
    // Found while reviewing this change, and it was mine. 055 feeds the
    // BREAKDOWNS; 027 feeds the two headline counts. Taking the rollup path on
    // 055 alone skips the paged fetch — and the counts fall through to the
    // paged figures, which are then empty. The payload published
    // `entriesShared: 0` beside a correct per-person total of 500: "your team
    // shared nothing", contradicted three fields further down its own response.
    //
    // Reachable, not theoretical: migrations here are applied by hand and out
    // of order, and supabase/MIGRATION-STATE.md records that as this project's
    // normal state. The gate is therefore BOTH migrations. Without 027 this
    // pages the old way and says exact:false — capped but honest.
    const now = Date.now();
    const rows = bigFixture({ total: 500, spanDays: 10, now });
    const members = AUTHORS.map(a => ({
      user_id: a.id, display_name: a.name, role: a.id === 'me' ? 'owner' : 'member',
      joined_at: new Date(now - 200 * DAY).toISOString(),
    }));
    const stub = stubTeam(rows, { members, exact: false }); // 055 yes, 027 no
    try {
      const out = await apiInsights.insightsPayload({}, 30, {}, 'T');
      const truth = truthFor(rows, 30, now);
      assert.strictEqual(out.exact, false, 'without 027 the counts are not database-measured');
      assert.strictEqual(out.entriesShared.count, truth.entries,
        `entriesShared must be counted, not zeroed (got ${out.entriesShared.count}, `
        + `true ${truth.entries})`);
      assert.ok(out.sessions.count > 0,
        `sessions must be counted, not zeroed (got ${out.sessions.count})`);
      // The contradiction that made this visible: the two halves must agree.
      const summed = out.perPerson.reduce((n, p) => n + p.shared, 0);
      assert.strictEqual(summed, out.entriesShared.count,
        `perPerson (${summed}) and entriesShared (${out.entriesShared.count}) must not `
        + 'disagree inside one response');
    } finally { stub.restore(); }
  });

  await check('a rollup that answers with the wrong shape is NOT treated as an empty team', async () => {
    // The signature defect of this codebase, guarded at the seam: a success
    // flag set on a path that achieved nothing. teamsync.teamInsightsRollup
    // returns null for a malformed answer, which must land on the paged
    // fallback (and report truncated honestly) rather than publishing zeroed
    // breakdowns as though they had been measured.
    const now = Date.now();
    const rows = bigFixture({ total: 300, spanDays: 10, now });
    const members = AUTHORS.map(a => ({
      user_id: a.id, display_name: a.name, role: a.id === 'me' ? 'owner' : 'member',
      joined_at: new Date(now - 200 * DAY).toISOString(),
    }));
    const stub = stubTeam(rows, { members });
    const realRollup = teamsync.teamInsightsRollup;
    teamsync.teamInsightsRollup = async () => null; // what the wrapper yields for a bad shape
    try {
      const out = await apiInsights.insightsPayload({}, 30, {}, 'T');
      const summed = out.perPerson.reduce((n, p) => n + p.shared, 0);
      assert.ok(summed > 0,
        'the fallback must actually count, not publish an empty team');
      assert.strictEqual(summed, truthFor(rows, 30, now).entries,
        'and under the cap the paged fold is still exact');
    } finally { teamsync.teamInsightsRollup = realRollup; stub.restore(); }
  });

  // -------------------------------------------------------------------------
  // 5. Nothing raw leaves the module.
  // -------------------------------------------------------------------------
  await check('no raw team_feed row reaches the payload', async () => {
    // The module's own spec: "aggregate server-side; raw rows are never shipped
    // to the client". Moving the aggregation into the database should make that
    // more true, not less — so this walks the whole serialised payload looking
    // for any key that only ever exists on a feed row.
    const now = Date.now();
    const rows = bigFixture({ total: 500, spanDays: 10, now }).map(r => ({
      ...r, ciphertext: 'CIPHER', nonce: 'NONCE', ask: 'ASK', summary: 'SUMMARY',
      files: ['a.js'], goal: 'GOAL', decisions: 'D', gotchas: 'G', key_epoch: 3,
    }));
    const members = AUTHORS.map(a => ({
      user_id: a.id, display_name: a.name, role: a.id === 'me' ? 'owner' : 'member',
      joined_at: new Date(now - 200 * DAY).toISOString(),
    }));
    const FORBIDDEN = ['ciphertext', 'nonce', 'ask', 'summary', 'files', 'goal',
      'decisions', 'gotchas', 'key_epoch', 'created_at', 'project_id', 'author_id'];
    for (const rollup of [true, false]) {
      const stub = stubTeam(rows, { members, rollup });
      try {
        const out = await apiInsights.insightsPayload({}, 30, {}, 'T');
        const hits = [];
        (function walk(node, at) {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${at}[${i}]`));
          for (const [k, v] of Object.entries(node)) {
            if (FORBIDDEN.includes(k)) hits.push(`${at}.${k}`);
            walk(v, `${at}.${k}`);
          }
        })(out, 'payload');
        assert.deepStrictEqual(hits, [],
          `rollup=${rollup}: raw feed-row fields reached the payload: ${hits.join(', ')}`);
        // And no fixture VALUE leaked under some other key name.
        const blob = JSON.stringify(out);
        for (const secret of ['CIPHER', 'NONCE', 'SUMMARY', 'GOTCHA']) {
          assert.ok(!blob.includes(secret),
            `rollup=${rollup}: "${secret}" appears in the payload`);
        }
      } finally { stub.restore(); }
    }
  });

  // -------------------------------------------------------------------------
  // 6. The one rule that is deliberately written twice.
  // -------------------------------------------------------------------------
  await check('the Distilled -> Codex fold means the same thing on both aggregation paths', async () => {
    // WHY THE DUPLICATION IS FORCED. Two source values fold to one tool, and
    // distinct-SESSION counts across them cannot be summed afterwards — a
    // session that emitted rows under both spellings would be counted twice.
    // So the fold has to happen inside the group-by, which means it exists in
    // SQL (055) as well as in JS (publicSource). The alternative is shipping
    // session ids to the client, which this module refuses to do.
    //
    // This is the strong half of the pin, and it needs no text parsing: run the
    // SAME rows through BOTH paths and require the same answer. Edit either
    // fold alone and this goes red.
    const now = Date.now();
    const base = new Date(now - 2 * DAY).toISOString();
    // The exact case that breaks a fold-after-grouping implementation: ONE
    // session emitting rows under both 'Codex' and 'Distilled'.
    const rows = [
      { id: 'a', ts: base, created_at: base, author_id: 'me', author_name: 'Me',
        project_id: 'P0', project_name: 'P0', source: 'Codex', session: 'shared' },
      { id: 'b', ts: base, created_at: base, author_id: 'me', author_name: 'Me',
        project_id: 'P0', project_name: 'P0', source: 'Distilled', session: 'shared' },
      { id: 'c', ts: base, created_at: base, author_id: 'me', author_name: 'Me',
        project_id: 'P0', project_name: 'P0', source: 'Claude Code', session: 'other' },
    ];
    const byPath = {};
    for (const rollup of [true, false]) {
      const stub = stubTeam(rows, { rollup });
      try {
        byPath[rollup] = (await apiInsights.insightsPayload({}, 30, {}, 'T')).byTool;
      } finally { stub.restore(); }
    }
    assert.deepStrictEqual(byPath.true, byPath.false,
      'the two paths disagree about tools — one side of the Distilled/Codex fold has drifted:\n'
      + `  rollup: ${JSON.stringify(byPath.true)}\n  paged:  ${JSON.stringify(byPath.false)}`);
    const codex = byPath.true.find(t => t.tool === 'Codex');
    assert.ok(codex, `expected a Codex row, got ${JSON.stringify(byPath.true)}`);
    assert.strictEqual(codex.sessions, 1,
      'one session emitting both spellings is ONE session, not two — the double-count '
      + 'a fold applied after the group-by would produce');
    assert.ok(!byPath.true.some(t => t.tool === 'Distilled'),
      '"Distilled" is an internal marker and must never reach the wire as a tool name');
  });

  await check('...and the migration spells that fold the same way', async () => {
    // The weak half, and the ONLY offline check that can see the SQL at all.
    // The check above compares two JavaScript readers; if someone changed both
    // of them and left the migration behind, only this notices.
    //
    // Deliberately one normalised substring, not a parser. If it fails because
    // the SQL was merely reformatted, widen the whitespace normalisation — do
    // not delete the check; and if it fails because the mapping really changed,
    // publicSource in lib/api-insights.js and the fold in test/mock-supabase.js
    // are the two other places that have to move with it.
    const sql = fs.readFileSync(path.join(__dirname, '..', '..',
      'supabase', 'migrations', '055_team_insights_rollup.sql'), 'utf8');
    const flat = sql.replace(/\s+/g, ' ');
    // Tolerant of an optional table qualifier (`win.source`) and of whitespace,
    // because both are formatting; intolerant of the two literals changing,
    // because that is the mapping. This check has already earned its keep once:
    // it fired when the migration's columns were qualified during review, which
    // is precisely the "did anyone edit this line" signal it exists to give.
    assert.match(flat, /case when (?:\w+\.)?source = 'Distilled' then 'Codex'/,
      "055's by_source CTE no longer carries the Distilled -> Codex fold that "
      + 'lib/api-insights.js publicSource and test/mock-supabase.js both implement');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
