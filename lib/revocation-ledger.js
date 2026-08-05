'use strict';
// Durable record of "this install may no longer read this project".
//
// WHY THIS FILE EXISTS. `proj.teamAccessLost` (stamped by lib/teamsync.js when
// the backend stops listing a project for this member) is the only gate on two
// caches of teammate content, and NEITHER of them lives in state.json:
//
//   * <project>/.membridge/teammate-notes.json — the derived notes index, read
//     by the SessionStart injection, the on-contact file note and the project
//     page card (gated by util.mayServeTeammateNotes).
//   * <homeDir>/team-archive/<projectId>.ndjson — the long tail search_memory
//     assembles from (gated in lib/activity.js projectCorpus).
//
// The FLAG, however, lives in exactly one place: state.json. And lib/util.js
// loadState discards that whole file and returns freshState() on two
// NON-corruption conditions — a `version` stamp this build does not recognise
// (any release that bumps it, and any downgrade), and a single session-less
// event in ANY project (the pre-v2 heuristic). loadState's own header argues
// that discard is safe because the transcripts are the source of truth and a
// rescan rebuilds from them. That is true of local events. It is false of
// teamAccessLost: no transcript records a revocation, so the flag is simply
// gone while both caches sit untouched on disk, and the machine resumes
// serving a former teammate's work into every agent session.
//
// It does not self-heal either: recovery would need the next sync pass to
// CONFIRM the revocation again, and lib/teamsync.js visibleProjectIds returns
// null — "skip the gate" — for an empty visible set, which is precisely the
// state of a member revoked from their only shared project.
//
// SHAPE, and why this one. The alternative was to have loadState's discard
// path carry teamAccessLost forward before returning freshState(). That fixes
// the version bump and nothing else: the daemon's next scan rewrites the
// project record from the transcripts, which have never carried a revocation,
// so the flag is lost again on the very next save. A fact that must outlive
// state.json has to be stored outside state.json.
//
// STORAGE. One append-only NDJSON file, <homeDir>/revocations.ndjson, one
// object per line:
//
//   {"ts":"2026-08-05T12:00:00.000Z","project":"/abs/path","projectId":"uuid","event":"revoked"}
//   {"ts":"2026-08-06T09:00:00.000Z","project":"/abs/path","projectId":"uuid","event":"restored"}
//
// Append-only, last line wins per project. Appending a single short line is
// the one write shape that cannot leave a torn record in place of a good one
// (unlike a rewrite, which has a window where the old content is already
// gone), and it keeps the history of a revoke/restore cycle rather than
// flattening it — the log is the audit trail for a security-relevant fact.
//
// KEYS. Keyed by absolute project PATH, because that is what state.json,
// util.mayServeTeammateNotes and the notes index are all keyed by. The team
// backend's projectId is carried alongside for the archive's benefit and for
// forensics, but it is not the lookup key: a project can be revoked while its
// team.json is unreadable, and the path is the one identifier every caller
// already holds. (lib/repo-root.js documents why project-RELATIVE keys
// fragment; an absolute path does not have that problem.)
//
// FAILURE MODE, stated because it is the opposite of the rest of this repo.
// Most local caches here fail OPEN — a broken index costs ranking quality,
// never memory. This one fails CLOSED: an unreadable ledger means we cannot
// prove a project was not revoked, and the only thing a wrong "closed" answer
// withholds is OTHER PEOPLE's content, which the next successful read hands
// back. A wrong "open" answer is the incident. A MISSING file is not a read
// failure — it is the honest state of every install that has never had a
// revocation, and reads as an empty ledger.
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'revocations.ndjson';

// Lazy require: lib/util.js requires THIS module (saveState calls reconcile),
// so a top-level require here would be circular and would see a half-built
// util at load time. Resolved at call time, when both modules are complete.
const util = () => require('./util');

function ledgerPath() {
  return path.join(util().homeDir(), FILE_NAME);
}

const keyOf = p => (p ? util().normPath(p) : '');

// Parsed ledger, memoized on the file's (mtime, size) so a loop over every
// tracked project — lib/activity.js does exactly that — parses it once. Any
// write invalidates it directly, so the cache cannot outlive its own append.
let cache = null; // { stamp, byPath: Map, failed: bool }

function statStamp() {
  try {
    const st = fs.statSync(ledgerPath());
    return `${st.mtimeMs}:${st.size}`;
  } catch (err) {
    if (err && err.code === 'ENOENT') return 'absent';
    return null; // unstattable: never cache, re-ask every time
  }
}

