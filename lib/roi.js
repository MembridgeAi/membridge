'use strict';
// The controlled comparison: what one eligible read costs when recall serves
// it, versus what it costs when recall is withheld, and how sure we are.
//
// This module is pure arithmetic over the four-values-per-arm blocks the fold
// accumulates (lib/ledger-fold-state.js's normalizeComparison). It reads no
// files, no clock and no config, so every number it produces is reproducible
// from its inputs alone -- which is the point: an effect figure nobody can
// re-derive is a claim, not a measurement.
//
// WHAT IT MEASURES. Assignment is per SESSION (lib/recall.js's holdoutBucket:
// 3% of sessions are wholly withheld). The unit of comparison is the ELIGIBLE
// READ. Both halves are load-bearing and they are not the same choice: session
// size varies by far more than the effect does, so a per-session comparison
// over a 1-in-30 sample is dominated by which sessions happened to land in the
// holdout, while a per-read ASSIGNMENT would leave no cohort to compare at all
// because a session would be simultaneously served and withheld.
//
// WHAT IT DOES NOT MEASURE, and cannot:
//  * Tokens billed. Both arms are priced by lib/token-estimate.js, an
//    estimator. The difference of two estimates is an estimate. The only
//    measured token figures MemBridge has are the vendor-reported ones
//    (lib/usage-normalize.js) and they cannot be attributed to a single read.
//  * Whether the session went better. A withheld session still gets its
//    injected CLAUDE.md block and its MCP tools; only the recall serve is
//    withheld. This measures tokens, not outcomes, and nothing here supports a
//    claim about quality in either direction.
//  * Anything, before both thresholds are crossed. See the sufficiency gate.
const { HOLDOUT_EPOCH } = require('./holdout-epoch');
const { normalizeComparison, zeroArm } = require('./ledger-fold-state');

// Sufficiency gate, TWO thresholds, both of which must be crossed. One is not
// enough: the two arms fill at wildly different rates (the withheld arm is 3%
// of sessions, so the served arm crosses any threshold roughly thirty times
// sooner), and a served count in the thousands says nothing about whether the
// withheld arm carries enough reads to separate a difference from noise.
//
// 30 per arm, applied independently, is the conventional floor at which a
// sample mean's normal approximation is usable -- which is exactly what the
// interval below rests on. It matches MIN_HOLDOUT_FOR_EFFECT, the threshold
// lib/ledger-fold.js already uses for the same question, and follows the
// precedent set by lib/diagnostics.js's MIN_HOLDOUT_SKIPS, whose own comment
// gives the reasoning this gate exists for: "reporting a number here would
// look precise while being noise."
const MIN_SERVED_READS = 30;
const MIN_WITHHELD_READS = 30;

// Two-sided 95%. A normal quantile, not a t quantile: with n >= 30 in both
// arms the difference is immaterial next to the estimator error already in
// both inputs, and pretending otherwise would be false precision.
const Z_95 = 1.96;

// Sample mean and sample variance from an arm's (reads, tokens, tokensSq).
// This is why tokensSq is stored: pooled MEANS compose from sums and counts,
// but an interval needs a second moment, and there is no way to recover one
// from means after the fact.
function armStats(arm) {
  const n = arm.reads;
  if (n <= 0) return { n: 0, mean: 0, variance: 0 };
  const mean = arm.tokens / n;
  if (n < 2) return { n, mean, variance: 0 };
  // Var = (sum(x^2) - n*mean^2) / (n-1), clamped at 0: the algebraically
  // equivalent forms differ in floating point, and a variance of -1e-9 would
  // become NaN one Math.sqrt later.
  const variance = Math.max(0, (arm.tokensSq - (n * mean * mean)) / (n - 1));
  return { n, mean, variance };
}

// Sum arms elementwise. Pooling across projects on one machine is exactly this
// -- the sums and counts are what compose, which is the whole reason the fold
// stores sums and counts.
function addArms(a, b) {
  return {
    reads: a.reads + b.reads,
    tokens: a.tokens + b.tokens,
    tokensSq: a.tokensSq + b.tokensSq,
  };
}

