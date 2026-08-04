'use strict';
// Team Insights aggregation (Task 12) — GET /api/team/insights?window=7|30|90.
// Answers "is the team getting value, and what is silently broken", so every
// number here must be exactly what its label claims: tokens only, no spend
// figure of any kind, counts with their real denominator, and problems
// phrased only from what this machine can actually observe.
//
// Observability limit (binding — see the plan's Global Constraints): a
// teammate's own daemon, hook, or token state lives on THEIR machine and is
// invisible here. team_members_list (supabase/migrations/002_team_v2.sql:267)
// returns only user_id, display_name, role, joined_at — so a teammate
// problem is phrased as ABSENCE ("nothing has arrived from X"), never a
// diagnosis of their setup. Problems about THIS machine (local ledger state)
// may say more, because this machine's own state is genuinely observable.
//
// Aggregation happens entirely in this module; the response carries counts
// and summaries only, never a raw team_feed row (spec: "aggregate
// server-side; raw rows are never shipped to the client").
const teamsync = require('./teamsync');
const { isManagerRole, selectTeam, AccessError } = require('./api-access');
const mcpUsage = require('./mcp-usage');

const DAY_MS = 24 * 60 * 60 * 1000;
const TEAM_FEED_PAGE = 200; // team_feed RPC's hard cap (013_e2e_feed.sql:64)
// An accepted approximate truncation for a very high-volume team — the same
// seam lib/server.js's own feedPayload documents for its team fetch. Exact
// correctness on every row is not worth unbounded pagination on every poll.
const MAX_PAGES = 10;
const TOP_PROJECTS_LIMIT = 8;

// Duplicated from lib/server.js's one-line helper rather than imported:
// server.js requires this module for route wiring, so importing back would
// be a circular require. Same trade lib/api-access.js already made for its
// own ~15-line restCall helper.
const publicSource = source => (source === 'Distilled' ? 'Codex' : (source || ''));

// Severity rule (spec, unit-tested standalone): a problem is `broken` when
// the failing share of its population is at or above 50%, OR the condition
// has persisted at least 24 hours; otherwise `minor`. Every problem builder
// below calls this so the rule lives in exactly one place.
function severityOf({ failing, population, sinceHours }) {
  const share = population > 0 ? failing / population : 0;
  return (share >= 0.5 || sinceHours >= 24) ? 'broken' : 'minor';
}

// Same fold Task 7's ui/src/data/skeletonStats.ts already does client-side
// for the Today page, ported here so the two screens can never disagree
// about what "the ledger has nothing yet" means. `savings` is the object
// lib/server.js's savingsPayload() already computed for this request,
// passed in rather than imported (same no-circular-require reason as
// publicSource above) — reads/avoided default to zero-filled objects, but a
// malformed or predates-Task-6 shape still degrades to unavailable rather
// than a fabricated zero.
function skeletonStatsFrom(savings) {
  const totals = (savings && savings.totals) || {};
  const { reads, avoided } = totals;
  if (!reads || !avoided) return { available: false };
  return { available: true, repeatOpens: reads.sameSession + reads.crossSession, answeredFirst: avoided.serves };
}

// Assists: every discrete instance where memory was actually delivered or
// consulted -- broader than `skeleton` above, which only measures one
// channel. The owner's framing: "any instance where the memory helped."
// Counting an INSTANCE is not a token-avoidance claim, so this can never
// reach spec §9 (see savingsPayload's header in lib/server.js) -- that rule
// is about avoidance TOKENS, and nothing here touches `avoided.tokens`.
// Channels: recallServed = avoided.serves; teammateNotes = the injection
// COUNT (notes.injections, never the token cost -- notesInjectedTokens stays
// an input-cost figure, not an assist count). Rejected: holdout.skips
// (measures what a call WOULD have cost, not a delivered instance) and the
// always-on context block (no per-instance signal exists).
//
// WHAT THE MCP FIGURE IS NOT. `mcpTools` sits BESIDE the total, never inside
// it. lib/mcp-usage.js keeps a { toolName: lastUsedIso } map and records
// which tools see use, never how often -- a deliberate privacy stance, not a
// gap -- so toolsUsedWithin filters the fixed MCP_TOOLS allowlist and its
// length is structurally bounded by that allowlist forever, whatever the
// call volume. That makes it a COVERAGE gauge, and adding a 0..6 gauge to
// two genuine per-instance counters produced a total that meant nothing and
// understated heavy MCP use to almost nothing. It is reported as the
// fraction it actually is, with the denominator taken from the allowlist
// itself rather than written out here. Degrades to 0 in use (never a crash)
// with no tally file yet.
//
// `available: false` only when `notesInjections` is absent from
// `savings.totals` -- a daemon predating this field talking to a newer UI,
// same cross-version reasoning skeletonStatsFrom uses for reads/avoided.
function assistsFrom(savings) {
  const totals = (savings && savings.totals) || {};
  const { avoided, notesInjections } = totals;
  if (!avoided || typeof notesInjections !== 'number') return { available: false };
  const recallServed = avoided.serves;
  const teammateNotes = notesInjections;
  return {
    available: true,
    total: recallServed + teammateNotes,
    byKind: { recallServed, teammateNotes },
    mcpTools: { inUse: mcpUsage.toolsUsedWithin(Infinity).length, total: mcpUsage.MCP_TOOLS.length },
  };
}

