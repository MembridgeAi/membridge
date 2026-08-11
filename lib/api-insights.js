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
// The response carries counts and summaries only, never a raw team_feed row
// (spec: "aggregate server-side; raw rows are never shipped to the client").
//
// WHERE THE AGGREGATION HAPPENS, AND WHY IT MOVED. It used to happen entirely
// in this module, over rows pulled down by paging team_feed. That paging is
// capped at MAX_PAGES * TEAM_FEED_PAGE = 2,000 rows and walks BACKWARDS from
// newest, so on a team with more than that it silently dropped the oldest
// quarter of the window — measured against production on 2026-08-08, 2,641 rows
// in a 30-day window, ~641 of them never counted.
//
// Two migrations moved it into the database, in two halves:
//   * 027_team_feed_counts.sql — the two HEADLINE counts (sessions, entries).
//   * 055_team_insights_rollup.sql — the six BREAKDOWNS underneath them.
//
// Three of those six name a person to a manager ("only X has worked on this
// project", "nothing has arrived from X", and X's own shared total), which is
// why a capped read was not an acceptable approximation here: it produced
// confident, plausible, wrong statements about named colleagues.
//
// Both migrations degrade rather than fail. A backend without them makes this
// module fall back to counting the old way, and the payload SAYS SO (`exact`,
// `truncated`) instead of publishing a floor as a total.
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
    // Nothing was fetched, so nothing was cut off: both spans are the full
    // requested range, and the UI reads that as "we looked, nothing was there"
    // rather than "we could not tell." Same shape as the populated payload.
    lookbackDays: windowDays * 2,
    coveredDays: windowDays * 2,
    sessions: { count: 0, deltaPct: null },
    membersSyncing: { ok: 0, total: 0 },
    entriesShared: { count: 0, delta: null },
    skeleton: skeletonStatsFrom(savings),
    // `assists.byKind.teammateNotes` counts notes DELIVERED FROM TEAMMATE ROWS
    // (lib/teammate-notes-store.js's rebuildTeammateNotes is the only writer of
    // the index those injections come out of). On a currently-solo daemon that
    // has never had a team the number is genuinely zero, and no override is
    // needed. On a daemon that WAS on a team and is now solo, the local ledger
    // still holds the historical count — a legitimate historical fact — but
    // this screen is a CURRENT-STATE view (perPerson: [], membersSyncing:
    // {0/0}). Reporting `teammateNotes: 43` next to those is the shape defect
    // the ticket names: a plausible number in a place its label no longer
    // matches. Zeroed here on the solo path only; `recallServed` (this
    // machine's own past-session skeleton serves) is kept intact because it is
    // a local figure that never depended on a team.
    //
    // See #82 for the full argument against a rename. In short: the name is
    // accurate for what the counter counts, so a rename could only make it
    // less honest, not more.
    assists: assistsForSolo(savings),
    perPerson: [],
    topProjects: [],
    problems: [],
    concentration: [],
    byTool: [],
  };
}

