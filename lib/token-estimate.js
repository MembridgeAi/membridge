'use strict';
// estimateTokens(str): the ONLY token-estimation point in the codebase.
// Every surface that reports tokens (serve policy, ledger fold, dashboard,
// diagnostics) must import this rather than reimplementing the heuristic --
// that keeps the estimate consistent everywhere.
//
// It lives in its own module, rather than in lib/skeleton.js where it started,
// so the recall hot path (lib/recall.js, reached from the PreToolUse hook)
// can have it without requiring the tree-sitter extractor at all. That module
// only loads wasm lazily, so the old arrangement was not actually slow -- but
// it left a binding startup-cost constraint resting on nobody ever adding a
// top-level require to it. This makes the separation structural. See the
// require-cache test in test/run-tests.js that pins it. Nothing above is
// imported here beyond Node builtins, for the same reason.
//
// WHAT CHANGED, AND WHY. This used to be `Math.ceil(str.length / 4)`. That is
// not merely coarse, it is BIASED, and it was the load-bearing number under
// every savings figure the product reports. Two concrete defects: it
// understates real source by roughly 8% (measured across this repo's own
// lib/*.js), and it understates multibyte source by three to four times,
// because one CJK character is one `length` unit but three UTF-8 bytes and
// typically one or more whole tokens. lib/recall.js documented the resulting
// bytes-versus-characters skew as a known, unfixed error. It is fixed here by
// running Anthropic's own published BPE instead of guessing.
//
// WHAT IT IS NOT. This is an approximation of the tokenizer Claude actually
// bills against, not that tokenizer. Exact counts require Anthropic's
// count-tokens endpoint, which needs a key and a network round trip, and is
// ruled out for a function on the recall hot path. What this buys is
// DETERMINISM and a much smaller error, not exactness, and no surface built
// on it may imply otherwise.
//
// THE VOCABULARY. vendor/tokenizer/claude-bpe.bin, re-encoded by
// scripts/build-tokenizer-vocab.js from claude.json as published in
// @anthropic-ai/tokenizer (MIT, Copyright 2023 Anthropic, PBC; the licence
// ships beside it). It is Anthropic's own BPE rather than an OpenAI one, it
// is 528 KB rather than the 22-53 MB the equivalent npm tokenizers unpack to,
// it needs no native build and no network at install time, and it is loaded
// LAZILY so an install that never estimates never pays for it.
//
// FAILURE IS NEVER FATAL. A missing, truncated or corrupt vocabulary falls
// back to exactly the old chars/4 behaviour and sets a degraded flag that the
// payload surfaces. This function is reached from a PreToolUse hook and from
// the sync pass, so it degrades rather than throwing, always.
const fs = require('fs');
const path = require('path');

const MAGIC = 'MBTK';
const VERSION = 1;

// Pieces longer than this are counted in chunks rather than merged whole. The
// merge below is quadratic in piece length, which is irrelevant for real
// pieces (the pretokenizer splits on word and whitespace boundaries, so they
// are tens of bytes) but not for a pathological one: the `\s+` branch happily
// matches a 50 KB run of spaces in a generated file, and merging that whole
// would stall the hook. Chunking slightly overcounts at the seams of inputs
// that are already degenerate, which is the right trade against a hang.
const MAX_PIECE_BYTES = 4096;

// Bounded memo of piece -> token count. Source code repeats its own
// identifiers and indentation constantly, so this is what makes tokenizing a
// whole file cheap. Bounded because the hook process is short-lived but the
// daemon's is not.
const MAX_CACHE = 100000;

const fallback = str => Math.ceil(String(str).length / 4);