function emptyInsights(windowDays, savings) {
  return {
    window: windowDays,
    // Nothing was fetched, so nothing was capped, and zero here is the real
    // answer rather than a figure that ran out of pages. `exact: true` keeps
    // the UI from labelling an honest empty state as approximate.
    exact: true,
    truncated: false,
    sessions: { count: 0, deltaPct: null },
    membersSyncing: { ok: 0, total: 0 },
    entriesShared: { count: 0, delta: null },
    skeleton: skeletonStatsFrom(savings),
    assists: assistsFrom(savings),
    perPerson: [],
    topProjects: [],
    problems: [],
    concentration: [],
    byTool: [],
  };
}

// Most rows carry a real session id; the rare row that doesn't (bare
// plumbing) still counts as its own one-off unit instead of silently
// merging into every other session-less row.
const sessionKeyOf = r => r.session || `entry:${r.id}`;
const distinctSessions = rows => new Set(rows.map(sessionKeyOf)).size;

function pctDelta(curr, prior) {
  if (!prior) return null; // no baseline in the prior window — never fabricate a percentage from zero
  return Math.round(((curr - prior) / prior) * 1000) / 10;
}

// Pages team_feed back to `sinceIso`, capped at MAX_PAGES * TEAM_FEED_PAGE
// rows — see the MAX_PAGES comment above.
//
// Returns `{ rows, truncated }`. `truncated` is the load-bearing half: paging
// is keyset and walks BACKWARDS from newest, so hitting the cap does not
// shave rows evenly — it drops the OLDEST ones. Callers that compare a
// current window against a prior one therefore lose the prior window FIRST,
// and a naive delta reads as growth when it is really just the fetch stopping
// early. Anything derived from a truncated fetch is a floor, never a total.
async function fetchSince(config, teamId, sinceIso) {
  const rows = [];
  let beforeCreatedAt = null;
  let beforeId = null;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await teamsync.teamFeed(config, teamId, {
      since: sinceIso, limit: TEAM_FEED_PAGE, beforeCreatedAt, beforeId,
    });
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < TEAM_FEED_PAGE) break;
    const last = batch[batch.length - 1];
    beforeCreatedAt = last.created_at;
    beforeId = last.id;
    // A full final page means the backend had more to give and we stopped
    // asking, which is exactly the cap being hit. A short page means we
    // reached the end of the data and the fetch is complete.
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { rows, truncated };
}

// The oldest row a fetch actually reached, as a timestamp, or null for an
// empty fetch. This is the real floor of what was searched — on a truncated
// fetch it is much later than the `sinceIso` that was requested.
function oldestTs(rows) {
  let oldest = null;
  for (const r of rows) {
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t)) continue;
    if (oldest === null || t < oldest) oldest = t;
  }
  return oldest;
}

// Per-member "last arrived" signal — the newest team_feed row authored by
// them. This is the supported signal for a teammate's absence (never a
// diagnosis of why). MUST be fed the same paginated `rows` that `perPerson`
// is built from, never a fresh, separately-capped page: a single
// TEAM_FEED_PAGE-sized newest-first page can be filled entirely by one
// high-volume author, silently pushing every other author's newest row off
// the page. That produced a real false positive — perPerson showed a
// teammate with 97 shared entries in the same response where problems
// claimed "0 entries shared" for that same teammate, because the two halves
// of the payload were reading two different-sized views of the feed.
// Sharing `rows` removes the second request entirely and makes the two
// halves agree by construction instead of by coincidence.
function lastSharedAtByAuthor(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!r.author_id) continue;
    const prev = map.get(r.author_id);
    if (!prev || String(r.ts) > String(prev)) map.set(r.author_id, r.ts);
  }
  return map;
}

