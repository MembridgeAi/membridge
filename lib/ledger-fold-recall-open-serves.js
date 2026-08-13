'use strict';
// Open-serve bookkeeping and the CORRECTION pass for revisable settlement
// (spec §7.1 revision, Task 6 fix round 2). Split out of
// lib/ledger-fold-recall.js/-settle.js purely to keep every module under the
// file-size budget -- this half owns "given the open serves on record and
// this pass's read events, which serves does new evidence correct, and what
// stays on record for next time". lib/ledger-fold-recall-settle.js owns
// pricing a single serve or read event; lib/ledger-fold-recall.js owns the
// queue file I/O and wires this module in.
//
// WHY a correction pass exists at all: lib/ledger-fold-recall-settle.js now
// settles every serve immediately, optimistically pricing followTokens as 0
// (see that module's header for the measured cost of the grace-window
// alternative this replaces). That optimism is sometimes wrong -- a
// same-session follow-up read of the served path, when it happens, can
// arrive seconds or hours later. An OPEN SERVE record is the compact,
// bounded receipt that makes the original serve findable again so a later
// read can correct it instead of the ledger just being wrong forever.
const { readKeyFor } = require('./ledger-fold');
const { byTs } = require('./ledger');
const { estimateReadTokens } = require('./ledger-fold-recall-settle');

// How long an open serve stays correctable. After this, "the number stands"
// -- a late follow-up is evidence the fold no longer has a receipt to apply
// it against, and is silently ignored (see boundOpenServes below). 24 hours
// comfortably covers the realistic tail of same-session re-reads (measured
// p95 gap: 154 minutes -- see ledger-fold-recall-settle.js's header) with
// wide margin, while still bounding how long one served path can keep
// revising a number that has long since been reported to the user.
const OPEN_SERVE_TTL_MS = 24 * 60 * 60 * 1000;

// Most open serves are corrected (or age out) within minutes to hours of
// being written, so the steady-state live set is far smaller than this --
// 2000 is sized as a generous multiple of SESSION_ID_CAP (the closest
// existing precedent for "how many distinct in-flight things a single
// project plausibly has open at once", lib/ledger-fold-state.js), not a
// measured serve rate. FIFO eviction (oldest first) trades a rare
// high-volume project's oldest still-open serves for boundedness -- an
// evicted serve simply stops being correctable early, exactly like a
// TTL-expired one; the accepted residual is the same "the number stands"
// contract, just triggered by volume instead of age.
const MAX_OPEN_SERVES = 2000;

// A stable identity for one settled serve, matching the same
// ts|sessionId|relPath key lib/ledger-fold-recall-settle.js's groupServeRows
// already uses to pair a pending row with its confirmation -- a serve is
// already uniquely identified by that triple.
const serveIdFor = pending => `${pending.ts}|${pending.sessionId}|${pending.relPath}`;

// Identity of ONE read event, for `correctedBy` -- mirrors the dedupe key
// lib/ledger-fold.js's foldReads uses for the exact same purpose (a read
// event may be re-presented across fold passes inside the sliding window,
// and must only ever correct a given open serve once).
//
// FINDING 4 (fix round 4): `toolUseId` isn't always present, and falling
// back to `e.ts` alone collapses two genuinely DISTINCT same-session,
// same-ts, same-file reads onto one key -- the second read's
// `correctedBy.includes(key)` then reads true though it was never applied,
// silently dropping its followTokens (measured: two 300/600-token follow-ups
// without toolUseId settle at 3530, not the honest 2930 -- one read never
// counts). Fixed by appending a per-(session|ts|file) OCCURRENCE INDEX when
// toolUseId is absent, so N identical-looking reads get N distinct keys --
// see buildCorrectionKeys for why `reads`' ordering makes that index stable.
function correctionKeyFor(e, occurrence) {
  if (e.toolUseId) return `${e.session || ''}|${e.toolUseId}|${e.file}`;
  return `${e.session || ''}|${e.ts}|${e.file}|${occurrence}`;
}

