'use strict';
// PURE serve policy for the recall layer: given a fully-assembled snapshot of
// "what do we know about this read", decide whether to answer it from the
// recall store instead of letting the read hit the file.
//
// This module does no I/O of its own -- no fs, no network, no requires with
// side effects -- so it is table-testable with plain object literals. Every
// fact it needs (the file's current hash, the store's cached skeleton,
// whether the project is tracked/paused) is computed by the caller (the
// PreToolUse hook, a later task) and handed in via `input`. That split keeps
// every actual stat/hash/disk-read on the hook's side of the boundary, where
// the ~150ms budget and fail-open contract are enforced.
const { estimateTokens } = require('./skeleton'); // pure: requiring this never loads wasm
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Constants (exact names per docs/superpowers/plans/2026-07-28-recall-
// saving-layer.md and the token-reduction design spec).
// ---------------------------------------------------------------------------
const MIN_CALL_TOKENS = 400;
const MIN_COMPRESSION = 2.25;
const HOLDOUT_PCT = 10;
const HOLDOUT_DAYS = 14;
const ANNOUNCE_TOKENS = 1000; // consumed by the hook's terminal-line gate, not by decide()
const REJECTION_LIMIT = 3;

const HOLDOUT_WINDOW_MS = HOLDOUT_DAYS * 24 * 60 * 60 * 1000;

// input shape (all caller-assembled, nothing fetched here):
//   projectPath, relPath, absPath   -- identity of the read
//   sessionId, toolName             -- who is asking
//   offset, limit                   -- the actual call shape (never file size)
//   sessionState  { served: {relPath: contentHash}, interceptions }
//   ledger        the project's ledger.json shape; only .fileReaders is read
//   storeEntry    lib/recall-store.js's get() result, or null
//   fileStat      { size, hash } -- size in bytes and the sha1 of the file's
//                 CURRENT on-disk content, both computed by the caller
//   config        effective config; only config.recall is read
//   projectCreatedAt  ISO string or epoch ms; first-tracked time (holdout)
//   tracked       optional, default true -- the caller's precomputed
//                 isTrackedProject/isProjectOff result (both need fs, which
//                 this function may never touch)
//   now           optional, default Date.now() -- wall-clock override, so
//                 holdout-window tests never race real time

// Deterministic holdout bucket: first 4 bytes of sha1(sessionId + relPath),
// read as an unsigned 32-bit int, mod 100. The same session+path always
// lands on the same side -- reproducible in tests, no flakiness.
function holdoutBucket(sessionId, relPath) {
  const hash = crypto.createHash('sha1').update(`${sessionId}${relPath}`).digest();
  return hash.readUInt32BE(0) % 100;
}

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

// This session has already READ relPath, per the ledger's accumulated
// fileReaders evidence (lib/ledger-fold.js) -- distinct from
// sessionState.served, which tracks what RECALL has already answered this
// session. Tiering cares about actual prior reads, not prior serves.
function readByThisSession(ledger, relPath, sessionId) {
  const rec = ledger && ledger.fileReaders && ledger.fileReaders[relPath];
  return !!(rec && Array.isArray(rec.sessions) && rec.sessions.includes(sessionId));
}

function readByOtherSession(ledger, relPath, sessionId) {
  const rec = ledger && ledger.fileReaders && ledger.fileReaders[relPath];
  return !!(rec && Array.isArray(rec.sessions) && rec.sessions.some(s => s !== sessionId));
}

// Which tier applies, or null. Freshness gates every tier: storeEntry must
// exist and its contentHash must match the file's CURRENT hash (fileStat.hash,
// computed by the caller), or the cache is stale and nothing may be served no
// matter what the read history says.
function tierFor(input) {
  const { relPath, sessionId, ledger, storeEntry, fileStat, config } = input;
  const fresh = !!(storeEntry && fileStat && storeEntry.contentHash && storeEntry.contentHash === fileStat.hash);
  if (!fresh) return null;
  if (readByThisSession(ledger, relPath, sessionId)) return 'A';
  if (readByOtherSession(ledger, relPath, sessionId) && storeEntry.skeleton) return 'B';
  const everRead = !!(ledger && ledger.fileReaders && ledger.fileReaders[relPath]);
  if (!everRead && storeEntry.skeleton && config && config.recall && config.recall.tierC) return 'C';
  return null;
}

const tierABody = (relPath, hash8) =>
  `MemBridge: this session already read ${relPath} (unchanged since; hash ${hash8}). Re-read only if you need to revisit specific content.`;

const tierBBody = (relPath, skeleton) =>
  `MemBridge structural summary of ${relPath} (full file unchanged on disk — read it directly for implementation bodies):\n\n${skeleton}`;

function decide(input) {
  const { relPath, sessionId, limit, sessionState, storeEntry, fileStat, config, projectCreatedAt } = input;
  const now = Number.isFinite(input.now) ? input.now : Date.now();

  // 1. Kill switch / config (recall.enabled defaults true; only an explicit
  // false turns it off).
  if (config && config.recall && config.recall.enabled === false) {
    return { serve: false, reason: 'recall-disabled' };
  }
  // 2. Tracked + unpaused. isTrackedProject/isProjectOff both need fs, so the
  // caller resolves this before ever building `input` and hands the answer in.
  if (input.tracked === false) {
    return { serve: false, reason: 'untracked-or-paused' };
  }
  // 3. Holdout -- only active inside the project's first HOLDOUT_DAYS.
  const createdMs = toMs(projectCreatedAt);
  const withinHoldoutWindow = Number.isFinite(createdMs) && (now - createdMs) < HOLDOUT_WINDOW_MS;
  if (withinHoldoutWindow && holdoutBucket(sessionId, relPath) < HOLDOUT_PCT) {
    return { serve: false, reason: 'holdout' };
  }
  // 4. Already served this session -- never intercept the same path twice.
  if (sessionState && sessionState.served && Object.prototype.hasOwnProperty.call(sessionState.served, relPath)) {
    return { serve: false, reason: 'already-served' };
  }
  // 5. Rejection learning -- the agent kept reading the real file anyway.
  if (storeEntry && storeEntry.rejections >= REJECTION_LIMIT) {
    return { serve: false, reason: 'rejection-limit' };
  }
  // 6. Tier.
  const tier = tierFor(input);
  if (!tier) {
    return { serve: false, reason: 'no-tier' };
  }
  // 7. Call-size floor, priced from the actual offset/limit, never file size.
  // 12 ≈ average tokens per source line, so limit*12 estimates a partial
  // read's cost the same way estimateTokens (chars/4) estimates a full one.
  const callTokens = limit ? limit * 12 : ((fileStat && fileStat.size) || 0) / 4;
  if (callTokens < MIN_CALL_TOKENS) {
    return { serve: false, reason: 'below-min-tokens' };
  }
  // 8. Compression floor + response body.
  if (tier === 'A') {
    // Tier A's body is a fixed, tiny pointer -- it always clears the floor.
    const hash8 = String(storeEntry.contentHash || '').slice(0, 8);
    const body = tierABody(relPath, hash8);
    const savedTokens = Math.max(0, callTokens - estimateTokens(body));
    const pct = callTokens > 0 ? Math.round((100 * savedTokens) / callTokens) : 0;
    return { serve: true, tier: 'A', body, savedTokens, pct };
  }
  // Tier B/C: the skeleton must clear MIN_COMPRESSION against this call.
  const skeletonTokens = storeEntry.skeletonTokens || 0;
  if (skeletonTokens <= 0 || callTokens / skeletonTokens < MIN_COMPRESSION) {
    return { serve: false, reason: 'below-compression-floor' };
  }
  const body = tierBBody(relPath, storeEntry.skeleton);
  const savedTokens = callTokens - skeletonTokens;
  const pct = Math.round((100 * savedTokens) / callTokens);
  return { serve: true, tier, body, savedTokens, pct };
}

module.exports = {
  decide,
  MIN_CALL_TOKENS, MIN_COMPRESSION, HOLDOUT_PCT, HOLDOUT_DAYS, ANNOUNCE_TOKENS, REJECTION_LIMIT,
};