// One absence-phrased problem per teammate who has shared nothing recently.
// `otherCount` (every member but the viewer) is the population every one of
// these problems shares — each failing count is 1 (this one person), so a
// 2-person team where the only teammate goes quiet reads as 100% of that
// population, and a 50-person team's one quiet joiner does not.
// `sharedByMember` (id -> count of entries THIS window) is `perPerson`'s own
// count, passed in so the invariant below can be checked directly rather
// than trusted: a member with entries in the window is never "silent".
// `lookbackDays` is how far back `lastShared` can see (the span `rows`
// covers) — used only to phrase the zero-evidence case honestly (see below).
function silentTeammateProblems(members, selfId, lastShared, sharedByMember, otherCount, lookbackDays, now) {
  const problems = [];
  const daysAgo = ms => Math.max(0, Math.floor(ms / DAY_MS));
  for (const m of members) {
    if (m.user_id === selfId) continue;
    const sharedInWindow = sharedByMember.get(m.user_id) || 0;
    // Invariant (the bug this guard exists to catch): a member with one or
    // more entries in the window must never produce a "nothing has
    // arrived" problem. Enforced here, not just in a test — if it ever
    // trips, `lastShared` and `perPerson` disagree about the same `rows`,
    // which is exactly the contradiction the live backend shipped (97
    // shared entries and "0 entries shared" in one response).
    if (sharedInWindow > 0) {
      if (!lastShared.get(m.user_id)) {
        throw new Error(`insights invariant violated: member ${m.user_id} has ` +
          `${sharedInWindow} shared entries this window but no lastShared timestamp`);
      }
      continue;
    }
    const last = lastShared.get(m.user_id) || null;
    const sinceHours = (now - Date.parse(last || m.joined_at)) / (60 * 60 * 1000);
    // Grace period: a member who joined less than a day ago has not had a
    // fair chance to sync anything yet — flagging them this early is noise
    // the team can do nothing about.
    if (!Number.isFinite(sinceHours) || sinceHours < 24) continue;
    // Zero-evidence phrasing is bounded to what was actually searched
    // (`lookbackDays`, the span `rows` covers) rather than claiming an
    // unbounded "never" — a member's true first share could predate that
    // span, and this machine has no way to see that far back.
    const scale = last
      ? `1 of ${otherCount} teammates · last shared ${daysAgo(now - Date.parse(last))}d ago`
      : `1 of ${otherCount} teammates · joined ${daysAgo(now - Date.parse(m.joined_at))}d ago · ` +
        `0 entries shared in the last ${lookbackDays}d`;
    problems.push({
      id: `silent:${m.user_id}`,
      severity: severityOf({ failing: 1, population: otherCount, sinceHours }),
      headline: `Nothing has arrived from ${m.display_name}`,
      scale,
      action: null, // nothing on THIS machine can fix another member's silence
    });
  }
  return problems;
}

