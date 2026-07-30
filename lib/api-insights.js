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
const { isManagerRole, AccessError } = require('./api-access');

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

function emptyInsights(windowDays, savings) {
  return {
    window: windowDays,
    sessions: { count: 0, deltaPct: null },
    membersSyncing: { ok: 0, total: 0 },
    entriesShared: { count: 0, delta: null },
    skeleton: skeletonStatsFrom(savings),
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
async function fetchSince(config, teamId, sinceIso) {
  const rows = [];
  let beforeCreatedAt = null;
  let beforeId = null;
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
  }
  return rows;
}

// Per-member "last arrived" signal — the newest team_feed row authored by
// them. This is the supported signal for a teammate's absence (never a
// diagnosis of why): one unpaginated pull of the RPC's own newest-first page
// is enough, since only the single newest row per author matters here.
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
function silentTeammateProblems(members, selfId, lastShared, otherCount, now) {
  const problems = [];
  const daysAgo = ms => Math.max(0, Math.floor(ms / DAY_MS));
  for (const m of members) {
    if (m.user_id === selfId) continue;
    const last = lastShared.get(m.user_id) || null;
    const sinceHours = (now - Date.parse(last || m.joined_at)) / (60 * 60 * 1000);
    // Grace period: a member who joined less than a day ago has not had a
    // fair chance to sync anything yet — flagging them this early is noise
    // the team can do nothing about.
    if (!Number.isFinite(sinceHours) || sinceHours < 24) continue;
    const scale = last
      ? `1 of ${otherCount} teammates · last shared ${daysAgo(now - Date.parse(last))}d ago`
      : `1 of ${otherCount} teammates · joined ${daysAgo(now - Date.parse(m.joined_at))}d ago · 0 entries shared`;
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

async function insightsPayload(config, windowDays, savings) {
  const creds = await teamsync.getAccessToken(config);
  if (!creds) return emptyInsights(windowDays, savings); // signed out — nothing to aggregate
  const teams = await teamsync.listTeams(config);
  const team = (teams || [])[0];
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

  const [rows, recentRows] = await Promise.all([
    fetchSince(config, team.team_id, new Date(priorStart).toISOString()),
    teamsync.teamFeed(config, team.team_id, { limit: TEAM_FEED_PAGE }),
  ]);
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

  const lastShared = lastSharedAtByAuthor(Array.isArray(recentRows) ? recentRows : []);
  const otherCount = members.filter(m => m.user_id !== creds.userId).length;
  const problems = silentTeammateProblems(members, creds.userId, lastShared, otherCount, now);

  return {
    window: windowDays,
    sessions: { count: distinctSessions(current), deltaPct: pctDelta(distinctSessions(current), distinctSessions(prior)) },
    membersSyncing: { ok: members.filter(m => authorsInWindow.has(m.user_id)).length, total: members.length },
    entriesShared: { count: current.length, delta: current.length - prior.length },
    skeleton: skeletonStatsFrom(savings),
    perPerson,
    topProjects,
    problems,
    concentration,
    byTool,
  };
}

module.exports = { insightsPayload, severityOf };
