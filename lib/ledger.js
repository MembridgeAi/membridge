'use strict';
// Residence-weighted token ledger. Ported from the reference implementation in
// token-spend-analysis/ledger_fixed.py, which is the oracle for the
// equivalence test in the suite.
const pricing = require('./pricing');
const { normalizeUsage, providerOf } = require('./usage-normalize');

// Timestamps arrive as ISO strings of mixed precision -- some carry
// milliseconds, some don't (e.g. "...:00Z" vs "...:00.500Z"). Comparing them
// as plain strings misorders that pair: "." (0x2E) sorts before "Z" (0x5A),
// so the millisecond-bearing stamp can land BEFORE the second it's actually
// later than. Parse to epoch millis when both sides parse cleanly; fall back
// to string compare otherwise (covers the plain "t1"/"t2"-style fixtures used
// in tests). Exported so redundancy.js can share this instead of
// re-implementing it -- it's a pure, stateless comparator, so importing it
// adds no real coupling between the two modules.
function byTs(a, b) {
  const ta = Date.parse(a.ts);
  const tb = Date.parse(b.ts);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  return String(a.ts).localeCompare(String(b.ts));
}

// One API request is written to the transcript as several records -- one per
// content block -- each repeating the SAME usage object. Fold them back into a
// single request keyed on message id, or every request is counted as many
// times as it had content blocks (roughly 2x inflation).
function buildRequests(events) {
  const byKey = new Map();
  for (const e of events) {
    if (!e || e.kind !== 'usage' || !e.usage) continue;
    // Namespaced by session too: Codex token_count payloads never carry
    // turn_id in practice, so the adapter falls back to `timestamp#seq`
    // (unique only within the file it came from -- see adapters/codex.js).
    // Nothing guarantees two DIFFERENT sessions can't land on the same
    // fallback string by coincidence, so session guards the dedupe key here.
    // Claude Code's real message ids are already globally unique, so this
    // changes nothing for them.
    const key = `${e.sidechain ? 1 : 0}|${e.session || ''}|${e.messageId || e.ts}`;
    if (byKey.has(key)) continue;
    const provider = providerOf(e.source, e.model);
    const norm = normalizeUsage(e.usage, provider);
    const { inCost, outCost } = pricing.requestCostUsd(norm, e.model, provider);
    byKey.set(key, {
      messageId: e.messageId || null,
      ts: e.ts,
      session: e.session || null,
      model: e.model || null,
      provider,
      ctx: norm.context,
      out: norm.output,
      inCost,
      outCost,
      sidechain: !!e.sidechain,
    });
  }
  return Array.from(byKey.values()).sort(byTs);
}

// A context that shrinks means the window was compacted or reset. Growth is
// only meaningful within an epoch, so epochs are split at those boundaries.
const RESET_DROP_RATIO = 0.15;   // a fall of >15% of the previous context
const RESET_JUMP = 600000;       // or an implausible jump forward

// The ONE epoch-boundary rule, shared: streamEpochs below uses it to split
// volume epochs, and lib/ledger-fold-recall-ride.js uses it to stop ride-along
// accrual at a compaction (spec §7.5) -- the same physical event read off the
// same two request records, so it must be the same predicate, imported, not a
// second hand-rolled copy that drifts.
function epochReset(prev, cur) {
  const gap = cur.ctx - prev.ctx - prev.out;
  return gap < -RESET_DROP_RATIO * Math.max(prev.ctx, 1) || gap > RESET_JUMP;
}

// Runs the gap/reset check over one stream's requests, in stream order.
// `indices` lists the positions (into the shared `requests` array) that make
// up this stream, already in chronological order. Returns [firstIndex,
// lastIndex] epoch pairs using those SAME original-array indices.
function streamEpochs(requests, indices) {
  const epochs = [];
  if (!indices.length) return epochs;
  let start = 0; // position within `indices`, not into `requests`
  for (let k = 1; k < indices.length; k++) {
    const prev = requests[indices[k - 1]];
    const cur = requests[indices[k]];
    if (epochReset(prev, cur)) { epochs.push([indices[start], indices[k - 1]]); start = k; }
  }
  epochs.push([indices[start], indices[indices.length - 1]]);
  return epochs;
}

function sessionVolume(requests) {
  let volume = 0, inCost = 0, outCost = 0;
  for (const r of requests) {
    volume += r.ctx;
    inCost += r.inCost || 0;
    outCost += r.outCost || 0;
  }
  // The oracle (ledger_fixed.py ~L206-284) keys request streams on
  // bool(isSidechain) and epoch-splits each stream independently, so a
  // subagent's small context mid-stream never reads as a compaction/reset in
  // the main stream (and vice versa). Partition indices by stream, run the
  // existing gap/reset logic within each partition (in chronological order),
  // then emit epochs as [firstIndex, lastIndex] pairs into `requests`.
  // IMPORTANT: those ranges are contiguous only WITHIN their own stream --
  // an index belonging to the OTHER stream can fall numerically inside a
  // given [first, last] range, so callers must not treat the range as
  // "slice requests[first..last], all of it belongs to this epoch".
  const nonSideIdx = [], sideIdx = [];
  requests.forEach((r, i) => (r.sidechain ? sideIdx : nonSideIdx).push(i));
  const epochs = streamEpochs(requests, nonSideIdx).concat(streamEpochs(requests, sideIdx));
  // `epochs` has no consumer in the shipped pipeline yet: it is consumed by
  // the residence-weighting stage of the next plan, and is kept here (and in
  // this shape) to stay oracle-compatible with ledger_fixed.py.
  return { nRequests: requests.length, volume, inCost, outCost, epochs };
}

module.exports = { buildRequests, sessionVolume, byTs, epochReset };
