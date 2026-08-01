'use strict';
// One tracked project's already-captured activity, normalized into the single
// feed entry shape lib/search.js ranks over: the local half
// (memorydb.buildEntries -> feed.normalizeLocal) and the cached teammate half
// (util.teamRowsFor -> feed.normalizeTeam).
//
// Extracted out of lib/mcp.js so a caller that is NOT the MCP server can build
// the same entries. lib/mcp.js loads the MCP SDK and zod at module scope, and
// lib/hooks-search.js -- which runs in front of a Grep, in a process that
// exits after one tool call -- must not pay a transport dependency to read
// memory sitting on local disk. Sharing this module is also what keeps the
// hook and search_memory answering out of the SAME corpus: two hand-rolled
// assemblies would drift, and a hook that quietly saw different entries than
// the tool would be impossible to reason about.
//
// The durable team ARCHIVE (lib/team-archive.js) is deliberately NOT built
// here. Reading it costs a full read+parse of the rows file, measured at ~4s
// per project at the 50,000-row cap (see the archive cache comment in
// lib/mcp.js), and the cache that makes that bearable is a PROCESS-lifetime
// memo: worth having in a long-lived stdio server, worthless to a hook that
// exits after one call and would pay the uncached cost every single time.
// Callers that can afford it (search_memory) merge the archive on top of what
// this returns.
const path = require('path');
const util = require('./util');
const digest = require('./digest');
const memorydb = require('./memorydb');
const feed = require('./feed');

// One raw team row (the wire/cache shape) as a normalized feed entry. The
// field mapping IS the wire contract, so it lives in exactly one place --
// lib/mcp.js's archive reader and projectEntries below both call this rather
// than each spelling the mapping out.
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

// { local, team } for ONE project.
//
// deferChanges is always on: deriving a change note shells out to git per
// entry, which no caller wants inside a per-project loop. lib/mcp.js runs
// that derivation afterwards, on the entries that actually survived its
// slice; the search hook never needs it at all and never asks.
function projectEntries(key, proj, config, regexes) {
  const name = path.basename(key);
  const redact = t => digest.redactText(t, regexes);
  const local = memorydb.buildEntries(key, proj, config, { deferChanges: true })
    .map(e => feed.normalizeLocal(e, { projectPath: key, projectName: name, redact }));
  // A project this machine may no longer read contributes NOTHING from the
  // team side (lib/teamsync.js stamps teamAccessLost the moment the backend
  // stops listing it for this member). The sync pass also drops teamEntries
  // and prunes the archive, but that only runs when the machine next syncs --
  // this guard is what makes a laptop that has not checked in stop answering.
  // Local entries are unaffected: they are this user's own work.
  // util.teamRowsFor is the only supported reader; see its own header.
  const team = proj.teamAccessLost
    ? []
    : util.teamRowsFor(proj).map(e => mapTeamRow(e, name, redact));
  return { local, team };
}

module.exports = { mapTeamRow, projectEntries };