// Assigns each read in `reads` its correction key up front, index-aligned,
// so the SAME physical read gets the SAME key on every pass that still sees
// it -- required for both the dedupe (`correctedBy`) and the accumulation
// (each distinct follow-up applies exactly once) to be stable.
//
// STABILITY: `reads` is filtered from proj.events, which lib/digest.js's
// mergeEvents rebuilds by pushing newly-scanned events in transcript order
// and then calling `proj.events.sort(byTs)` (digest.js ~line 132/141).
// Array.prototype.sort has been STABLE in Node/V8 since Node 11 (an ES2019
// requirement), so events sharing an identical ts keep their push order
// after sorting -- and re-scanning the same transcript content always
// produces the same push order, so a given physical read's occurrence index
// is the same on every pass that still has it in `readEvents`.
function buildCorrectionKeys(reads) {
  const counts = new Map();
  return reads.map(e => {
    if (e.toolUseId) return correctionKeyFor(e);
    const base = `${e.session || ''}|${e.ts}|${e.file}`;
    const occurrence = counts.get(base) || 0;
    counts.set(base, occurrence + 1);
    return correctionKeyFor(e, occurrence);
  });
}

// followTokens===0 is always 'full', regardless of net's sign -- mirroring
// the pre-revision rule exactly (a serve with no follow-up in evidence is
// full avoidance, full stop; see lib/ledger-fold-recall-settle.js's
// settleRows). Only once a follow-up read is actually on record does a serve
// become 'partial' (net still >= 0) or 'negative' (net < 0).
function classify(net, followTokens) {
  if (followTokens <= 0) return 'full';
  return net < 0 ? 'negative' : 'partial';
}

// Clock-corruption clamp (fix round 3, mirroring lib/scan.js's
// SETTLE_TS_SANITY_MS clamp comment, ~line 103 there): a serve row's ts is
// operator/adapter-supplied, same as any other event ts, so nothing stops a
// garbled clock from stamping one in the future. Left unclamped, TWO things
// break at once: (1) OPEN_SERVE_TTL_MS's age check (now - ts) goes negative
// and never crosses the TTL, so the receipt never ages out no matter how much
// REAL wall-clock time passes -- immortal, not just long-lived; (2) every
// genuine follow-up read looks like it happened BEFORE the serve (a real
// read's ts can never exceed a corrupt future stamp), so the receipt is also
// permanently uncorrectable. Recording the clamped value directly into the
// receipt's own `ts` field (rather than re-clamping on every read the way
// scan.js's ceiling check does) fixes both: the stored ts is anchored to a
// real moment, so age grows normally from here and a real follow-up read can
// exceed it. `now` is the same clock settleRows() was already handed for
// this pass -- no extra I/O.
function clampFutureTs(ts, now) {
  const parsed = Date.parse(ts);
  if (Number.isFinite(parsed) && Number.isFinite(now) && parsed > now) return new Date(now).toISOString();
  return ts;
}

// Compact record for one settled serve, built the moment it settles
// (followTokens=0, so netRecorded === net and classified === 'full').
// `serveId` is derived from the pending row's OWN (unclamped) ts -- it must
// keep matching groupServeRows' pending/confirmation key -- only the `ts`
// FIELD used for aging/ordering is clamped.
function buildOpenServe(pending, net, now) {
  return {
    serveId: serveIdFor(pending),
    ts: clampFutureTs(pending.ts, now),
    sessionId: pending.sessionId,
    relPath: pending.relPath,
    callTokens: pending.callTokens,
    skeletonTokens: pending.skeletonTokens,
    netRecorded: net,
    classified: classify(net, 0),
    correctedBy: [],
    // Ride-along accrual (spec §7.5) -- see lib/ledger-fold-recall-ride.js
    // for what each field means and why the frontier is the dedupe evidence.
    rideRequests: 0,
    rideFrontierTs: null,
    rideFrontierIds: [],
    ridePrevCtx: null,
    ridePrevOut: 0,
    rideClosed: false,
    billedRecorded: 0,
  };
}

// The ledger field a classification bucket lives in -- 'full' has none (see
// classify's header): avoided.serves already counts it, and there is no
// separate "full-win" counter to move in or out of.
function bucketField(classification) {
  if (classification === 'partial') return 'partialWins';
  if (classification === 'negative') return 'netNegatives';
  return null;
}

// Fold one classification transition into a running avoidedDelta: decrement
// the OLD bucket, increment the NEW one. A no-op when the classification
// doesn't change (the overwhelmingly common case: a correction that doesn't
// cross a boundary, or none at all).
function moveBucket(avoidedDelta, oldClass, newClass) {
  if (oldClass === newClass) return;
  const oldField = bucketField(oldClass);
  const newField = bucketField(newClass);
  if (oldField) avoidedDelta[oldField] -= 1;
  if (newField) avoidedDelta[newField] += 1;
}

