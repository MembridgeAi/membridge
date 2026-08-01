'use strict';
// The machine-local activity corpus and the ranked search over it, shared by
// EVERY surface that answers "what has this team already done": the MCP tools
// (lib/mcp.js) and the dashboard's own search endpoint (lib/server.js).
//
// This module exists because those two surfaces MUST return the same answers.
// While the corpus lived inside lib/mcp.js, the app could only ever show the
// slice its feed happened to fetch, and an agent asking over MCP saw strictly
// more history than the human looking at the same machine — the exact split
// this module removes.
//
// Everything here is a local read: state.json, each project's cached teammate
// rows, and (opt-in) the durable per-project team archive. No network call, no
// credentials — a search must answer offline, and the MCP no-network-call
// invariant depends on it. Redaction is re-applied at this boundary regardless
// of whether the source already redacted it, the same defense-in-depth rule
// the context-block render and the dashboard feed follow: raw archive rows are
// unredacted secrets at rest (module contract in lib/team-archive.js).
const fs = require('fs');
const path = require('path');
const util = require('./util');
const digest = require('./digest');
const memorydb = require('./memorydb');
const feed = require('./feed');
const searchLib = require('./search');
const teamsync = require('./teamsync');
const teamArchive = require('./team-archive');

// Fresh config/state/redactor on every call — a long-lived stdio server (and
// an equally long-lived daemon) must never serve a stale snapshot from
// whenever it happened to start.
function loadContext() {
  const config = util.getConfig();
  const state = util.loadState();
  const regexes = digest.compileRedactions(config);
  return { config, state, regexes };
}

function trackedProjectEntries(state, config) {
  return Object.entries(state.projects || {}).filter(([key]) => !util.isProjectOff(key, config));
}

// Pass through everything normalizeTeam knows how to carry — the stored row
// shape is pullProject's `mapped` (lib/teamsync.js), and archive rows share
// that exact shape (team-archive.js). An omission here silently blinds
// search and activity to that field. Pulled out to module scope (rather than
// a closure rebuilt on every project in allActivity's loop) so
// loadArchiveEntries below can reuse it for the cached archive path too.
function mapTeamRow(e, name, redact) {
  return feed.normalizeTeam({
    author_name: e.author,
    project_name: name,
    ts: e.ts,
    source: e.source,
    session: e.session,
    ask: e.ask,
    goal: e.goal,
    decisions: e.decisions,
    gotchas: e.gotchas,
    summary: e.summary,
    headline: e.headline,
    distilled: e.distilled,
    files: e.files,
    changes: e.changes,
    ...(e.undecryptable ? { undecryptable: true } : {}),
  }, { redact });
}

// ---------------------------------------------------------------------------
// Archive read cache (fix wave, review of the archive retention rework):
// teamArchive.loadArchive reads and JSON.parses the ENTIRE rows file, and
// allActivity used to call it fresh on every single search for every
// linked project. At the (then newly raised) 50,000-row cap that measured
// ~4s per project — unusable for a tool an agent calls repeatedly in one
// session. Both callers are long-lived processes (one `membridge mcp`
// invocation serves many tool calls; the daemon serves many requests), so the
// parsed-AND-NORMALIZED entries can be memoized here for the process's
// lifetime instead of recomputed every call.
//
// Cached value is ALWAYS post-redaction, post-normalization entries — never
// raw rows re-redacted later. Raw archive rows are unredacted secrets at
// rest (module contract in team-archive.js); the redaction boundary stays
// exactly where it already was, at the normalizeTeam call. Only the RESULT
// of that boundary is cached now, invalidated whenever it would change:
// - the rows file's mtimeMs + size (any write moves at least one of these)
// - a signature of the compiled redaction config (a live edit to
//   config.redact must invalidate even with the archive file untouched)
// Bounded to a handful of projects (ARCHIVE_CACHE_LIMIT) with simple
// least-recently-used eviction, so a machine tracking many projects cannot
// grow this without limit.
const ARCHIVE_CACHE_LIMIT = 20;
const archiveEntryCache = new Map(); // projectId -> { mtimeMs, size, redactSig, entries }

function redactionSignature(regexes) {
  const r = (regexes && typeof regexes === 'object') ? regexes : { useDefaults: true, user: [] };
  const user = Array.isArray(r.user) ? r.user : [];
  return `${r.useDefaults !== false}|${user.map(rx => rx.source + rx.flags).join(',')}`;
}

// Exported for tests only: prove the cache is bounded rather than unbounded.
function _archiveCacheSizeForTests() {
  return archiveEntryCache.size;
}

