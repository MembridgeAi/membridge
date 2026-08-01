'use strict';
// PreToolUse hook on Grep and Glob: when an agent starts digging through a
// tracked project to reconstruct prior work, MemBridge's own memory of that
// work is put in front of it, unasked.
//
// WHY THIS EXISTS AT ALL: the MCP memory tools were called zero times across
// months of real use despite being registered and working. An advertised tool
// is a request the agent can skip, and it skipped. lib/hooks-recall.js already
// proved the shape that does not ask -- it serves memory on a file read with
// no agent initiative -- and this is its sibling for SEARCH. A Grep is the
// single clearest signal that an agent is about to rediscover something
// somebody already worked out.
//
// GOVERNING RULE, inherited verbatim from lib/hooks-recall.js: every failure
// degrades to ordinary agent behaviour, never to broken work. runSearch()'s
// ENTIRE body is wrapped in a try/catch, so any exception -- corrupt state,
// bad JSON, a permission error, anything -- is swallowed and the search
// proceeds untouched (exit 0, no stdout), with at most a line in the local
// log. This hook NEVER denies: its output is always an `allow` carrying
// additionalContext, so even a serve leaves the Grep itself to run exactly as
// the agent wrote it.
//
// TIME BOUND: the per-hook `timeout` on the PreToolUse entry that
// lib/hooks.js's reconcileSearchHook writes into settings.json is the ONLY
// real bound, and Claude Code's own hook runner enforces it. As in
// hooks-recall, there is deliberately no in-process JS watchdog: this path is
// SYNCHRONOUS from the blocking fs.readFileSync(0) onward, so the event loop
// never gets a turn and a setTimeout could never fire. The defence is
// ordering instead -- the cheapest decisive gate runs first, and the pattern
// is rejected before any disk is touched.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('./util');
const memorydb = require('./memorydb');
const digest = require('./digest');
const feed = require('./feed');
const projectResolve = require('./project-resolve');
const searchLib = require('./search');
const searchQuery = require('./search-query');
const searchBrief = require('./search-brief');
const activity = require('./activity');

// Real session ids are UUIDs. Anything else cannot safely become a filename
// (path traversal, reserved names), so a session id failing this is treated
// exactly like a malformed payload: step aside. Same rule, same reason, as
// lib/hooks-recall.js's own SESSION_ID_RE.
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

// The tools this hook answers. Read is deliberately absent: it belongs to
// lib/hooks-recall.js, which already has a much better answer for a file read
// (the file's own skeleton) than a prose search could ever be.
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);

// How many served-entry fingerprints one session file keeps. Comfortably more
// than a long session will ever serve at MAX_RESULTS per search, and small
// enough that the file stays a few kilobytes no matter how long the session
// runs.
const SERVED_MEMO_MAX = 200;

const searchDir = projectPath => path.join(projectPath, memorydb.DIR_NAME, 'search');
const sessionStatePath = (projectPath, sessionId) => path.join(searchDir(projectPath), `${sessionId}.json`);

// A stable, compact fingerprint for "this piece of memory". feed.dedupeKey is
// the codebase's existing answer to "the same work in both sources", so a
// local entry and its own pushed team twin fingerprint identically and can
// never both be served. Hashed because dedupeKey embeds the (up to 300
// character) ask, and 200 of those stored verbatim would be a 60KB file.
const fingerprint = entry => crypto.createHash('sha1').update(feed.dedupeKey(entry)).digest('hex').slice(0, 16);

