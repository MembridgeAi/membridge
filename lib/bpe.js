'use strict';
// Byte-pair encoding over a vendored vocabulary (vendor/tokenizer/claude-v1.json).
// This module exists to answer one question -- "how many tokens is this
// string" -- deterministically, with no network call, no native module and no
// wasm. It is the engine behind lib/token-estimate.js; nothing else should
// require it directly.
//
// WHY NOT A LIBRARY: the two credible pure-JS candidates ship every OpenAI
// encoding in one package (js-tiktoken 22 MB unpacked, gpt-tokenizer 53 MB),
// and MemBridge is a global npm install AND a signed Electron app -- both pay
// that in download size for one function. The vocabulary itself is 681 KB and
// the merge loop below is 60 lines, so vendoring the data and writing the loop
// costs a thirtieth of the disk. transformers.js (381 MB) and fastembed
// (234 MB) were measured by a sibling scout and are not in the running.
//
// CORRECTNESS: this loop is not "a BPE" -- it reproduces tiktoken's exact
// output for the vendored vocabulary. That equivalence is pinned by a fixture
// of reference counts in test/suites/token-estimate.test.js, generated from
// the tiktoken reference implementation, so a change here that quietly
// diverges fails the suite instead of silently re-pricing every token figure
// MemBridge reports.
//
// GOVERNING RULE (same as every recall module): nothing here may throw into a
// caller. countTokens returns null when the vocabulary is unavailable or
// unusable, and lib/token-estimate.js degrades to the old chars/4 heuristic
// and says so in tokenizerInfo(). A missing vocabulary must never break a
// hook, a sync pass, or a payload.
const fs = require('fs');
const path = require('path');

// Overridable for tests exactly the way lib/skeleton.js's MEMBRIDGE_GRAMMAR_DIR
// is: read once, at first load, so it behaves like a fixed vendoring location
// for the life of the process.
const VOCAB_PATH = process.env.MEMBRIDGE_TOKENIZER_VOCAB
  || path.join(__dirname, '..', 'vendor', 'tokenizer', 'claude-v1.json');

// A single regex match longer than this is chunked before merging. The merge
// loop is O(n^2) in the length of ONE piece, and the pre-tokenizer's
// `[^\s\p{L}\p{N}]+` branch can match arbitrarily long runs of punctuation --
// a minified bundle or a base64 blob is exactly that. 1024 bytes keeps the
// worst case near a millisecond; the cost is a handful of extra tokens at the
// chunk seams of pathological input, which is a far better failure than a
// hook that hangs. Ordinary source never reaches it: the longest piece in
// MemBridge's own lib/ is 47 bytes.
const MAX_PIECE_BYTES = 1024;

// Pieces repeat heavily in real text (every `const`, every `  `), so the
// per-piece count is memoized. Bounded because this module is long-lived in
// the daemon: at the cap the cache is dropped wholesale rather than evicted
// one entry at a time, which is the same cheap strategy lib/skeleton.js's
// grammar cache uses and costs one repopulation on a pathological corpus.
const PIECE_CACHE_CAP = 100000;

// undefined = not attempted yet (lazy), null = attempted and unavailable.
let vocab;

function loadVocab() {
  if (vocab !== undefined) return vocab;
  vocab = null;
  try {
    const raw = JSON.parse(fs.readFileSync(VOCAB_PATH, 'utf8'));
    if (!raw || typeof raw.bpe_ranks !== 'string' || typeof raw.pat_str !== 'string') return vocab;
    const ranks = new Map();
    // Upstream format (one line, but parsed line-wise because upstream's own
    // loader is): "<ignored> <rankOffset> <base64 token> <base64 token> ...",
    // with each token's rank being rankOffset + its index in the line.
    for (const line of raw.bpe_ranks.split('\n')) {
      if (!line) continue;
      const parts = line.split(' ');
      const offset = Number.parseInt(parts[1], 10);
      if (!Number.isFinite(offset)) continue;
      for (let i = 2; i < parts.length; i++) {
        // latin1 == "one JS char per byte", so a Map keyed on these strings is
        // a Map keyed on byte sequences. The vocabulary's tokens are raw byte
        // strings, not text, and must not be treated as UTF-8.
        ranks.set(Buffer.from(parts[i], 'base64').toString('latin1'), offset + (i - 2));
      }
    }
    if (ranks.size === 0) return vocab;
    vocab = { ranks, pattern: new RegExp(raw.pat_str, 'gu'), cache: new Map() };
  } catch {
    vocab = null; // unreadable, malformed, or a pat_str this engine can't compile
  }
  return vocab;
}

// Merge one piece down to its token count. `piece` is a latin1 byte string.
function countPiece(piece, ranks) {
  if (ranks.has(piece)) return 1; // the overwhelmingly common case: a whole word
  const n = piece.length;
  if (n <= 1) return n;
  // parts[i] is the start offset of part i; the final entry is the end
  // sentinel, so the token count is always parts.length - 1.
  const parts = new Array(n + 1);
  for (let i = 0; i <= n; i++) parts[i] = i;
  for (;;) {
    if (parts.length <= 2) break;
    let minRank = Infinity;
    let minIdx = -1;
    for (let i = 0; i < parts.length - 2; i++) {
      const r = ranks.get(piece.slice(parts[i], parts[i + 2]));
      if (r !== undefined && r < minRank) { minRank = r; minIdx = i; }
    }
    if (minIdx === -1) break; // no adjacent pair is in the vocabulary: done
    parts.splice(minIdx + 1, 1);
  }
  return parts.length - 1;
}

function countChunked(bytes, ranks, cache) {
  if (bytes.length <= MAX_PIECE_BYTES) {
    const hit = cache.get(bytes);
    if (hit !== undefined) return hit;
    const n = countPiece(bytes, ranks);
    if (cache.size >= PIECE_CACHE_CAP) cache.clear();
    cache.set(bytes, n);
    return n;
  }
  let total = 0;
  for (let i = 0; i < bytes.length; i += MAX_PIECE_BYTES) {
    total += countPiece(bytes.slice(i, i + MAX_PIECE_BYTES), ranks);
  }
  return total;
}

// The token count of `text`, or null when the vocabulary is unavailable.
// Never throws.
function countTokens(text) {
  const v = loadVocab();
  if (!v) return null;
  try {
    const s = String(text);
    if (!s) return 0;
    let total = 0;
    // exec-loop rather than String#match: a 1 MB file produces ~250k pieces,
    // and materialising them all as an array first is the difference between
    // a few MB of transient garbage and tens of MB.
    v.pattern.lastIndex = 0;
    let m;
    while ((m = v.pattern.exec(s)) !== null) {
      if (m[0] === '') { v.pattern.lastIndex++; continue; } // defensive: never spin
      total += countChunked(Buffer.from(m[0], 'utf8').toString('latin1'), v.ranks, v.cache);
    }
    return total;
  } catch {
    return null; // degrade to the caller's fallback rather than break a hook
  }
}

// Whether the vocabulary is usable, WITHOUT loading it if nothing has needed
// it yet -- lib/token-estimate.js's tokenizerInfo() reports the live state and
// must not itself be the thing that pays the load cost.
function vocabularyState() {
  if (vocab === undefined) return 'unloaded';
  return vocab ? 'loaded' : 'unavailable';
}

module.exports = {
  countTokens,
  vocabularyState,
  VOCAB_PATH,
  MAX_PIECE_BYTES,
  // Exported for the calibration suite only.
  _loadVocab: loadVocab,
  _resetForTests: () => { vocab = undefined; },
};