// Normalized, redacted entries for one project's durable archive — the same
// shape allActivity's own proj.teamEntries loop produces via mapTeamRow, so
// callers can merge the two lists without caring which one a row came from.
// A cache hit costs one fs.statSync; a miss costs exactly what the
// un-cached path always cost (loadArchive's read+parse, then one
// mapTeamRow per row) plus one extra map insert.
function loadArchiveEntries(projectId, name, regexes) {
  let stat;
  try {
    stat = fs.statSync(teamArchive.archivePath(projectId));
  } catch {
    return []; // no rows file on disk yet — nothing to read or cache
  }
  const redactSig = redactionSignature(regexes);
  const cached = archiveEntryCache.get(projectId);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.redactSig === redactSig) {
    // Touch for LRU: delete + re-set moves this key to the Map's MRU end
    // (Map iteration order is insertion order), so eviction below always
    // drops the least-recently-used entry, not just the oldest-inserted one.
    archiveEntryCache.delete(projectId);
    archiveEntryCache.set(projectId, cached);
    return cached.entries;
  }
  const redact = t => digest.redactText(t, regexes);
  const entries = teamArchive.loadArchive(projectId).rows.map(e => mapTeamRow(e, name, redact));
  archiveEntryCache.set(projectId, { mtimeMs: stat.mtimeMs, size: stat.size, redactSig, entries });
  if (archiveEntryCache.size > ARCHIVE_CACHE_LIMIT) {
    archiveEntryCache.delete(archiveEntryCache.keys().next().value); // evict the LRU entry
  }
  return entries;
}

// Identity of ONE captured event, independent of who the backend says wrote it.
// A session id is minted per tool run and is never shared between two people,
// so (session, ts, source) names the event itself.
//
// This matters because one human can reach a project's history under two
// display names — an account first pushed as "andrewludwigbrown" and later
// renders as "Andrew Brown" — and every such row is a genuine, separate row on
// the backend. Keyed on the author, they read as two people doing the same
// work at the same millisecond: on live data, 4 of 8 search results were the
// same two events, twice. Only a session-less row (older captures, harvested
// rows) falls back to the author spelling, where nothing better exists.
function eventKey(e) {
  return `${e.session || `~${e.author}`}|${e.ts}|${e.source}`;
}

// How much a row actually TELLS you — used to pick the survivor when two rows
// are the same event. A headline outranks everything (it is the only field
// written to be read at a glance), then narrative length, then blast radius.
function contentRank(e) {
  return (e.headline ? 10000 : 0)
    + String(e.summary || '').length
    + (Array.isArray(e.files) ? e.files.length : 0)
    + (e.decisions ? 100 : 0) + (e.gotchas ? 100 : 0);
}

// Collapse rows that are the same event under different author identities,
// keeping the one that says the most. Stable: ties keep the earlier row, so
// the caller's ordering survives.
function collapseIdentityTwins(entries) {
  const best = new Map();
  for (const e of entries) {
    const key = eventKey(e);
    const prev = best.get(key);
    if (!prev || contentRank(e) > contentRank(prev)) best.set(key, e);
  }
  return best.size === entries.length ? entries : [...best.values()];
}

// Flattened, per-prompt entries (memorydb.buildEntries — the same source as
// memory.json and the dashboard's own activity list) across every tracked,
// non-paused project, local + cached teammate pulls, shaped with the same
// feed normalizers the dashboard feed uses. Team rows are read from each
// project's locally cached, already-pulled proj.teamEntries (no live network
// call — a search must never require team credentials to answer a local
// read), so fields only known at live-fetch time (author id, row id) are
// simply omitted; feed.normalizeTeam already defaults those to null.
//
// opts.includeArchive (default false) additionally merges each project's
// durable team-archive (lib/team-archive.js) into `team` — the long tail
// beyond proj.teamEntries's working-cache window. This is still a local-only
// read (loadArchiveEntries is a plain fs read [memoized, see above],
// teamsync.loadTeamLink just parses .membridge/team.json — no network call,
// no credentials). Only search opts in: the recent-activity readers must
// keep their exact current payload size, so they call with no opts and never
// touch the archive.
function allActivity(state, config, regexes, opts = {}) {
  const local = [];
  const team = [];
  const redact = t => digest.redactText(t, regexes);
  for (const [key, proj] of trackedProjectEntries(state, config)) {
    const name = path.basename(key);
    for (const e of memorydb.buildEntries(key, proj, config, { deferChanges: true })) {
      local.push(feed.normalizeLocal(e, { projectPath: key, projectName: name, redact }));
    }
    // A project this machine may no longer read (lib/teamsync.js sets this the
    // moment the backend stops listing it) contributes NOTHING from the team
    // side. The sync pass also drops teamEntries and prunes the archive, but
    // that only runs when the machine next syncs — this guard is what makes a
    // laptop that has not checked in stop answering, and it costs one field
    // read. Local entries are unaffected: they are this user's own work.
    if (proj.teamAccessLost) continue;
    for (const e of util.teamRowsFor(proj)) team.push(mapTeamRow(e, name, redact));
    if (opts.includeArchive) {
      const link = teamsync.loadTeamLink(key);
      if (link && link.projectId) {
        // Cache rows win on collision: the working cache is always at least
        // as fresh as the archive for a row it still holds. Dedup key is
        // formed from the NORMALIZED entry's own fields, which carry the
        // same session/ts/source values as the raw row here.
        //
        // The key is keyed on SESSION, not on the author's display name. A
        // person who changed their display name (an account named
        // "andrewludwigbrown" that later renders as "Andrew Brown") writes
        // both spellings into one project's history, and an author-keyed
        // dedup then treats the archive copy of a cached row as a different
        // event -- the same work comes back twice under two names, filling
        // half a result page. Only a session-less row (older captures, some
        // harvested rows) falls back to the author spelling, where there is
        // nothing better to key on.
        const seen = new Set(util.teamRowsFor(proj).map(eventKey));
        for (const entry of loadArchiveEntries(link.projectId, name, regexes)) {
          const key = eventKey(entry);
          if (seen.has(key)) continue;
          seen.add(key); // the archive can hold its own twins under two names
          team.push(entry);
        }
      }
    }
  }
  return { local, team };
}

