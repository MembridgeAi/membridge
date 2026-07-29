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
const correctionKeyFor = e => `${e.session || ''}|${e.toolUseId || e.ts}|${e.file}`;

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
// into 'negative' this pass (at most once per LOGICAL serve -- see
// `bumpedServeIds` below).
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
// strictly later than the serve's own ts (compared via lib/ledger.js's byTs,
// which parses to epoch millis first -- a raw string compare misorders
// mixed-precision ISO stamps, e.g. a millisecond-bearing read ts can sort
// BEFORE the whole-second serve ts it is actually later than, since '.'
// sorts before 'Z'), and not already applied (correctionKeyFor not yet in
// that serve's correctedBy). Multiple matching reads in one pass all apply,
// in order, and accumulate (spec: two follow-ups of 300 and 400 must net
// followTokens=700, not just the last one seen).
//
// `bumpedServeIds` guards a narrower, separate concern: a failed queue
// rewrite (lib/ledger-fold-recall.js's commit()) leaves a confirmed serve's
// rows on the queue, so the NEXT pass re-settles them into a SECOND open-serve
// record sharing the exact same serveId as the one already on record from the
// first (successful) settle -- an accepted, documented over-count (see that
// module's header: avoided.tokens/serves double, openServes carries both
// records). That duplication is harmless for tokens (both eventually get
// corrected or age out independently, and the number only ever needs to be
// "close enough, never lost"), but recall-store's rejection counter is a
// durable, hard-to-undo side effect -- one physical follow-up read must never
// bump it twice just because it happens to match two open-serve records that
// both trace back to the same real serve. Scoped for the whole call (not
// per-record), so the FIRST record sharing a serveId to cross into 'negative'
// this pass wins the bump and every later duplicate is silently skipped.
function applyCorrections(openServes, readEvents, projectPath, now) {
  const avoidedDelta = { tokens: 0, serves: 0, tierA: 0, tierB: 0, partialWins: 0, netNegatives: 0 };
  const rejections = [];
  const bumpedServeIds = new Set();
  const reads = (readEvents || []).filter(e => e && e.kind === 'read' && e.file);

  const nextOpenServes = [];
  for (const serve of openServes) {
    const ts = Date.parse(serve.ts);
    if (!Number.isFinite(ts) || (now - ts) >= OPEN_SERVE_TTL_MS) {
      continue; // expired: dropped, uncorrectable from here on -- "the number stands"
    }
    let current = serve;
    for (const e of reads) {
      if ((e.session || '') !== current.sessionId) continue;
      if (readKeyFor(projectPath, e.file) !== current.relPath) continue;
      if (byTs({ ts: e.ts }, { ts: current.ts }) <= 0) continue;
      const key = correctionKeyFor(e);
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
      moveBucket(avoidedDelta, current.classified, newClass);
      if (current.classified !== 'negative' && newClass === 'negative' && !bumpedServeIds.has(current.serveId)) {
        rejections.push(current.relPath); // at most once per LOGICAL serve this pass -- see bumpedServeIds above
        bumpedServeIds.add(current.serveId);
      }

      current = { ...current, netRecorded: newNet, classified: newClass, correctedBy: [...current.correctedBy, key] };
    }
    nextOpenServes.push(current);
  }

  return { openServes: nextOpenServes, avoidedDelta, rejections };
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
