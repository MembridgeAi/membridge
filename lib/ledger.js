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

module.exports = { buildRequests };
