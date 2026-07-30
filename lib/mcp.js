'use strict';
// Read-only MCP (Model Context Protocol) server: exposes MemBridge's already-
// captured, already-distilled project memory to MCP clients (Claude Desktop,
// Cursor, Cowork, ...). No capture or distillation logic lives here — every
// tool reads state.json fresh and reuses the same functions the dashboard and
// context-file injection already use (memorydb.buildEntries, digest.sessionGroups
// / teamInjectSlice, feed.normalizeLocal / normalizeTeam). Redaction is
// re-applied at this boundary regardless of whether the source already
// redacted it — the same defense-in-depth rule renderBlock and the dashboard
// feed already follow, since an MCP client is an agent/network boundary too.
//
// No trigger/side-effect tools: every tool here only reads. Nothing here
// pushes/pulls team sync, writes a context file, or mutates state.
//
// @modelcontextprotocol/sdk and zod are ordinary runtime dependencies (see
// package.json): a plain `npm install` ships them, so they are guaranteed
// present here. They are still required lazily, from inside this file, which
// is itself only ever required from inside `membridge mcp`'s command handler —
// so no other code path pays their load cost. A failure to load them is now a
// genuine broken install and surfaces as an ordinary error.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('./util');
const digest = require('./digest');
const memorydb = require('./memorydb');
const feed = require('./feed');
const provenance = require('./provenance');
const { findProjectKey } = require('./scan');
const recallStore = require('./recall-store');
const recall = require('./recall');
const diagnostics = require('./diagnostics');
const pkg = require('../package.json');

