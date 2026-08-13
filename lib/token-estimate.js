'use strict';
// estimateTokens(str): the ONLY token-estimation point in the codebase.
// Every surface that reports tokens (serve policy, ledger fold, dashboard,
// diagnostics) must import this rather than reimplementing the heuristic --
// that keeps one number one number, everywhere.
//
// It lives in its own module, rather than in lib/skeleton.js where it started,
// so the recall hot path (lib/recall.js, reached from the PreToolUse hook)
// can have it without requiring the tree-sitter extractor at all. That module
// only loads wasm lazily, so the old arrangement was not actually slow -- but
// it left a binding startup-cost constraint resting on nobody ever adding a
// top-level require to it. This makes the separation structural. See the
// require-cache test in test/run-tests.js that pins it. lib/bpe.js, required
// below, holds that line: fs and path, nothing else, and it does not read the
// vocabulary off disk until a count is actually asked for.
//
// --- WHAT CHANGED (measured-savings spec, Tier 2) ---------------------------
// This used to be `Math.ceil(str.length / 4)` in full. It is now a real BPE
// tokenizer over a vendored vocabulary (see vendor/tokenizer/README.md), for
// two reasons the spec spells out:
//
//   1. chars/4 is not centred. Measured over 318 of this repo's own source
//      files (4.49 M chars), the real ratio is 3.62 chars per token, not 4.00.
//      chars/4 therefore UNDERSTATES a source file by 9.4% in aggregate, with
//      a per-file spread of -40.9% to +9.5% -- and the error is a function of
//      file type (CSS -25.0%, JSON -18.4%, Markdown -12.3%, TS -8.5%,
//      JS -6.8%, TSX -5.4%), so it does not cancel between two files.
//   2. It made the two sides of the avoidance formula incomparable.
//      estimateCallTokens priced a read in BYTES/4 while this priced the
//      skeleton in CHARS/4, an asymmetry recorded but unfixed at
//      lib/recall.js's own MINOR 2 note. Both sides now count tokens with the
//      same vocabulary, so their difference means something.
//
// It is STILL AN ESTIMATE, and the vocabulary is not Claude's current
// tokenizer -- exact counts need Anthropic's count-tokens endpoint, a key and
// a network call. Nothing derived from this function may be labelled
// "measured" on any surface. The only measured token figures MemBridge has
// are the vendor-reported ones in lib/usage-normalize.js. What Tier 2 buys is
// determinism and a smaller, quantified error; the calibration evidence lives
// in test/suites/token-estimate.test.js.
//
// AUTO-PAUSE AND REJECTION LEARNING are unchanged in mechanism and remain
// estimate-driven decisions, not reported figures (spec: "chars/4 still drives
// auto-pause and rejection learning"). Rejection learning counts rejections
// and never reads a token figure at all; the net-negative auto-pause reads the
// SIGN of a lifetime total plus a serve count (lib/diagnostics.js), neither of
// which is a scale-sensitive threshold. They are better fed by a centred
// estimator than a biased one, but they are not thereby measured, and no
// surface may say they are.
const bpe = require('./bpe');

// Single-session escape hatch, matching MEMBRIDGE_NO_RECALL / MEMBRIDGE_NO_DIAGNOSTICS.
// Set it and every count falls back to the old heuristic -- useful for
// bisecting a token figure, and it is the switch a user with a hard process
// startup budget can reach for.
const disabled = () => process.env.MEMBRIDGE_NO_BPE === '1';

// The pre-Tier-2 heuristic. Kept, exported and tested, because it is the
// fallback when the vocabulary cannot be loaded (spec's error handling:
// "fall back to the existing chars/4 and mark the estimate as degraded ...
// never throw into the recall hot path or the sync pass"), and because the
// calibration suite measures the new estimator against it.
function estimateTokensChars4(str) {
  return Math.ceil(String(str).length / 4);
}

let degradedReason = null;

function estimateTokens(str) {
  if (disabled()) return estimateTokensChars4(str);
  const n = bpe.countTokens(str);
  if (n === null) {
    degradedReason = 'vocabulary-unavailable';
    return estimateTokensChars4(str);
  }
  return n;
}

// --- pricing a read that is not in hand -------------------------------------
// Two callers must price a read WITHOUT its content: lib/mcp.js's recallTool
// (floor-checking off fs.statSync before it ever reads anything) and
// lib/ledger-fold-recall-open-serves.js's correction pass (which prices a
// follow-up read via a bare stat precisely so pricing a correction never costs
// a full read of a possibly-large, possibly-deleted file). Those cannot call
// estimateTokens, so they get the best constant available instead of an
// invented one.
//
// BYTES_PER_TOKEN and TOKENS_PER_LINE are both MEASURED against this
// tokenizer over this repo's lib/, ui/src/ and docs/ (318 files, 4.51 MB):
// 3.631 bytes per token and 13.88 tokens per line. The values that used to sit
// here were 4 and 12 -- inherited round numbers, each off in the same
// direction (understating a read by ~9% and ~14% respectively), which biased
// avoidance DOWNWARD on the call side and so understated what recall does.
// They are rounded to 3 significant figures deliberately: a constant carried
// to five decimals would imply a precision this corpus does not support.
//
// These stay estimates of the coarsest kind -- a stat knows a file's size, not
// its contents -- and a surface must never dress them as anything else.
const BYTES_PER_TOKEN = 3.63;
const TOKENS_PER_LINE = 13.9;

function estimateTokensFromBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n / BYTES_PER_TOKEN);
}

function estimateTokensFromLines(lines) {
  const n = Number(lines);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * TOKENS_PER_LINE);
}

// What a payload should say about the provenance of its token figures. Never
// loads the vocabulary itself -- it reports the live state, and asking about
// the tokenizer must not be the thing that pays for it.
function tokenizerInfo() {
  const state = disabled() ? 'disabled' : bpe.vocabularyState();
  const degraded = state === 'unavailable' || state === 'disabled';
  return {
    // "estimate", always. There is no value of this field that means measured.
    kind: 'estimate',
    method: degraded ? 'chars4' : 'bpe',
    vocabulary: degraded ? null : 'claude-v1',
    degraded,
    reason: degraded ? (state === 'disabled' ? 'disabled-by-env' : (degradedReason || 'vocabulary-unavailable')) : null,
  };
}

module.exports = {
  estimateTokens,
  estimateTokensChars4,
  estimateTokensFromBytes,
  estimateTokensFromLines,
  tokenizerInfo,
  BYTES_PER_TOKEN,
  TOKENS_PER_LINE,
};
