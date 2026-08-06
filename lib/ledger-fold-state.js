'use strict';
// Bounds, schema versioning, and on-disk-shape normalization for the durable
// ledger fold (lib/ledger-fold.js). Split out so ledger-fold.js itself stays
// under the file-size budget -- this half owns "how big can it get and what
// does an old/foreign shape coerce into", the other half owns the actual
// fold.

// --- schema version ----------------------------------------------------------
// Bumped whenever the persisted shape changes in a way that makes an older
// ledger.json ambiguous to fold onto. See isUnmigrated() below for what
// version 2 guards against, and isPreRelativeKeys() for version 3.
//
// Version 4 (Task 6, spec §7.1/§7.3): adds the top-level `avoided` and
// `holdout` blocks. This is purely ADDITIVE -- no existing field changed
// shape -- so unlike the v2->v3 bump there is nothing to migrate away from:
// normalize() below simply defaults both blocks to zero when absent (see
// normalizeAvoided/normalizeHoldout). Neither isUnmigrated nor
// isPreRelativeKeys needs to know about this bump; both gate on hasTotals /
// hasSeenKeys / RELATIVE_KEYS_VERSION, none of which this change touches, so
// a real v3 ledger (with its own totals and dedupe evidence intact) folds
// through untouched and simply gains zeroed avoided/holdout blocks.
//
// Fix round 2 (revisable settlement): adds the top-level `openServes` list,
// same additive shape as the v4 bump above -- no further version bump
// needed; normalizeOpenServes() defaults an absent/foreign block to `[]`.
//
// v5 (repeat-read fix): fileReaders/hotPaths keys stopped carrying the
// .claude/worktrees/<name>/ prefix -- a read from a linked worktree now
// collapses onto the main checkout's key (lib/repo-root.js's ledgerKeyFor).
// A second key-SHAPE change, so it gets the same treatment v3 did: the
// key-shaped fields reset, every cumulative total survives.
const LEDGER_VERSION = 5;
// The version at which fileReaders/hotPaths keys became repo-RELATIVE.
const RELATIVE_KEYS_VERSION = 3;
// The version at which those keys stopped carrying a worktree prefix.
const WORKTREE_KEYS_VERSION = 5;

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

// Direct-avoidance / holdout accumulators (spec §7.1/§7.2, Task 6). Both are
// plain running totals -- no bounded lists, nothing to cap -- so normalizing
// them is just coercing whatever is on disk (absent on any ledger written
// before v4, malformed on a hand-edited or foreign one) into the full shape
// with zero defaults. Exported so lib/server.js's /api/savings projection
// and lib/ledger-fold-recall.js's settlement both default the SAME way
// instead of drifting between two hand-rolled versions of "what does an
// absent block mean".
function normalizeAvoided(a) {
  const v = a && typeof a === 'object' ? a : {};
  return {
    tokens: num(v.tokens),
    serves: num(v.serves),
    tierA: num(v.tierA),
    tierB: num(v.tierB),
    // Serves whose tier the queue row never carried. Defaults to 0 for every
    // ledger written before this existed, which is correct: those serves were
    // miscounted into tierB at the time and this cannot retroactively unpick
    // them -- see the doc. It only stops NEW ones being miscounted.
    tierUnknown: num(v.tierUnknown),
    partialWins: num(v.partialWins),
    netNegatives: num(v.netNegatives),
  };
}

// MINOR 3 (final whole-branch review): `seenKeys` is dedupe evidence for
// holdout rows, the same idempotency precedent openServes/serveId already
// establishes for serve rows (see lib/ledger-fold-recall-settle.js's
// settleRows header) -- without it, a re-read of the same still-queued
// holdout row after a failed queue rewrite re-tallied skips/callTokens.
// Bounded, additive-only-via-replacement (lib/ledger-fold-recall.js merges
// and bounds this list itself, the same way it already owns openServes'
// bound), so normalizing it here is just shape coercion: absent on any
// ledger written before this fix, malformed on a hand-edited or foreign
// one, otherwise passed through.
function normalizeHoldout(h) {
  const v = h && typeof h === 'object' ? h : {};
  return { skips: num(v.skips), callTokens: num(v.callTokens), seenKeys: list(v.seenKeys) };
}

// Teammate-note injection accounting (spec §9). Same shape and same reasoning
// as normalizeHoldout above: two running totals plus bounded dedupe evidence,
// absent on every ledger written before this change and therefore defaulted to
// zero rather than migrated.
//
// This block is deliberately NOT part of, and never summed into, `avoided`:
// an injected note is pure INPUT COST, and what it buys is a mistake nobody
// made, which this ledger has no way to observe. Netting it against avoidance
// would be a fabricated balance. lib/server.js projects it as its own figure,
// outside the net (spec §9) -- keep it that way.
function normalizeNotes(n) {
  const v = n && typeof n === 'object' ? n : {};
  return { injections: num(v.injections), tokens: num(v.tokens), seenKeys: list(v.seenKeys) };
}

