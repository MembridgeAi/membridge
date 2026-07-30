'use strict';
// Ride-along accrual (spec §7.5, added 2026-07-29): the billed-impact side of
// direct avoidance. avoided.tokens counts what a serve kept out of context
// ONCE, but a real session re-sends its whole context on every subsequent
// request, so the tokens a serve kept out are kept out of every one of those
// requests too. billed.tokens = netRecorded x the session's OBSERVED
// subsequent requests -- measured off the same usage stream the ledger
// already folds (lib/ledger.js's buildRequests), never modelled from an
// average. Marco's direction (2026-07-29): the conservative once-only figure
// hid most of the real effect; this measures where the avoidance actually
// accrues. Still tokens, never dollars (spec §8.1), still "avoided" (§8.2).
//
// WHAT COUNTS: a non-sidechain request of the serve's OWN session with a ts
// after the serve's. A sidechain (subagent) request carries its own context,
// not this session's, so the avoided tokens were never in it. Counting stops
// -- permanently, `rideClosed` -- at the first context reset (compaction),
// detected with the SAME epoch rule lib/ledger.js's streamEpochs uses
// (epochReset, imported): once the window is compacted, the read's content
// would have been summarized away, so later requests would not have carried
// it either way and crediting them would fabricate accrual. The first
// counted request has no predecessor to compare against, so a compaction
// landing exactly between the serve and that first request is undetectable
// -- accepted, it can only overcount that one boundary case by one epoch.
//
// DEDUPE: the sliding events window re-presents the same usage events on
// every fold pass, so each receipt carries a FRONTIER -- the ts of the last
// counted request plus the request ids seen at exactly that ts (ties in
// mixed-precision stamps are real; ids disambiguate them, same concern as
// buildCorrectionKeys in lib/ledger-fold-recall-open-serves.js). A request
// at or before the frontier has already been counted. Before anything is
// counted the frontier is the serve's own ts, exclusive: a request stamped
// on the serve's exact millisecond is the one the serve interrupted, not a
// subsequent one.
//
// SETTLEMENT MATH: each pass, every receipt's billed figure is recomputed as
// netRecorded x rideRequests and the DELTA against what it last recorded
// (billedRecorded) is folded into ledger.billed.tokens. Running the
// recompute unconditionally -- not just when new requests were counted --
// is what keeps billed consistent with corrections: a follow-up read that
// revises netRecorded down retro-adjusts billed to newNet x rides on the
// same pass, and a serve that later crosses negative drags its billed
// figure negative with it (the skeleton AND the re-read rode along too).
// When a receipt expires or is evicted (lib/ledger-fold-recall-open-serves
// .js's TTL/FIFO), its last recorded figure stands -- the same "the number
// stands" contract corrections already accept.
const { buildRequests, byTs, epochReset } = require('./ledger');

// Ties share one exact timestamp; a handful of ids is plenty to tell them
// apart. Bounded so a pathological adapter stamping thousands of requests
// with one ts cannot grow a receipt without limit.
const FRONTIER_ID_CAP = 32;

const requestIdOf = r => String(r.messageId || r.ts);

// True when `r` is already behind the receipt's frontier (counted, or the
// serve's own pre-serve past). See the DEDUPE paragraph in the header.
function behindFrontier(r, serve) {
  const frontier = serve.rideFrontierTs || serve.ts;
  const cmp = byTs({ ts: r.ts }, { ts: frontier });
  if (cmp < 0) return true;
  if (cmp > 0) return false;
  // Exactly ON the frontier: before anything is counted that ts is the
  // serve's own stamp (exclusive -- skip); afterwards it is the last counted
  // request's ts, already-seen ids are skipped, a new tie still counts.
  if (!serve.rideFrontierTs) return true;
  return serve.rideFrontierIds.includes(requestIdOf(r));
}

// Count this pass's new ride-along requests onto one receipt. Pure on its
// inputs; returns the receipt unchanged (same reference) when nothing moved.
function rideReceipt(serve, sessionRequests) {
  if (serve.rideClosed || !sessionRequests || !sessionRequests.length) return serve;
  let { rideRequests, rideFrontierTs, rideFrontierIds, ridePrevCtx, ridePrevOut, rideClosed } = serve;
  let changed = false;
  for (const r of sessionRequests) {
    if (behindFrontier(r, { ...serve, rideFrontierTs, rideFrontierIds })) continue;
    if (ridePrevCtx !== null && epochReset({ ctx: ridePrevCtx, out: ridePrevOut }, { ctx: r.ctx })) {
      rideClosed = true;
      changed = true;
      break; // compacted: nothing after this boundary ever counts
    }
    rideRequests += 1;
    ridePrevCtx = r.ctx;
    ridePrevOut = r.out;
    const id = requestIdOf(r);
    if (rideFrontierTs && byTs({ ts: r.ts }, { ts: rideFrontierTs }) === 0) {
      rideFrontierIds = rideFrontierIds.concat([id]).slice(-FRONTIER_ID_CAP);
    } else {
      rideFrontierIds = [id];
    }
    rideFrontierTs = r.ts;
    changed = true;
  }
  if (!changed) return serve;
  return { ...serve, rideRequests, rideFrontierTs, rideFrontierIds, ridePrevCtx, ridePrevOut, rideClosed };
}

// The pass entry point lib/ledger-fold-recall.js calls after corrections:
// count new requests onto every open receipt, then recompute every receipt's
// billed figure (see SETTLEMENT MATH above). Returns the next openServes
// list plus the one billedDelta to fold into ledger.billed.tokens.
function applyRideAlong(openServes, events) {
  const requests = buildRequests(events || []).filter(r => !r.sidechain);
  const bySession = new Map();
  for (const r of requests) {
    const sid = r.session || '';
    const list = bySession.get(sid);
    if (list) list.push(r);
    else bySession.set(sid, [r]);
  }

  let billedDelta = 0;
  const next = [];
  for (const serve of openServes) {
    let cur = rideReceipt(serve, bySession.get(serve.sessionId));
    const billed = cur.netRecorded * cur.rideRequests;
    if (billed !== cur.billedRecorded) {
      billedDelta += billed - cur.billedRecorded;
      cur = { ...cur, billedRecorded: billed };
    }
    next.push(cur);
  }
  return { openServes: next, billedDelta };
}

module.exports = { applyRideAlong, FRONTIER_ID_CAP };