// { served: [fingerprint] }. Missing or corrupt reads as a fresh session,
// never a throw: fail-open all the way down.
function loadServed(projectPath, sessionId) {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionStatePath(projectPath, sessionId), 'utf8'));
    return new Set(Array.isArray(raw && raw.served) ? raw.served.filter(v => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

// Atomic write: the tmp-file + rename pattern util.js's saveState and
// lib/hooks-recall.js's saveSessionState both use, so a crash mid-write can
// only ever leave a stray temp file behind, never a half-written record that
// would then read as corrupt and re-serve everything.
let writeCounter = 0;
function saveServed(projectPath, sessionId, served) {
  const target = sessionStatePath(projectPath, sessionId);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  // Newest kept: an old fingerprint aging out can at worst re-serve one
  // long-forgotten entry, which is a far better failure than an unbounded file.
  const json = JSON.stringify({ served: [...served].slice(-SERVED_MEMO_MAX) });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${writeCounter++}.tmp`);
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// projectResolve.resolveRoot starts its walk at path.dirname(file), because
// every caller so far handed it a FILE. A Grep has no file -- it has a working
// directory -- and starting at that directory's PARENT would skip the
// directory itself, missing the project whenever the search runs from the
// project root, which is the common case. Joining a name puts the walk's
// first step exactly on `dir`. The name is never read off disk: resolveRoot
// uses this argument for dirname() alone, and every .membridge/.git probe
// below it runs against directories.
const dirProbe = dir => path.join(dir, 'membridge-cwd-probe');

function doRunSearch() {
  // Test-only hook, mirroring lib/hooks-recall.js's MEMBRIDGE_RECALL_FORCE_FAIL:
  // proves the outer fail-open wrapper actually swallows a real exception,
  // deterministically, without fragile mocking of fs or require internals.
  // Deliberately NOT a feature switch -- memory delivery is what MemBridge
  // is, so it ships on with no flag of its own. The per-project controls that
  // already exist (a `.membridge-off` marker, the exclude list) remain the way
  // to turn it off somewhere, and are honoured below.
  if (process.env.MEMBRIDGE_SEARCH_FORCE_FAIL === '1') {
    throw new Error('forced failure (MEMBRIDGE_SEARCH_FORCE_FAIL)');
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return; // no/garbled payload: not a real hook invocation, step aside
  }
  if (!payload || typeof payload !== 'object') return;

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null;
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : null;
  if (!sessionId || !SESSION_ID_RE.test(sessionId) || !cwd || !SEARCH_TOOLS.has(toolName)) return;

  // Cheapest decisive gate first, and it is a pure function of the payload:
  // a pattern with nothing specific in it (`.*`, `\s+`, `^$`, a two-letter
  // fragment) can never produce a useful result, so rejecting it here means
  // those searches pay one process start and touch no disk at all.
  const query = searchQuery.queryFromToolInput(payload.tool_input);
  if (!query) return;

  const state = util.loadState();
  const hit = projectResolve.resolveTrackedKey(state, dirProbe(cwd));
  if (!hit) return; // no tracked project owns this working directory
  const projectPath = hit.key;
  const proj = (state.projects || {})[projectPath];
  if (!proj) return;

  const config = util.getConfig();
  // The same gate every other surface honours: a paused (`.membridge-off`) or
  // excluded project is off, full stop. This is not a feature toggle for the
  // hook, it is the user's established per-project control, and it is the one
  // way to stop this happening somewhere.
  if (util.isProjectOff(projectPath, config)) return;

  const served = loadServed(projectPath, sessionId);
  const regexes = digest.compileRedactions(config);
  const { local, team } = activity.projectEntries(projectPath, proj, config, regexes);
  // Same collision rule as feed.buildFeed and search_memory: a local entry
  // wins over its own pushed twin, so the same work is never counted twice.
  const seen = new Set(local.map(feed.dedupeKey));
  const all = local.concat(team.filter(t => !seen.has(feed.dedupeKey(t))));

  // rankWithFallback, not a private scorer: the hook and search_memory must
  // answer the same query out of the same ranking, or the two would drift.
  const ranked = searchLib.rankWithFallback(all, query);
  // No duplicate serving. Filtering by ENTRY rather than by query is the
  // stronger rule and subsumes it: a repeat of the same search produces the
  // same entries and is filtered to nothing, and so is a differently-worded
  // search that happens to land on memory this session has already been given.
  const brief = searchBrief.build(ranked.filter(e => !served.has(fingerprint(e))));
  if (!brief) return; // nothing worth saying: silent, always, never a "no results" line

  // additionalContext carried by an explicit `allow`, exactly as
  // lib/hooks-recall.js's emitNotes does: the search runs untouched and the
  // memory lands beside its result. This hook has no `deny` branch at all --
  // answering a Grep out of prose memory would be a guess, and the whole
  // point is that the agent gets BOTH.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: brief.text,
    },
  }) + '\n');

  // Recorded only AFTER the write returns, the same discipline
  // buildNotesOutput's commit() follows: memory is marked delivered when it
  // has actually been delivered. Marking first would lose an entry forever
  // whenever the write threw.
  for (const entry of brief.entries) served.add(fingerprint(entry));
  saveServed(projectPath, sessionId, served);
}

// `membridge-hook.js search` -- reads the PreToolUse payload from stdin and
// either hands the agent a short block of matching memory (stdout:
// hookSpecificOutput allow + additionalContext, exit 0) or steps aside
// (exit 0, no output). See the module docstring for the fail-open contract.
function runSearch() {
  try {
    doRunSearch();
  } catch (err) {
    try { util.log(`hook search error: ${err && err.stack ? err.stack : err}`); } catch {}
  }
}

module.exports = {
  runSearch,
  // Exposed for tests: the session-memo contract (where it lives, what a
  // fingerprint is) is worth pinning directly rather than only through the
  // full hook.
  searchDir, sessionStatePath, fingerprint, SERVED_MEMO_MAX,
};
