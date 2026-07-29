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
// with at most a line in the local log.
//
// TIME BOUND: the per-hook `timeout` on the PreToolUse entry that
// lib/hooks.js's reconcileRecallHook writes into settings.json (5s) is the
// ONLY real bound on this hook, and Claude Code's own hook runner enforces
// it. There is deliberately no in-process JS watchdog: this whole path is
// SYNCHRONOUS, starting with a blocking fs.readFileSync(0) of the payload,
// so the event loop never gets a turn and a setTimeout can never fire (a
// held-open stdin was measured still running at 3004ms against a nominal
// 150ms timer). A timer here would look like a budget while enforcing
// nothing, which is worse than none. Keep the real work below cheap -- a
// store lookup before anything expensive -- and keep the settings timeout
// low.
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
const diagnostics = require('./diagnostics');
const notes = require('./teammate-notes');
const notesStore = require('./teammate-notes-store');
const repoRootLib = require('./repo-root');
// events.jsonl's own rotation (byte cap + pending/confirmation-pairing
// safety) lives in lib/hooks-recall-rotate.js -- split out purely to keep
// this module under the file-size budget (see that module's own header).
const { rotateEvents } = require('./hooks-recall-rotate');

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
  const file = eventsPath(projectPath);
  rotateEvents(file);
  fs.appendFileSync(file, JSON.stringify(event) + '\n');
}

// Repo-relative identity for a read. MUST be the byte-identical rule
// lib/ledger-fold.js's readKeyFor writes with, or every lookup below misses:
// this hook reads ledger.fileReaders[relPath] and recallStore.get(_, relPath),
// both keyed by that fold. So it is the SAME function, imported, not a fourth
// hand-rolled copy -- the drift between two such copies (project-relative
// here, worktree-prefixed there) is what made repeat reads uncountable.
// A path outside the project is dropped (null) rather than ever being
// intercepted or leaking an absolute path into the store or a served body.
const relFile = repoRootLib.ledgerKeyFor;

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

// Spec §6/§8.2, given verbatim in the Task 5 brief: leads with the percentage
// (the figure a developer grasps at a glance), the absolute token count in
// parentheses. Presentation only -- decide() already gated the serve on the
// 2.25x/400-token floors, this is just how it reads.
// "avoided", never "saved" (spec §8.2): "saved" implies the bill fell, which
// direct avoidance alone cannot support -- it only measures tokens not
// loaded. This is also the OPTIMISTIC figure (avoidedTokensOptimistic): a
// same-session follow-up read may claw some or all of it back, which only
// the fold (a later task) settles.
const terminalLine = (pct, avoidedTokensOptimistic) =>
  `answered from MemBridge · avoided ${pct}% of this read (${avoidedTokensOptimistic} tokens) — structure only, read the file directly for bodies`;

// The reason string sent as permissionDecisionReason: the terminal line is
// prepended only when it is either the session's FIRST interception (so the
// user learns what happened once) or the avoidance clears ANNOUNCE_TOKENS
// (material enough to mention again); otherwise the body alone, quietly.
// `sessionState` here is the PRE-serve snapshot (loaded before this decision),
// so `.interceptions === 0` means "nothing served yet this session".
function reasonFor(decision, sessionState) {
  const announce = decision.avoidedTokensOptimistic > recall.ANNOUNCE_TOKENS || sessionState.interceptions === 0;
  return announce ? `${terminalLine(decision.pct, decision.avoidedTokensOptimistic)}\n${decision.body}` : decision.body;
}