async function insightsPayload(config, windowDays, savings, teamId) {
  const creds = await teamsync.getAccessToken(config);
  if (!creds) return emptyInsights(windowDays, savings); // signed out — nothing to aggregate
  const teams = await teamsync.listTeams(config);
  // The team the caller is looking at, not an unconditional teams[0] — see
  // api-access.js selectTeam. Insights must describe the same team the rest of
  // the screen does.
  const team = selectTeam(teams, teamId);
  if (!team) return emptyInsights(windowDays, savings); // solo — no team to report on
  // Manager-only, same gate api-access.js's accessMatrix already applies: a
  // member reading this would learn per-person figures for every teammate,
  // including ones can_see has hidden projects from them.
  if (!isManagerRole(team.role)) {
    throw new AccessError(403, 'only a team owner or admin can view team insights');
  }

  const members = await teamsync.listMembers(config, team.team_id);
  const now = Date.now();
  const windowMs = windowDays * DAY_MS;
  const windowStart = now - windowMs;
  const priorStart = now - 2 * windowMs;

  // Single fetch, shared by perPerson AND the silent-teammate check below —
  // see the lastSharedAtByAuthor comment for why a second, separately
  // capped request produced a real false positive.
  // Exact totals, counted in the database (027_team_feed_counts.sql), for the
  // two figures that are quoted as numbers rather than used as a ranking:
  // entries and distinct sessions, per window. The paged fetch below still
  // feeds the BREAKDOWNS (perPerson, topProjects, byTool, concentration),
  // which are top-N orderings — a cap changes the tail of a ranking, but a
  // cap on a headline count publishes a wrong number, which is what this
  // fixes. `null` means the backend predates the migration; the paged count
  // is then the only figure available and the payload says so.
  const [exactCurrent, exactPrior] = await Promise.all([
    teamsync.teamFeedCounts(config, team.team_id, {
      since: new Date(windowStart).toISOString(), until: new Date(now).toISOString(),
    }),
    teamsync.teamFeedCounts(config, team.team_id, {
      since: new Date(priorStart).toISOString(), until: new Date(windowStart).toISOString(),
    }),
  ]);

  const { rows, truncated } = await fetchSince(config, team.team_id, new Date(priorStart).toISOString());
  const current = rows.filter(r => Date.parse(r.ts) >= windowStart);
  const prior = rows.filter(r => {
    const t = Date.parse(r.ts);
    return t >= priorStart && t < windowStart;
  });

  const authorsInWindow = new Set(current.map(r => r.author_id));
  const perPerson = members
    .map(m => {
      const mine = current.filter(r => r.author_id === m.user_id);
      return { id: m.user_id, name: m.display_name, sessions: distinctSessions(mine), shared: mine.length };
    })
    .sort((a, b) => b.sessions - a.sessions);

  const byProject = new Map();
  for (const r of current) {
    if (!r.project_id) continue;
    let g = byProject.get(r.project_id);
    if (!g) { g = { name: r.project_name || 'Unknown project', sessions: new Set(), people: new Map() }; byProject.set(r.project_id, g); }
    g.sessions.add(sessionKeyOf(r));
    g.people.set(r.author_id, r.author_name);
  }
  const projectGroups = [...byProject.values()];
  const topProjects = projectGroups
    .map(g => ({ name: g.name, sessions: g.sessions.size, people: g.people.size }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, TOP_PROJECTS_LIMIT);
  const concentration = projectGroups
    .filter(g => g.people.size === 1)
    .map(g => {
      const onlyPerson = [...g.people.values()][0] || 'Unknown';
      return { projectName: g.name, onlyPerson, detail: `only ${onlyPerson} has worked on this project in the last ${windowDays}d` };
    });

  const byToolMap = new Map();
  for (const r of current) {
    const tool = publicSource(r.source) || 'Unknown';
    if (!byToolMap.has(tool)) byToolMap.set(tool, new Set());
    byToolMap.get(tool).add(sessionKeyOf(r));
  }
  const byTool = [...byToolMap.entries()]
    .map(([tool, set]) => ({ tool, sessions: set.size }))
    .sort((a, b) => b.sessions - a.sessions);

  const lastShared = lastSharedAtByAuthor(rows);
  const sharedByMember = new Map(perPerson.map(p => [p.id, p.shared]));
  const otherCount = members.filter(m => m.user_id !== creds.userId).length;
  // How far back `rows` REALLY reaches. Untruncated that is priorStart..now,
  // i.e. two windows. Truncated it is only as far as the oldest row the cap
  // let us fetch — and this number is what the silent-teammate phrasing
  // quotes ("nothing has arrived in N days"), so leaving it at windowDays * 2
  // makes that sentence claim a search that never happened. On a busy team a
  // 30d window can reach back barely a fortnight.
  const oldest = oldestTs(rows);
  const lookbackDays = truncated && oldest !== null
    ? Math.max(1, Math.floor((now - oldest) / DAY_MS))
    : windowDays * 2;
  const problems = silentTeammateProblems(
    members, creds.userId, lastShared, sharedByMember, otherCount, lookbackDays, now);

  return {
    window: windowDays,
    // `exact` says the two counts below were measured in the database rather
    // than by counting fetched rows. When it is false the backend predates
    // 027_team_feed_counts.sql and the paged fetch is all there is, so a
    // truncated page really does cap the figure — the UI needs to know which
    // of those two worlds it is rendering.
    //
    // The deltas follow the counts: exact ones are a real comparison, and the
    // paged fallback suppresses them when truncated, because the cap eats the
    // OLDEST rows and empties the prior window first. Observed live before
    // this landed: 2000 entries, prior window empty, "+2000" published as
    // growth that never happened. Same rule pctDelta already followed for a
    // zero baseline — never fabricate a comparison from a baseline that was
    // not read.
    exact: Boolean(exactCurrent && exactPrior),
    truncated: Boolean(truncated && !(exactCurrent && exactPrior)),
    sessions: exactCurrent && exactPrior
      ? { count: exactCurrent.sessions, deltaPct: pctDelta(exactCurrent.sessions, exactPrior.sessions) }
      : {
        count: distinctSessions(current),
        deltaPct: truncated ? null : pctDelta(distinctSessions(current), distinctSessions(prior)),
      },
    membersSyncing: { ok: members.filter(m => authorsInWindow.has(m.user_id)).length, total: members.length },
    entriesShared: exactCurrent && exactPrior
      ? { count: exactCurrent.entries, delta: exactCurrent.entries - exactPrior.entries }
      : { count: current.length, delta: truncated ? null : current.length - prior.length },
    skeleton: skeletonStatsFrom(savings),
    assists: assistsFrom(savings),
    perPerson,
    topProjects,
    problems,
    concentration,
    byTool,
  };
}

// fetchSince and the page constants are exported for the suite: the
// truncation path needs MAX_PAGES * TEAM_FEED_PAGE rows to trigger, which is
// impractical to stage through the full mock-Supabase fixture the other
// insights checks use.
module.exports = {
  insightsPayload, severityOf, assistsFrom,
  fetchSince, oldestTs, TEAM_FEED_PAGE, MAX_PAGES,
};