// Pool a list of comparison blocks into one. Any block whose epoch is not this
// build's is DROPPED, not converted -- pooling is the one place where mixing
// would be silent and irreversible, so it refuses here as well as at the
// normalize boundary. Returns the pooled block plus how many inputs were
// dropped, so a caller can say so rather than quietly reporting less data than
// it was handed.
function poolComparisons(blocks) {
  let served = zeroArm();
  let withheld = zeroArm();
  let pooled = 0;
  let droppedForEpoch = 0;
  for (const raw of blocks || []) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.epoch !== HOLDOUT_EPOCH) { droppedForEpoch++; continue; }
    const c = normalizeComparison(raw);
    served = addArms(served, c.served);
    withheld = addArms(withheld, c.withheld);
    pooled++;
  }
  return { epoch: HOLDOUT_EPOCH, served, withheld, pooled, droppedForEpoch };
}

// The measurement block. `effect` is null until BOTH thresholds are crossed --
// null, never 0. A day-one install genuinely has no evidence, and rendering
// that as "0 tokens saved" is a measured claim made on no measurement, which
// is the single most discrediting thing this surface could do. Callers render
// the counts and the two thresholds instead; a null effect is never a zero.
function measurement(comparisonBlock) {
  const c = comparisonBlock && comparisonBlock.epoch === HOLDOUT_EPOCH
    ? normalizeComparison(comparisonBlock)
    : { epoch: HOLDOUT_EPOCH, served: zeroArm(), withheld: zeroArm() };
  const served = armStats(c.served);
  const withheld = armStats(c.withheld);
  const sufficient = served.n >= MIN_SERVED_READS && withheld.n >= MIN_WITHHELD_READS;

  const base = {
    epoch: HOLDOUT_EPOCH,
    state: sufficient ? 'sufficient' : 'measuring',
    servedReads: served.n,
    withheldReads: withheld.n,
    minServedReads: MIN_SERVED_READS,
    minWithheldReads: MIN_WITHHELD_READS,
    // Always an estimate, at every state, whatever the counts say. Both arms
    // are priced by an estimator; a controlled comparison of two estimates is
    // a controlled comparison of two estimates.
    kind: 'estimate',
    effect: null,
  };
  if (!sufficient) return base;

  // Welch: the arms have different sizes and, since one is priced on skeletons
  // and the other on whole reads, wildly different variances. Pooling their
  // variances would understate the interval on precisely the asymmetry that
  // defines the two arms.
  const diff = withheld.mean - served.mean; // tokens avoided per eligible read
  const se = Math.sqrt((served.variance / served.n) + (withheld.variance / withheld.n));
  const half = Z_95 * se;
  const round = n => Math.round(n * 100) / 100;
  return {
    ...base,
    effect: {
      tokensPerReadAvoided: round(diff),
      ci95: { low: round(diff - half), high: round(diff + half) },
      // An interval that straddles zero means this sample cannot tell the
      // difference from no effect. Surfaced as a field rather than left for a
      // reader to notice, because "the interval includes zero" is the single
      // most important thing about such a result and the easiest to skip over.
      significant: (diff - half) > 0 || (diff + half) < 0,
      servedMeanTokens: round(served.mean),
      withheldMeanTokens: round(withheld.mean),
      standardError: round(se),
    },
  };
}

// Pool, then measure -- the two-step every caller wants, kept as one call so
// nobody measures an unpooled block by accident or pools without dropping the
// wrong-epoch ones. The coverage counts ride along because a fleet or
// multi-project figure that does not say what it covers invites the reader to
// assume it covers everything.
function poolMeasurement(blocks) {
  const pooled = poolComparisons(blocks);
  return {
    ...measurement(pooled),
    projectsPooled: pooled.pooled,
    projectsDroppedForEpoch: pooled.droppedForEpoch,
  };
}

module.exports = {
  measurement,
  poolMeasurement,
  poolComparisons,
  armStats,
  addArms,
  MIN_SERVED_READS,
  MIN_WITHHELD_READS,
  Z_95,
};
