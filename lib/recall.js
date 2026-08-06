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
const { estimateTokens, estimateTokensFromBytes, estimateTokensFromLines } = require('./token-estimate');
const { HOLDOUT_EPOCH } = require('./holdout-epoch');
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

// Deterministic holdout bucket: first 4 bytes of sha1(sessionId), read as an
// unsigned 32-bit int, mod 100. The same session always lands on the same
// side -- reproducible in tests, no flakiness.
//
// ASSIGNMENT IS PER SESSION (measured-savings spec, Tier 3). It used to hash
// `${sessionId}${relPath}`, which assigned the holdout per READ: a session was
// partly served and partly withheld, so there was no cohort to compare
// anything against. Taking relPath out of the hash is the whole fix -- a
// session is now wholly in or wholly out, and the withheld arm is a clean 3%
// sample of sessions. The rate is unchanged.
//
// THE SIGNATURE TAKES ONE ARGUMENT ON PURPOSE. A second argument would be
// silently ignored, which is exactly how this would regress: a future caller
// passing a path would look like it was still per-path and behave as though it
// weren't. Callers pass a session id and nothing else.
//
// ASSIGNMENT AND MEASUREMENT ARE DIFFERENT CHOICES AND MUST NOT BE CONFLATED.
// Assignment is per session, here. The unit the comparison is COMPUTED over
// stays the eligible read (lib/roi.js) -- session size varies by far more than
// the effect does, so a per-session comparison over a 1-in-30 sample is
// dominated by which sessions happened to land in the holdout. Moving this
// hash back to per read breaks the cohort; computing the effect per session
// throws away most of the power. Both halves are required.
function holdoutBucket(sessionId) {
  const hash = crypto.createHash('sha1').update(String(sessionId)).digest();
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

// ---------------------------------------------------------------------------
// DELIVERED WINDOWS (REV-12).
//
// The ledger records that a session read a PATH. It has never recorded which
// LINES came back, and Tier A used to serve on that alone -- so a session
// handed lines 90-179 of a file and then issuing an unranged read was told
// "this session already read it", and skipped lines 1-89 it had never seen.
// Two such cases are in this machine's own transcripts (see
// docs/recall-serve-funnel.md, REV-11): 2 of 10 servable candidates, a 20%
// false-claim rate on the tier.
//
// Same shape as the bug REV-4 fixed, one layer down: that one proved the file
// had not changed, this one proves the session was actually handed the part
// being asked for. A file being unchanged says nothing about whether you have
// seen the lines you are now asking for.
// ---------------------------------------------------------------------------

// A Read call's delivered window, in 1-based line numbers. Claude Code returns
// `limit` lines from `offset`, and at most READ_TOOL_MAX_LINES without one --
// so an unqualified read of a 24k-line file delivers [1, 2000], NOT the file.
// Treating it as the whole file is the same overclaim in miniature.
function windowFor(offset, limit) {
  const lo = Number.isFinite(offset) && offset > 0 ? offset : 1;
  const span = Number.isFinite(limit) && limit > 0 ? limit : READ_TOOL_MAX_LINES;
  return [lo, lo + span - 1];
}

// How many disjoint windows one path keeps per session. A patchwork beyond
// this is a session that has read a file in dozens of scattered pieces, and
// dropping spans only ever SHRINKS what we claim to have delivered -- the safe
// direction. The lowest spans are kept because an unranged call asks for
// [1, N], so they are the ones a later serve can actually use.
const MAX_WINDOWS_PER_PATH = 32;

// Union of delivered windows, sorted and merged. Adjacency counts as
// contiguous: a session handed [1,45] and then [46,2000] really does hold
// [1,2000], and treating those as separate would refuse a serve it has earned.
function addWindow(ranges, win) {
  const all = [...(Array.isArray(ranges) ? ranges : []), win]
    .filter(r => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] >= r[0])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [lo, hi] of all) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out.slice(0, MAX_WINDOWS_PER_PATH);
}

