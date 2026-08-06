'use strict';
// The Stop hook's own flight recorder.
//
// WHY THIS EXISTS. runStop fails open everywhere: a garbled payload, an
// untracked project, a paused project, a session with no edits and a session
// whose checkpoint simply is not due yet ALL produce the same thing — exit 0,
// zero bytes of stdout. That is correct product behaviour (a MemBridge bug
// must never trap a user's session) and it is a diagnostic catastrophe,
// because the most dangerous failure in the system lands in that same bucket:
//
//   runStop reads a session's edits from state.json, which ONLY the daemon
//   writes. Daemon down => no edit events => never due => never blocks =>
//   nothing is ever captured => memory, team sync, search and `why` are all
//   silently empty, forever, while every hook invocation reports success.
//
// Measured on the author's own machine at the time this was written: of 49
// logged Stop invocations, 39 were silent and 10 blocked. Nothing anywhere
// distinguished which of the 39 were "there was nothing to capture" from
// "MemBridge could not know, because the daemon was dead".
//
// THE RULE THIS FILE ENFORCES: "captured nothing" and "had nothing to
// capture" must never share a representation.
//
// It also closes the wrapper's blind spot. ~/.membridge/hook-exec-wrapper.sh
// logs AFTER the child returns, so a hook killed at the 10s timeout writes no
// line at all — the one failure the wrapper exists to catch is the one it
// cannot see. Here every invocation writes a `start` line BEFORE any work and
// an `end` line after, so a start with no end IS the timeout/kill record.
//
// Everything here is best-effort and never throws: this is instrumentation
// bolted to a fail-open path, and instrumentation that can break the thing it
// measures is worse than no instrumentation.
const fs = require('fs');
const path = require('path');
const util = require('./util');

const FILE_NAME = 'hook-stops.jsonl';
// Bounded like the exec wrapper's log, for the same reason: this appends on
// every session stop and on every summary append, forever. Two lines per stop
// at ~200B is ~2.5k stops per rotation.
const MAX_BYTES = 512 * 1024;
const KEEP_BYTES = 256 * 1024;
// How much of the tail a reader parses. Bounded so the read cost per stop is
// constant no matter how the file grows between rotations.
const TAIL_BYTES = 96 * 1024;

function logPath() {
  return path.join(util.homeDir(), FILE_NAME);
}

// The outcome vocabulary. Exported so callers cannot invent a spelling and so
// a reader (status, tests, a future dashboard card) can enumerate them.
//
// The distinction this whole module exists for is the pair in the middle:
// NO_EDITS_DAEMON_DOWN means MemBridge could not know whether there was
// anything to capture, NO_EDITS means it knew and there was not.
const OUTCOME = {
  BLOCKED: 'blocked',                              // asked the agent for a summary
  NOT_DUE: 'not-due',                              // edits exist, checkpoint not due yet
  NO_EDITS: 'no-edits',                            // daemon healthy, session changed nothing
  NO_EDITS_DAEMON_DOWN: 'no-edits-daemon-down',    // CANNOT KNOW: state.json is stale/absent
  UNTRACKED: 'untracked',                          // cwd/session resolve to no tracked project
  PAUSED: 'paused',                                // project explicitly paused
  DISABLED: 'disabled',                            // distill.enabled === false
  LOOP_GUARD: 'loop-guard',                        // stop_hook_active: already asked this cycle
  NO_PAYLOAD: 'no-payload',                        // stdin absent or not a hook payload
  ERROR: 'error',                                  // threw; fail-open still allowed the stop
};

// Is the daemon in a state where "this session has no edit events" is
// TRUSTWORTHY? Three independent ways to answer no, all cheap (one stat, one
// signal-0 kill, no parsing):
//   - state.json absent entirely: nothing has ever been scanned;
//   - no live daemon pid: nothing is scanning now;
//   - state.json older than several sync intervals: something is scanning, but
//     not recently enough for the tail of this session to be in it.
// Every failure answers "unknown" (healthy: null) rather than guessing — this
// gates a diagnostic label, and a wrong label is worse than a missing one.
function daemonHealth(config) {
  const out = { running: null, stateAgeSec: null, stateMissing: null, stale: null };
  try {
    const pidRaw = fs.readFileSync(util.pidPath(), 'utf8');
    const pid = parseInt(String(pidRaw).trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        out.running = true;
      } catch (err) {
        // EPERM means the process exists but belongs to someone else — still
        // running. Only ESRCH proves it is gone.
        out.running = !!(err && err.code === 'EPERM');
      }
    } else {
      out.running = false;
    }
  } catch {
    out.running = false; // no pid file at all
  }
  try {
    const st = fs.statSync(util.statePath());
    out.stateMissing = false;
    out.stateAgeSec = Math.max(0, Math.round((Date.now() - st.mtimeMs) / 1000));
  } catch {
    out.stateMissing = true;
  }
  const interval = Number.isFinite(config && config.intervalSec) ? config.intervalSec : 60;
  // Three intervals, floored at five minutes: one missed tick is normal, three
  // is not, and a very short configured interval must not make this trigger on
  // ordinary idleness.
  const staleAfter = Math.max(interval * 3, 300);
  if (out.stateMissing) out.stale = true;
  else if (out.stateAgeSec !== null) out.stale = out.stateAgeSec > staleAfter || out.running === false;
  return out;
}