// Apply every eligible read event in `readEvents` (proj.events, already in
// hand) to `openServes` (this project's on-record receipts, TTL-expired ones
// already excluded by the caller is NOT assumed -- expiry is checked here,
// per-record, so a stale record is dropped and never corrected against, "the
// number stands"). Returns the next openServes list (TTL-expired records
// dropped, everything else carried forward, corrected or not) plus the
// avoidedDelta the corrections earned and the relPaths that newly crossed
// into 'negative' this pass.
//
// EVICTION RESIDUAL (fix round 3, documented not further engineered):
// `readEvents` is whatever proj.events looks like THIS pass, and
// lib/digest.js's mergeEvents caps that array (maxPlumbingEvents, shared
// between 'usage' and 'read' events) BEFORE lib/scan.js's syncOnce calls
// updateLedger -- in the SAME tick, not a later one. So a read only needs to
// survive from the moment it is scanned to the very next merge's cap, and in
// steady-state operation (one fold per tick, a read's own ts is ~"now" at
// scan time) it is essentially always among the most-recent-by-ts plumbing
// events and is never at risk. The real exposure is narrower than "more than
// maxPlumbingEvents events arrive within one tick interval" might suggest:
// because the cap is applied to the FULL accumulated window on every merge,
// not to a per-tick delta, a read can only be evicted before any fold ever
// sees it if, at the moment it is merged in, at least maxPlumbingEvents OTHER
// plumbing events with a LATER ts already exist for the project -- which
// requires either catching up a large backlog in one tick (the daemon was
// off for a while and syncOnce processes everything at once) or an extreme
// same-tick burst of usage events from a concurrently-scanned session dated
// after this read. Once a correction DOES land, it is permanent regardless
// of what happens to proj.events afterward: the delta is folded into
// st.avoided and the read's key is recorded in correctedBy directly in
// ledger.json, neither of which is re-derived from proj.events on a later
// pass -- so a since-evicted read can neither un-correct (nothing re-reads
// proj.events to undo it) nor re-correct (correctedBy still remembers it,
// even though the read that earned that entry is long gone from the window).
//
// A read corrects a serve when: same session, same CANONICAL path (via
// readKeyFor -- must match the exact identity lib/ledger-fold.js's own
// fileReaders uses, or a follow-up would never find the serve it corrects),
// AT OR AFTER the serve's own ts (compared via lib/ledger.js's byTs, which
// parses to epoch millis first -- a raw string compare misorders
// mixed-precision ISO stamps, e.g. a millisecond-bearing read ts can sort
// BEFORE the whole-second serve ts it is actually later than, since '.'
// sorts before 'Z'), and not already applied (correctionKeyFor not yet in
// that serve's correctedBy). Multiple matching reads in one pass all apply,
// in order, and accumulate (spec: two follow-ups of 300 and 400 must net
// followTokens=700, not just the last one seen).
//
// FINDING 5 (fix round 4): a tie (byTs === 0, read.ts and serve.ts parse to
// the identical epoch millisecond) used to be excluded (`<= 0`) on the theory
// that it might be the serve's OWN intercepted read echoing back into
// proj.events. Verified against lib/adapters/claude-code.js + the hook flow
// and that theory doesn't hold up as a reason to keep `<=`: a PreToolUse hook
// fires only after the model has already generated the tool_use (a hook
// can't un-happen a turn the transcript already recorded), so even if that
// intercepted call's own entry does end up as a 'read' event -- the adapter
// has no notion of "denied" and would emit one the same as any other -- its
// ts is the EARLIER, pre-hook transcript timestamp. The serve's own ts is
// stamped afterward, by hooks-recall.js's OWN later `new Date().toISOString()`
// call. Two separate, sequential `new Date()` reads are always strictly
// ordered, so that pair's byTs is always negative, never zero -- a tie can
// only happen between a millisecond-precision serve.ts and a SEPARATE, later,
// second-precision adapter read.ts that floors onto the same whole second: a
// real follow-up, wrongly excluded in the overstatement direction. Changed to
// `< 0` so a tie counts as a follow-up.
// C3 MIRROR (accuracy pass, 2026-07-29): the serve side already refuses to
// answer a Grep/Glob as though the whole file had been read (lib/recall.js's
// non-read-tool gate, C3), but this pass still priced a follow-up Grep at
// full file size via estimateReadTokens' no-limit branch -- a grep returning
// three lines clawed back thousands of tokens, understating net AND able to
// cross a healthy serve into 'negative', burning a rejection strike toward
// permanently disabling recall on exactly the hot paths it was serving well.
// Only a content-bearing read (Read, NotebookRead) may correct a serve. An
// event with NO tool field predates the adapter stamping one -- treated as
// content-bearing so old data keeps correcting exactly as it always did.
const CONTENT_BEARING_TOOLS = new Set(['Read', 'NotebookRead']);
const isContentBearingRead = e => !e.tool || CONTENT_BEARING_TOOLS.has(e.tool);

