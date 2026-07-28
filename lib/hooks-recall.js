'use strict';
// PreToolUse hook: answers a Read/Grep/Glob call from the recall cache
// instead of letting it hit the file, when lib/recall.js's serve policy says
// to. See docs/superpowers/plans/2026-07-28-recall-saving-layer.md (Task 5)
// and docs/superpowers/specs/2026-07-28-membridge-token-reduction-design.md
// (§5 serve policy, §6 terminal output, §10 safety).
//
// GOVERNING RULE (spec §10): every failure degrades to ordinary agent
// behaviour, never to broken work. runRecall()'s ENTIRE body is wrapped in a
// try/catch so any exception -- corrupt store, bad JSON, a permission error,
// anything -- is swallowed: the read proceeds untouched (exit 0, no stdout),
// with at most a line in the local log. A 150ms unref'd watchdog is a second
// layer of the same contract: if something hangs, force-exit 0 with no
// output rather than make every read feel slow.
//
// This module NEVER parses source or loads tree-sitter/wasm -- it only reads
// a pre-built cache entry via recall-store.get() and re-hashes the target
// file on disk. Skeletons are built out-of-band by recall-store.warm().
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('./util');
const memorydb = require('./memorydb');
const projectResolve = require('./project-resolve');
const ledgerStore = require('./ledger-store');
const recallStore = require('./recall-store');
const recall = require('./recall');

const WATCHDOG_MS = 150;
// Real session ids are UUIDs. Anything else can't safely become a filename
// (path traversal, reserved names), so a session id failing this is treated
// exactly like a malformed payload -- step aside.
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

const recallDir = projectPath => path.join(projectPath, memorydb.DIR_NAME, 'recall');
const sessionsDir = projectPath => path.join(recallDir(projectPath), 'sessions');
const sessionStatePath = (projectPath, sessionId) => path.join(sessionsDir(projectPath), `${sessionId}.json`);
const eventsPath = projectPath => path.join(recallDir(projectPath), 'events.jsonl');

// sessionState: { served: {relPath: contentHash}, interceptions: n }. Missing
// or corrupt -> a fresh session, never a throw (fail-open all the way down).
function loadSessionState(projectPath, sessionId) {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionStatePath(projectPath, sessionId), 'utf8'));
    const served = raw && raw.served && typeof raw.served === 'object' && !Array.isArray(raw.served) ? raw.served : {};
    const interceptions = Number.isFinite(raw && raw.interceptions) ? raw.interceptions : 0;
    return { served, interceptions };
  } catch {
    return { served: {}, interceptions: 0 };
  }
}

