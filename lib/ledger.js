'use strict';
// Residence-weighted token ledger. Ported from the reference implementation in
// token-spend-analysis/ledger_fixed.py, which is the oracle for the
// equivalence test in the suite.
const pricing = require('./pricing');
const { normalizeUsage, providerOf } = require('./usage-normalize');

// One API request is written to the transcript as several records -- one per
// content block -- each repeating the SAME usage object. Fold them back into a
// single request keyed on message id, or every request is counted as many
// times as it had content blocks (roughly 2x inflation).
function buildRequests(events) {
  const byKey = new Map();
  for (const e of events) {
    if (!e || e.kind !== 'usage' || !e.usage) continue;
    const key = `${e.sidechain ? 1 : 0}|${e.messageId || e.ts}`;
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
  return Array.from(byKey.values()).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

// A context that shrinks means the window was compacted or reset. Growth is
// only meaningful within an epoch, so epochs are split at those boundaries.
const RESET_DROP_RATIO = 0.15;   // a fall of >15% of the previous context
const RESET_JUMP = 600000;       // or an implausible jump forward

function sessionVolume(requests) {
  let volume = 0, inCost = 0, outCost = 0;
  for (const r of requests) {
    volume += r.ctx;
    inCost += r.inCost || 0;
    outCost += r.outCost || 0;
  }
  const epochs = [];
  if (requests.length) {
    let start = 0;
    for (let i = 1; i < requests.length; i++) {
      const prev = requests[i - 1];
      const gap = requests[i].ctx - prev.ctx - prev.out;
      const reset = gap < -RESET_DROP_RATIO * Math.max(prev.ctx, 1) || gap > RESET_JUMP;
      if (reset) { epochs.push([start, i - 1]); start = i; }
    }
    epochs.push([start, requests.length - 1]);
  }
  return { nRequests: requests.length, volume, inCost, outCost, epochs };
}

module.exports = { buildRequests, sessionVolume };