// Parses the vendored binary. Exported so scripts/build-tokenizer-vocab.js
// can round-trip what it just wrote through the real reader and prove the
// ranks survive: a vocabulary that loads but decodes to different merges
// would never fail loudly, it would just be wrong forever.
//
// Layout: magic 'MBTK' | version u8 | patStr len u16 | patStr utf8 |
//         minRank u32 | count u32 | count x (len u16, token bytes)
// Ranks are implied by position, which is why the writer refuses to emit a
// vocabulary whose ranks are not contiguous.
function readVocabBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 15) throw new Error('vocabulary too short');
  if (buf.toString('ascii', 0, 4) !== MAGIC) throw new Error('vocabulary magic mismatch');
  const version = buf.readUInt8(4);
  if (version !== VERSION) throw new Error(`unsupported vocabulary version ${version}`);
  const patLen = buf.readUInt16LE(5);
  let o = 7;
  const patStr = buf.toString('utf8', o, o + patLen);
  o += patLen;
  const minRank = buf.readUInt32LE(o); o += 4;
  const count = buf.readUInt32LE(o); o += 4;
  if (!count) throw new Error('vocabulary is empty');
  const ranks = new Map();
  for (let i = 0; i < count; i++) {
    if (o + 2 > buf.length) throw new Error('vocabulary truncated');
    const len = buf.readUInt16LE(o); o += 2;
    if (o + len > buf.length) throw new Error('vocabulary truncated');
    // latin1 makes each BYTE one code unit, so a JS string is a faithful and
    // cheap key for a byte sequence. Never utf8 here: that would collapse
    // distinct byte sequences onto the same key.
    ranks.set(buf.toString('latin1', o, o + len), minRank + i);
    o += len;
  }
  return { patStr, ranks, minRank };
}

function vocabPath() {
  return process.env.MEMBRIDGE_TOKENIZER_VOCAB
    || path.join(__dirname, '..', 'vendor', 'tokenizer', 'claude-bpe.bin');
}

let state = null; // null until first use -- this is the lazy load

function loadVocab() {
  try {
    const { patStr, ranks } = readVocabBuffer(fs.readFileSync(vocabPath()));
    // 'u' for the \p{L}/\p{N} classes, 'g' to walk the whole input.
    return { ranks, pat: new RegExp(patStr, 'gu'), cache: new Map(), degraded: false };
  } catch {
    // Missing, truncated, corrupt, unreadable, or an unusable pat_str. Any of
    // them means chars/4 from here on, flagged, never an exception.
    return { ranks: null, pat: null, cache: null, degraded: true };
  }
}

function ensure() {
  if (!state) state = loadVocab();
  return state;
}

// Standard byte-pair merge: repeatedly join the adjacent pair with the lowest
// merge rank until no adjacent pair is in the vocabulary. Returns the number
// of tokens the piece collapses to; the token ids themselves are never needed.
function mergeCount(piece, ranks) {
  if (piece.length <= 1) return piece.length;
  const parts = piece.split('');
  while (parts.length > 1) {
    let bestRank = Infinity;
    let bestIdx = -1;
    for (let i = 0; i + 1 < parts.length; i++) {
      const r = ranks.get(parts[i] + parts[i + 1]);
      if (r !== undefined && r < bestRank) { bestRank = r; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    parts.splice(bestIdx, 2, parts[bestIdx] + parts[bestIdx + 1]);
  }
  return parts.length;
}

function countPiece(piece, st) {
  let n = st.cache.get(piece);
  if (n !== undefined) return n;
  if (piece.length <= MAX_PIECE_BYTES) {
    n = mergeCount(piece, st.ranks);
  } else {
    n = 0;
    for (let i = 0; i < piece.length; i += MAX_PIECE_BYTES) {
      n += mergeCount(piece.slice(i, i + MAX_PIECE_BYTES), st.ranks);
    }
  }
  if (st.cache.size < MAX_CACHE) st.cache.set(piece, n);
  return n;
}

function estimateTokens(str) {
  const st = ensure();
  if (st.degraded) return fallback(str);
  try {
    // NFKC first, matching the reference implementation in
    // @anthropic-ai/tokenizer: the vocabulary was built against normalised
    // text, so skipping this would mis-tokenize fullwidth and composed forms.
    const text = String(str).normalize('NFKC');
    let n = 0;
    let m;
    st.pat.lastIndex = 0;
    while ((m = st.pat.exec(text)) !== null) {
      // The pretokenizer yields characters; BPE operates on UTF-8 BYTES. This
      // conversion is the whole fix for the multibyte skew: one CJK character
      // becomes three byte-units here rather than one character-unit.
      n += countPiece(Buffer.from(m[0], 'utf8').toString('latin1'), st);
      if (m[0] === '') st.pat.lastIndex++; // a zero-width match would loop forever
    }
    return n;
  } catch {
    // Belt and braces: nothing above should throw, and if anything ever does
    // it must not do so inside a PreToolUse hook.
    return fallback(str);
  }
}

// Whether the count above is the BPE figure or the chars/4 fallback. The
// savings payload marks a degraded estimate rather than presenting a
// fallback number as though it were tokenized.
function estimateDegraded() {
  return ensure().degraded;
}

module.exports = { estimateTokens, estimateDegraded, readVocabBuffer };
