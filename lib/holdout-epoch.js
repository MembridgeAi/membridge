'use strict';
// The holdout EPOCH: which assignment scheme a piece of holdout evidence was
// gathered under.
//
// This exists because the assignment scheme changed in a way that makes old
// evidence and new evidence non-comparable, and averaging them together would
// produce a number that looks like more data and is actually less.
//
//   Epoch 1 (until 2026-08-06): holdoutBucket hashed `sessionId + relPath`, so
//     the holdout was assigned PER READ. A single session was partly served
//     and partly withheld. There was no cohort -- the "withheld" arm was a
//     sample of reads drawn from sessions that were simultaneously being
//     served, so any within-session effect of having been served (an agent
//     that already got a skeleton reads differently afterwards) contaminated
//     both arms at once, in opposite directions.
//   Epoch 2 (from 2026-08-06): holdoutBucket hashes `sessionId` alone. A
//     session is wholly in or wholly out. Rate unchanged at 3%.
//
// The consequence, accepted explicitly by the owner: THE MEASUREMENT CLOCK
// RESTARTS. Epoch 1 evidence cannot be retro-fitted -- nothing recorded which
// side of a split session a read came from, and even if it had, the
// contamination is in the reads themselves, not in the bookkeeping. So epoch 1
// evidence is not migrated, not converted, and not counted. It is dropped from
// the comparison the first time a ledger is folded under epoch 2.
//
// "Dropped", not "kept and ignored", is deliberate. A retained old total is a
// number sitting in a file waiting for a future reader to sum it with the new
// one; lib/ledger-fold-state.js's normalizeComparison zeroes the whole block
// on an epoch mismatch, so there is no stale value left to mix in. The
// cumulative lifetime totals in `avoided`/`holdout` are NOT reset -- those are
// bookkeeping, they were never a controlled comparison, and nothing may derive
// an effect figure from them (lib/roi.js reads the comparison block alone).
//
// BUMP THIS whenever the assignment scheme, the eligible-read definition, or
// the unit the arms are priced in changes in a way that makes new evidence
// non-comparable with old. Changing the token ESTIMATOR is such a change: both
// arms are re-priced from the moment of the change, so the sums either side of
// it are in different units. Tier 2 (the BPE tokenizer) and Tier 3 (per-session
// assignment) landed together and share this bump.
const HOLDOUT_EPOCH = 2;

module.exports = { HOLDOUT_EPOCH };