// Delivery points 2 and 3 (spec §3.1): unseen prose decisions on ANY read
// (arrival), plus this file's notes on contact. Returns null when there is
// nothing to say -- the overwhelmingly common case, and the reason this is
// safe to call ahead of the storeEntry gate.
//
// The seen-marking is deliberately NOT done here. It is returned as commit(),
// so a note is only ever marked delivered once its text has actually been
// written to stdout. Marking first would lose a note whenever a later write
// threw -- the same pending/confirmation discipline the serve path uses for
// its event rows.
function buildNotesOutput({ projectPath, absPath, relPath, sessionId, now, config }) {
  try {
    if (!notes.isNotesEnabled(config)) return null;
    const index = notesStore.read(projectPath);
    if (!index) return null;

    // byFile is keyed by WIRE key, never by the tracked-relative relPath the
    // rest of this hook uses. For a session run from a worktree the two differ
    // -- relPath carries the worktree prefix -- and looking up the wrong one is
    // exactly the silent no-match this feature must not have. wireKeyFor is
    // memoized per directory, so this is a Map hit after the first read in a
    // tree, and null (a file outside any checkout) simply means "no note".
    const wireKey = repoRootLib.wireKeyFor(absPath);

    const { items: prose, overflow } = notes.selectProse(index, now);
    const fileNotes = wireKey ? notes.selectFileNotes(index, wireKey, sessionId, now) : [];
    if (!prose.length && !fileNotes.length) return null;

    const parts = [];
    if (fileNotes.length) parts.push(notes.formatFileNotes(fileNotes));
    if (prose.length) parts.push(notes.formatProse(prose, overflow));
    const text = parts.join('\n\n');

    const proseIds = prose.map(p => p.id);
    const fileIds = fileNotes.map(n => n.id);
    const commit = () => {
      notesStore.update(projectPath, ix => {
        let next = ix;
        if (proseIds.length) next = notes.markProseSeen(next, proseIds, now);
        if (fileIds.length) next = notes.markFileSeen(next, sessionId, fileIds, now);
        return next;
      });
    };
    return { text, commit };
  } catch {
    return null;
  }
}

