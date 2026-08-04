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
// It also serves lib/hooks-search.js, which runs in front of a Grep in a
// process that exits after one tool call. That caller is why projectEntries
// below is a separate, archive-free export rather than a slice of allActivity:
// lib/mcp.js loads the MCP SDK and zod at module scope, and a hook reading
// memory off local disk must not pay a transport dependency. allActivity
// CALLS projectEntries rather than repeating its body, which is what stops
// the hook and the tools from answering out of two hand-rolled assemblies
// that drift.
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
const crypto = require('crypto');
const util = require('./util');
const digest = require('./digest');
const memorydb = require('./memorydb');
const feed = require('./feed');
const searchLib = require('./search');
const fileGraph = require('./file-graph');
const searchIndex = require('./search-index');
const teamsync = require('./teamsync');
const teamArchive = require('./team-archive');
const retrievals = require('./retrievals');

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
// `projectId` is the shared backend id of the project the row belongs to.
// Archive rows are read out of a per-project file and carry no project column
// of their own, so without it every archived entry normalized to
// `projectId: null` -- and anything filtering by project could reach the
// working cache but never the archive behind it.
function mapTeamRow(e, name, redact, projectId) {
  return feed.normalizeTeam({
    author_name: e.author,
    project_name: name,
    project_id: e.project_id || projectId || null,
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
  const entries = teamArchive.loadArchive(projectId).rows.map(e => mapTeamRow(e, name, redact, projectId));
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

// { local, team } for ONE project: the local half (memorydb.buildEntries ->
// feed.normalizeLocal) and the cached teammate half (util.teamRowsFor ->
// mapTeamRow). This is THE per-project assembly. allActivity loops over it and
// lib/hooks-search.js calls it directly, so there is exactly one definition of
// what a project's entries are.
//
// The durable team ARCHIVE is deliberately NOT read here. loadArchive costs a
// full read+parse, measured at ~4s per project at the 50,000-row cap, and the
// cache that makes that bearable is a PROCESS-lifetime memo: worth having in a
// long-lived stdio server or daemon, worthless to a hook that exits after one
// call and would pay the uncached cost every single time. Callers that can
// afford it opt in through allActivity's includeArchive.
//
// deferChanges is always on: deriving a change note shells out to git per
// entry, which no caller wants inside a per-project loop. deriveDeferred runs
// that afterwards, on the entries that actually survived the caller's slice;
// the search hook never needs it at all and never asks.
function projectEntries(key, proj, config, regexes) {
  const name = path.basename(key);
  const redact = t => digest.redactText(t, regexes);
  const local = memorydb.buildEntries(key, proj, config, { deferChanges: true })
    .map(e => feed.normalizeLocal(e, { projectPath: key, projectName: name, redact }));
  // A project this machine may no longer read (lib/teamsync.js sets this the
  // moment the backend stops listing it) contributes NOTHING from the team
  // side. The sync pass also drops teamEntries and prunes the archive, but that
  // only runs when the machine next syncs — this guard is what makes a laptop
  // that has not checked in stop answering. Local entries are unaffected: they
  // are this user's own work. util.teamRowsFor is the only supported reader.
  const team = proj.teamAccessLost
    ? []
    : util.teamRowsFor(proj).map(e => mapTeamRow(e, name, redact));
  return { local, team };
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
// ONE project's slice of the corpus. Extracted from allActivity's loop body so
// the FTS5 indexer (freshenIndex, below) refills a SINGLE project without
// re-assembling every other one — and, more importantly, so it does that
// through the same assembly allActivity uses rather than a second hand-rolled
// copy. That duplication is the exact failure this module was created to end.
function projectCorpus(key, proj, config, regexes, opts = {}) {
  const local = [];
  const team = [];
  {
    const name = path.basename(key);
    // The SAME assembly lib/hooks-search.js calls. Repeating its body here is
    // what two independent extractions of this module each did, and it is the
    // one thing this module exists to prevent: the teamAccessLost guard lives
    // in there, and is re-tested below only to gate the ARCHIVE, which
    // projectEntries deliberately does not read.
    const own = projectEntries(key, proj, config, regexes);
    for (const e of own.local) local.push(e);
    for (const e of own.team) team.push(e);
    if (proj.teamAccessLost) return { local, team };
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

// Every tracked project's corpus, concatenated. Delegates to projectCorpus so
// the whole-machine read and the per-project index refill can never disagree
// about what a project's entries are.
function allActivity(state, config, regexes, opts = {}) {
  const local = [];
  const team = [];
  for (const [key, proj] of trackedProjectEntries(state, config)) {
    const own = projectCorpus(key, proj, config, regexes, opts);
    for (const e of own.local) local.push(e);
    for (const e of own.team) team.push(e);
  }
  return { local, team };
}

// ---------------------------------------------------------------------------
// FTS5 index freshening
// ---------------------------------------------------------------------------
// Everything a project's corpus is derived from, as one cheap value: the
// project's slice of state.json (hashed, because a distilled summary can be
// written onto an EXISTING event without changing the event count or its ts),
// plus the archive file's stat.
//
// STAT, NOT CONTENT, for the archive -- deliberately, and the suite pins it.
// loadArchiveEntries' memo keys on mtimeMs+size, and test/run-tests.js asserts
// that an equal-length on-disk archive mutation with the mtime restored stays
// INVISIBLE to search. Hashing archive bytes here would make it visible and
// silently change documented cache semantics.
// Per-process memo of the EXPENSIVE half (serializing and hashing a project's
// state slice), keyed on state.json's own stat. Nothing in state.json can
// change without that stat moving, so a search that follows an unchanged
// state pays one statSync instead of re-hashing every project — measured at
// 125ms per search across 50 projects before this.
//
// Same shape, and the same accepted exposure, as loadArchiveEntries' cache
// above and lib/retrievals.js's fold memo: two writes landing in the same
// millisecond at an identical size would look unchanged.
let stateHashMemo = null; // { stat, hashes: Map<memoKey, hash> }

function stateStatKey() {
  try {
    const stat = fs.statSync(util.statePath());
    return `${stat.mtimeMs}|${stat.size}`;
  } catch {
    return 'absent';
  }
}

function projectStateHash(key, proj, regexes) {
  const stat = stateStatKey();
  if (!stateHashMemo || stateHashMemo.stat !== stat) stateHashMemo = { stat, hashes: new Map() };
  const memoKey = `${key}|${redactionSignature(regexes)}`;
  let hash = stateHashMemo.hashes.get(memoKey);
  if (hash == null) {
    hash = crypto.createHash('sha1')
      .update(JSON.stringify(proj || {}))
      .update(`|${redactionSignature(regexes)}`)
      .digest('hex');
    stateHashMemo.hashes.set(memoKey, hash);
  }
  return hash;
}

function projectSearchFingerprint(key, proj, regexes) {
  const h = crypto.createHash('sha1');
  h.update(projectStateHash(key, proj, regexes));
  try {
    const link = teamsync.loadTeamLink(key);
    if (link && link.projectId) {
      const stat = fs.statSync(teamArchive.archivePath(link.projectId));
      h.update(`|${link.projectId}|${stat.mtimeMs}|${stat.size}`);
    } else {
      h.update('|unlinked');
    }
  } catch {
    h.update('|no-archive'); // no rows file yet: a real, stable state
  }
  return h.digest('hex');
}

// Bring the index up to date, touching only what moved. A full rebuild on
// every search would be SLOWER than the linear scan this replaces -- the
// daemon rewrites state.json every tick -- so the common case here is N
// fingerprint compares and no writes at all.
function freshenIndex(db, state, config, regexes) {
  const signature = `${searchIndex.SCHEMA_VERSION}|${redactionSignature(regexes)}`;
  if (searchIndex.needsRebuild(db, signature)) {
    // Empties the index AND every per-project fingerprint, so the loop below
    // refills from scratch. This is the redaction-config path: patterns that
    // the index never saw must not leave old text searchable.
    searchIndex.replaceAll(db, [], { signature });
  }
  let refreshed = 0;
  for (const [key, proj] of trackedProjectEntries(state, config)) {
    if (freshenProject(db, key, proj, config, regexes)) refreshed += 1;
  }
  return { refreshed };
}

// One project's refill, or nothing if its inputs have not moved. Split out so
// a caller that only cares about a SINGLE project -- lib/hooks-search.js runs
// in front of one Grep, in one repo -- can pay for that project alone instead
// of freshening the whole machine on its way to reading one row.
// Returns whether it wrote anything.
function freshenProject(db, key, proj, config, regexes) {
  const fingerprint = projectSearchFingerprint(key, proj, regexes);
  if (searchIndex.projectFingerprint(db, key) === fingerprint) return false;
  const { local, team } = projectCorpus(key, proj, config, regexes, { includeArchive: true });
  // Same collision rule as buildFeed: a local entry wins over its own pushed
  // twin. Expressed here as write ORDER -- replaceProject keeps the last
  // write for a key -- so team rows go in first and local rows overwrite.
  const items = [...collapseIdentityTwins(team), ...local]
    .map(entry => ({ key: eventKey(entry), entry }));
  searchIndex.replaceProject(db, key, items, fingerprint);
  return true;
}

// The daemon's whole contribution to search: keep the index current on the
// tick it already runs, so the first search after a busy period does not pay
// to refill it on everyone else's behalf.
//
// Fail-open and self-contained, exactly like countersTick in bin/membridge.js:
// this rides a tick whose real job is syncing memory, and a search-index
// problem must never break that. It logs and returns instead of throwing, and
// reports what it did so the caller can log something useful.
function refreshSearchIndex() {
  try {
    const { state, config, regexes } = loadContext();
    const db = searchIndex.open();
    try {
      return freshenIndex(db, state, config, regexes);
    } finally {
      searchIndex.close(db);
    }
  } catch (err) {
    try { util.log(`search index refresh failed: ${err && err.stack ? err.stack : err}`); } catch {}
    return { refreshed: 0, failed: true };
  }
}

// Projects whose team rows must not be served. util.teamRowsFor is the only
// supported reader of a project's team rows precisely because it applies this
// gate; the index cannot call it (it holds rows, not projects), so the gate is
// re-derived here and pushed into the query instead.
function revokedProjects(state, config) {
  const revoked = [];
  for (const [key, proj] of trackedProjectEntries(state, config)) {
    if (proj && proj.teamAccessLost) revoked.push(key);
  }
  return revoked;
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

// ---------------------------------------------------------------------------
// Filter matching, shared by search_memory and the dashboard's /api/search.
//
// The two callers speak different dialects and both are legitimate. The MCP
// tool's documented contract is human input: a NAME SUBSTRING ("andrew",
// "membridge"). The dashboard's dropdowns send IDENTIFIERS -- a member's user
// id and a project's absolute path -- because those are what /api/feed matches
// on (lib/server.js: `e.authorId === opts.author`, `e.projectPath ===
// opts.project`), and the two screens share one filter vocabulary.
//
// Matching names alone, as this did, meant the dashboard's filters could never
// match anything at all: a uuid is not a substring of a display name, and an
// absolute path is not a substring of a project name. Every dropdown returned
// an empty list for every query. Both dialects are accepted rather than one
// being chosen, because dropping either breaks a shipped caller.
// ---------------------------------------------------------------------------
const lower = v => String(v == null ? '' : v).toLowerCase();

// A leading '!' inverts the person filter -- "everyone except this one" --
// which is how the dashboard's "Hide mine" control is expressed. It has to
// narrow BEFORE ranking and before the page limit: filtering the returned page
// in the browser would carve rows out of a top-25 that is mostly your own work
// and leave the reported total describing a list nobody can see.
function matchesAuthor(entry, filter) {
  const raw = String(filter);
  const negated = raw.startsWith('!');
  const want = negated ? raw.slice(1) : raw;
  if (!want) return true;
  const hit = entry.authorId === want || lower(entry.author).includes(lower(want));
  return negated ? !hit : hit;
}

// Team rows carry no path -- lib/feed.js normalizeTeam pins `projectPath` to
// null on purpose, since a teammate's checkout lives somewhere else on their
// machine and the field would be a lie. So an absolute path from the dashboard
// is resolved through the local checkout's own .membridge/team.json to the
// SHARED project id, and matched on that instead. lib/server.js does exactly
// this for the feed (`teamProject`); doing it once per search rather than once
// per entry keeps the file read out of the filter loop.
function projectFilterFor(filter) {
  if (!filter) return null;
  let linkedId = null;
  if (path.isAbsolute(filter)) {
    try {
      const link = teamsync.loadTeamLink(filter);
      linkedId = (link && link.projectId) || null;
    } catch {
      linkedId = null; // an unreadable link is "no shared id", never a throw
    }
  }
  return { raw: filter, linkedId };
}

function matchesProject(entry, filter) {
  return entry.projectPath === filter.raw
    || entry.projectId === filter.raw
    || (!!filter.linkedId && entry.projectId === filter.linkedId)
    || lower(entry.project).includes(lower(filter.raw));
}

// Exact, never substring: 'Claude' would otherwise select 'Claude Code' too,
// and the dropdown offers both as separate choices. Folded through
// publicSource so the dropdown's 'Codex' reaches rows stored as 'Distilled'.
function matchesTool(entry, filter) {
  return lower(entry.source) === lower(filter)
    || lower(util.publicSource(entry.source)) === lower(filter);
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
  const db = searchIndex.open();
  try {
    return searchMemoryVia(db, args, state, config, regexes);
  } finally {
    searchIndex.close(db);
  }
}

// How many rows the neighbour query may bring back. A footprint file can be
// one almost every session touched, and pulling its whole adjacency list to
// fill at most a page of empty slots is work thrown away. Bounded here rather
// than by trying to guess which files are hubs before querying — the weighting
// in lib/file-graph.js already ranks a hub file's links near zero, so the cap
// only decides how much evidence that judgement is made on.
const BACKFILL_SCAN_LIMIT = 500;

// Entries that touched the same code as the best lexical hits, for the slots a
// short page left empty. Returns [] whenever the page is already full, which
// is the common case and costs one length check.
//
// IDF CAVEAT, stated plainly because it changes how the scores read. The graph
// here is built over the WORKING SET (the lexical candidates plus the rows the
// neighbour query returned), not the whole corpus, so a file's weight is its
// rarity within that set rather than on disk. Absolute affinities are
// therefore not comparable across queries. The ORDER is what backfill uses,
// and order survives: every row in the working set touches a footprint file,
// so a footprint file that nearly all of them touch is genuinely the
// non-discriminating one *for this comparison*, and the rare file that only a
// couple share still wins. Building the true corpus-wide graph would mean
// reading every row on every search, which is exactly the cost the index was
// introduced to remove.
function backfillFromFileGraph(db, opts) {
  const { page, ranked, limit, filtered, excludeTeamFor, passesFilters } = opts;
  const room = limit - page.length;
  if (room <= 0) return [];
  const footprint = searchLib.footprintOf(ranked);
  if (!footprint.length) return [];
  const rows = searchIndex.neighboursByFiles(db, {
    files: footprint, excludeTeamFor, limit: BACKFILL_SCAN_LIMIT,
  });
  if (!rows.length) return [];
  // The user's filters bind here exactly as they do on the lexical path — same
  // predicate, not a second copy of it.
  const seen = new Set(filtered.map(e => e.key));
  const fresh = rows.filter(e => !seen.has(e.key) && passesFilters(e));
  if (!fresh.length) return [];
  const working = [...filtered, ...fresh];
  const graph = fileGraph.buildGraph(working, e => e.key);
  const byKey = new Map(fresh.map(e => [e.key, e]));
  const picks = searchLib.fileBackfill(graph, footprint, {
    exclude: seen, limit: room,
  });
  const out = [];
  for (const pick of picks) {
    const row = byKey.get(pick.key);
    if (!row) continue;
    // score 0, deliberately: these did not match the query lexically and
    // inventing a BM25-comparable number for them would put them into a
    // ranking they were never scored in. They sit below every lexical hit
    // because they are appended after the page, not because of this number.
    out.push({ ...row, score: 0, fileAffinity: Math.round(pick.affinity * 1000) / 1000 });
  }
  return out;
}

function searchMemoryVia(db, args, state, config, regexes) {
  freshenIndex(db, state, config, regexes);
  // searchLib.searchPasses, not a private strict/relaxed two-pass: it is the
  // SAME policy rankWithFallback applies in memory (lib/hooks-search.js still
  // ranks that way), expressed as index queries. Written out separately the
  // two would drift, and "no results" would quietly mean different things on
  // different surfaces.
  const passes = searchLib.searchPasses(args.query);
  const excludeTeamFor = revokedProjects(state, config);
  let hits = [];
  for (const pass of passes) {
    hits = searchIndex.search(db, { terms: pass.terms, minTerms: pass.minTerms, excludeTeamFor });
    if (hits.length) break; // a query with a strict match never reaches the relaxed pass
  }
  // Metadata only at this point — no entry bodies. Filtering and ranking run
  // over the whole candidate set, which a broad query makes large, and only
  // the page that survives is hydrated below.
  const all = hits;
  const needle = v => String(v).toLowerCase();
  const projectFilter = projectFilterFor(args.project);
  // Named, because the file-graph backfill below has to apply the IDENTICAL
  // predicate to the rows it brings in. A second hand-written copy is how a
  // backfilled row would start ignoring an author or date filter the user
  // explicitly asked for — or, worse, a project scope.
  const passesFilters = e => {
    if (args.author && !matchesAuthor(e, args.author)) return false;
    if (projectFilter && !matchesProject(e, projectFilter)) return false;
    if (args.tool && !matchesTool(e, args.tool)) return false;
    // Bare-date bounds (e.g. "2026-06-01") must include that whole day: compare
    // only the shared prefix length so a full ISO instant on the boundary day
    // neither sorts before `since` nor after `until`. Full-timestamp bounds
    // still compare exactly, since the prefix then equals the whole string.
    if (args.since && String(e.ts || '').slice(0, args.since.length) < args.since) return false;
    if (args.until && String(e.ts || '').slice(0, args.until.length) > args.until) return false;
    if (args.file && !(e.files || []).some(f => needle(f).includes(needle(args.file)))) return false;
    return true;
  };
  const filtered = all.filter(passesFilters);
  // Usage as a relevance prior (lib/retrievals.js): among entries the lexical
  // scorer rates as near-equal, the one the team keeps coming back to is the
  // better answer. Counts are read HERE, not inside lib/search.js, which
  // stays pure and never learns where they live — it just gets a lookup. Read
  // across the whole candidate pool rather than the served slice, because the
  // prior has to be available while the order is still being decided; the fold
  // behind countsFor is memoized per process, so this is one map, not one read
  // per candidate.
  // Keys come straight off the index rows: eventKey(e) cannot be recomputed
  // here, because these are metadata rows and the entry bodies they were
  // derived from are not loaded yet.
  const counts = retrievals.countsFor(filtered.map(e => e.key));
  // The usage boost, applied to BM25 relevance. lib/search-index.js already
  // negated bm25()'s native negative scores, so higher is better here exactly
  // as it was under the hand-rolled scorer and searchLib.usageBoost multiplies
  // in the right direction without knowing which ranker produced the score.
  //
  // Re-sorted rather than trusting SQL's ORDER BY: the boost can legitimately
  // reorder near-ties, and the ts tiebreak below is the same newest-first rule
  // rankEntries applies.
  const ranked = filtered
    .map(e => {
      const c = counts[e.key];
      const boost = searchLib.usageBoost(c ? c.n : 0);
      return { ...e, score: Math.round(e.score * boost * 1000) / 1000 };
    })
    .sort((a, b) => (b.score - a.score) || String(b.ts || '').localeCompare(String(a.ts || '')));
  // Hydrate ONLY the page. Everything above ran on metadata; the full entry
  // bodies are read and parsed here, for at most `limit` rows.
  const limit = args.limit || 20;
  const page = ranked.slice(0, limit);
  // File-graph backfill: sessions that touched the same code as the best
  // lexical hits, for a query whose words never reached them. Only ever fills
  // slots the lexical pass left EMPTY (see lib/search.js), so a query that
  // already fills its page is untouched and no lexical hit is ever displaced.
  const backfilled = backfillFromFileGraph(db, {
    page, ranked, limit, filtered, excludeTeamFor, passesFilters,
  });
  for (const row of backfilled) page.push(row);
  const bodies = searchIndex.hydrate(db, page.map(e => e.key));
  const results = deriveDeferred(
    page.map(e => ({
      ...(bodies.get(e.key) || {}),
      score: e.score,
      // Present ONLY on backfilled rows, and the honest label for them: this
      // entry came back because it touched the same code, not because it
      // matched the words. Its `matched` list is legitimately empty, and
      // without this an agent would see a zero-score result with no
      // explanation for why it is in the page at all.
      ...(e.fileAffinity != null ? { fileAffinity: e.fileAffinity } : {}),
    })), regexes);
  // `matched` is part of the result contract and BM25 cannot report it (one
  // score per row, not per column), so it is derived for the served page only
  // — never the whole ranked list — from lib/search.js's shared field rules.
  const queryTokens = [...new Set(searchLib.tokenize(args.query))];
  results.forEach(e => { e.matched = searchLib.matchedFields(e, queryTokens); });
  // Usage tracking, for the entries actually SERVED — the slice, never the
  // full ranked list. Annotate each result with how many times it had been
  // retrieved BEFORE this call (so the number an agent reads is history, not
  // self-fulfilling — and it is the same `counts` snapshot the ranking above
  // used, taken before this serve was appended), then append this serve.
  // Recording here covers both shipped callers of this function — the MCP
  // tool and the dashboard's /api/search — which is the point: the corpus
  // invariant says those surfaces answer identically, and that has to
  // include what they count.
  // Taken from the index rows, not recomputed with eventKey over the hydrated
  // bodies: the indexed key is what the ranking and the counts above already
  // used, and a recomputed one that disagreed would split a memory's history
  // across two keys without anything failing visibly.
  const keys = page.map(e => e.key);
  results.forEach((e, i) => { e.retrievals = counts[keys[i]] ? counts[keys[i]].n : 0; });
  // The query goes down WITH the keys, in one line, because the pairing is the
  // whole point: a query and a served slice recorded apart could never be
  // rejoined. `total` is the ranked pool the slice came out of, and `files`
  // the file filter when the caller narrowed by one.
  retrievals.record('search', keys, {
    config,
    regexes,
    query: args.query,
    project: args.project || null,
    total: ranked.length,
    files: args.file ? [args.file] : null,
  });
  // `total` counts the backfilled rows too: it is what the caller was offered,
  // and reporting the lexical pool alone could claim a total BELOW the number
  // of results actually returned.
  return { query: args.query, total: ranked.length + backfilled.length, results };
}

module.exports = {
  loadContext, trackedProjectEntries, projectEntries, projectCorpus, mapTeamRow, loadArchiveEntries,
  eventKey, collapseIdentityTwins,
  allActivity, deriveDeferred, recentActivity, searchMemory,
  // The index lane: the daemon freshens on its own tick (lib/server.js) rather
  // than leaving every refill to whoever searches first.
  freshenIndex, freshenProject, refreshSearchIndex, projectSearchFingerprint, revokedProjects,
  // Exported for tests only: observe the archive-entry cache's size, to
  // prove it stays bounded rather than growing without limit.
  _archiveCacheSizeForTests,
};
