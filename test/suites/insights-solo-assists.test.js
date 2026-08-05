'use strict';
// #82: a solo daemon must not report a team-derived figure on the currently-
// solo Insights payload.
//
// THE OBSERVATION. A solo install returns
//   assists.byKind = { recallServed: N, teammateNotes: 43 }
// alongside perPerson: [] and membersSyncing: {ok:0,total:0}. The 43 is real
// — the local ledger accumulates `notesInjections` across the lifetime of the
// install, and a daemon that USED to be on a team keeps that count forever —
// but it is misplaced. This screen describes the CURRENT team state; a number
// labelled `teammateNotes` next to "no teammates" reads like a defect.
//
// THE CHOICE. Two shapes were on the table:
//   1. Zero the team-derived figure on the currently-solo payload, preserve
//      `recallServed` (this machine's own past-session skeleton serves), and
//      recompute `total`. Historical count is still on disk in /api/savings.
//   2. Rename the field to "notes retrieved from my own past sessions."
// Chose 1. The name `teammateNotes` is FACTUALLY ACCURATE — the counter grows
// exclusively when the notes hook injects a teammate-derived note
// (lib/teammate-notes-store.js's rebuildTeammateNotes is its only writer) —
// so a rename to "own past sessions" would MISDESCRIBE what is counted. It
// would turn a shape mismatch into a labelling error, which is worse. See the
// header comment in emptyInsights for the argument recorded next to the code.
//
// WHAT THESE CANNOT PROVE. That /api/savings still exposes the raw historical
// count — it does today (lib/server.js totals.notesInjections), but that is a
// different endpoint's contract. This suite pins the /api/team/insights side.
//
// Run directly, or via `node test/run.js insights-solo-assists`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const teamsync = require('../../lib/teamsync');
const apiInsights = require('../../lib/api-insights');
const DAY = 86400000;

// A savings payload with real historical figures: 800 recall serves and 43
// teammate-note injections. The Team path must keep both; the solo path must
// zero the teammate figure.
const HISTORY = {
  totals: {
    reads: { sameSession: 500, crossSession: 700 },
    avoided: { serves: 800, tokens: 12000, tierA: 300, tierB: 500 },
    notesInjections: 43,
    notesInjectedTokens: 4300,
    holdout: { skips: 0, callTokens: 0 },
    billed: { tokens: 0 },
  },
};

function stubTeamContext(opts) {
  const restore = {
    getAccessToken: teamsync.getAccessToken, listTeams: teamsync.listTeams,
    listMembers: teamsync.listMembers, teamFeedCounts: teamsync.teamFeedCounts,
    teamFeed: teamsync.teamFeed,
  };
  teamsync.getAccessToken = async () => opts.creds || null;
  teamsync.listTeams = async () => opts.teams || [];
  teamsync.listMembers = async () => opts.members || [];
  teamsync.teamFeedCounts = async () => ({ sessions: 0, entries: 0 });
  teamsync.teamFeed = async () => [];
  return () => Object.assign(teamsync, restore);
}