function readLedger() {
  const stamp = statStamp();
  if (cache && stamp !== null && cache.stamp === stamp) return cache;
  if (stamp === 'absent') {
    cache = { stamp, byPath: new Map(), failed: false };
    return cache;
  }
  let raw;
  try {
    raw = fs.readFileSync(ledgerPath(), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      cache = { stamp: 'absent', byPath: new Map(), failed: false };
      return cache;
    }
    // Fail CLOSED (see the header): a ledger we cannot read is not evidence
    // that nothing was revoked.
    try { util().log(`revocation ledger unreadable (${err && err.code}) — refusing all teammate content until it can be read`); } catch {}
    const out = { stamp: null, byPath: new Map(), failed: true };
    cache = null;
    return out;
  }
  const byPath = new Map();
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let rec;
    try { rec = JSON.parse(s); } catch { skipped++; continue; } // a torn tail from a crash mid-append
    if (!rec || !rec.project) { skipped++; continue; }
    // Last line wins: an append never has to find and rewrite an earlier one.
    byPath.set(keyOf(rec.project), {
      revoked: rec.event !== 'restored',
      ts: rec.ts || null,
      projectId: rec.projectId || null,
    });
  }
  if (skipped) {
    try { util().log(`revocation ledger: skipped ${skipped} unparseable line(s)`); } catch {}
  }
  cache = { stamp, byPath, failed: false };
  return cache;
}

// May this install still read `projectPath`'s teammate content, as far as the
// ledger knows? `false` here is a positive, durable "no".
function isRevoked(projectPath) {
  if (!projectPath) return false;
  const led = readLedger();
  if (led.failed) return true; // fail closed
  const rec = led.byPath.get(keyOf(projectPath));
  return !!(rec && rec.revoked);
}

// Every project path the ledger currently holds a live revocation for.
function revokedPaths() {
  const led = readLedger();
  const out = [];
  for (const [key, rec] of led.byPath) if (rec && rec.revoked) out.push(key);
  return out;
}

function append(record) {
  try {
    util().ensureHomeDir();
    fs.appendFileSync(ledgerPath(), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    try { fs.chmodSync(ledgerPath(), 0o600); } catch {}
  } catch (err) {
    // A failed append must not break the sync pass that noticed the
    // revocation — the in-state flag still gates this run. It DOES mean the
    // fact is not durable yet, so say so loudly rather than silently.
    try { util().log(`revocation ledger append failed (${err && err.code}) — revocation of ${record.project} is not durable`); } catch {}
    return false;
  }
  cache = null;
  return true;
}

function record(projectPath, event, opts = {}) {
  if (!projectPath) return false;
  return append({
    ts: opts.ts || new Date().toISOString(),
    project: path.resolve(String(projectPath)),
    projectId: opts.projectId || null,
    event,
  });
}

// ---------------------------------------------------------------------------
// The state.json mirror.
//
// Called by util.saveState with the state about to be written, and returns the
// state that should actually be written. Two directions, deliberately NOT
// symmetric:
//
//   RECORD a revocation whenever a saved project record carries
//   teamAccessLost. Positive fact, cheap, and it catches every writer — not
//   just lib/teamsync.js's branch — so an install that was already revoked
//   before this code shipped becomes durable on its next save.
//
//   CLEAR one only for a writer that COULD SEE it. loadState tags the state it
//   returns with the revocations that were actually in the file
//   (SEEN_REVOKED); a caller that loaded a state, saw the flag and removed it
//   is un-revoking on purpose (lib/teamsync.js does exactly this when the
//   backend lists the project again). A caller whose loaded state never showed
//   the flag — because loadState DISCARDED the file — has said nothing about
//   access, and its save must not be read as consent. That asymmetry is the
//   whole fix: absence of the flag is only meaningful from a writer who would
//   have been shown it.
//
// When a revocation is kept, the flag is stamped back into the record being
// written, so state.json repairs itself on the first save after a discard and
// every in-state reader (util.teamRowsFor, lib/activity.js, lib/teamsync.js's
// own skip branch) is correct again without consulting this file.
function reconcile(state) {
  if (!state || typeof state !== 'object') return state;
  const projects = state.projects || {};
  const keys = Object.keys(projects);
  if (!keys.length) return state;

  // Read ONCE for the whole save. Every append below invalidates the parse
  // cache, so asking per project would re-read the file once per revocation.
  const led = readLedger();
  const revokedTs = new Map(); // normalised path -> the ts we are holding it at
  if (led.failed) return state; // cannot tell what is recorded; change nothing
  for (const [k, rec] of led.byPath) if (rec && rec.revoked) revokedTs.set(k, rec.ts);

  for (const key of keys) {
    const proj = projects[key];
    if (!proj || !proj.teamAccessLost) continue;
    if (revokedTs.has(keyOf(key))) continue; // already durable
    record(key, 'revoked', { ts: proj.teamAccessLost });
    revokedTs.set(keyOf(key), proj.teamAccessLost);
  }

  const seen = util().seenRevoked(state);
  let repaired = null;
  for (const key of keys) {
    const proj = projects[key];
    if (!proj || proj.teamAccessLost || !revokedTs.has(keyOf(key))) continue;
    if (seen.has(keyOf(key))) {
      record(key, 'restored'); // the writer saw the revocation and lifted it
      revokedTs.delete(keyOf(key));
      continue;
    }
    // The writer never saw it. Keep the revocation and put the flag back, so
    // state.json repairs itself and every in-state reader is correct again.
    repaired = repaired || { ...state, projects: { ...projects } };
    repaired.projects[key] = { ...proj, teamAccessLost: revokedTs.get(keyOf(key)) || new Date().toISOString() };
  }
  return repaired || state;
}

module.exports = { FILE_NAME, ledgerPath, isRevoked, revokedPaths, record, reconcile };