// Ride-along billed accrual (spec §7.5): one running total, a FLAT sibling of
// `avoided` on the same reasoning notes uses above -- avoided stays the
// once-only §7.1 figure, billed is that same avoidance accrued over the
// session's observed subsequent requests (lib/ledger-fold-recall-ride.js).
// Absent on every ledger written before 2026-07-29 and therefore defaulted to
// zero rather than migrated. May legitimately be negative (num() here does
// not clamp sign): billed inherits corrections, and a serve that crossed
// negative drags its rides negative with it.
function normalizeBilled(b) {
  const v = b && typeof b === 'object' ? b : {};
  return { tokens: num(v.tokens) };
}

// A classified bucket must be one of these three, or applyCorrections'
// moveBucket/bucketField (lib/ledger-fold-recall-open-serves.js) silently
// treat a foreign value as un-bucketed rather than throwing -- normalizing
// it up front to a known value is simpler than teaching every reader to cope
// with "anything else".
const OPEN_SERVE_CLASSES = new Set(['full', 'partial', 'negative']);

// FINDING 3 (fix round 4): a hand-edited or foreign openServes entry used to
// pass through with only object-ness checked. lib/ledger-fold-recall-open-
// serves.js's applyCorrections unconditionally dereferences
// `current.correctedBy.includes(...)` -- a receipt missing that field (e.g.
// a receipt written before this fix, or truncated by a partial write) throws
// TypeError, which lib/scan.js's syncOnce catches and logs, but the SAME
// malformed ledger.json is read back and re-thrown on every subsequent
// pass -- the whole project's requests/volume/warm accumulation freezes
// forever, not just for one tick. Coercing the shape here -- correctedBy to
// an array, classified to a known bucket (default 'full', mirroring a fresh
// receipt's own initial value), and the numeric fields through the same
// num() helper every other field in this module already uses -- makes one
// malformed receipt inert instead of fatal: it folds cleanly and the
// project keeps accumulating.
function normalizeOpenServe(r) {
  return {
    serveId: r.serveId,
    ts: r.ts,
    sessionId: r.sessionId,
    relPath: r.relPath,
    callTokens: num(r.callTokens),
    skeletonTokens: num(r.skeletonTokens),
    netRecorded: num(r.netRecorded),
    classified: OPEN_SERVE_CLASSES.has(r.classified) ? r.classified : 'full',
    correctedBy: Array.isArray(r.correctedBy) ? r.correctedBy.slice() : [],
    // Ride-along fields (spec §7.5) -- absent on receipts written before
    // 2026-07-29, defaulted to a fresh receipt's own initial values so an old
    // receipt simply starts counting from here. ridePrevCtx keeps its
    // null-when-unset sentinel through coercion: 0 would read as "the
    // previous context was empty" and make the very next request look like
    // an implausible jump (lib/ledger.js's epochReset), closing accrual on a
    // receipt that never counted anything.
    rideRequests: num(r.rideRequests),
    rideFrontierTs: typeof r.rideFrontierTs === 'string' ? r.rideFrontierTs : null,
    rideFrontierIds: list(r.rideFrontierIds),
    ridePrevCtx: Number.isFinite(r.ridePrevCtx) ? r.ridePrevCtx : null,
    ridePrevOut: num(r.ridePrevOut),
    rideClosed: r.rideClosed === true,
    billedRecorded: num(r.billedRecorded),
  };
}

// Open-serve receipts for revisable settlement (fix round 2, Task 6) -- a
// bounded LIST rather than a running total, so normalizing it is just shape
// coercion (absent on any ledger written before this fix, malformed on a
// hand-edited or foreign one, otherwise passed through). Bounds
// (OPEN_SERVE_TTL_MS, MAX_OPEN_SERVES) and the correction math live in
// lib/ledger-fold-recall-open-serves.js.
function normalizeOpenServes(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(r => r && typeof r === 'object').map(normalizeOpenServe);
}

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

// A ledger written before RELATIVE_KEYS_VERSION keys fileReaders (and the
// hotPaths derived from it) by the read event's VERBATIM path -- absolute, as
// lib/adapters/claude-code.js emits it. Every consumer looks those keys up
// REPO-RELATIVE, so the two never matched and the recall layer was inert; the
// fold now relativizes at the write boundary (see foldReads in
// ledger-fold.js). Folding new relative keys onto old absolute ones would
// leave one file counted twice under two names and one ledger carrying two
// key shapes forever, so such a ledger is discarded exactly like an
// unmigratable one. There is no in-place migration because the old keys are
// absolute paths from whatever machine wrote them -- not reliably
// relativizable here -- and the cost is one rebuild of a young metric.
function isPreRelativeKeys(p) {
  if (num(p.version) >= RELATIVE_KEYS_VERSION) return false;
  const hasTotals = num(p.requests) > 0 || num(p.volume) > 0 || num(p.sessions) > 0;
  return hasTotals || Object.keys(p.fileReaders || {}).length > 0;
}