// Deferred git-change derivation, mirroring lib/server.js: buildEntries
// above skipped the git-subprocess step for EVERY entry of EVERY project;
// run it here only for the local entries that survived the caller's slice,
// then strip the internal carrier so it never reaches the JSON boundary.
function deriveDeferred(entries, regexes) {
  const redact = t => digest.redactText(t, regexes);
  for (const e of entries) {
    if (e.origin === 'local' && e._highlights) {
      e.changes = memorydb.deriveEntryChanges(e.projectPath, e.files, e._highlights, regexes)
        .map(c => (c.note ? { ...c, note: redact(c.note) } : c));
    }
    if (e._highlights) delete e._highlights;
  }
  return entries;
}

function recentActivity(limit) {
  const { state, config, regexes } = loadContext();
  const { local, team } = allActivity(state, config, regexes);
  const { entries } = feed.buildFeed({ local, team, limit: limit || 50 });
  return { entries: deriveDeferred(entries, regexes) };
}

// Ranked search (lib/search.js) over everything cached on this machine:
// your entries plus teammates' pulled rows and the durable archive, across
// every tracked project. Filters narrow BEFORE ranking. File filtering is a
// substring match on purpose: local files are project-relative, team files
// arrive as checkout-relative wire keys, and worktree prefixes differ per
// machine — exact path equality across those schemes is a known trap
// (lib/repo-root.js).
function searchMemory(args) {
  const { state, config, regexes } = loadContext();
  const { local, team } = allActivity(state, config, regexes, { includeArchive: true });
  // Same collision rule as buildFeed: local wins over its own pushed twin.
  const seen = new Set(local.map(feed.dedupeKey));
  const all = local.concat(collapseIdentityTwins(team.filter(t => !seen.has(feed.dedupeKey(t)))));
  const needle = v => String(v).toLowerCase();
  const filtered = all.filter(e => {
    if (args.author && !needle(e.author || '').includes(needle(args.author))) return false;
    if (args.project && !needle(e.project || '').includes(needle(args.project))) return false;
    if (args.tool && needle(e.source || '') !== needle(args.tool)) return false;
    // Bare-date bounds (e.g. "2026-06-01") must include that whole day: compare
    // only the shared prefix length so a full ISO instant on the boundary day
    // neither sorts before `since` nor after `until`. Full-timestamp bounds
    // still compare exactly, since the prefix then equals the whole string.
    if (args.since && String(e.ts || '').slice(0, args.since.length) < args.since) return false;
    if (args.until && String(e.ts || '').slice(0, args.until.length) > args.until) return false;
    if (args.file && !(e.files || []).some(f => needle(f).includes(needle(args.file)))) return false;
    return true;
  });
  let ranked = searchLib.rankEntries(filtered, args.query);
  // Natural-language fallback (final whole-branch review, Finding #1): the
  // strict pass requires a majority of distinct query tokens to match, which
  // is right for a keyword/topic query but makes a question-shaped one (e.g.
  // "who touched auth.js", "has anyone dealt with vault rotation") return
  // nothing — the filler words around the real keyword count toward the
  // majority and are never going to appear in memory prose. When the strict
  // pass finds nothing and the query has more than one distinct token, relax
  // to "at least one term matches" and re-rank. A query that already has a
  // strict match never reaches this branch, so precision is unchanged
  // whenever precision exists.
  const queryTokenCount = new Set(searchLib.tokenize(args.query)).size;
  if (ranked.length === 0 && queryTokenCount >= 2) {
    ranked = searchLib.rankEntries(filtered, args.query, { minTerms: 1 });
  }
  const results = deriveDeferred(ranked.slice(0, args.limit || 20), regexes);
  return { query: args.query, total: ranked.length, results };
}

module.exports = {
  loadContext, trackedProjectEntries, mapTeamRow, loadArchiveEntries,
  eventKey, collapseIdentityTwins,
  allActivity, deriveDeferred, recentActivity, searchMemory,
  // Exported for tests only: observe the archive-entry cache's size, to
  // prove it stays bounded rather than growing without limit.
  _archiveCacheSizeForTests,
};