// Solo variant of assistsFrom. Same shape, same availability rules, but
// teammateNotes is forced to zero and the total is recomputed accordingly — see
// emptyInsights' comment for why. mcpTools stays as-is: it is a COVERAGE gauge
// over a fixed allowlist and is not a team figure.
function assistsForSolo(savings) {
  const base = assistsFrom(savings);
  if (!base.available) return base;
  return {
    ...base,
    total: base.byKind.recallServed,
    byKind: { ...base.byKind, teammateNotes: 0 },
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
// `silenceSpanDays` is how far back a "nothing arrived" claim about this
// person can honestly reach — see `spansFor` for how it is bounded.
function silentTeammateProblems(members, selfId, lastShared, sharedByMember, otherCount, silenceSpanDays, now) {
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
    // Zero-evidence phrasing is bounded to what was actually searched rather
    // than claiming an unbounded "never" — a member's true first share could
    // predate that span, and this machine has no way to see that far back.
    const scale = last
      ? `1 of ${otherCount} teammates · last shared ${daysAgo(now - Date.parse(last))}d ago`
      : `1 of ${otherCount} teammates · joined ${daysAgo(now - Date.parse(m.joined_at))}d ago · ` +
        `0 entries shared in the last ${silenceSpanDays}d`;
    // Always 'broken', deliberately — and inlined here rather than routed
    // through severityOf, which would compute the same thing behind a call that
    // makes the outcome look conditional when it is not. The grace-period
    // `continue` above already refused every `sinceHours < 24` case, so this
    // call site can never reach severityOf's `share >= 0.5 || sinceHours >= 24`
    // predicate with anything but true — the `minor` branch is unreachable
    // through this problem builder. severityOf stays exported and general for
    // the next problem builder to use; this one just no longer pretends it might
    // return anything else.
    problems.push({
      id: `silent:${m.user_id}`,
      severity: 'broken',
      headline: `Nothing has arrived from ${m.display_name}`,
      scale,
      action: null, // nothing on THIS machine can fix another member's silence
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// THE BREAKDOWN SEAM
//
// Six figures on this screen are breakdowns rather than headline counts:
// perPerson, topProjects, byTool, concentration, membersSyncing and the
// silent-teammate check. They can be built two ways, and everything below this
// seam reads only the normalised shape both produce, so the two paths cannot
// drift into publishing differently-shaped payloads:
//
//   * `breakdownsFromRollup` — 055's team_insights_rollup. ONE request, no row
//     limit, counted in the database. This is the path a current backend takes.
//   * `breakdownsFromRows`   — the paged team_feed fetch, capped at
//     MAX_PAGES * TEAM_FEED_PAGE = 2,000 rows. What every backend did before
//     055, and what one without it still does.
//
// The shape:
//   byAuthor   Map(author_id -> { entries, sessions })  over the CURRENT window
//   projects   [{ name, sessions, people, onlyPerson }] over the CURRENT window
//   byTool     [{ tool, sessions }]                     over the CURRENT window
//   lastShared Map(author_id -> ts)
//   truncated  whether anything was cut off
//   earliestTs ms of the team's oldest visible entry, or null when unknown
// ---------------------------------------------------------------------------

// `truncated: false` here is EARNED, not assumed: 055's body has no `limit`
// clause at all, so there is no cap for the result to have hit. `earliestTs` is
// what lets a caller check that rather than take it on trust — it is the oldest
// entry that exists, so a test can assert the aggregate reached past the bottom
// of the team's history instead of believing this comment.
function breakdownsFromRollup(rollup) {
  const byAuthor = new Map();
  for (const r of rollup.by_author) {
    if (!r || !r.author_id) continue;
    byAuthor.set(r.author_id, {
      entries: Number(r.entries) || 0,
      sessions: Number(r.sessions) || 0,
    });
  }
  const projects = rollup.by_project.map(p => ({
    name: p.project_name || 'Unknown project',
    sessions: Number(p.sessions) || 0,
    people: Number(p.people) || 0,
    // Only ever read when people === 1, and the SQL counts distinct author_id,
    // so a project whose rows carry no author comes back with people = 0 and
    // never reaches concentration at all. The JS fold this replaces keyed those
    // rows under a single null and could publish "only Unknown has worked on
    // this project" — a concentration warning about nobody.
    onlyPerson: p.recent_author_name || 'Unknown',
  }));
  // `tool || 'Unknown'` is the JS half of the fold 055's by_source CTE performs
  // in SQL: the migration emits coalesce(source, '') for anything that is not
  // Distilled, and an empty tool name is this module's 'Unknown', exactly as
  // `publicSource(r.source) || 'Unknown'` produces it on the paged path.
  const byTool = rollup.by_source
    .map(s => ({ tool: s.tool || 'Unknown', sessions: Number(s.sessions) || 0 }))
    .sort((a, b) => b.sessions - a.sessions);
  const lastShared = new Map();
  for (const r of rollup.last_shared) {
    if (!r || !r.author_id || !r.ts) continue;
    lastShared.set(r.author_id, r.ts);
  }
  const earliest = rollup.earliest_ts ? Date.parse(rollup.earliest_ts) : NaN;
  return {
    byAuthor, projects, byTool, lastShared,
    truncated: false,
    earliestTs: Number.isFinite(earliest) ? earliest : null,
  };
}

// The pre-055 fold, unchanged in behaviour and moved here so both paths hand
// the same shape to the assembly below. `earliestTs` is null on purpose: a
// capped fetch cannot see the bottom of the team's history, and guessing that
// the oldest row it happened to reach IS the oldest row that exists is the
// precise mistake that made a 26-day-old team report five missing days.
function breakdownsFromRows(rows, current, truncated) {
  const authorAcc = new Map();
  for (const r of current) {
    if (!r.author_id) continue;
    let a = authorAcc.get(r.author_id);
    if (!a) { a = { entries: 0, sessions: new Set() }; authorAcc.set(r.author_id, a); }
    a.entries++;
    a.sessions.add(sessionKeyOf(r));
  }
  const byAuthor = new Map([...authorAcc].map(([id, a]) => [id, { entries: a.entries, sessions: a.sessions.size }]));

  const byProject = new Map();
  for (const r of current) {
    if (!r.project_id) continue;
    let g = byProject.get(r.project_id);
    if (!g) { g = { name: r.project_name || 'Unknown project', sessions: new Set(), people: new Map() }; byProject.set(r.project_id, g); }
    g.sessions.add(sessionKeyOf(r));
    g.people.set(r.author_id, r.author_name);
  }
  const projects = [...byProject.values()].map(g => ({
    name: g.name,
    sessions: g.sessions.size,
    people: g.people.size,
    onlyPerson: [...g.people.values()][0] || 'Unknown',
  }));

  const byToolMap = new Map();
  for (const r of current) {
    const tool = publicSource(r.source) || 'Unknown';
    if (!byToolMap.has(tool)) byToolMap.set(tool, new Set());
    byToolMap.get(tool).add(sessionKeyOf(r));
  }
  const byTool = [...byToolMap.entries()]
    .map(([tool, set]) => ({ tool, sessions: set.size }))
    .sort((a, b) => b.sessions - a.sessions);

  return {
    byAuthor, projects, byTool,
    lastShared: lastSharedAtByAuthor(rows),
    truncated,
    earliestTs: null,
  };
}

// The three spans this payload quotes, which are three different questions and
// were previously one number answering all of them wrongly.
//
//   coveredDays  — HOW FAR WE LOOKED. The banner's question is "did we search
//     everywhere we were asked to", not "how much data exists", so on a
//     complete read this is the full requested span even when the team is
//     younger than it. Measuring it against real earliest activity instead
//     would report a 26-day-old team on a 30-day window as "30 requested, 26
//     reached" — the same invented shortfall, one size smaller. A truncated
//     fetch is the case where we genuinely stopped early, and only then does
//     this drop to the real floor of what was read.
//
//   silenceSpanDays — HOW LONG WE CAN SAY SOMEONE HAS BEEN QUIET. Bounded by
//     the team's own history: "0 entries shared in the last 60d" about a named
//     person, on a team that has existed for 26 days, overstates their silence
//     by more than the team has been alive.
//
//   concentrationSpanDays — HOW LONG ONE PERSON HAS BEEN A PROJECT'S ONLY
//     CONTRIBUTOR. Bounded additionally by the WINDOW, because that group was
//     built from window rows and nothing else. This is a defect fix beyond the
//     truncation work: with an untruncated fetch the old expression published
//     "only X has worked on this project in the last 60d" on a 30-day window,
//     claiming 60 days of exclusivity from 30 days of rows. It happened to read
//     correctly only while the fetch was truncated.
//
// `historyDays` is null when the team's earliest activity is unknown (the
// pre-055 path), and then it bounds nothing rather than being guessed at.
function spansFor(windowDays, truncated, oldest, earliestTs, now) {
  const daysBetween = ms => Math.max(1, Math.floor(ms / DAY_MS));
  const coveredDays = truncated && oldest !== null
    ? daysBetween(now - oldest)
    : windowDays * 2;
  const historyDays = earliestTs !== null ? daysBetween(now - earliestTs) : null;
  const bound = (...vals) => Math.min(...vals.filter(v => v !== null && v !== undefined));
  return {
    coveredDays,
    silenceSpanDays: bound(coveredDays, historyDays),
    concentrationSpanDays: bound(windowDays, coveredDays, historyDays),
  };
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

  const now = Date.now();
  const windowMs = windowDays * DAY_MS;
  const windowStart = now - windowMs;
  const priorStart = now - 2 * windowMs;

  // Exact totals, counted in the database (027_team_feed_counts.sql), for the
  // two figures that are quoted as numbers rather than used as a ranking:
  // entries and distinct sessions, per window. `null` means the backend
  // predates the migration; the paged count is then the only figure available
  // and the payload says so.
  //
  // The rollup (055) is the same move for the BREAKDOWNS underneath them, and
  // it is fetched in this same stage: `null` from it means the backend predates
  // 055, and only then does the paged fetch below run at all.
  //
  // EVERY REMAINING FETCH IN ONE STAGE. These four requests share exactly one
  // input — team.team_id, which my_teams already returned — and none of them
  // reads another's result, so running them one after another spent round trips
  // on nothing. Measured on a stub backend at 250ms/request: 3,392ms -> 2,897ms,
  // the members call and the counts pair having been ~2 sequential trips of pure
  // latency ahead of a fetch that does not depend on either.
  //
  // The manager gate above stays STRICTLY BEFORE this line. It is the only
  // ordering here that is load-bearing: a member who may not read per-person
  // figures must be refused before any of them is fetched, so hoisting
  // listMembers into this stage would have to keep the throw ahead of it.
  const [rawMembers, exactCurrent, exactPrior, rollup] = await Promise.all([
    teamsync.listMembers(config, team.team_id),
    teamsync.teamFeedCounts(config, team.team_id, {
      since: new Date(windowStart).toISOString(), until: new Date(now).toISOString(),
    }),
    teamsync.teamFeedCounts(config, team.team_id, {
      since: new Date(priorStart).toISOString(), until: new Date(windowStart).toISOString(),
    }),
    teamsync.teamInsightsRollup(config, team.team_id, {
      since: new Date(windowStart).toISOString(), until: new Date(now).toISOString(),
    }),
  ]);
  // activeMembers: without it a soft-deleted account produces a
  // "Nothing has arrived from <name>" card with action: null -- nagging a
  // manager about somebody who no longer exists and can never fix it -- and
  // counts toward otherCount, so it also distorts the severity of every other
  // card ("1 of N teammates"). Both are present-tense claims about the team,
  // which is what this whole payload is. Filtered AFTER the Promise.all so
  // the parallel fetch stays a single stage.
  const members = teamsync.activeMembers(rawMembers);

  // ONE of these two paths runs, never both. The rollup answers in a single
  // request with no row limit; the paged fallback costs ~10 sequential round
  // trips and stops at 2,000 rows, so it only runs when the backend cannot do
  // better. `pagedPrior` exists solely for the delta fallback below and is
  // empty on the rollup path, where the exact counts supply both windows.
  //
  // AND THAT IS WHY THE ROLLUP ALONE IS NOT ENOUGH TO TAKE THIS PATH. 055 feeds
  // the breakdowns; it does not feed the two headline counts, which come from
  // 027. On a backend carrying 055 but NOT 027 the counts fall through to the
  // paged figures — and with the fetch skipped those lists are empty, so the
  // payload published `entriesShared: 0` beside a correct per-person total of
  // 500. A fabricated zero reading "your team shared nothing", contradicted
  // three fields further down the same response.
  //
  // Not hypothetical: migrations here are applied by hand and out of order, and
  // supabase/MIGRATION-STATE.md documents that as the normal state of this
  // project. So the gate is BOTH migrations, not just this one. A backend with
  // 055 and no 027 pages the old way and says `exact: false` — capped but
  // honest, which is the only acceptable degradation.
  const haveExactCounts = Boolean(exactCurrent && exactPrior);
  let breakdowns;
  let pagedCurrent = [];
  let pagedPrior = [];
  let oldest = null;
  if (rollup && haveExactCounts) {
    breakdowns = breakdownsFromRollup(rollup);
  } else {
    // fetchSince is a SEQUENTIAL cursor walk and is the dominant cost of this
    // whole payload whenever it runs. Making it concurrent is #70; with 055
    // applied it does not run at all, which is the better answer to the same
    // problem.
    const { rows, truncated: capped } = await fetchSince(
      config, team.team_id, new Date(priorStart).toISOString());
    pagedCurrent = rows.filter(r => Date.parse(r.ts) >= windowStart);
    pagedPrior = rows.filter(r => {
      const t = Date.parse(r.ts);
      return t >= priorStart && t < windowStart;
    });
    oldest = oldestTs(rows);
    breakdowns = breakdownsFromRows(rows, pagedCurrent, capped);
  }
  const truncated = breakdowns.truncated;

  const perPerson = members
    .map(m => {
      const mine = breakdowns.byAuthor.get(m.user_id);
      return {
        id: m.user_id,
        // The MEMBER's display name, not the author-name snapshot stored on the
        // row: one principal with two spellings is two people on this screen.
        name: m.display_name,
        sessions: mine ? mine.sessions : 0,
        shared: mine ? mine.entries : 0,
      };
    })
    .sort((a, b) => b.sessions - a.sessions);

  const topProjects = breakdowns.projects
    .map(g => ({ name: g.name, sessions: g.sessions, people: g.people }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, TOP_PROJECTS_LIMIT);

  const { lastShared } = breakdowns;
  const sharedByMember = new Map(perPerson.map(p => [p.id, p.shared]));
  const otherCount = members.filter(m => m.user_id !== creds.userId).length;
  const { coveredDays, silenceSpanDays, concentrationSpanDays } =
    spansFor(windowDays, truncated, oldest, breakdowns.earliestTs, now);
  const lookbackDays = coveredDays; // one name for one number; both are exposed

  const concentration = breakdowns.projects
    .filter(g => g.people === 1)
    .map(g => ({
      projectName: g.name,
      onlyPerson: g.onlyPerson,
      detail: `only ${g.onlyPerson} has worked on this project in the last ${concentrationSpanDays}d`,
    }));
  const problems = silentTeammateProblems(
    members, creds.userId, lastShared, sharedByMember, otherCount, silenceSpanDays, now);

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
    exact: haveExactCounts,
    // `truncated` covers the BREAKDOWNS — perPerson, topProjects, byTool,
    // concentration, membersSyncing, problems — and is a different question
    // from `exact`, which covers the two headline counts. It used to be masked
    // behind `!exact`, so with 027 live it read false even when the fetch had
    // genuinely stopped at the cap, and the client's honesty layer sat behind
    // that mask and never fired.
    //
    // With 055 applied this is false because there is nothing left to truncate:
    // the rollup is one query with no row limit, so the breakdowns are totals
    // rather than floors. Without 055 it is the paged fetch's real state. It is
    // never set from anywhere except the path that actually ran — see
    // `breakdowns.truncated`, which each builder sets for itself.
    truncated: Boolean(truncated),
    // How far back this payload actually searched, in DAYS — the question the
    // UI's "N days requested, M days reached" line is really asking. On the
    // rollup path the aggregate covers the whole requested range, so both equal
    // windowDays * 2 and a young team reads as fully covered rather than as a
    // shortfall; on a truncated paged fetch both drop to the real floor of what
    // was read. Two names for one number, because the client should not have to
    // derive it from `truncated + window * 2`.
    lookbackDays,
    coveredDays,
    sessions: exactCurrent && exactPrior
      ? { count: exactCurrent.sessions, deltaPct: pctDelta(exactCurrent.sessions, exactPrior.sessions) }
      : {
        count: distinctSessions(pagedCurrent),
        deltaPct: truncated ? null : pctDelta(distinctSessions(pagedCurrent), distinctSessions(pagedPrior)),
      },
    // A member counts as syncing when the window holds at least one entry of
    // theirs — the same fact perPerson already reports, read from the same
    // aggregate so the two halves of the payload cannot disagree.
    membersSyncing: {
      ok: members.filter(m => (breakdowns.byAuthor.get(m.user_id) || { entries: 0 }).entries > 0).length,
      total: members.length,
    },
    entriesShared: exactCurrent && exactPrior
      ? { count: exactCurrent.entries, delta: exactCurrent.entries - exactPrior.entries }
      : { count: pagedCurrent.length, delta: truncated ? null : pagedCurrent.length - pagedPrior.length },
    skeleton: skeletonStatsFrom(savings),
    assists: assistsFrom(savings),
    perPerson,
    topProjects,
    problems,
    concentration,
    byTool: breakdowns.byTool,
  };
}

// fetchSince and the page constants are exported for the suite: the
// truncation path needs MAX_PAGES * TEAM_FEED_PAGE rows to trigger, which is
// impractical to stage through the full mock-Supabase fixture the other
// insights checks use. `spansFor` is exported so the three spans can be
// unit-tested without staging a whole backend behind them.
module.exports = {
  insightsPayload, severityOf, assistsFrom,
  fetchSince, oldestTs, spansFor, TEAM_FEED_PAGE, MAX_PAGES,
};
