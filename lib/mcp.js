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
// @modelcontextprotocol/sdk and zod are opt-in, not core dependencies (see
// package.json — MemBridge's plain `npm install` stays zero-dependency): they
// are only ever required from inside this file, which is itself only ever
// required from inside `membridge mcp`'s command handler. loadSdkDeps() below
// turns a missing-package MODULE_NOT_FOUND into one clear, actionable line
// instead of a raw stack trace.
const path = require('path');
const util = require('./util');
const digest = require('./digest');
const memorydb = require('./memorydb');
const feed = require('./feed');
const { findProjectKey } = require('./scan');
const pkg = require('../package.json');

const MISSING_DEPS_MESSAGE =
  'The MemBridge MCP server needs @modelcontextprotocol/sdk and zod, which are opt-in (not installed by a plain `npm install`).\n' +
  'Install them with:\n\n  npm install @modelcontextprotocol/sdk zod\n';

// requireFn is injectable so a test can exercise this exact MODULE_NOT_FOUND
// handling without needing the real packages to be absent.
function loadSdkDeps(requireFn = require) {
  try {
    const { McpServer } = requireFn('@modelcontextprotocol/sdk/server/mcp.js');
    const { StdioServerTransport } = requireFn('@modelcontextprotocol/sdk/server/stdio.js');
    const { z } = requireFn('zod');
    return { McpServer, StdioServerTransport, z };
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      console.error(MISSING_DEPS_MESSAGE);
      process.exit(1);
    }
    throw err;
  }
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
    for (const e of memorydb.buildEntries(key, proj, config)) {
      local.push(feed.normalizeLocal(e, { projectPath: key, projectName: name, redact }));
    }
    for (const e of proj.teamEntries || []) {
      team.push(feed.normalizeTeam({
        author_name: e.author,
        project_name: name,
        ts: e.ts,
        source: e.source,
        ask: e.ask,
        summary: e.summary,
        files: e.files,
      }, { redact }));
    }
  }
  return { local, team };
}

function getRecentActivity(limit) {
  const { state, config, regexes } = loadContext();
  const { local, team } = allActivity(state, config, regexes);
  const { entries } = feed.buildFeed({ local, team, limit: limit || 50 });
  return { entries };
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
  return { query, results: entries };
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
  listProjects, getProjectMemory, getRecentActivity, searchMemory,
  // Exported for tests: exercise the missing-dependency path in isolation.
  loadSdkDeps, MISSING_DEPS_MESSAGE,
};