// True when "no edit events for this session" cannot be trusted as evidence
// that the session did nothing.
function cannotKnow(health) {
  return !!(health && (health.stateMissing === true || health.running === false || health.stale === true));
}

function appendLine(obj) {
  try {
    fs.mkdirSync(util.homeDir(), { recursive: true });
    const p = logPath();
    fs.appendFileSync(p, JSON.stringify(obj) + '\n', { mode: 0o600 });
    rotate(p);
  } catch {
    // instrumentation must never break the hook
  }
}

function rotate(p) {
  try {
    const st = fs.statSync(p);
    if (st.size <= MAX_BYTES) return;
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(KEEP_BYTES);
      const n = fs.readSync(fd, buf, 0, KEEP_BYTES, st.size - KEEP_BYTES);
      let text = buf.slice(0, n).toString('utf8');
      // Drop the partial first line so every retained line still parses.
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
      fs.writeFileSync(p, text, { mode: 0o600 });
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
}

let seq = 0;
function newId() {
  return `${process.pid.toString(36)}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

// Open an invocation record. Called FIRST, before stdin is even read, so that
// a hook killed at the timeout leaves a start line with no end line — the
// only way this process can record its own death.
function begin(kind = 'stop') {
  const h = { id: newId(), t0: Date.now(), kind };
  appendLine({ k: 'start', id: h.id, kind, ts: new Date().toISOString(), pid: process.pid });
  return h;
}

// Close an invocation record with its outcome. `extra` carries the evidence a
// reader needs to act: session, project, edit count, daemon health.
function end(h, outcome, extra = {}) {
  if (!h || !h.id) return;
  appendLine({
    k: 'end',
    id: h.id,
    kind: h.kind || 'stop',
    ts: new Date().toISOString(),
    ms: Date.now() - h.t0,
    outcome,
    ...extra,
  });
}

// A summary line actually landed on disk. Written by runAppend, i.e. by the
// process that really did the writing — the Stop hook never learns whether
// its ask was honoured, because the append happens in a different process
// after the hook has exited. This is the last-successful-capture signal.
function capture(entry) {
  appendLine({ k: 'capture', ts: new Date().toISOString(), ...entry });
}

// Parse the bounded tail of the log, oldest-first.
function readRecent() {
  const p = logPath();
  let st;
  try { st = fs.statSync(p); } catch { return []; }
  let text = '';
  try {
    const start = Math.max(0, st.size - TAIL_BYTES);
    const fd = fs.openSync(p, 'r');
    try {
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, start);
      text = buf.slice(0, n).toString('utf8');
      if (start > 0) {
        const nl = text.indexOf('\n');
        text = nl === -1 ? '' : text.slice(nl + 1);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object') out.push(o);
    } catch { /* torn or hand-edited line: skip */ }
  }
  return out;
}

// The health picture `membridge status` prints and the tests assert on.
//
// Every number here answers a question that previously had no answer at all:
//   silentBecauseUnknown  the daemon was down, so nothing could be captured
//   incomplete            invocations that started and never finished (killed
//                         at the timeout, or crashed hard)
//   unhonoredBlocks       MemBridge asked for a summary and no line ever
//                         arrived — the model ignored the block
//   lastCapture           the last time a summary actually reached disk
function summarize(records = readRecent()) {
  const byOutcome = {};
  const starts = new Map();
  const blocks = [];          // {session, ts}
  const capturesBySession = new Map();
  let lastCapture = null;
  let lastBlock = null;
  let lastStop = null;
  for (const r of records) {
    if (r.k === 'start') {
      starts.set(r.id, r);
      continue;
    }
    if (r.k === 'end') {
      starts.delete(r.id);
      byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
      lastStop = r;
      if (r.outcome === OUTCOME.BLOCKED) {
        blocks.push(r);
        lastBlock = r;
      }
      continue;
    }
    if (r.k === 'capture') {
      lastCapture = r;
      const list = capturesBySession.get(r.session) || [];
      list.push(r);
      capturesBySession.set(r.session, list);
    }
  }
  // A block is honoured when a capture for that session was recorded AFTER it.
  // Compared on the recorded ts, which this process writes — never on the
  // agent-supplied `ts` inside the summary line, which models routinely
  // estimate wrongly (see scan.js's claimedTs note).
  let unhonoredBlocks = 0;
  for (const b of blocks) {
    const caps = capturesBySession.get(b.session) || [];
    if (!caps.some(c => String(c.ts) >= String(b.ts))) unhonoredBlocks++;
  }
  return {
    file: logPath(),
    stops: Object.values(byOutcome).reduce((a, b) => a + b, 0),
    byOutcome,
    blocked: byOutcome[OUTCOME.BLOCKED] || 0,
    silentBecauseUnknown: byOutcome[OUTCOME.NO_EDITS_DAEMON_DOWN] || 0,
    incomplete: starts.size,
    unhonoredBlocks,
    lastCapture,
    lastBlock,
    lastStop,
  };
}

module.exports = {
  OUTCOME, FILE_NAME, logPath,
  begin, end, capture, readRecent, summarize,
  daemonHealth, cannotKnow,
};
