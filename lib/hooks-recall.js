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
const projectResolve = require('./project-resolve');
const ledgerStore = require('./ledger-store');
const recallStore = require('./recall-store');
const teamsync = require('./teamsync');
const recall = require('./recall');
const diagnostics = require('./diagnostics');
const notes = require('./teammate-notes');
const notesStore = require('./teammate-notes-store');
const repoRootLib = require('./repo-root');
// events.jsonl's own rotation (byte cap + pending/confirmation-pairing
// safety) lives in lib/hooks-recall-rotate.js -- split out purely to keep
// this module under the file-size budget (see that module's own header).
const { rotateEvents } = require('./hooks-recall-rotate');
// recallDir/eventsPath/appendEvent live in lib/recall-events.js so
// lib/hooks-notes.js can append a measurement row without dragging this
// module's whole require graph into the SessionStart path -- see that
// module's own header. Re-exported below, so this file's public surface is
// unchanged.
const { recallDir, eventsPath, appendEvent } = require('./recall-events');
const { estimateTokens } = require('./token-estimate');

// Real session ids are UUIDs. Anything else can't safely become a filename
// (path traversal, reserved names), so a session id failing this is treated
// exactly like a malformed payload -- step aside.
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

const sessionsDir = projectPath => path.join(recallDir(projectPath), 'sessions');
const sessionStatePath = (projectPath, sessionId) => path.join(sessionsDir(projectPath), `${sessionId}.json`);

// sessionState: { served: {relPath: contentHash},
//                 reads:  {relPath: {hash, ranges: [[lo,hi], ...]}},
//                 interceptions: n }. Missing or corrupt -> a fresh session,
// never a throw (fail-open all the way down).
//
// `reads` records the READ-TIME facts: the hash is what the file looked like at
// the moment this session was about to read it, and `ranges` is the union of
// the LINE WINDOWS it was handed. They answer different questions and Tier A
// needs both -- "unchanged" is about the file, "you already read this" is about
// the part of it you were given (REV-12; see tierFor in lib/recall.js).
// `served` is a third fact (what we handed back when we intercepted) and none
// of the three substitutes for another. In particular Tier A cannot borrow the
// store's hash: the store's is a WARM-time hash, which proves a different
// interval than the one Tier A's wording claims.
//
// An ABSENT entry means "this session has no proof of what the file looked
// like when it read it" and must never be read as "unchanged" -- every
// pre-upgrade session file lands here, and reading absence as agreement would
// make each one serve a false claim. tierFor requires a present, matching hash.
// A record written before REV-12 is a bare hash STRING: readRecordOf normalises
// it to an empty window union, so it likewise fails closed rather than claiming
// a coverage it never recorded.
function loadSessionState(projectPath, sessionId) {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionStatePath(projectPath, sessionId), 'utf8'));
    const obj = k => (raw && raw[k] && typeof raw[k] === 'object' && !Array.isArray(raw[k]) ? raw[k] : {});
    const interceptions = Number.isFinite(raw && raw.interceptions) ? raw.interceptions : 0;
    return { served: obj('served'), reads: obj('reads'), interceptions };
  } catch {
    return { served: {}, reads: {}, interceptions: 0 };
  }
}

// How many per-file read hashes one session keeps. A long session can read
// thousands of files and this map is rewritten on disk each time it changes,
// so it is bounded like every other per-session structure here. Oldest
// insertions are dropped first (string keys keep insertion order), which is
// also the right eviction order: the file a session read longest ago is the
// one whose "unchanged since" claim is least likely to still hold.
const MAX_SESSION_READ_HASHES = 400;

// Record what this session saw, THIS read: the content hash, and the WINDOW of
// lines this call delivers (REV-12 -- see lib/recall.js's own header on why the
// window is a separate fact from the hash). Returns the next `reads` map, or
// null when nothing changed, so the caller can skip the write entirely.
//
// A CHANGED HASH RESETS THE UNION. The recorded windows describe content that
// no longer exists; carrying them across an edit would claim the session holds
// lines of the new file it has only ever seen the old version of -- the same
// borrowed-fact error one level further in.
function nextReadsMap(sessionState, relPath, hash, win) {
  const reads = (sessionState && sessionState.reads) || {};
  const prev = recall.readRecordOf(sessionState, relPath);
  const carried = prev && prev.hash === hash ? prev.ranges : [];
  const ranges = recall.addWindow(carried, win);
  const same = prev && prev.hash === hash && prev.ranges.length === ranges.length
    && ranges.every((r, i) => r[0] === prev.ranges[i][0] && r[1] === prev.ranges[i][1]);
  if (same) return null;
  const next = { ...reads, [relPath]: { hash, ranges } };
  const keys = Object.keys(next);
  if (keys.length > MAX_SESSION_READ_HASHES) {
    for (const k of keys.slice(0, keys.length - MAX_SESSION_READ_HASHES)) delete next[k];
  }
  return next;
}