async function main() {
  await check('CURRENTLY SOLO (signed out): teammateNotes is 0, recallServed and total are honest', async () => {
    const restore = stubTeamContext({ creds: null });
    try {
      const out = await apiInsights.insightsPayload({}, 30, HISTORY);
      // Precondition: this is the empty payload, so perPerson and membersSyncing
      // read the way the ticket described. If either of these changes, the whole
      // premise of the mismatch dissolves and this check has to be revisited.
      assert.deepStrictEqual(out.perPerson, [], 'sanity: emptyInsights is being returned');
      assert.deepStrictEqual(out.membersSyncing, { ok: 0, total: 0 });

      assert.strictEqual(out.assists.available, true, 'the local ledger is populated, so assists is available');
      assert.strictEqual(out.assists.byKind.teammateNotes, 0,
        'a team-derived figure must not sit beside "no teammates"');
      assert.strictEqual(out.assists.byKind.recallServed, 800,
        'your own past-session skeleton serves are a solo figure and stay');
      assert.strictEqual(out.assists.total, 800,
        'total is recomputed off the visible parts, not carried forward with a hidden addend');
    } finally { restore(); }
  });

  await check('CURRENTLY SOLO (no team, but signed in): same rule', async () => {
    // The other way to land on emptyInsights: a signed-in user who is not on
    // any team. Both branches must agree, or the payload becomes situational.
    const restore = stubTeamContext({ creds: { userId: 'me', accessToken: 'a' }, teams: [] });
    try {
      const out = await apiInsights.insightsPayload({}, 30, HISTORY);
      assert.deepStrictEqual(out.perPerson, []);
      assert.strictEqual(out.assists.byKind.teammateNotes, 0);
      assert.strictEqual(out.assists.total, 800);
    } finally { restore(); }
  });

  await check('CURRENTLY ON A TEAM: teammateNotes is unchanged — that is what the field is for', async () => {
    // The regression guard against the fix over-applying. On a real team the
    // historical/current 43 is a real, current-team figure and must survive.
    const now = Date.now();
    const restore = stubTeamContext({
      creds: { userId: 'me', accessToken: 'a' },
      teams: [{ team_id: 'T', name: 'T', role: 'owner' }],
      members: [
        { user_id: 'me', display_name: 'Me', role: 'owner',
          joined_at: new Date(now - 200 * DAY).toISOString() },
      ],
    });
    try {
      const out = await apiInsights.insightsPayload({}, 30, HISTORY, 'T');
      assert.strictEqual(out.assists.byKind.teammateNotes, 43, 'on a live team the counter reflects real deliveries');
      assert.strictEqual(out.assists.byKind.recallServed, 800);
      assert.strictEqual(out.assists.total, 843);
    } finally { restore(); }
  });

  await check('the ledger keeps the historical figure — the solo view hides it, does not erase it', async () => {
    // Belt and braces: the wire suppression must not double as a data change.
    // Calling assistsFrom (the raw fold, exported for exactly this reason) on
    // the same savings input must still see the 43. If a future fix "cleans up"
    // the ledger on team removal, that is a data-writing change with its own
    // review, and this check trips first.
    const raw = apiInsights.assistsFrom(HISTORY);
    assert.strictEqual(raw.available, true);
    assert.strictEqual(raw.byKind.teammateNotes, 43,
      'the underlying assistsFrom must still see the historical count');
    assert.strictEqual(raw.byKind.recallServed, 800);
    assert.strictEqual(raw.total, 843);
  });

  await check('assists.available:false survives on both paths when the ledger predates the field', async () => {
    // No notesInjections in totals => the whole assists block reports
    // available:false. Same on solo and team — the "unknown" case must not
    // silently reshape into an "answered zero" case on one path only.
    const bare = { totals: { reads: { sameSession: 0, crossSession: 0 }, avoided: { serves: 0, tokens: 0, tierA: 0, tierB: 0 } } };
    const restoreSolo = stubTeamContext({ creds: null });
    let solo;
    try { solo = await apiInsights.insightsPayload({}, 30, bare); } finally { restoreSolo(); }
    assert.deepStrictEqual(solo.assists, { available: false });

    const restoreTeam = stubTeamContext({
      creds: { userId: 'me', accessToken: 'a' },
      teams: [{ team_id: 'T', name: 'T', role: 'owner' }],
      members: [{ user_id: 'me', display_name: 'Me', role: 'owner',
        joined_at: new Date(Date.now() - 200 * DAY).toISOString() }],
    });
    let team;
    try { team = await apiInsights.insightsPayload({}, 30, bare, 'T'); } finally { restoreTeam(); }
    assert.deepStrictEqual(team.assists, { available: false });
  });

  await check('the wire SHAPE is identical between the two paths — a client using either need not branch', async () => {
    // #79 pinned the same rule for lookbackDays/coveredDays; extending it to
    // assists here. A UI mounting Insights that flips between team and solo
    // must never see a differently-shaped object.
    const now = Date.now();
    const restoreSolo = stubTeamContext({ creds: null });
    const solo = await apiInsights.insightsPayload({}, 30, HISTORY);
    restoreSolo();
    const restoreTeam = stubTeamContext({
      creds: { userId: 'me', accessToken: 'a' },
      teams: [{ team_id: 'T', name: 'T', role: 'owner' }],
      members: [{ user_id: 'me', display_name: 'Me', role: 'owner',
        joined_at: new Date(now - 200 * DAY).toISOString() }],
    });
    const team = await apiInsights.insightsPayload({}, 30, HISTORY, 'T');
    restoreTeam();
    // Same top-level keys, same nested keys under assists.byKind — only the
    // VALUES differ, which is exactly what this fix intends.
    assert.deepStrictEqual(Object.keys(solo).sort(), Object.keys(team).sort());
    assert.deepStrictEqual(Object.keys(solo.assists.byKind).sort(),
      Object.keys(team.assists.byKind).sort(),
      'the byKind object must expose the same keys on both paths');
  });

  h.finish();
}

main().catch(err => { console.error(err); process.exit(1); });
