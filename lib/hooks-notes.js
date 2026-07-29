'use strict';
// Session-scoped delivery of teammate notes (spec §3.1, delivery points 4 and
// 5): read the per-project index the daemon builds on each team pull
// (.membridge/teammate-notes.json) and hand the agent the decisions it has not
// been told -- plus, after a compaction, the ones it WAS told and has since
// lost.
//
// GOVERNING RULE, identical to lib/hooks-recall.js: every failure degrades to
// ordinary agent behaviour. The run* entry point wraps its whole body, so a
// corrupt index, a permission error or a malformed payload all end as a silent
// no-op with at most a line in the local log. Injection is only ever via
// hookSpecificOutput.additionalContext; nothing here blocks anything.
//
// WHY POSTCOMPACT IS A NO-OP HERE, and where delivery point 4 actually lives.
// The plan routed "re-inject after compaction" through a PostCompact hook.
// Checked against Claude Code 2.1.220 the way the FileChanged spike was
// (docs/superpowers/spikes/2026-07-28-filechanged-findings.md), that cannot
// work, for three independent reasons:
//   1. The hookSpecificOutput schema is a union of per-event object types and
//      there is NO PostCompact member. Our JSON fails validation, and a
//      validation failure on a zero-exit hook is thrown and reported as a
//      FAILED hook.
//   2. PostCompact runs through executeHooksOutsideREPL, whose result carries
//      only { command, succeeded, output, blocked, watchPaths, systemMessage }.
//      additionalContext is never read for any event on that path.
//   3. The PostCompact executor's whole product is a userDisplayMessage built
//      from the hook's raw stdout -- shown to the HUMAN, never to the model. So
//      anything printed here lands in the user's terminal as
//      "PostCompact [<command>] completed successfully: {...}".
// So this hook prints nothing at all. Delivery point 4 is served instead by
// SessionStart with source "compact": the compaction path really does fire the
// SessionStart hooks with that source, and SessionStart does support
// additionalContext. Our SessionStart registration carries no matcher, so it
// already fires for it.
//
// WHY RE-INJECTION IS NEEDED AT ALL: injected context is linear and compaction
// summarises it away. Without it a decision delivered in hour one is simply
// gone by hour four, which is exactly the long session this feature exists for.
const fs = require('fs');
const path = require('path');
const util = require('./util');
const projectResolve = require('./project-resolve');
const notes = require('./teammate-notes');
const notesStore = require('./teammate-notes-store');

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const ms = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };

// SessionStart sources that mean "the context this session had is gone", as
// opposed to "this session is new" (startup) or "the context is coming back"
// (resume, fork -- both restore the earlier transcript, so a re-statement
// would be pure duplication).
const CONTEXT_ERASED_SOURCES = new Set(['compact', 'clear']);

// Prose already delivered, but worth saying again because whatever held it was
// thrown away. Bounded by REFIRE_DAYS: spec §5's "seven days governs re-firing
// only" is precisely this case, and it is the only thing stopping a compaction
// from replaying a year of history.
//
// Deliberately NOT session-scoped. Keeping a per-session record of every
// delivered decision would have to be written by lib/hooks-recall.js too (most
// prose arrives on a tool call, not at session start) and would still be lost
// the moment a marker was pruned. "The newest few decisions of the last week"
// is what a compacted session had, to within an edge case, at no bookkeeping
// cost at all.
function selectRefireProse(index, now, excludeIds, limit) {
  const ix = index || notes.emptyIndex();
  const cap = Math.max(0, limit);
  if (!cap) return [];
  const nowMs = ms(now);
  if (!nowMs) return []; // an unreadable clock must not re-fire everything
  const seen = (ix.seen && ix.seen.prose) || {};
  const skip = new Set(excludeIds || []);
  const cutoff = nowMs - notes.REFIRE_DAYS * DAY_MS;
  return (ix.prose || [])
    .filter(p => seen[p.id] && !skip.has(p.id) && ms(p.ts) >= cutoff)
    .slice(0, cap);
}

// How many DIFFERENT teammates the backlog came from -- counted across every
// unseen decision, not just the three about to be shown. "from 3 teammates" is
// a fact about the backlog, and taking it from the visible slice would
// under-report it in exactly the catch-up case it exists for.
function countUnseenAuthors(index) {
  const seen = (index && index.seen && index.seen.prose) || {};
  const names = new Set();
  for (const p of (index && index.prose) || []) if (!seen[p.id]) names.add(p.author);
  return names.size;
}

