'use strict';
// estimateTokens(str): the ONLY token-estimation point in the codebase.
// 1 token ~= 4 characters. Every surface that reports tokens (serve policy,
// ledger fold, dashboard, diagnostics) must import this rather than
// reimplementing the heuristic — that keeps the estimate consistent even
// though it is deliberately coarse.
//
// It lives in its own module, rather than in lib/skeleton.js where it started,
// so the recall hot path (lib/recall.js, reached from the PreToolUse hook)
// can have it without requiring the tree-sitter extractor at all. That module
// only loads wasm lazily, so the old arrangement was not actually slow — but
// it left a binding startup-cost constraint resting on nobody ever adding a
// top-level require to it. This makes the separation structural. See the
// require-cache test in test/run-tests.js that pins it.
function estimateTokens(str) {
  return Math.ceil(String(str).length / 4);
}

module.exports = { estimateTokens };
