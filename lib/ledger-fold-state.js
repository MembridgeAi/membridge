'use strict';
// Bounds, schema versioning, and on-disk-shape normalization for the durable
// ledger fold (lib/ledger-fold.js). Split out so ledger-fold.js itself stays
// under the file-size budget -- this half owns "how big can it get and what
// does an old/foreign shape coerce into", the other half owns the actual
// fold.

// --- schema version ----------------------------------------------------------
// Bumped whenever the persisted shape changes in a way that makes an older
// ledger.json ambiguous to fold onto. See isUnmigrated() below for what
// version 2 guards against.
const LEDGER_VERSION = 2;

// --- bounds ----------------------------------------------------------------
// ledger.json is rewritten on every dirty sync, so nothing stored here may
// grow without limit. Every list below is capped and documented.

// Request/read dedupe horizons, FIFO by insertion.
//
// INVARIANT: the key horizon must exceed the maximum window that can ever be
// re-presented to a single fold call. The window that feeds this fold is
// config.maxPlumbingEvents -- USER-CONFIGURABLE and unclamped -- so a fixed
// horizon is not safe: raise the window above the horizon and the fold
// evicts a key before the same window can repeat, and re-folding it
// double-counts every request and read in it, permanently and compounding on
// every sync (measured: window 8000 against a fixed 5000-key horizon, folded
// twice, inflated totals by 38%). So the horizon SCALES with the effective
// window instead of being a constant: 2.5x the plumbing cap, floored at the
// old fixed bound so default/small configs keep exactly the same margin as
// before.
const MIN_KEY_HORIZON = 5000;
const KEY_HORIZON_MULTIPLIER = 2.5;
// Mirrors digest.js's DEFAULT_PLUMBING_EVENTS. Duplicated rather than
// imported: pulling digest.js's render/redact/classify dependency chain into
// this low-level accumulator for one constant is the wrong direction.
const DEFAULT_PLUMBING_EVENTS = 2000;

// Effective seenKeys/readKeys horizon for a project whose plumbing cap is
// `plumbingCap` (config.maxPlumbingEvents, or the default when the caller
// doesn't know it -- e.g. a one-shot buildProjectLedger with no config in
// scope). Same formula for both lists: they cover the same window and are
// both dedupe evidence, so there is no reason for them to diverge.
function keyHorizonFor(plumbingCap) {
  const cap = Number.isFinite(plumbingCap) && plumbingCap > 0 ? plumbingCap : DEFAULT_PLUMBING_EVENTS;
  return Math.max(MIN_KEY_HORIZON, Math.ceil(KEY_HORIZON_MULTIPLIER * cap));
}

// Legacy/default-config horizon, exported for callers and tests that size
// fixtures off a fixed cap (a plumbingCap-less fold uses exactly this value).
const SEEN_KEY_CAP = keyHorizonFor(DEFAULT_PLUMBING_EVENTS);
const READ_KEY_CAP = SEEN_KEY_CAP;
// Distinct session ids remembered. The COUNT is accumulated separately, so it
// never falls when an id ages out. (An id that ages out and then reappears is
// counted twice -- over-counting is the acceptable direction here, because the
// whole point of this module is that a total must never go backwards.)
const SESSION_ID_CAP = 2000;
// Reader sessions remembered per path, LRU by last read. Tiering only needs
// "has anyone else read this", so a small set per path suffices; a path read
// by more sessions than this reports the cap as its reader count.
const READERS_PER_PATH_CAP = 32;
// Paths tracked at all. Least-recently-read paths are dropped first. A dropped
// path's next read re-tiers as 'first', which slightly under-counts repeats --
// acceptable at this depth, and it is the only way to keep ledger.json bounded
// on a repo with an unbounded file count.
const FILE_READERS_CAP = 5000;
// Hot set surfaced to the API, by reads desc.
const HOT_PATH_CAP = 200;

const LIMITS = {
  SEEN_KEY_CAP, READ_KEY_CAP, SESSION_ID_CAP,
  READERS_PER_PATH_CAP, FILE_READERS_CAP, HOT_PATH_CAP,
};

const num = v => (Number.isFinite(v) ? v : 0);
const list = v => (Array.isArray(v) ? v.slice() : []);

// FIFO push: oldest keys leave first, so the horizon always covers the most
// recent `cap` insertions.
function pushBounded(arr, value, cap) {
  arr.push(value);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

// A pre-v2 ledger.json (no version field, or version < LEDGER_VERSION) that
// already carries nonzero totals but NO dedupe evidence (seenKeys empty) is
// unmigratable: there is no way to tell how much of those totals the current
// window already re-contributes, so folding onto it re-adds the whole window
// on top of the old total (measured: +100% one-time over-count, and it never
// self-heals because it is baked into the persisted number from then on).
// Discarding days of a never-shipped metric beats permanently poisoned
// totals, so a ledger in this state is treated as though it never existed.
function isUnmigrated(p) {
  const hasTotals = num(p.requests) > 0 || num(p.volume) > 0 || num(p.sessions) > 0;
  const hasSeenKeys = Array.isArray(p.seenKeys) && p.seenKeys.length > 0;
  return num(p.version) < LEDGER_VERSION && hasTotals && !hasSeenKeys;
}

// Coerce whatever is on disk -- null on first run, an older shape after an
// upgrade -- into the full accumulator, so a partial ledger.json lifts in
// place instead of throwing or resetting to zero.
function normalize(prev) {
  let p = prev && typeof prev === 'object' ? prev : {};
  if (isUnmigrated(p)) p = {};
  const reads = (p.reads && typeof p.reads === 'object') ? p.reads : {};
  const fileReaders = {};
  for (const [file, rec] of Object.entries(p.fileReaders || {})) {
    if (Array.isArray(rec)) {
      fileReaders[file] = { sessions: rec.slice(), reads: rec.length, lastTs: '', firstTs: '', firstSession: '' };
    } else if (rec && Array.isArray(rec.sessions)) {
      fileReaders[file] = {
        sessions: rec.sessions.slice(),
        reads: num(rec.reads),
        lastTs: String(rec.lastTs || ''),
        // Absent on ledgers written before the ordering-guard fix. '' never
        // compares as "earlier than" a real ISO timestamp (see ledger-fold's
        // tierFor), so these paths simply keep pre-fix behavior until a
        // genuine 'first' read gives them a real firstTs.
        firstTs: String(rec.firstTs || ''),
        firstSession: String(rec.firstSession || ''),
      };
    }
  }
  return {
    requests: num(p.requests),
    volume: num(p.volume),
    inCost: num(p.inCost),
    outCost: num(p.outCost),
    sessionsTotal: num(p.sessions),
    sessionIds: list(p.sessionIds),
    reads: {
      first: num(reads.first),
      sameSession: num(reads.sameSession),
      crossSession: num(reads.crossSession),
    },
    seenKeys: list(p.seenKeys),
    readKeys: list(p.readKeys),
    fileReaders,
  };
}

module.exports = {
  LEDGER_VERSION, LIMITS, keyHorizonFor, pushBounded, normalize,
};