// The ONLY model-facing output this feature produces on its own account:
// additionalContext carried by an explicit `allow`, so the read goes through
// untouched and the note lands beside its result (spec §3.1). A teammate's
// warning must never cost the agent a tool call -- the one place a note rides
// on a `deny` is the co-occurrence case in the serve branch below, where the
// recall feature was already denying that read for its own reasons.
//
// commit() runs only after the write returns: a note is marked delivered when
// it has actually been delivered, never before.
function emitNotes(notesOut) {
  if (!notesOut) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: notesOut.text,
    },
  }) + '\n');
  notesOut.commit();
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
  // isProjectOff covers the pause/exclude gate on top of that, and
  // diagnostics.isRecallPausedForProject covers the Task 9 net-negative
  // auto-pause -- a SEPARATE, recall-only pause (config.recall.pausedProjects)
  // from isProjectOff's `.membridge-off` marker, which also stops memory
  // capture/injection. A net-negative verdict must silence only recall.
  const tracked = !util.isProjectOff(projectPath, config) && !diagnostics.isRecallPausedForProject(projectPath, config);

  // Teammate notes (spec §4.1) are looked up BEFORE the storeEntry gate below,
  // because a teammate's warning about a file matters whether or not that file
  // is hot enough to have a cached skeleton. Cost on a miss is one small JSON
  // parse -- no content hash, no ledger read -- so the ordering discipline the
  // comment on storeEntry describes still holds.
  const notesOut = buildNotesOutput({
    projectPath, absPath, relPath, sessionId,
    now: new Date().toISOString(),
    config,
  });

  const storeEntry = recallStore.get(projectPath, relPath); // null on any store error -- fail-open
  // Cheapest decisive fact first. Nothing downstream can serve without a
  // cache entry -- recall.js's tierFor() requires one for every tier -- so on
  // a miss (the common case, in front of every read) return before parsing
  // the ledger and, above all, before hashing the target file: that read+sha1
  // is the single most expensive thing this hook can do (measured 74ms on a
  // 22MB file) and it was pure waste on every miss. A holdout row is not lost
  // by returning here either: with no entry, wouldServe would be null, and
  // those rows are deliberately not logged (see below).
  if (!storeEntry) {
    // No skeleton to serve, but possibly a teammate note: emit it and stop
    // before the expensive work below (ledger parse, content hash) that only
    // a serve decision needs.
    emitNotes(notesOut);
    return;
  }
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
    tracked,
  };

  const decision = recall.decide(input);

  if (decision.serve) {
    // Order matters, in two layers (the second added in fix round 3):
    //
    // 1. The event write happens FIRST (L7): if IT throws (a full disk, an
    //    unwritable .membridge), nothing below runs and no session state is
    //    ever touched -- a failure here costs one measurement row, never a
    //    served-and-locked-out path the agent never actually got.
    // 2. That first row is written `committed: false` -- a claim of
    //    "attempted", not "done" (fix round 3). Only once the session-state
    //    commit below actually succeeds does a SECOND, confirming row get
    //    appended with `committed: true`. Before this, the one row written
    //    here looked identical whether or not the state commit that
    //    followed it actually succeeded -- so a state-write failure (the
    //    outer catch swallows it, same fail-open contract as ever) left a
    //    row in events.jsonl claiming a real serve for one the agent never
    //    received. Making the two writes atomic isn't attempted (that's a
    //    much bigger change for a low-severity measurement bug); making the
    //    partial-failure state DETECTABLE -- an uncommitted row with no
    //    confirmation -- is enough.
    //
    // stdout still only comes after both the state commit and the
    // confirmation: a state-write failure throws here, which the outer
    // runRecall() catch swallows into an ordinary read, exactly as before.
    const ts = new Date().toISOString();
    appendEvent(projectPath, {
      ts, sessionId, relPath, tier: decision.tier,
      callTokens: decision.callTokens, skeletonTokens: decision.skeletonTokens,
      holdout: false, committed: false,
    });
    const nextServed = { ...sessionState.served, [relPath]: hash };
    saveSessionState(projectPath, sessionId, { served: nextServed, interceptions: sessionState.interceptions + 1 });
    // Reaching this line means the state commit above did not throw --
    // promote the pending row into a confirmed one.
    appendEvent(projectPath, { ts, sessionId, relPath, committed: true });
    // Co-occurrence (spec §4.1): this read is ALREADY being denied on the
    // recall feature's own account, so the note rides on that one output
    // rather than becoming a second, conflicting one. This is the single
    // exception to "a note never denies a read" -- the denial is not the
    // note's doing, and suppressing the note here would lose it entirely.
    const base = reasonFor(decision, sessionState);
    const reason = notesOut ? `${notesOut.text}\n\n${base}` : base;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }) + '\n');
    if (notesOut) notesOut.commit();
    return;
  }

  if (decision.reason === 'holdout') {
    // Log what tier WOULD have served, for the held-out-vs-served comparison
    // (spec §7.1) -- tierFor is independent of the holdout gate itself, so
    // calling it directly here is correct regardless of decide()'s own
    // internal ordering. A null tier means this read could never have been
    // served in the first place (stale or absent cache entry): logging it
    // would pad the held-out arm with reads the served arm has no counterpart
    // for, biasing the comparison the arm exists to make -- and every read of
    // a held-out path would grow events.jsonl forever.
    const wouldServe = recall.tierFor(input);
    if (wouldServe !== null) {
      // callTokens is priced with decide()'s own formula even though decide()
      // itself never got here (the holdout gate fires before its own
      // callTokens computation) -- the fold needs this row priced the same
      // way a served row is, or a held-out read can't be compared on equal
      // footing against one that was actually answered.
      const callTokens = recall.estimateCallTokens(input.limit, input.fileStat);
      appendEvent(projectPath, {
        ts: new Date().toISOString(), sessionId, relPath, holdout: true, wouldServe, callTokens,
      });
    }
  }
  // Every other refusal steps aside as far as RECALL is concerned -- but a
  // teammate note is not recall's to withhold. A cached skeleton that decide()
  // declined to serve (below the token floor, already served this session, in
  // the holdout arm) is the most likely place for a note to land: those are
  // precisely the files people work on. Emitting it here is what keeps the
  // note's delivery independent of a serve decision it has nothing to do with.
  emitNotes(notesOut);
}

// `membridge hook recall` — reads the PreToolUse payload from stdin and
// either answers the read (stdout: hookSpecificOutput deny + reason, exit 0)
// or steps aside (exit 0, no output). See the module docstring for the
// fail-open contract this wraps.
function runRecall() {
  try {
    doRunRecall();
  } catch (err) {
    try { util.log(`hook recall error: ${err && err.stack ? err.stack : err}`); } catch {}
  }
}

module.exports = {
  runRecall,
  // Exposed for direct testing of the selection/marking contract; the hook
  // body is the only production caller.
  buildNotesOutput,
  // Exposed for tests (and any future consumer that needs to locate these
  // files, e.g. a diagnostics sweep) -- not part of the hook's own contract.
  recallDir, sessionsDir, sessionStatePath, eventsPath,
  // Exposed for a direct unit test of the pending/confirmation-pairing safety
  // check (fix round 3) -- exercising it through the full hook would require
  // timing an actual rotation to land between a pending write and its
  // confirmation, which isn't practically controllable from a test.
  rotateEvents,
};
