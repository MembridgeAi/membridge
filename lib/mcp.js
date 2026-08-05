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
const provenance = require('./provenance');
const { findProjectKey } = require('./scan');
const recallStore = require('./recall-store');
const recall = require('./recall');
const diagnostics = require('./diagnostics');
const mcpUsage = require('./mcp-usage');
const retrievals = require('./retrievals');
const activity = require('./activity');
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
const { loadContext, trackedProjectEntries, _archiveCacheSizeForTests } = activity;

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
  //
  // goal/decisions/gotchas/headline are the WHY of a session, and for a long
  // time they were dropped here while renderBlock printed them (as "Intent:"
  // and "Notes:"). So the tool whose entire contract is "the block, queryable"
  // returned strictly less than the block, and an agent that trusted it saw an
  // ask and a result with the reasoning stripped out. Same redaction treatment
  // as ask/result: redactedOrNull, so a missing field is JSON null and a
  // present one is re-scrubbed at this boundary like everything else.
  const recentAsks = digest.sessionGroups(key, proj, config).map(s => ({
    ts: s.ts,
    source: s.source,
    ask: redactedOrNull(regexes, s.ask),
    goal: redactedOrNull(regexes, s.goal),
    headline: redactedOrNull(regexes, s.headline),
    result: redactedOrNull(regexes, s.summary),
    decisions: redactedOrNull(regexes, s.decisions),
    gotchas: redactedOrNull(regexes, s.gotchas),
    distilled: !!s.distilled,
    tasks: s.todos ? digest.todoCounts(s.todos) : null,
    files: s.files.map(f => f.file),
    changes: redactChanges(regexes, s.changes),
  }));

  // Mirrors renderBlock's "Teammates' AI activity" section exactly — the same
  // teamInjectMax/teamMaxAgeHours trimming and per-(author,session) dedup, and
  // the same four why-fields as recentAsks above (a teammate row carries them
  // verbatim off the wire, see lib/teamsync.js pullProject).
  const teammates = digest.teamInjectSlice(util.teamRowsFor(proj), config).map(e => ({
    ts: e.ts,
    author: e.author,
    source: e.source,
    ask: redactedOrNull(regexes, e.ask),
    goal: redactedOrNull(regexes, e.goal),
    headline: redactedOrNull(regexes, e.headline),
    result: redactedOrNull(regexes, e.summary),
    decisions: redactedOrNull(regexes, e.decisions),
    gotchas: redactedOrNull(regexes, e.gotchas),
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

// Both of these are the shared machine-local corpus + scorer (lib/activity.js),
// which the dashboard's /api/search calls too. Kept as thin named wrappers so
// the tool registration below and the existing tests keep one stable name each,
// and so the two surfaces can never answer the same question differently.
function getRecentActivity(limit, opts) {
  return activity.recentActivity(limit, opts);
}

function searchMemory(args) {
  return activity.searchMemory(args);
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
  // Usage tracking (lib/retrievals.js): a `why` row is a demand-driven serve
  // of a specific memory, exactly like a search result — same event identity
  // (activity.eventKey), so a session recalled through EITHER surface
  // accrues onto one count. Provenance rows spell the fields who/tool where
  // entries say author/source; the adapter below maps them, it never guesses.
  const keyRow = r => activity.eventKey({ session: r.session, author: r.who, ts: r.ts, source: r.tool });
  const annotate = rows => {
    const keys = rows.map(keyRow);
    const counts = retrievals.countsFor(keys);
    rows.forEach((r, i) => { r.retrievals = counts[keys[i]] ? counts[keys[i]].n : 0; });
    // No `q`: a `why` serve is addressed by FILE, not by a query, and writing
    // the path into `q` would put a thing that was never typed as a search
    // into the corpus the eval lane replays. It goes in `files` instead —
    // where it is the strongest file-graph edge either surface produces, an
    // explicit "this file, these memories" with no lexical matching in between.
    retrievals.record('why', keys, { config, regexes, project: key, files: fileArg ? [fileArg] : null });
    return rows;
  };
  // Line-level: one owning session (or a fallback reason), every text field
  // re-redacted at this boundary exactly like the file-level rows.
  if (line != null) {
    const res = provenance.lineProvenance(key, proj, config, fileArg, line, Date.now());
    return {
      project: key,
      file: provenance.normalizeRel(key, fileArg),
      line: res.line,
      sha: res.sha,
      session: res.session ? annotate([redactRow(res.session)])[0] : null,
      fallback: res.fallback,
    };
  }
  const sessions = annotate(provenance.fileProvenance(key, proj, config, fileArg).map(redactRow));
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

// Anonymous presence tally (lib/mcp-usage.js): records ONLY that this tool
// name was invoked, never arguments or a count -- see that file's own
// comment for the full rationale. Wrapped once here rather than duplicated
// across six handler bodies; a tally failure is swallowed so it can never
// turn into a tool-call failure.
//
// util.getConfig() ONLY -- not loadContext() (final whole-branch review,
// Finding #4). loadContext() also calls util.loadState() (parses the whole
// state.json) and compiles redaction regexes, neither of which this tally
// needs; every handler below loads its own fresh context anyway. That
// mattered doubly for recallTool: its own doc comment promises "no I/O at all
// before" the MEMBRIDGE_NO_RECALL check, but tracked() runs BEFORE the
// wrapped handler, so a loadContext() here was doing state.json I/O (and
// tallying recall's use) ahead of a kill switch meant to make that call free.
const tracked = (name, fn) => async (args) => {
  try { mcpUsage.recordToolUse(name, { config: util.getConfig() }); } catch { /* never block a tool */ }
  return fn(args);
};

function registerTools(server) {
  server.registerTool('list_projects', {
    title: 'List tracked projects',
    description: 'List every project MemBridge is tracking (paused/excluded projects are omitted), with basic metadata: path, name, last activity, last sync, and which AI tools have been active there.',
    inputSchema: {},
    annotations: READ_ONLY,
  }, tracked('list_projects', async () => textResult(listProjects())));

  server.registerTool('get_project_memory', {
    title: "Get a project's shared memory",
    description: "One project's shared cross-tool memory: recent asks/results grouped by session, plus teammate activity pulled via team sync — the same content MemBridge injects into that project's CLAUDE.md/AGENTS.md, as structured data.",
    inputSchema: {
      project: z.string().min(1).describe('Absolute (or CWD-relative) path to a tracked project'),
    },
    annotations: READ_ONLY,
  }, tracked('get_project_memory', async ({ project }) => textResult(getProjectMemory(project))));

  server.registerTool('get_recent_activity', {
    title: 'Get recent activity across all projects',
    description: "Newest-first AI activity across every tracked, non-paused project, combining local sessions and cached teammate activity. THIS IS THE TOOL for \"what is <teammate> working on\" or \"what has anyone touched today\" — pass `author` to narrow to one person (name substring, e.g. \"andrew\"); search_memory ranks by relevance with no recency weighting and cannot answer it.\n\nAnswer from the NEWEST entry and use its `presence`, which grades how current the entry actually is:\n• `active` — activity landed within one sync interval. Say so in the present tense: \"Andrew is working on the invite redemption path.\" This is a real signal, not a guess; a row cannot arrive that recently unless their tooling was running.\n• `recent` — within the last 15 minutes. \"Andrew was on X a few minutes ago.\"\n• `idle` — older. Give the age: \"Andrew's last synced work was 3 hours ago.\" That means they have not synced since, which is not the same as them being idle.\n\nCRUCIALLY, presence is graded on `lastActivityAt` (their newest activity), NOT on `ts` (when the prompt was made). A session prompted 13 minutes ago whose agent is still running tools is `active` — someone is working right now on something they asked for a while back. Reporting the prompt age alone would call that dead. When the two differ, say both: \"Andrew asked about the invite flow 13 minutes ago and is still working on it.\"\n\nThis is a LOCAL read of rows team sync has already pulled, so a teammate who started seconds ago may not appear yet — absence is never evidence they are idle. `liveBasis` names what the judgement rests on: 'session-events' (your own session, its newest real event) or 'synced-row' (a teammate, judged on when their row reached the backend). Do not upgrade `recent` or `idle` into the present tense; `active` already carries that claim.",
    inputSchema: {
      limit: z.number().int().positive().max(200).optional().describe('Max entries to return (default 50, max 200)'),
      author: z.string().optional().describe('only this teammate (name substring, e.g. "andrew"); omit for everyone'),
      project: z.string().optional().describe('only this project (name substring or absolute path)'),
    },
    annotations: READ_ONLY,
  }, tracked('get_recent_activity', async ({ limit, author, project }) =>
    textResult(getRecentActivity(limit, { author, project }))));

  server.registerTool('search_memory', {
    title: 'Search team memory',
    description: 'Ranked search over everything MemBridge remembers on this machine: your sessions and your teammates\' shared work (asks, summaries, decisions, gotchas, headlines, files touched) across all tracked projects. Works best with keywords, file names, or short topics (e.g. "auth rotation", "vault.tf") rather than full question sentences. Results are ranked by relevance, not date — old work surfaces when it matches. Each result carries `retrievals`: how many times that entry had been served (via search or `why`) before this call — a high number marks knowledge the team actually leans on, and it breaks ties in the ranking, so among near-equal matches the proven one comes first.',
    inputSchema: {
      query: z.string().min(1).describe('keywords, a file name, or a topic'),
      author: z.string().optional().describe('only entries by this teammate (name substring)'),
      project: z.string().optional().describe('only this project (name substring)'),
      file: z.string().optional().describe('only entries touching this file (path substring)'),
      tool: z.string().optional().describe('only this source tool, e.g. "Claude Code" or "Codex" (case-insensitive)'),
      since: z.string().optional().describe('ISO date lower bound, e.g. "2026-06-01"'),
      until: z.string().optional().describe('ISO date upper bound'),
      limit: z.number().int().positive().max(200).optional(),
    },
    annotations: READ_ONLY,
  }, tracked('search_memory', async (args) => textResult(searchMemory(args))));

  server.registerTool('why', {
    title: 'Why — file & line provenance',
    description: "Provenance for one file in a tracked project: which AI sessions (yours and teammates') edited it, newest first, each with the ask behind the edit, the session's result summary, decisions/gotchas, and whether that session is still live (`live` with a `liveBasis` of 'session-events' for your own sessions, or 'synced-row' for a teammate, where it means only that their newest synced row is recent, not that they are working now). Pass an optional `line` to get the single session behind ONE line (git blame → the local commit map → the owning session); an uncommitted, unmapped, or merge line falls back to the file-level answer with an explicit reason.",
    inputSchema: {
      project: z.string().min(1).describe('Absolute (or CWD-relative) path to a tracked project'),
      file: z.string().min(1).describe('File path relative to the project root (an absolute path inside the project also works)'),
      line: z.number().int().positive().optional().describe('Optional 1-based line number for line-level provenance'),
    },
    annotations: READ_ONLY,
  }, tracked('why', async ({ project, file, line }) => textResult(whyFile(project, file, line))));

  server.registerTool('recall', {
    title: 'Recall a cached file skeleton',
    description: "Structural summary of a tracked file from MemBridge's recall cache -- the same Tier B \"header + skeleton\" body the PreToolUse recall hook would serve, but with no session-based gating (an MCP caller manages its own context, unlike a hook in front of one session's reads). Returns { available: false, reason } -- one of unknown-project, project-paused, not-found, no-entry, stale, or below-floor -- when there is nothing servable.",
    inputSchema: {
      project: z.string().min(1).describe('Absolute (or CWD-relative) path to a tracked project'),
      path: z.string().min(1).describe('File path relative to the project root (an absolute path inside the project also works)'),
    },
    annotations: READ_ONLY,
  }, tracked('recall', async ({ project, path: relPath }) => textResult(recallTool(project, relPath))));
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
  // Exported for tests only: observe the archive-entry cache's size, to
  // prove it stays bounded rather than growing without limit.
  _archiveCacheSizeForTests,
};