// Spec §5's catch-up brief: one block, not a trickle, the first time back where
// the backlog is bigger than a single injection can carry. Distinct from
// notes.formatProse's arrival wording on purpose -- an agent needs to know this
// is a backlog it is being caught up on, not news that just landed.
function formatCatchUp(items, overflow, teammates) {
  const total = items.length + overflow;
  const who = teammates === 1 ? '1 teammate' : `${teammates} teammates`;
  return [
    `While you were away — ${total} teammate decisions from ${who}. The ${items.length} most recent:`,
    ...items.map(i => `- ${i.author}: ${i.text}`),
    `${overflow} more in the MemBridge feed.`,
  ].join('\n');
}

function formatRefire(items) {
  return [
    'Teammate decisions still in force (restated — the context holding them was cleared):',
    ...items.map(i => `- ${i.author}: ${i.text}`),
  ].join('\n');
}

// Session-scoped delivery: PROSE only. File notes deliberately do not appear
// here -- they are meaningless until the agent touches the file, which is
// delivery point 3's job in lib/hooks-recall.js.
//
// `sessionId` is accepted but unused: prose delivers once GLOBALLY (spec §5),
// so unlike a file note it has nothing to key per session. It stays in the
// signature because the caller has it and every other entry point in this
// feature is passed it.
//
// The seen-marking is NOT done here. It comes back as commit(), so a decision
// is only ever marked delivered once its text has actually been written to
// stdout -- the same discipline as buildNotesOutput in lib/hooks-recall.js.
// Restated decisions are excluded from commit(): they carry no new fact, and
// their marker already exists. When a restatement is ALL there is, commit() is
// a no-op rather than a rewrite -- otherwise every compaction of every session
// would touch the index to record nothing.
function buildSessionOutput({ projectPath, sessionId, source, now, config }) {
  try {
    if (!notes.isNotesEnabled(config)) return null;
    const index = notesStore.read(projectPath);
    if (!index) return null;

    const { items, overflow } = notes.selectProse(index, now);
    const parts = [];
    if (items.length) {
      parts.push(overflow > 0
        ? formatCatchUp(items, overflow, countUnseenAuthors(index))
        : notes.formatProse(items, 0));
    }

    // The per-injection cap of 3 covers the whole injection, new and restated
    // together -- a compaction must not turn into a six-line wall.
    const restated = CONTEXT_ERASED_SOURCES.has(source)
      ? selectRefireProse(index, now, items.map(i => i.id), notes.PROSE_CAP - items.length)
      : [];
    if (restated.length) parts.push(formatRefire(restated));
    if (!parts.length) return null;

    const ids = items.map(i => i.id);
    const commit = () => {
      if (!ids.length) return; // nothing new was said; leave the index alone
      notesStore.update(projectPath, ix => notes.markProseSeen(ix, ids, now));
    };
    return { text: parts.join('\n\n'), commit };
  } catch {
    return null;
  }
}

// Payload handling for the model-facing entry point. Returns the resolved
// project and session, or null if this is not a usable invocation.
function readPayload() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null;
  if (!sessionId || !SESSION_ID_RE.test(sessionId) || !cwd) return null;
  const state = util.loadState();
  // resolveTrackedKey takes a FILE path: resolveRoot starts its walk at
  // path.dirname(file). A session's cwd is normally the project root itself, so
  // handing it over bare would start one level too high and answer null for the
  // commonest case there is -- delivery dead, silently. Verified rather than
  // assumed; the test suite pins both halves.
  const hit = projectResolve.resolveTrackedKey(state, path.join(cwd, 'x'));
  if (!hit) return null;
  const source = typeof payload.source === 'string' ? payload.source : '';
  return { sessionId, source, projectPath: hit.key, config: util.getConfig() };
}

function emit(eventName, text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
  }) + '\n');
}

function runSessionStart() {
  try {
    const ctx = readPayload();
    if (!ctx) return;
    const out = buildSessionOutput({
      projectPath: ctx.projectPath,
      sessionId: ctx.sessionId,
      source: ctx.source,
      now: new Date().toISOString(),
      config: ctx.config,
    });
    if (!out) return;
    emit('SessionStart', out.text);
    out.commit(); // only after the write actually happened
  } catch (err) {
    try { util.log(`hook notes session-start error: ${err && err.stack ? err.stack : err}`); } catch {}
  }
}

// Registered (lib/hooks.js) and routed (lib/membridge-hook.js), but deliberately
// mute -- see the PostCompact note at the top of this file. It must stay a real
// no-op rather than "deliver but print nothing": marking a decision seen for an
// injection that never reached the model would lose it outright.
//
// FOLLOW-UP for whoever owns Task 7: the registration itself should go. Claude
// Code prints "PostCompact [<command>] completed successfully" to the user for
// every PostCompact hook that runs, even one with empty output, so an entry
// that can never do anything still costs the user a line after every
// compaction.
function runPostCompact() {}

module.exports = {
  runSessionStart, runPostCompact, buildSessionOutput,
  selectRefireProse, formatCatchUp, CONTEXT_ERASED_SOURCES,
};