// Does the union already contain every line this call is asking for?
// An empty/absent union covers nothing -- absence of evidence is never
// agreement, the same rule the recorded hash follows.
function coversWindow(ranges, [lo, hi]) {
  if (!Array.isArray(ranges) || !ranges.length) return false;
  // Sorted defensively rather than assumed. addWindow always produces sorted,
  // merged spans, but these come off disk -- a session record can be hand-
  // edited, half-written, or produced by an older build, and a function that
  // silently depends on an unstated invariant of its input is how a "covered"
  // answer becomes a coin flip. Order carries no meaning here, so sorting
  // computes the same set's true coverage rather than changing what is claimed.
  const spans = ranges
    .filter(r => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] >= r[0])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cursor = lo;
  for (const [rlo, rhi] of spans) {
    if (rhi < cursor) continue;
    if (rlo > cursor) return false; // a hole before the next span
    cursor = rhi + 1;
    if (cursor > hi) return true;
  }
  return cursor > hi;
}

// Normalise one entry of sessionState.reads. Two shapes exist on disk:
//   { hash, ranges: [[lo,hi], ...] }  -- current
//   "<hash>"                          -- written before REV-12
// The legacy string carries no window information at all, so it normalises to
// an EMPTY union and fails closed: a session recorded before this shipped
// cannot serve Tier A until its next read records a window. That is the same
// upgrade behaviour REV-4 chose for the hash, and for the same reason --
// reading absence as agreement is what reproduces the bug for every existing
// install.
function readRecordOf(sessionState, relPath) {
  const raw = sessionState && sessionState.reads ? sessionState.reads[relPath] : null;
  if (typeof raw === 'string' && raw) return { hash: raw, ranges: [] };
  if (raw && typeof raw === 'object' && typeof raw.hash === 'string' && raw.hash) {
    return { hash: raw.hash, ranges: Array.isArray(raw.ranges) ? raw.ranges : [] };
  }
  return null;
}

