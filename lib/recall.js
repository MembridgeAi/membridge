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
// the fail-open contract and the settings-level hook timeout (the only real
// time bound there is -- see lib/hooks-recall.js's header) apply.
// Deliberately NOT require('./skeleton'): this module is reached from the
// PreToolUse hook, in front of every file read, and must never pull the
// tree-sitter extractor into the process just to get one arithmetic helper.
//
// ATTRIBUTION (design spec §7, rewritten 2026-07-28): a serve here reports an
// OPTIMISTIC figure only -- `avoidedTokensOptimistic`, the gap between the
// call and what was served, as if there is never a follow-up read. It is NOT
// the settled number. The actual net for a serve is only known after the
// session, once the fold (a later task) knows whether the agent read the
// same path again:
//
//   net = callTokens - (skeletonTokens + followTokens)
//
// where followTokens is any same-session follow-up read of that path (0 if
// none). A smaller, targeted follow-up is a PARTIAL WIN, not a rejection --
// only net < 0 counts against a path's rejection count. decide() cannot
// compute this itself (it has no visibility into what happens after this
// call), so it hands the fold everything it needs -- callTokens and
// skeletonTokens on the result -- and lets the fold apply the formula.
const { estimateTokens } = require('./token-estimate');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Constants (exact names per docs/superpowers/plans/2026-07-28-recall-
// saving-layer.md and the token-reduction design spec).
// ---------------------------------------------------------------------------
const MIN_CALL_TOKENS = 400;
const MIN_COMPRESSION = 2.25;
const HOLDOUT_PCT = 3;
const ANNOUNCE_TOKENS = 1000; // consumed by the hook's terminal-line gate, not by decide()
const REJECTION_LIMIT = 3;

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
//   tracked       REQUIRED affirmative: must be exactly `true` for a serve to
//                 even be considered. The caller's precomputed
//                 isTrackedProject/isProjectOff result (both need fs, which
//                 this function may never touch). Anything other than the
//                 literal `true` -- omitted, undefined, false, or a truthy
//                 non-boolean the caller forgot to resolve -- refuses. This
//                 is deliberately fail-closed: the Global Constraints require
//                 recall to never intercept an untracked/paused project, so
//                 the default here must lean toward NOT serving, not toward
//                 serving unless told otherwise.
//
// NOTE (rewritten 2026-07-28): the holdout used to be scoped to a project's
// first 14 days (`projectCreatedAt`, `now`). It is now a CONTINUOUS 3% split
// with no date dependence at all -- decide() is pure with no wall-clock read,
// and neither field is part of this input shape any more. A caller still
// passing `projectCreatedAt` is harmless (it is simply ignored), but should
// stop -- see lib/hooks-recall.js, which no longer computes it.

// Deterministic holdout bucket: first 4 bytes of sha1(sessionId + relPath),
// read as an unsigned 32-bit int, mod 100. The same session+path always
// lands on the same side -- reproducible in tests, no flakiness.
function holdoutBucket(sessionId, relPath) {
  const hash = crypto.createHash('sha1').update(`${sessionId}${relPath}`).digest();
  return hash.readUInt32BE(0) % 100;
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

// Call-size estimate, priced from the actual offset/limit, never file size.
// 12 ≈ average tokens per source line, so limit*12 estimates a partial
// read's cost the same way estimateTokens (chars/4) estimates a full one.
// Exported so the hook can price a held-out read for its own log row (§7.2)
// without decide() ever having reached the point of computing it itself --
// the holdout gate fires before this in decide()'s own order.
//
// MINOR 1 (final whole-branch review): Math.round on the no-limit branch --
// a limit*12 call is already a whole number, but fileStat.size/4 is not
// whenever size isn't a clean multiple of 4, and that fractional remainder
// used to survive all the way to the terminal string ('672.75 tokens'),
// avoided.tokens, and net_tokens. Rounding once, here, at the single place
// this arithmetic is done (every caller -- lib/mcp.js's recallTool,
// lib/ledger-fold-recall-settle.js's estimateReadTokens -- goes through
// this function rather than re-deriving size/4 itself) fixes it everywhere
// downstream: skeletonTokens is already Math.ceil'd by
// lib/token-estimate.js's estimateTokens, so once callTokens is an integer
// too, avoidedTokensOptimistic (their difference) and pct (derived from
// that) are automatically whole numbers as well.
//
// MINOR 2 (documented, not fixed -- see the review's own note): this is
// BYTES/4, while estimateTokens is CHARS/4, so multibyte source (e.g. a
// file with non-ASCII identifiers or comments) prices callTokens slightly
// higher than skeletonTokens would price the same text, biasing
// avoidedTokensOptimistic upward. Left as bytes/4 deliberately: the two
// callers that price a NO-LIMIT read without already having the file's
// content in hand (lib/mcp.js's recallTool prices off fs.statSync alone
// when floor-checking before ever reading skeleton content for the body;
// lib/ledger-fold-recall-open-serves.js's correction pass prices a
// follow-up read via byteSizeOf, a bare fs.statSync, precisely so pricing a
// correction never costs a full read of a possibly-large, possibly-gone
// file) would have to read the file just to price it char-accurately --
// turning a cheap stat into a full read on every call, in the two places
// this codebase is most deliberate about avoiding exactly that cost (see
// each module's own header). lib/hooks-recall.js's PreToolUse hook DOES
// already read the file's content for contentHashOf() before this point,
// so it could switch its own no-limit calls to char-based pricing "for
// free" -- but doing that would price the SAME formula two different ways
// depending on which caller happens to already hold the content, which is
// the exact drift lib/ledger-fold-recall-settle.js's own header warns
// against ("pricing both sides of the formula with two different
// estimators would make net meaningless the moment they drift apart").
// Keeping one formula everywhere is the more honest tradeoff.
//
// CEILING (accuracy pass, 2026-07-29): a no-limit call is additionally capped
// at READ_TOOL_MAX_LINES * 12 -- Claude Code's Read tool returns at most
// ~2000 lines on a no-limit call, so size/4 on a bigger file claims tokens
// the read would never have loaded. That was the one estimator bias pointing
// in the flattering direction (every other approximation here understates).
// The cap applies ONLY to the no-limit branch: an explicit `limit` is the
// caller's own stated call shape, not an inference, and is priced as given.
const READ_TOOL_MAX_LINES = 2000;
function estimateCallTokens(limit, fileStat) {
  if (limit) return limit * 12;
  const sizeTokens = Math.round(((fileStat && fileStat.size) || 0) / 4);
  return Math.min(sizeTokens, READ_TOOL_MAX_LINES * 12);
}

function decide(input) {
  const { relPath, sessionId, limit, sessionState, storeEntry, fileStat, config } = input;

  // 1. Kill switch / config (recall.enabled defaults true; only an explicit
  // false turns it off).
  if (config && config.recall && config.recall.enabled === false) {
    return { serve: false, reason: 'recall-disabled' };
  }
  // 2. Tracked + unpaused. isTrackedProject/isProjectOff both need fs, so the
  // caller resolves this before ever building `input` and hands the answer
  // in. Require an explicit affirmative (=== true) rather than refusing only
  // on an explicit false -- an omitted/undefined tracked must never drift
  // toward serving an untracked or paused project.
  if (input.tracked !== true) {
    return { serve: false, reason: 'untracked-or-paused' };
  }
  // 2.5. Read-only interception (final whole-branch review, C3): decide()
  // accepted a `toolName` in its input contract but never read it, so a
  // Grep/Glob interception (the hook used to register on 'Read|Grep|Glob' --
  // see lib/hooks.js's RECALL_MATCHER) was answered exactly like a Read,
  // priced by estimateCallTokens(null, {size}) as though the WHOLE FILE had
  // been read -- though a grep call only ever returns a few matching lines.
  // That inflates the §7.1 headline on exactly the calls where "we observed
  // the request" doesn't hold. Refusing here is the honest floor: only a
  // real Read call may ever be served from the cache. Grep/Glob targets
  // still feed the ledger's read tiers via the adapters (lib/adapters/*,
  // untouched) -- only INTERCEPTION narrows.
  if (input.toolName !== 'Read') {
    return { serve: false, reason: 'non-read-tool' };
  }
  // 3. Holdout -- CONTINUOUS, no date window (spec §7.2, rewritten
  // 2026-07-28): 3% of eligible reads, chosen deterministically by
  // hash(sessionId + relPath), are never served, regardless of how old or
  // new the project is. This used to switch off after the project's first 14
  // days; it no longer has any notion of "expiring".
  if (holdoutBucket(sessionId, relPath) < HOLDOUT_PCT) {
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
  // 7. Call-size floor.
  const callTokens = estimateCallTokens(limit, fileStat);
  if (callTokens < MIN_CALL_TOKENS) {
    return { serve: false, reason: 'below-min-tokens' };
  }
  // 8. Compression floor + response body. Every serve reports callTokens and
  // skeletonTokens alongside avoidedTokensOptimistic (spec §7.1): this is the
  // OPTIMISTIC figure, computed as if there is never a follow-up read. The
  // settled net -- which may be smaller, or negative -- is only known once
  // the fold (a later task) sees whether this session re-read the path.
  if (tier === 'A') {
    // Tier A's body is a fixed, tiny pointer -- it always clears the floor.
    // There is no cached skeleton for tier A; skeletonTokens here is the cost
    // of the pointer body itself, the only thing actually served.
    const hash8 = String(storeEntry.contentHash || '').slice(0, 8);
    const body = tierABody(relPath, hash8);
    const skeletonTokens = estimateTokens(body);
    const avoidedTokensOptimistic = Math.max(0, callTokens - skeletonTokens);
    const pct = callTokens > 0 ? Math.round((100 * avoidedTokensOptimistic) / callTokens) : 0;
    return { serve: true, tier: 'A', body, callTokens, skeletonTokens, avoidedTokensOptimistic, pct };
  }
  // Tier B/C: the skeleton must clear MIN_COMPRESSION against this call.
  const skeletonTokens = storeEntry.skeletonTokens || 0;
  if (skeletonTokens <= 0 || callTokens / skeletonTokens < MIN_COMPRESSION) {
    return { serve: false, reason: 'below-compression-floor' };
  }
  const body = tierBBody(relPath, storeEntry.skeleton);
  const avoidedTokensOptimistic = callTokens - skeletonTokens;
  const pct = Math.round((100 * avoidedTokensOptimistic) / callTokens);
  return { serve: true, tier, body, callTokens, skeletonTokens, avoidedTokensOptimistic, pct };
}

module.exports = {
  decide,
  // tierFor is exported for the PreToolUse hook (lib/hooks-recall.js): a
  // holdout skip still needs to log which tier WOULD have served (spec
  // §7.1's held-out-vs-served comparison), and tierFor is the single source
  // of truth for that -- re-deriving it hookside would risk drifting from
  // decide()'s own tiering.
  tierFor,
  // estimateCallTokens is exported for the same reason: a holdout skip needs
  // to log callTokens too (so the fold can compare held-out vs served on
  // equal footing), but decide() never reaches its own callTokens
  // computation on a holdout path -- the hook prices it itself with the
  // exact same formula.
  estimateCallTokens,
  MIN_CALL_TOKENS, MIN_COMPRESSION, HOLDOUT_PCT, ANNOUNCE_TOKENS, REJECTION_LIMIT,
  // tierBBody is exported so a second caller with its own tiering (the MCP
  // recall tool, lib/mcp.js) can serve the exact "header + skeleton" wording
  // decide() serves for a Tier B hit, without duplicating the header string.
  // The MCP tool does its OWN freshness/floor checks (it has no session to
  // gate on -- see that module's own comment), so it composes this body
  // itself rather than calling decide().
  tierBBody,
};