// Atomic write: same tmp-file + rename pattern as util.js's saveState and
// lib/recall-store.js's put() -- a crash mid-write can only ever leave a
// stray temp file behind, never a half-written session record.
let writeCounter = 0;
function saveSessionState(projectPath, sessionId, state) {
  const target = sessionStatePath(projectPath, sessionId);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(state);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${writeCounter++}.tmp`);
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function appendEvent(projectPath, event) {
  fs.mkdirSync(recallDir(projectPath), { recursive: true });
  fs.appendFileSync(eventsPath(projectPath), JSON.stringify(event) + '\n');
}

// "First tracked" anchor for the 14-day calibration holdout (lib/recall.js's
// projectCreatedAt) -- the project's .membridge dir's own creation time,
// since that is when MemBridge started watching this project at all, not
// when recall itself happened to first run against it. birthtime is 0 or
// unsupported on a few older filesystems; mtime is a reasonable stand-in
// there. An unreadable/missing dir (should not happen -- resolveTrackedKey
// already required one to resolve this file at all) treats the project as
// brand new, the safer direction for a fresh gate (holdout runs, biasing
// toward measurement over aggressive serving on an unknown project).
function projectFirstTracked(projectPath) {
  try {
    const st = fs.statSync(path.join(projectPath, memorydb.DIR_NAME));
    const t = st.birthtimeMs || st.mtimeMs;
    return Number.isFinite(t) && t > 0 ? t : Date.now();
  } catch {
    return Date.now();
  }
}

const toPosix = p => p.split(path.sep).join('/');

// Repo-relative identity for a read, mirroring lib/digest.js's / lib/memorydb.js's
// own relFile helper: a path outside the project is dropped (null) rather
// than ever being intercepted or leaking an absolute path into the store or
// a served body.
function relFile(projectPath, absFile) {
  try {
    const r = path.relative(projectPath, absFile);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return toPosix(r);
  } catch {}
  return null;
}

// Matches lib/recall-store.js's own sha1(): hash the utf8-DECODED string, not
// the raw bytes, so a hash computed here can be compared against a
// contentHash recall-store computed from the same file (see warm()) -- both
// sides read via fs.readFileSync(path, 'utf8') and hash the resulting string.
function contentHashOf(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  return crypto.createHash('sha1').update(text).digest('hex');
}

// Same field-preference order lib/adapters/claude-code.js uses for a read
// event's target (file_path, then notebook_path, then path), so the identity
// this hook computes agrees with what a session's own transcript later
// resolves to.
function extractTarget(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const f = toolInput.file_path || toolInput.notebook_path || toolInput.path;
  return typeof f === 'string' && f ? f : null;
}

// Spec §6, given verbatim in the Task 5 brief: leads with the percentage (the
// figure a developer grasps at a glance), the absolute token count in
// parentheses. Presentation only -- decide() already gated the serve on the
// 2.25x/400-token floors, this is just how it reads.
const terminalLine = (pct, savedTokens) =>
  `answered from MemBridge · saved ${pct}% of this read (${savedTokens} tokens) — structure only, read the file directly for bodies`;

// The reason string sent as permissionDecisionReason: the terminal line is
// prepended only when it is either the session's FIRST interception (so the
// user learns what happened once) or the saving clears ANNOUNCE_TOKENS
// (material enough to mention again); otherwise the body alone, quietly.
// `sessionState` here is the PRE-serve snapshot (loaded before this decision),
// so `.interceptions === 0` means "nothing served yet this session".
function reasonFor(decision, sessionState) {
  const announce = decision.savedTokens > recall.ANNOUNCE_TOKENS || sessionState.interceptions === 0;
  return announce ? `${terminalLine(decision.pct, decision.savedTokens)}\n${decision.body}` : decision.body;
}

function doRunRecall() {
  // Fastest-possible kill switch: no I/O at all before this check.
  if (process.env.MEMBRIDGE_NO_RECALL === '1') return;
  // Test-only hook, mirroring lib/skeleton.js's MEMBRIDGE_FORCE_ENGINE_FAIL:
  // proves the outer fail-open wrapper in runRecall() actually swallows a
  // real exception, deterministically, without fragile mocking of fs/require
  // internals.
  if (process.env.MEMBRIDGE_RECALL_FORCE_FAIL === '1') {
    throw new Error('forced failure (MEMBRIDGE_RECALL_FORCE_FAIL)');
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
  const toolName = typeof payload.tool_name === 'string' && payload.tool_name ? payload.tool_name : null;
  if (!sessionId || !SESSION_ID_RE.test(sessionId) || !cwd || !toolName) return;

  const target = extractTarget(payload.tool_input);
  if (!target) return;
  const absPath = path.isAbsolute(target) ? target : path.resolve(cwd, target);

  const config = util.getConfig();
  if (config.recall && config.recall.enabled === false) return;

  let stat;
  try {
    stat = fs.statSync(absPath);
    if (!stat.isFile()) return;
  } catch {
    return; // gone/unreadable: nothing to serve, let the real read surface the error
  }

  const state = util.loadState();
  const hit = projectResolve.resolveTrackedKey(state, absPath);
  if (!hit) return; // no tracked project owns this file
  const projectPath = hit.key;

  const relPath = relFile(projectPath, absPath);
  if (!relPath) return;

  // A real, always-computed boolean -- lib/recall.js's decide() refuses
  // unless this is the literal `true`, by design (see its own comment on
  // `tracked`). resolveTrackedKey already proved the project is tracked;
  // isProjectOff covers the pause/exclude gate on top of that.
  const tracked = !util.isProjectOff(projectPath, config);

  const storeEntry = recallStore.get(projectPath, relPath); // null on any store error -- fail-open
  const ledger = ledgerStore.readLedger(projectPath) || { fileReaders: {} };
  const sessionState = loadSessionState(projectPath, sessionId);
  const hash = contentHashOf(absPath);

  const toolInput = payload.tool_input || {};
  const input = {
    projectPath, relPath, absPath,
    sessionId, toolName,
    offset: typeof toolInput.offset === 'number' ? toolInput.offset : null,
    limit: typeof toolInput.limit === 'number' ? toolInput.limit : null,
    sessionState,
    ledger,
    storeEntry,
    fileStat: { size: stat.size, hash },
    config,
    projectCreatedAt: projectFirstTracked(projectPath),
    tracked,
  };

  const decision = recall.decide(input);

  if (decision.serve) {
    const nextServed = { ...sessionState.served, [relPath]: hash };
    saveSessionState(projectPath, sessionId, { served: nextServed, interceptions: sessionState.interceptions + 1 });
    appendEvent(projectPath, {
      ts: new Date().toISOString(), sessionId, relPath,
      tier: decision.tier, savedTokens: decision.savedTokens, holdout: false,
    });
    const reason = reasonFor(decision, sessionState);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }) + '\n');
    return;
  }

  if (decision.reason === 'holdout') {
    // Log what tier WOULD have served, for the held-out-vs-served comparison
    // (spec §7.1) -- tierFor is independent of the holdout gate itself, so
    // calling it directly here is correct regardless of decide()'s own
    // internal ordering.
    appendEvent(projectPath, {
      ts: new Date().toISOString(), sessionId, relPath,
      holdout: true, wouldServe: recall.tierFor(input),
    });
  }
  // Every other refusal: step aside silently. Nothing written, nothing
  // printed -- the read proceeds exactly as if this hook did not exist.
}

// `membridge hook recall` — reads the PreToolUse payload from stdin and
// either answers the read (stdout: hookSpecificOutput deny + reason, exit 0)
// or steps aside (exit 0, no output). See the module docstring for the
// fail-open contract this wraps.
function runRecall() {
  const timer = setTimeout(() => { try { process.exit(0); } catch {} }, WATCHDOG_MS);
  timer.unref(); // must never keep the process alive on its own
  try {
    doRunRecall();
  } catch (err) {
    try { util.log(`hook recall error: ${err && err.stack ? err.stack : err}`); } catch {}
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  runRecall,
  // Exposed for tests (and any future consumer that needs to locate these
  // files, e.g. a diagnostics sweep) -- not part of the hook's own contract.
  recallDir, sessionsDir, sessionStatePath, eventsPath,
};