// The size above which this hook will NOT compute a read-time hash for a file
// it has no cache entry for. The hash is the most expensive thing here --
// measured on this machine at ~1.4ms of CPU per MB (0.03ms at this repo's
// median read, 2.7ms on its 1.5MB test monolith, 30ms on a synthetic 22MB
// file) -- and it now runs in front of reads that will never serve, because
// read-time evidence cannot be reconstructed after the fact. What CAN be
// bounded is the tail, and this is that bound: at 4MiB the worst invocation
// pays ~5ms, against the 150ms hook budget in this module's header.
//
// Above the cap nothing is recorded, so Tier A simply never fires for that
// file. That is the same fail-closed outcome as a session that predates the
// `reads` map -- silence, never a claim made on absent evidence.
const MAX_HASH_BYTES = 4 * 1024 * 1024;

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

// Persist what this session saw at THIS read, leaving every other field of
// the session record alone. Best-effort by contract: a failure to record costs
// a future Tier A serve (which then fails closed and stays silent) and must
// never cost the read itself, so it is swallowed here rather than thrown at a
// caller that is about to let the read through.
//
// Two hook processes can run concurrently for one session (a batched set of
// Read calls), and this write is last-one-wins, so a racing pair can drop one
// path's hash. That loses a later Tier A serve and can never invent one: the
// map only ever gains hashes for reads that were about to happen.
function recordRead(projectPath, sessionId, sessionState, relPath, hash, win) {
  const nextReads = nextReadsMap(sessionState, relPath, hash, win);
  if (!nextReads) return;
  try {
    saveSessionState(projectPath, sessionId, {
      served: sessionState.served,
      reads: nextReads,
      interceptions: sessionState.interceptions,
    });
  } catch { /* fail open: an unrecorded read only means no Tier A next time */ }
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
//
// The tail after the em dash says WHAT WAS HANDED BACK, and the tiers hand
// back different things, so one sentence cannot cover both without going
// vague. Tier A returns a pointer and no file content at all; tiers B and C
// return a structural skeleton. The single tail this used to carry --
// "structure only, read the file directly for bodies" -- was written when
// Tier B was the only tier that could fire in practice. Once Tier A started
// serving (REV-8) it made the product describe a skeleton it had not sent, on
// roughly half of all serves: a false statement about what the agent is
// holding, which is the exact class of bug this line of work exists to close.
//
// Tier C serves tierBBody, so it shares B's tail. An unrecognised tier gets a
// tail that claims nothing about what was returned -- same discipline as
// REV-5's tierUnknown bucket: an unknown must never be filed as a known.
const TIER_TAILS = {
  A: 'pointer only, the file is unchanged since you read it earlier this session',
  B: 'structure only, read the file directly for bodies',
  C: 'structure only, read the file directly for bodies',
};
const tailFor = tier => TIER_TAILS[tier] || 'read the file directly if you need more than this';
const terminalLine = (pct, avoidedTokensOptimistic, tier) =>
  `answered from MemBridge · avoided ${pct}% of this read (${avoidedTokensOptimistic} tokens) — ${tailFor(tier)}`;

// The reason string sent as permissionDecisionReason: the terminal line is
// prepended only when it is either the session's FIRST interception (so the
// user learns what happened once) or the avoidance clears ANNOUNCE_TOKENS
// (material enough to mention again); otherwise the body alone, quietly.
// `sessionState` here is the PRE-serve snapshot (loaded before this decision),
// so `.interceptions === 0` means "nothing served yet this session".
function reasonFor(decision, sessionState) {
  const announce = decision.avoidedTokensOptimistic > recall.ANNOUNCE_TOKENS || sessionState.interceptions === 0;
  return announce
    ? `${terminalLine(decision.pct, decision.avoidedTokensOptimistic, decision.tier)}\n${decision.body}`
    : decision.body;
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
// `proj` is this project's state record, from the loadState the caller has
// already done — a pure optimisation for the gate below, which resolves the
// record from state itself when it is omitted. Omitting it costs a state read on
// this hot path; it never changes the answer.
function buildNotesOutput({ projectPath, absPath, relPath, sessionId, now, config, proj }) {
  try {
    if (!notes.isNotesEnabled(config)) return null;
    const index = notesStore.read(projectPath);
    if (!index) return null;
    // The longest tail of the three delivery points: a file note re-fires on
    // contact in every NEW session until REFIRE_DAYS past its own timestamp, so
    // without this gate a revoked teammate's warnings keep arriving for up to a
    // week of fresh sessions. The index is a derived copy of the team rows,
    // which is exactly why util.teamRowsFor cannot cover it. Asked after the
    // read above: a project with no index file pays nothing for this, which is
    // what keeps the hook inside its budget.
    if (!util.mayServeTeammateNotes(projectPath, proj)) return null;

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
      // Spec §9: exact attribution, tagged at the moment of injection rather
      // than inferred from context growth. `text` is what emitNotes (or the
      // co-occurrence branch) has already written to stdout, so this counts
      // what the model was actually handed.
      //
      // Best-effort, and deliberately LAST: a failed measurement row must
      // never cost the user the note itself, and the seen-marking above --
      // the write that decides whether this note is ever shown again -- must
      // not be skipped because accounting threw.
      try {
        appendEvent(projectPath, {
          ts: now, sessionId, relPath,
          kind: 'notes_injected',
          tokens: estimateTokens(text),
        });
      } catch {}
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
  // `config.recall.enabled === false` is a preference about RECALL -- about
  // answering reads from a skeleton cache. It is NOT a preference about
  // teammate notes, which have their own switch (config.teammateNotes.enabled)
  // and which never block a read. Two switches a user set independently must
  // behave independently, and for anyone in a team the notes are the point of
  // the product: a teammate's "don't touch this yet" must not go missing
  // because the token-saving feature was turned off months earlier.
  //
  // So this no longer returns. It suppresses SERVING only: with recall off we
  // skip the store lookup, which sends the flow through the no-skeleton branch
  // below -- notes are delivered and none of the expensive work (ledger parse,
  // content hash) ever runs.
  //
  // MEMBRIDGE_NO_RECALL=1 at the top of this function is unchanged and remains
  // the absolute panic button: an env var meaning "stop touching my reads",
  // which still silences everything here including notes.
  const recallEnabled = !(config.recall && config.recall.enabled === false);

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
    // From the state loaded above — the entitlement gate inside costs no read.
    proj: (state.projects || {})[projectPath] || null,
  });

  // A TEAM-LINKED project always serves, whatever config.recall says. Sharing
  // context with teammates is the product, and a recall preference set months
  // ago -- probably before the project was ever linked -- must not quietly opt
  // someone out of it. Solo projects keep their off switch.
  //
  // Ordering matters: `||` short-circuits, so loadTeamLink's file read happens
  // ONLY when recall is already off (rare). The common path costs nothing extra,
  // which is what keeps this inside the 150ms budget.
  const teamLinked = recallEnabled ? false : !!teamsync.loadTeamLink(projectPath);
  const serveEnabled = recallEnabled || teamLinked;

  // lib/recall.js's decide() reads config.recall.enabled itself and refuses on
  // its own account, so gating the store lookup above is not enough -- a
  // team-linked project must be HANDED a config saying what is actually true
  // for it. decide() stays a pure policy function told the truth, rather than
  // growing a second notion of team-linkedness it has no business knowing.
  const effectiveConfig = teamLinked
    ? { ...config, recall: { ...(config.recall || {}), enabled: true } }
    : config;

  // Not serving -> no store lookup at all, so this reads as a cache miss and the
  // branch below delivers any teammate note and stops. Same fail-open contract:
  // a store error is also null.
  const storeEntry = serveEnabled ? recallStore.get(projectPath, relPath) : null;

  // Cheapest decisive fact first, and since REV-4 that is no longer the store.
  // Tier A serves a pointer proved by the hash THIS session saw at an earlier
  // read of this path, and needs no cache entry at all -- so a store miss (the
  // common case, in front of ~90% of reads) can no longer end the hook. What
  // ends it is having nothing to prove Tier A with and no way to record the
  // proof for next time.
  //
  // This session's record is a small per-session JSON: 0.01ms to load on a
  // live session file, 0.14ms at the 400-entry bound, cheaper than the store
  // lookup above.
  const sessionState = loadSessionState(projectPath, sessionId);

  // The read-time hash is the single most expensive thing this hook can do,
  // and it is unavoidable rather than merely deferred: it is evidence about a
  // moment that has already passed, so nothing later can reconstruct it. The
  // guard is therefore not "hash only when it will pay off" -- unknowable on a
  // path's first read -- but "never let one read pay an unbounded price for
  // it": MAX_HASH_BYTES bounds the tail, and the hash is skipped outright when
  // nothing could ever be served from it anyway (recall off for this project,
  // or untracked/paused -- both of which decide() refuses on regardless).
  //
  // A file WITH a cache entry is hashed exactly as before, cap or no cap:
  // tiers B and C need that hash to prove their skeleton still matches disk,
  // and this change does not touch them.
  const mayRecordRead = serveEnabled && tracked && stat.size <= MAX_HASH_BYTES;
  if (!storeEntry && !mayRecordRead) {
    // Nothing to serve and nothing worth recording: emit any teammate note and
    // stop, before the ledger parse and the hash.
    emitNotes(notesOut);
    return;
  }
  // stat() succeeded but the CONTENT may still be unreadable -- a permissions
  // bit, a race with a delete. There is no tier without a hash, so step aside,
  // and do it here rather than letting the outer fail-open catch it: that
  // catch files what it swallows as 'hook recall error', and now that a store
  // miss reaches the hash at all, an ordinary unreadable file would write that
  // line on every single read of it.
  let hash;
  try {
    hash = contentHashOf(absPath);
  } catch {
    emitNotes(notesOut);
    return;
  }

  // The window THIS call delivers, and what the session has been handed before.
  // Both come from lib/recall.js so the union this hook maintains is built and
  // tested with the exact functions tierFor decides with.
  const toolInputEarly = payload.tool_input || {};
  const callWindow = recall.windowFor(
    typeof toolInputEarly.offset === 'number' ? toolInputEarly.offset : null,
    typeof toolInputEarly.limit === 'number' ? toolInputEarly.limit : null,
  );
  const priorRead = recall.readRecordOf(sessionState, relPath);

  // With no cache entry the ONLY tier that can fire is A, and it requires BOTH
  // that this session saw exactly these bytes and that it was handed the lines
  // now being asked for. Neither holds -- first read of the path, the file
  // changed since, or a call reaching outside what was delivered -- so record
  // what this read is seeing and stop, before the ledger parse (0.48ms on this
  // repo's 604KB ledger) and decide(), neither of which could reach a serve.
  //
  // This is the bootstrap the whole fix is for: the read that CANNOT be served
  // is the one whose hash makes the next one servable. Before it, no file
  // outside the top-25 warm set ever recorded a hash, so Tier A could not fire
  // for ~90% of reads however correct its policy was.
  //
  // A PRE-FILTER, NEVER A DECISION. It tests a strict subset of what tierFor
  // requires (which also needs the ledger), so it can only skip work on reads
  // that could not have been served anyway. tierFor stays the one place that
  // decides.
  const couldServeTierA = !!priorRead && priorRead.hash === hash
    && recall.coversWindow(priorRead.ranges, callWindow);
  if (!storeEntry && !couldServeTierA) {
    recordRead(projectPath, sessionId, sessionState, relPath, hash, callWindow);
    emitNotes(notesOut);
    return;
  }

  const ledger = ledgerStore.readLedger(projectPath) || { fileReaders: {} };

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
    config: effectiveConfig,
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
    // `reads` is carried through explicitly. Rebuilding this object from
    // named fields is what makes it a place a future field can be dropped by
    // omission, so every field the session carries is listed here.
    saveSessionState(projectPath, sessionId, {
      served: nextServed,
      reads: nextReadsMap(sessionState, relPath, hash, callWindow) || sessionState.reads,
      interceptions: sessionState.interceptions + 1,
    });
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
  // Record what this session saw at THIS read, on the path where the read is
  // actually going to happen. This is the important one: a file's FIRST read
  // is never served, and it is exactly the read whose hash Tier A needs in
  // order to say anything true about a later one. The serve branch above
  // records it too, through its own single state write.
  //
  // Best-effort, and deliberately after every decision above: a failure to
  // record costs a future Tier A serve (which then fails closed and stays
  // silent), and must never cost the read itself. Same write the store-miss
  // bootstrap above performs -- one helper, so the two can never drift.
  recordRead(projectPath, sessionId, sessionState, relPath, hash, callWindow);
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