function applyCorrections(openServes, readEvents, projectPath, now) {
  const avoidedDelta = { tokens: 0, serves: 0, tierA: 0, tierB: 0, tierUnknown: 0, partialWins: 0, netNegatives: 0 };
  // Corrections move the SERVED arm of the controlled comparison too, and it
  // matters that they do: a follow-up read is token spend that a served
  // session incurred and a withheld one did not. Leaving it out would price
  // the served arm at its optimistic cost while the withheld arm is priced at
  // what actually happened -- flattering exactly the side this measurement
  // exists to be sceptical about. `reads` does not move: the eligible read was
  // already counted when it settled, and a correction revises its price rather
  // than adding another read.
  const comparisonDelta = { served: { reads: 0, tokens: 0, tokensSq: 0 }, withheld: { reads: 0, tokens: 0, tokensSq: 0 } };
  const rejections = [];
  const reads = (readEvents || []).filter(e => e && e.kind === 'read' && e.file && isContentBearingRead(e));
  // See buildCorrectionKeys' own header for why this index-aligned,
  // precomputed-once array is what makes a toolUseId-less read's key stable
  // across passes (FINDING 4).
  const keys = buildCorrectionKeys(reads);

  const nextOpenServes = [];
  for (const serve of openServes) {
    const ts = Date.parse(serve.ts);
    if (!Number.isFinite(ts) || (now - ts) >= OPEN_SERVE_TTL_MS) {
      continue; // expired: dropped, uncorrectable from here on -- "the number stands"
    }
    let current = serve;
    for (let ri = 0; ri < reads.length; ri++) {
      const e = reads[ri];
      if ((e.session || '') !== current.sessionId) continue;
      if (readKeyFor(projectPath, e.file) !== current.relPath) continue;
      if (byTs({ ts: e.ts }, { ts: current.ts }) < 0) continue;
      const key = keys[ri];
      if (current.correctedBy.includes(key)) continue;

      // followTokens so far = what the original callTokens/skeletonTokens/
      // netRecorded triple already implies, plus this one read's own price
      // -- reconstructing the running total from netRecorded rather than
      // storing it separately keeps the record shape to exactly what spec
      // §7.1's design calls for.
      const followTokensSoFar = (current.callTokens - current.skeletonTokens - current.netRecorded)
        + estimateReadTokens(e, projectPath, current.relPath);
      const newNet = current.callTokens - current.skeletonTokens - followTokensSoFar;
      const newClass = classify(newNet, followTokensSoFar);

      avoidedDelta.tokens += newNet - current.netRecorded;
      // Same serve, re-priced: cost = callTokens - net, so the arm's running
      // sum and sum-of-squares are adjusted by the difference between the old
      // and new cost rather than by appending a second entry for one read.
      const oldCost = current.callTokens - current.netRecorded;
      const newCost = current.callTokens - newNet;
      comparisonDelta.served.tokens += newCost - oldCost;
      comparisonDelta.served.tokensSq += (newCost * newCost) - (oldCost * oldCost);
      moveBucket(avoidedDelta, current.classified, newClass);
      // No per-call dedupe guard needed here (fix round 4): settleRows is now
      // idempotent on serveId (lib/ledger-fold-recall-settle.js), so
      // `openServes` can never carry two records for the same physical
      // serve -- every serveId appears at most once per call, and this bump
      // fires at most once per LOGICAL serve for exactly that reason.
      if (current.classified !== 'negative' && newClass === 'negative') {
        rejections.push(current.relPath);
      }

      current = { ...current, netRecorded: newNet, classified: newClass, correctedBy: [...current.correctedBy, key] };
    }
    nextOpenServes.push(current);
  }

  return { openServes: nextOpenServes, avoidedDelta, comparisonDelta, rejections };
}

// FIFO cap: oldest (earliest-inserted) open serves are dropped first once
// the list exceeds MAX_OPEN_SERVES. Called after merging in this pass's
// newly-settled serves and running corrections, so the most recently settled
// (and therefore most likely to still be correctable) serves are always the
// ones kept.
function capOpenServes(list) {
  if (list.length <= MAX_OPEN_SERVES) return list;
  return list.slice(list.length - MAX_OPEN_SERVES);
}

module.exports = {
  buildOpenServe, applyCorrections, capOpenServes, classify,
  OPEN_SERVE_TTL_MS, MAX_OPEN_SERVES,
};