// Which tier applies, or null. Freshness gates every tier: storeEntry must
// exist and its contentHash must match the file's CURRENT hash (fileStat.hash,
// computed by the caller), or the cache is stale and nothing may be served no
// matter what the read history says.
function tierFor(input) {
  const { relPath, sessionId, ledger, storeEntry, fileStat, config, sessionState } = input;
  // ---- Tier A proves ITS OWN interval. ----
  //
  // Tier A's body says the file is unchanged since THIS SESSION READ IT, which
  // is the interval [read, now]. The `fresh` check below compares the store's
  // contentHash -- stamped when lib/recall-store.js's warm() cached the file --
  // against the hash now, which is [warm, now]. Those are different intervals,
  // and using the second to justify the first is wrong in an ordinary case:
  // read at T1, someone edits at T2, a sync pass warms the new content at T3,
  // the session reads again at T4. `fresh` passes, and Tier A tells the agent
  // a file it is holding STALE content for is unchanged -- so it skips the
  // re-read and proceeds on the old bytes believing they are current. Nothing
  // downstream can detect that. It is the one failure on this path that hands
  // a false statement to something that will act on it.
  //
  // So Tier A is answered from the hash THIS session saw at THAT read
  // (lib/hooks-recall.js records it on every read into sessionState.reads),
  // and is independent of the store -- which is right on its own terms too,
  // since Tier A serves a one-line notice and never reads a skeleton.
  //
  // BOTH conditions are required, and they prove different things:
  //   * the recorded hash proves WHAT the file looked like at that read;
  //   * the ledger proves the read ACTUALLY HAPPENED. The hook runs on
  //     PreToolUse, i.e. BEFORE the read, so a recorded hash alone would also
  //     cover a read that was subsequently denied or never executed, and the
  //     session would be told it had already seen a file it never received.
  //
  // An ABSENT recorded hash is never agreement. Every session file written
  // before this shipped has no `reads` map at all, and reading that absence as
  // "unchanged" would make each one serve exactly the false claim this fixes.
  //
  // THIRD condition, and it proves a third thing (REV-12): that the session was
  // handed THE LINES IT IS NOW ASKING FOR. The two above are about the file --
  // what it looked like, and that it was read. Neither says anything about
  // WHICH PART came back, because the ledger has never recorded a range. A
  // session handed lines 90-179 and now asking for 1-90 has read the path, at
  // this exact content, and still holds none of what it is asking for.
  //
  // The union is the hook's own record of the windows it saw requested. It
  // narrows the claim from "some read of this path happened" to "these lines
  // were delivered"; the residual is a read the hook recorded and the user then
  // denied, which the ledger's proof-of-read covers only at path granularity.
  // Stated rather than papered over.
  const record = readRecordOf(sessionState, relPath);
  if (record && fileStat && record.hash === fileStat.hash
      && readByThisSession(ledger, relPath, sessionId)
      && coversWindow(record.ranges, windowFor(input.offset, input.limit))) return 'A';
  // ---- Tiers B and C: `fresh` IS the right proof. ----
  // Their body claims the SKELETON matches the file on disk now, and the
  // skeleton was built from exactly the content contentHash names -- so
  // storeEntry.contentHash === fileStat.hash is precisely that claim, not a
  // borrowed interval. Unchanged.
  const fresh = !!(storeEntry && fileStat && storeEntry.contentHash && storeEntry.contentHash === fileStat.hash);
  if (!fresh) return null;
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
// estimateTokensFromLines (lib/token-estimate.js) prices a partial read the
// same way estimateTokens prices a full one -- both now count tokens against
// the same vendored vocabulary rather than against two different divisors.
// Exported so the hook can price a held-out read for its own log row (§7.2)
// without decide() ever having reached the point of computing it itself --
// the holdout gate fires before this in decide()'s own order.
//
// MINOR 1 (final whole-branch review): rounding on the no-limit branch --
// the per-line call was already a whole number, but a size-derived one is not
// whenever the division doesn't come out even, and that fractional remainder
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
// MINOR 2 (FIXED, measured-savings spec Tier 2): this used to be BYTES/4
// while estimateTokens was CHARS/4, so multibyte source (a file with
// non-ASCII identifiers or comments) priced callTokens higher than
// skeletonTokens would have priced the same text, biasing
// avoidedTokensOptimistic upward -- one side of the subtraction counted a
// unit the other side did not.
//
// Both sides now count TOKENS, against the same vendored vocabulary. The two
// callers that price a NO-LIMIT read without the file's content in hand
// (lib/mcp.js's recallTool, floor-checking off fs.statSync before it reads
// anything; lib/ledger-fold-recall-open-serves.js's correction pass, pricing
// a follow-up read via byteSizeOf precisely so a correction never costs a
// full read of a possibly-large, possibly-gone file) still get a
// size-derived number -- a stat cannot know a file's contents -- but it is
// now size / BYTES_PER_TOKEN, where BYTES_PER_TOKEN was MEASURED against
// this tokenizer on 4.51 MB of this repo's own source rather than assumed.
// The residual is that a byte-derived estimate cannot see how a specific
// file tokenizes; the systematic unit mismatch is gone.
//
// Still ONE formula for every caller, deliberately. lib/hooks-recall.js's
// PreToolUse hook already holds the file's content (it hashed it) and could
// now price its own no-limit calls exactly, for free -- and must not, because
// that would price the SAME quantity two different ways depending on which
// caller happens to hold the content, which is the exact drift
// lib/ledger-fold-recall-settle.js's header warns against ("pricing both
// sides of the formula with two different estimators would make net
// meaningless the moment they drift apart"). One formula everywhere remains
// the more honest tradeoff.
//
// CEILING (accuracy pass, 2026-07-29): a no-limit call is additionally capped
// at the token price of READ_TOOL_MAX_LINES lines -- Claude Code's Read tool
// returns at most ~2000 lines on a no-limit call, so pricing a bigger file by
// its whole size claims tokens the read would never have loaded. That was the
// one estimator bias pointing
// in the flattering direction (every other approximation here understates).
// The cap applies ONLY to the no-limit branch: an explicit `limit` is the
// caller's own stated call shape, not an inference, and is priced as given.
const READ_TOOL_MAX_LINES = 2000;
function estimateCallTokens(limit, fileStat) {
  if (limit) return estimateTokensFromLines(limit);
  const sizeTokens = estimateTokensFromBytes((fileStat && fileStat.size) || 0);
  return Math.min(sizeTokens, estimateTokensFromLines(READ_TOOL_MAX_LINES));
}

function decide(input) {
  const { relPath, sessionId, offset, limit, sessionState, storeEntry, fileStat, config } = input;

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
  // 2.6. Ranged reads are never intercepted, at any tier (dogfooding,
  // 2026-08-02). The ledger's fileReaders records that a session read a PATH;
  // it has never recorded WHICH LINES came back. Tier A's "this session
  // already read it" is therefore a claim the evidence cannot support the
  // moment a call names an offset: a read of lines 23510-23551 of a
  // 24000-line file, by a session that earlier read lines 9200-9319, is a
  // request for content that was never served. It was answered with the
  // pointer anyway, and the caller had to fall back to `sed` to get the
  // lines. Tier B is refused for the same reason -- a structural skeleton is
  // not the specific lines that were asked for.
  //
  // Only a POSITIVE offset counts as ranged. offset 0 and a bare `limit` both
  // start at the top of the file, which is what an unqualified read returns
  // anyway, so those stay interceptable and the §7.1 headline keeps every
  // serve it legitimately had.
  //
  // Fixing this properly (recording served ranges and comparing them) means
  // the ledger and the fold, which is far more than this narrow correctness
  // hole is worth: refusing is the honest floor, exactly as it is for a
  // non-Read tool above.
  if (typeof offset === 'number' && offset > 0) {
    return { serve: false, reason: 'ranged-read' };
  }
  // 3. Holdout -- CONTINUOUS, no date window (spec §7.2, rewritten
  // 2026-07-28): 3% of SESSIONS, chosen deterministically by hash(sessionId),
  // are never served, regardless of how old or new the project is. This used
  // to switch off after the project's first 14 days; it no longer has any
  // notion of "expiring". It also used to be 3% of READS -- see holdoutBucket
  // and lib/holdout-epoch.js for why that had to change and what it cost.
  if (holdoutBucket(sessionId) < HOLDOUT_PCT) {
    return { serve: false, reason: 'holdout' };
  }
  // 4. Already served this session -- never hand the session a second notice
  // about CONTENT IT HAS ALREADY BEEN TOLD ABOUT. `served` is
  // relPath -> the contentHash that was served, and the hash is the whole
  // point of storing it: repeating the same pointer for the same bytes is
  // noise, but once the file CHANGES, the earlier serve says nothing about
  // what is on disk now.
  //
  // Keyed on the path alone (as this was), one serve silenced the path for the
  // rest of the session, including reads of content that had never been
  // covered by any serve: session reads v1, is served the pointer, the file is
  // rewritten to v2, the session reads v2 and re-reads it -- the second read is
  // provably a repeat of content this session has seen, and was refused with
  // "already-served" on the strength of a notice about v1. That is the same
  // shape as Tier A borrowing the store's interval: a fact about one moment
  // used to answer a question about another.
  //
  // A missing fileStat leaves this gate open, which costs nothing: tierFor
  // requires fileStat for every tier, so such a call refuses at step 6 anyway.
  const servedHash = sessionState && sessionState.served ? sessionState.served[relPath] : undefined;
  if (servedHash !== undefined && fileStat && servedHash === fileStat.hash) {
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
    // Quote the hash Tier A actually PROVED: the content this session read,
    // which tierFor has just established still matches the file on disk. The
    // store's contentHash is a warm-time hash of possibly different content --
    // the very interval confusion REV-4 removed from the gate -- and on a store
    // MISS, now the common case for Tier A, there is no storeEntry to read at
    // all: this line used to throw a TypeError on the one path Tier A was
    // finally free to take, which the outer fail-open swallowed into silence.
    const hash8 = String((fileStat && fileStat.hash) || '').slice(0, 8);
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
  // holdoutBucket is exported so the cohort property can be ASSERTED rather
  // than re-derived: a test that reimplements the hash tests its own copy of
  // the algorithm, not this one, and would have kept passing through the
  // per-read-to-per-session change that made the cohort real.
  holdoutBucket,
  MIN_CALL_TOKENS, MIN_COMPRESSION, HOLDOUT_PCT, ANNOUNCE_TOKENS, REJECTION_LIMIT,
  // Which assignment scheme this build assigns under. Carried on every piece
  // of comparison evidence so evidence from an older scheme can never be
  // summed with this one -- see lib/holdout-epoch.js.
  HOLDOUT_EPOCH,
  // tierBBody is exported so a second caller with its own tiering (the MCP
  // recall tool, lib/mcp.js) can serve the exact "header + skeleton" wording
  // decide() serves for a Tier B hit, without duplicating the header string.
  // The MCP tool does its OWN freshness/floor checks (it has no session to
  // gate on -- see that module's own comment), so it composes this body
  // itself rather than calling decide().
  tierBBody,
  // The delivered-window helpers (REV-12) are exported for lib/hooks-recall.js,
  // which MAINTAINS the union it records on every read and pre-filters on it
  // before paying for a ledger parse. It must build and test coverage with the
  // exact functions tierFor decides with -- a second implementation hookside is
  // how the read-key fold drifted, and this is the same trap.
  windowFor, addWindow, coversWindow, readRecordOf,
  READ_TOOL_MAX_LINES, MAX_WINDOWS_PER_PATH,
};