// requireFn is injectable so a test can exercise a broken install without
// needing the real packages to be absent. A load failure propagates as-is:
// these ship with the package, so the only way to get here is a genuinely
// damaged node_modules, and the real module error names the missing file far
// more usefully than any advice we could print.
function loadSdkDeps(requireFn = require) {
  const { McpServer } = requireFn('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = requireFn('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = requireFn('zod');
  return { McpServer, StdioServerTransport, z };
}

const { McpServer, StdioServerTransport, z } = loadSdkDeps();

// Fresh config/state/redactor on every call — a long-lived stdio server must
// never serve a stale snapshot from whenever it happened to start.
function loadContext() {
  const config = util.getConfig();
  const state = util.loadState();
  const regexes = digest.compileRedactions(config);
  return { config, state, regexes };
}

// Every text field returned to an MCP client passes through here, independent
// of whether its source already redacted it (buildEntries does; raw
// teamEntries and sessionGroups do not). Falsy input (missing/empty ask)
// always comes back as JSON null — never '' and never the string "null".
function redactedOrNull(regexes, text) {
  if (!text) return null;
  return digest.redactText(text, regexes);
}

// The change model is structured, but its `note` is free text: re-redact it on
// the way out, same defense-in-depth as redactedOrNull for ask/summary.
function redactChanges(regexes, changes) {
  if (!Array.isArray(changes)) return [];
  return changes.map(c => (c && c.note ? { ...c, note: digest.redactText(c.note, regexes) } : c));
}

function trackedProjectEntries(state, config) {
  return Object.entries(state.projects || {}).filter(([key]) => !util.isProjectOff(key, config));
}

// ---------------------------------------------------------------------------
// Tool implementations — pure functions of on-disk state, independently
// testable without a transport. registerTools() below is the only place that
// wires them to the MCP SDK.
// ---------------------------------------------------------------------------

function listProjects() {
  const { state, config } = loadContext();
  const projects = trackedProjectEntries(state, config).map(([key, proj]) => {
    const events = proj.events || [];
    return {
      path: key,
      name: path.basename(key),
      lastActivity: events.length ? events[events.length - 1].ts : null,
      lastSync: proj.lastSync || null,
      tools: [...new Set(events.map(e => e.source))],
    };
  });
  projects.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  return { projects };
}

function getProjectMemory(projectArg) {
  const { state, config, regexes } = loadContext();
  const key = findProjectKey(state, projectArg);
  if (!key) return { error: `unknown project: ${projectArg}` };
  if (util.isProjectOff(key, config)) return { error: `project is paused/excluded: ${key}` };
  const proj = state.projects[key];
  if (!Array.isArray(proj.events)) proj.events = [];

  // Mirrors renderBlock's "Recent asks across tools" section exactly — the
  // same per-session grouping that lands in CLAUDE.md/AGENTS.md.
  const recentAsks = digest.sessionGroups(key, proj, config).map(s => ({
    ts: s.ts,
    source: s.source,
    ask: redactedOrNull(regexes, s.ask),
    result: redactedOrNull(regexes, s.summary),
    distilled: !!s.distilled,
    tasks: s.todos ? digest.todoCounts(s.todos) : null,
    files: s.files.map(f => f.file),
    changes: redactChanges(regexes, s.changes),
  }));

  // Mirrors renderBlock's "Teammates' AI activity" section exactly — the same
  // teamInjectMax/teamMaxAgeHours trimming and per-(author,session) dedup.
  const teammates = digest.teamInjectSlice(proj.teamEntries, config).map(e => ({
    ts: e.ts,
    author: e.author,
    source: e.source,
    ask: redactedOrNull(regexes, e.ask),
    result: redactedOrNull(regexes, e.summary),
    files: Array.isArray(e.files) ? e.files : [],
    changes: redactChanges(regexes, e.changes),
  }));

  return {
    project: key,
    name: path.basename(key),
    lastSync: proj.lastSync || null,
    recentAsks,
    teammates,
  };
}

// Flattened, per-prompt entries (memorydb.buildEntries — the same source as
// memory.json and the dashboard's own activity list) across every tracked,
// non-paused project, local + cached teammate pulls, shaped with the same
// feed normalizers the dashboard feed uses. Team rows are read from each
// project's locally cached, already-pulled proj.teamEntries (no live network
// call — an MCP tool call must never require team credentials to answer a
// local read), so fields only known at live-fetch time (author id, row id)
// are simply omitted; feed.normalizeTeam already defaults those to null.
function allActivity(state, config, regexes) {
  const local = [];
  const team = [];
  const redact = t => digest.redactText(t, regexes);
  for (const [key, proj] of trackedProjectEntries(state, config)) {
    const name = path.basename(key);
    for (const e of memorydb.buildEntries(key, proj, config, { deferChanges: true })) {
      local.push(feed.normalizeLocal(e, { projectPath: key, projectName: name, redact }));
    }
    for (const e of proj.teamEntries || []) {
      // Pass through everything normalizeTeam knows how to carry — the
      // stored row shape is pullProject's `mapped` (lib/teamsync.js). An
      // omission here silently blinds search and activity to that field.
      team.push(feed.normalizeTeam({
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
      }, { redact }));
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

function getRecentActivity(limit) {
  const { state, config, regexes } = loadContext();
  const { local, team } = allActivity(state, config, regexes);
  const { entries } = feed.buildFeed({ local, team, limit: limit || 50 });
  return { entries: deriveDeferred(entries, regexes) };
}

function searchMemory(query, limit) {
  const { state, config, regexes } = loadContext();
  const { local, team } = allActivity(state, config, regexes);
  const q = String(query || '').toLowerCase();
  const matches = e =>
    (e.ask && e.ask.toLowerCase().includes(q)) ||
    (e.summary && e.summary.toLowerCase().includes(q));
  const { entries } = feed.buildFeed({
    local: local.filter(matches),
    team: team.filter(matches),
    limit: limit || 50,
  });
  return { query, results: deriveDeferred(entries, regexes) };
}

// File-level provenance (lib/provenance.js): which sessions — yours and
// teammates' — edited one file, newest first. Same unknown/paused project
// handling as get_project_memory; an unknown FILE is an empty sessions list,
// not an error (that is a legitimate answer, not a failure). Rows come back
// already redacted, but every text field re-runs redactedOrNull anyway — the
// same boundary rule as the other four tools.
function whyFile(projectArg, fileArg, line) {
  const { state, config, regexes } = loadContext();
  const key = findProjectKey(state, projectArg);
  if (!key) return { error: `unknown project: ${projectArg}` };
  if (util.isProjectOff(key, config)) return { error: `project is paused/excluded: ${key}` };
  const proj = state.projects[key];
  if (!Array.isArray(proj.events)) proj.events = [];
  const redactRow = r => ({
    ...r,
    ask: redactedOrNull(regexes, r.ask),
    summary: redactedOrNull(regexes, r.summary),
    decisions: redactedOrNull(regexes, r.decisions),
    gotchas: redactedOrNull(regexes, r.gotchas),
  });
  // Line-level: one owning session (or a fallback reason), every text field
  // re-redacted at this boundary exactly like the file-level rows.
  if (line != null) {
    const res = provenance.lineProvenance(key, proj, config, fileArg, line, Date.now());
    return {
      project: key,
      file: provenance.normalizeRel(key, fileArg),
      line: res.line,
      sha: res.sha,
      session: res.session ? redactRow(res.session) : null,
      fallback: res.fallback,
    };
  }
  const sessions = provenance.fileProvenance(key, proj, config, fileArg).map(redactRow);
  return { project: key, file: provenance.normalizeRel(key, fileArg), sessions };
}

// Same sha1-of-utf8-decoded-content hash lib/hooks-recall.js's contentHashOf
// and lib/recall-store.js's warm() both compute, so a hash produced here
// compares equal to a storeEntry.contentHash written by either of those.
// Duplicated rather than imported: it's a two-line use of Node's own crypto
// module, not a maintained template string, and lib/hooks-recall.js is a
// file this task must not touch to add an export to.
function contentHashOf(absPath) {
  return crypto.createHash('sha1').update(fs.readFileSync(absPath, 'utf8')).digest('hex');
}

// recall({ project, path }): the same Tier B "header + skeleton" body
// lib/recall.js's decide() would serve for a warmed, fresh, cache-eligible
// path -- but with NO session gating. decide() (and the tiers it computes
// via tierFor) exist to answer "has THIS session earned a serve", which is
// meaningless for an MCP caller: there is no PreToolUse session to gate on,
// and the brief is explicit that an MCP caller manages its own context. So
// this does its own, simpler check -- fresh cache entry + a skeleton +
// decide()'s own floors (MIN_CALL_TOKENS, MIN_COMPRESSION) -- and composes
// the body with recall.tierBBody, the exact same template decide() uses for
// a Tier B hit, rather than re-deriving the wording here.
//
// C2 fix (final whole-branch review): this tool used to gate ONLY on
// isProjectOff, bypassing all three kill switches the PreToolUse hook
// honours (lib/hooks-recall.js:151,178,204) -- MEMBRIDGE_NO_RECALL=1,
// config.recall.enabled === false, and config.recall.pausedProjects (the
// Task 9 net-negative auto-pause, lib/diagnostics.js). Mirrored here in the
// same order the hook checks them, each returning the tool's own
// { available: false, reason } miss shape rather than the hook's silent
// step-aside (an MCP caller always gets an answer). Session-scoped gates
// (holdout, already-served, rejection-limit) deliberately stay absent --
// those answer "has THIS session earned a serve", meaningless for a
// pull-based MCP caller with no session to gate on.
//
// Read-only, deliberately: no appendEvent, no session-state write. An MCP
// call is not an interception -- see lib/hooks-recall.js's own events.jsonl
// writes, which this function has no equivalent of -- and must never be
// folded into avoided totals (Task 6's ledger fold only ever reads
// events.jsonl, which this path never touches).
function recallTool(projectArg, pathArg) {
  // Fastest-possible kill switch, mirroring the hook's own ordering: no I/O
  // at all before this check.
  if (process.env.MEMBRIDGE_NO_RECALL === '1') return { available: false, reason: 'recall-disabled' };

  const { state, config } = loadContext();
  if (config.recall && config.recall.enabled === false) return { available: false, reason: 'recall-disabled' };

  const key = findProjectKey(state, projectArg);
  if (!key) return { available: false, reason: 'unknown-project' };
  if (util.isProjectOff(key, config)) return { available: false, reason: 'project-paused' };
  // A SEPARATE, recall-only pause from isProjectOff above (which also stops
  // memory capture/injection) -- a net-negative verdict must silence only
  // recall, exactly as lib/hooks-recall.js's own `tracked` gate documents.
  if (diagnostics.isRecallPausedForProject(key, config)) return { available: false, reason: 'recall-paused' };

  const relPath = provenance.normalizeRel(key, pathArg);
  if (!relPath) return { available: false, reason: 'not-found' };
  const absPath = path.join(key, relPath);

  let stat;
  try {
    stat = fs.statSync(absPath);
    if (!stat.isFile()) return { available: false, reason: 'not-found' };
  } catch {
    return { available: false, reason: 'not-found' };
  }

  const storeEntry = recallStore.get(key, relPath);
  if (!storeEntry || !storeEntry.skeleton) return { available: false, reason: 'no-entry' };

  let hash;
  try {
    hash = contentHashOf(absPath);
  } catch {
    return { available: false, reason: 'not-found' };
  }
  if (!storeEntry.contentHash || storeEntry.contentHash !== hash) return { available: false, reason: 'stale' };

  // Same floors decide() applies for Tier B, priced the same way: a full
  // read (no offset/limit -- an MCP caller isn't making a partial-read call).
  const callTokens = recall.estimateCallTokens(null, { size: stat.size });
  if (callTokens < recall.MIN_CALL_TOKENS) return { available: false, reason: 'below-floor' };
  const skeletonTokens = storeEntry.skeletonTokens || 0;
  if (skeletonTokens <= 0 || callTokens / skeletonTokens < recall.MIN_COMPRESSION) {
    return { available: false, reason: 'below-floor' };
  }

  const body = recall.tierBBody(relPath, storeEntry.skeleton);
  return { available: true, project: key, path: relPath, body, callTokens, skeletonTokens };
}

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------

// Every tool here is a read: readOnlyHint true, destructiveHint/idempotent/
// openWorld all reflect that (a fixed local dataset, no external side effects).
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function textResult(data) {
  const result = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  if (data && data.error) result.isError = true;
  return result;
}

function registerTools(server) {
  server.registerTool('list_projects', {
    title: 'List tracked projects',
    description: 'List every project MemBridge is tracking (paused/excluded projects are omitted), with basic metadata: path, name, last activity, last sync, and which AI tools have been active there.',
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => textResult(listProjects()));

  server.registerTool('get_project_memory', {
    title: "Get a project's shared memory",
    description: "One project's shared cross-tool memory: recent asks/results grouped by session, plus teammate activity pulled via team sync — the same content MemBridge injects into that project's CLAUDE.md/AGENTS.md, as structured data.",
    inputSchema: {
      project: z.string().min(1).describe('Absolute (or CWD-relative) path to a tracked project'),
    },
    annotations: READ_ONLY,
  }, async ({ project }) => textResult(getProjectMemory(project)));

  server.registerTool('get_recent_activity', {
    title: 'Get recent activity across all projects',
    description: 'Newest-first AI activity across every tracked, non-paused project, combining local sessions and cached teammate activity.',
    inputSchema: {
      limit: z.number().int().positive().max(200).optional().describe('Max entries to return (default 50, max 200)'),
    },
    annotations: READ_ONLY,
  }, async ({ limit }) => textResult(getRecentActivity(limit)));

  server.registerTool('search_memory', {
    title: 'Search project memory',
    description: "Keyword search across every tracked project's asks and results (local + teammate), newest match first.",
    inputSchema: {
      query: z.string().min(1).describe('Keyword or phrase to search for'),
      limit: z.number().int().positive().max(200).optional().describe('Max results to return (default 50, max 200)'),
    },
    annotations: READ_ONLY,
  }, async ({ query, limit }) => textResult(searchMemory(query, limit)));

  server.registerTool('why', {
    title: 'Why — file & line provenance',
    description: "Provenance for one file in a tracked project: which AI sessions (yours and teammates') edited it, newest first, each with the ask behind the edit, the session's result summary, decisions/gotchas, and whether that session is still live. Pass an optional `line` to get the single session behind ONE line (git blame → the local commit map → the owning session); an uncommitted, unmapped, or merge line falls back to the file-level answer with an explicit reason.",
    inputSchema: {
      project: z.string().min(1).describe('Absolute (or CWD-relative) path to a tracked project'),
      file: z.string().min(1).describe('File path relative to the project root (an absolute path inside the project also works)'),
      line: z.number().int().positive().optional().describe('Optional 1-based line number for line-level provenance'),
    },
    annotations: READ_ONLY,
  }, async ({ project, file, line }) => textResult(whyFile(project, file, line)));

  server.registerTool('recall', {
    title: 'Recall a cached file skeleton',
    description: "Structural summary of a tracked file from MemBridge's recall cache -- the same Tier B \"header + skeleton\" body the PreToolUse recall hook would serve, but with no session-based gating (an MCP caller manages its own context, unlike a hook in front of one session's reads). Returns { available: false, reason } -- one of unknown-project, project-paused, not-found, no-entry, stale, or below-floor -- when there is nothing servable.",
    inputSchema: {
      project: z.string().min(1).describe('Absolute (or CWD-relative) path to a tracked project'),
      path: z.string().min(1).describe('File path relative to the project root (an absolute path inside the project also works)'),
    },
    annotations: READ_ONLY,
  }, async ({ project, path: relPath }) => textResult(recallTool(project, relPath)));
}

function createServer() {
  const server = new McpServer({ name: 'membridge', version: pkg.version });
  registerTools(server);
  return server;
}

// Long-lived: resolves once the stdio transport is connected, not once the
// client disconnects. Never write to stdout here — it is the JSON-RPC wire.
async function startMcpServer() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  return server;
}

module.exports = {
  createServer, startMcpServer,
  // Exported for tests: pure functions, no transport required.
  listProjects, getProjectMemory, getRecentActivity, searchMemory, whyFile, recallTool,
  // Exported for tests: exercise the dependency-load path in isolation.
  loadSdkDeps,
};