// A ledger written before WORKTREE_KEYS_VERSION keys a file read inside a
// linked worktree by its path relative to the PROJECT, so the same file read
// from <main>/lib/scan.js and from <main>/.claude/worktrees/x/lib/scan.js
// occupied two rows and could never tier as a repeat read (measured on a live
// ledger: 12/12 rows worktree-prefixed, two files present twice, both scored
// 'first'). lib/repo-root.js's ledgerKeyFor now collapses the prefix.
//
// Same reasoning as isPreRelativeKeys above: mixing the two shapes in one
// fileReaders would leave a file counted under two names indefinitely, so the
// key-shaped fields reset once. Unlike v3 the old keys ARE mechanically
// rewritable here -- but rewriting them would have to MERGE two rows into one,
// and the merged row's contribution to reads.first/sameSession/crossSession
// was already written under the old shape. Those tier totals are cumulative
// and never move backwards (this module's header invariant), and the evidence
// needed to re-tier them is long gone from the event window. A clean reset of
// the reader sets, with every total preserved, is the honest option: past
// reads stay counted as they were seen, and the NEXT read of a
// previously-worktree-read file tiers correctly.
function isPreWorktreeKeys(p) {
  if (num(p.version) >= WORKTREE_KEYS_VERSION) return false;
  return Object.keys(p.fileReaders || {}).length > 0;
}

// Coerce whatever is on disk -- null on first run, an older shape after an
// upgrade -- into the full accumulator, so a partial ledger.json lifts in
// place instead of throwing or resetting to zero.
function normalize(prev) {
  let p = prev && typeof prev === 'object' ? prev : {};
  if (isUnmigrated(p)) {
    // Genuinely unmigratable (see isUnmigrated's own comment): no dedupe
    // evidence at all, so the existing totals cannot be trusted not to
    // already double-count the current window. Full reset, as before.
    p = {};
  } else if (isPreRelativeKeys(p) || isPreWorktreeKeys(p)) {
    // A real pre-bump ledger (v2 for the relative-keys change, v4 for the
    // worktree-keys one) DOES carry dedupe evidence (seenKeys is non-empty --
    // isUnmigrated above already ruled out the case where it doesn't), so
    // its requests/volume/cost/session totals are trustworthy and must
    // survive the key-shape bump. Resetting THOSE alongside the key-shaped
    // fields was the bug (measured on a real ledger: 900 requests / 54M
    // volume / accumulated cost zeroed by an upgrade that only changed how
    // fileReaders is keyed) -- exactly the "volume can go DOWN" regression
    // this module's header exists to prevent.
    //
    // Only the fields whose KEY FORMAT actually changed are cleared:
    // fileReaders/hotPaths (keyed by path -- absolute under v2, repo-relative
    // from v3 on; see isPreRelativeKeys' own comment for why the two shapes
    // may never mix) and readKeys (the per-read-event dedupe list). readKeys'
    // own key format doesn't strictly depend on the fileReaders key shape --
    // lib/ledger-fold.js documents it as staying on the event's verbatim path
    // regardless -- but it exists purely to stop a re-fold of an
    // already-counted window from double-tallying into reads.first/
    // sameSession/crossSession, so clearing it alongside fileReaders is the
    // conservative, self-consistent choice: the in-flight window simply
    // re-tiers cleanly against a known-empty base under the new key shape,
    // at the cost of a bounded, one-time, SELF-CORRECTING over-count of
    // that one window -- never a decrease (see SESSION_ID_CAP's comment
    // above for the same "over-count is the acceptable direction"
    // principle already used elsewhere in this module).
    //
    // reads.first/sameSession/crossSession are DELIBERATELY preserved, not
    // reset, even though they were tallied against the now-cleared
    // fileReaders: they are cumulative TOTALS under the exact same
    // never-goes-backwards invariant as requests/volume (that invariant is
    // the whole point of this module, per the file header), and discarding
    // them would be the identical regression this fix exists to stop, just
    // for a different field.
    p = {
      requests: p.requests, volume: p.volume, inCost: p.inCost, outCost: p.outCost,
      sessions: p.sessions, sessionIds: p.sessionIds, seenKeys: p.seenKeys,
      reads: p.reads,
      // fileReaders/readKeys deliberately omitted: normalize() below treats
      // their absence exactly like a fresh ledger's.
    };
  }
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
    avoided: normalizeAvoided(p.avoided),
    holdout: normalizeHoldout(p.holdout),
    notes: normalizeNotes(p.notes),
    billed: normalizeBilled(p.billed),
    openServes: normalizeOpenServes(p.openServes),
  };
}

module.exports = {
  LEDGER_VERSION, LIMITS, keyHorizonFor, pushBounded, normalize,
  normalizeAvoided, normalizeHoldout, normalizeNotes, normalizeBilled, normalizeOpenServes,
};
