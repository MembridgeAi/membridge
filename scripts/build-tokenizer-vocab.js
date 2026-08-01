#!/usr/bin/env node
'use strict';
// Re-encodes Anthropic's published Claude BPE vocabulary into the compact
// binary lib/token-estimate.js loads at runtime.
//
// WHY A DERIVED FILE RATHER THAN THE PUBLISHED JSON. The source asset is
// claude.json from @anthropic-ai/tokenizer (MIT, Copyright 2023 Anthropic,
// PBC). It stores the merge ranks as one space-separated string of base64
// tokens, so loading it costs a JSON parse plus ~65k base64 decodes: measured
// at roughly 18-25 ms on this machine. lib/token-estimate.js sits on the
// PreToolUse recall hot path, whose whole module-load budget is about 11 ms,
// so that price is not payable. The same ranks in this format load in
// roughly 7 ms, because the token bytes are already bytes and the ranks are
// implied by position. The vocabulary itself is byte-for-byte the same set of
// merges; this script asserts that equivalence before writing.
//
// Regenerate with:
//   npm pack @anthropic-ai/tokenizer && tar xzf anthropic-ai-tokenizer-*.tgz
//   node scripts/build-tokenizer-vocab.js package/claude.json
//
// It is committed rather than fetched at install time on purpose: no network
// during `npm install`, and no build step, native or otherwise.
const fs = require('fs');
const path = require('path');

const MAGIC = 'MBTK';
const VERSION = 1;
const OUT = path.join(__dirname, '..', 'vendor', 'tokenizer', 'claude-bpe.bin');

// The published bpe_ranks string: newline-separated runs, each
// "<ignored> <startRank> <base64 token> <base64 token> ...", where the i-th
// token of a run has rank startRank + i. Same parse as the reference
// implementation in js-tiktoken's Tiktoken constructor.
function parseRanks(bpeRanks) {
  const out = [];
  for (const line of String(bpeRanks).split('\n')) {
    if (!line) continue;
    const parts = line.split(' ');
    const offset = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(offset)) throw new Error(`unparseable rank offset in run: ${parts[0]} ${parts[1]}`);
    for (let i = 2; i < parts.length; i++) out.push([offset + i - 2, Buffer.from(parts[i], 'base64')]);
  }
  return out;
}

function build(specPath) {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  if (typeof spec.pat_str !== 'string' || !spec.bpe_ranks) {
    throw new Error(`${specPath} does not look like a tiktoken vocabulary (no pat_str / bpe_ranks)`);
  }
  const entries = parseRanks(spec.bpe_ranks).sort((a, b) => a[0] - b[0]);
  if (!entries.length) throw new Error('vocabulary is empty');
  const minRank = entries[0][0];
  // Ranks must be a contiguous run, which is what lets this format drop them
  // and recover each from its index. Refuse to write a file whose ranks the
  // loader would then reconstruct incorrectly.
  entries.forEach(([rank], i) => {
    if (rank !== minRank + i) throw new Error(`ranks are not contiguous at index ${i} (got ${rank}, expected ${minRank + i})`);
  });

  const patStr = Buffer.from(spec.pat_str, 'utf8');
  const head = Buffer.alloc(4 + 1 + 2);
  head.write(MAGIC, 0, 'ascii');
  head.writeUInt8(VERSION, 4);
  head.writeUInt16LE(patStr.length, 5);
  const meta = Buffer.alloc(8);
  meta.writeUInt32LE(minRank, 0);
  meta.writeUInt32LE(entries.length, 4);

  const chunks = [head, patStr, meta];
  for (const [, bytes] of entries) {
    if (bytes.length > 0xffff) throw new Error(`token longer than the uint16 length prefix allows (${bytes.length})`);
    const len = Buffer.alloc(2);
    len.writeUInt16LE(bytes.length, 0);
    chunks.push(len, bytes);
  }
  return { buf: Buffer.concat(chunks), entries, patStr: spec.pat_str, minRank };
}

function main() {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error('usage: node scripts/build-tokenizer-vocab.js <path to claude.json>');
    process.exit(1);
  }
  const { buf, entries, patStr, minRank } = build(specPath);

  // Round-trip the file back through the runtime loader's own reader and
  // assert it reproduces the source ranks exactly. A vocabulary that loads
  // but decodes to different merges would not fail loudly at runtime, it
  // would just silently produce wrong token counts forever.
  const { readVocabBuffer } = require('../lib/token-estimate');
  const back = readVocabBuffer(buf);
  if (back.patStr !== patStr) throw new Error('round-trip mismatch: pat_str');
  if (back.ranks.size !== entries.length) throw new Error(`round-trip mismatch: ${back.ranks.size} vs ${entries.length} entries`);
  for (const [rank, bytes] of entries) {
    const got = back.ranks.get(bytes.toString('latin1'));
    if (got !== rank) throw new Error(`round-trip mismatch at rank ${rank}: got ${got}`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buf);
  console.log(`wrote ${path.relative(path.join(__dirname, '..'), OUT)}`);
  console.log(`  ${entries.length} merges, ranks ${minRank}..${minRank + entries.length - 1}`);
  console.log(`  ${(buf.length / 1024).toFixed(0)} KB (source ${(fs.statSync(specPath).size / 1024).toFixed(0)} KB)`);
}

if (require.main === module) main();
module.exports = { build, parseRanks };
