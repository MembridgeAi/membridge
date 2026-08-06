#!/usr/bin/env node
// REV-11: is a ranged repeat read actually redundant, and could it be proved?
//
// decide() refuses every read with offset > 0, at every tier. That gate is the
// dominant constraint on the whole mechanism -- REV-10 measured 380 of 392
// same-session repeat reads refused by it -- so the question is whether it
// could be narrowed honestly. Two things have to be true before any design:
//
//   1. THE READ MUST ACTUALLY BE REDUNDANT. An agent re-reading a DIFFERENT
//      window of an unchanged file is doing new work, not repeat work. Only a
//      re-read of content the session already received is redundant. So the
//      ceiling is not "ranged repeats" -- it is the subset asking for lines
//      this session has already been given.
//
//   2. IT MUST BE PROVABLE. The hook sees offset/limit at the read, so it can
//      RECORD a window; it cannot prove the read happened (PreToolUse runs
//      first). Today the ledger supplies that proof, and the ledger has no
//      ranges. The only other source is the session transcript, which carries
//      both the range and the tool_result -- but only if the earlier read is
//      close enough to the tail to be read cheaply. That distance is measured
//      here too, because it is what prices the mechanism.
//
// COVERAGE MODEL. Claude Code's Read returns `limit` lines from `offset`
// (1-based), and at most READ_TOOL_MAX_LINES without one. So a call covers
// [offset, offset + limit - 1]. Each repeat is classified against the UNION of
// what the session was already handed for that path:
//
//   same-window  exact (offset, limit) as an earlier read   -- strongest claim
//   contained    inside the union, not an exact match       -- needs range math
//   overlap      partially inside                           -- not redundant
//   disjoint     nothing in common                          -- new work
//
// Usage: node scripts/measure-ranged-repeats.js [projectPath]
// Read-only. Never writes to a ledger, a project, or the daemon.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const repoRoot = require('../lib/repo-root');

const PROJECT = path.resolve(process.argv[2] || '/Users/marco/Documents/Membridge');
const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const READ_TOOL_MAX_LINES = 2000; // lib/recall.js's own constant

const root = path.join(os.homedir(), '.claude', 'projects');
const prefix = PROJECT.replace(/[/.]/g, '-');
let dirs;
try {
  dirs = fs.readdirSync(root).filter(d => d === prefix || d.startsWith(`${prefix}-`));
} catch { dirs = []; }
if (!dirs.length) {
  console.error(`no transcripts for ${PROJECT}`);
  process.exit(1);
}

const reads = [];
const edits = [];
let files = 0;
for (const d of dirs) {
  const dir = path.join(root, d);
  let names;
  try { names = fs.readdirSync(dir); } catch { continue; }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    files++;
    let raw;
    try { raw = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    // Byte offset of each line, so "how far back in the transcript is the
    // earlier read" can be answered in the unit that actually prices a tail
    // read: bytes, not events.
    let byteOffset = 0;
    for (const line of raw.split('\n')) {
      const at = byteOffset;
      byteOffset += Buffer.byteLength(line, 'utf8') + 1;
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
      const session = typeof e.sessionId === 'string' && e.sessionId ? e.sessionId : name.replace(/\.jsonl$/, '');
      const ts = Date.parse(e.timestamp);
      for (const c of e.message.content) {
        if (!c || c.type !== 'tool_use' || !c.input) continue;
        const file = c.input.file_path || c.input.notebook_path || c.input.path || null;
        if (!file) continue;
        const key = repoRoot.ledgerKeyFor(PROJECT, file);
        if (!key) continue;
        if (READ_TOOLS.has(c.name)) {
          const offset = typeof c.input.offset === 'number' && c.input.offset > 0 ? c.input.offset : 1;
          const limit = typeof c.input.limit === 'number' && c.input.limit > 0 ? c.input.limit : READ_TOOL_MAX_LINES;
          reads.push({
            session, key, ts, at, transcript: `${d}/${name}`,
            ranged: typeof c.input.offset === 'number' && c.input.offset > 0,
            explicitLimit: typeof c.input.limit === 'number' ? c.input.limit : null,
            lo: offset, hi: offset + limit - 1,
          });
        } else if (EDIT_TOOLS.has(c.name)) {
          edits.push({ key, ts });
        }
      }
    }
  }
}

const editsByKey = new Map();
for (const e of edits) {
  if (!editsByKey.has(e.key)) editsByKey.set(e.key, []);
  editsByKey.get(e.key).push(e.ts);
}
const editedBetween = (key, a, b) => (editsByKey.get(key) || []).some(t => t > a && t <= b);

const groups = new Map();
for (const r of reads) {
  const k = `${r.session}::${r.key}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

// Union of already-delivered line ranges, as a sorted disjoint list.
const addRange = (union, lo, hi) => {
  const out = [];
  let [a, b] = [lo, hi];
  for (const [x, y] of union) {
    if (y < a - 1) out.push([x, y]);
    else if (x > b + 1) { out.push([a, b]); out.push([x, y]); a = null; }
    else { a = Math.min(a, x); b = Math.max(b, y); }
    if (a === null) { // already flushed; copy the rest
      const rest = union.slice(union.indexOf([x, y]) + 1);
      for (const r of rest) out.push(r);
      break;
    }
  }
  if (a !== null) out.push([a, b]);
  return out.sort((p, q) => p[0] - q[0]);
};
const coveredBy = (union, lo, hi) => {
  let cursor = lo;
  for (const [x, y] of union) {
    if (y < cursor) continue;
    if (x > cursor) return false;
    cursor = y + 1;
    if (cursor > hi) return true;
  }
  return cursor > hi;
};
const intersects = (union, lo, hi) => union.some(([x, y]) => x <= hi && y >= lo);

// The prize, in the only unit that decides whether this is worth building:
// tokens the agent would not have loaded. Priced exactly as
// lib/recall.js's estimateCallTokens does -- limit * 12 for a call that names
// one, else size/4 capped at the Read tool's own 2000-line ceiling.
const callTokens = r => (r.explicitLimit ? r.explicitLimit * 12 : Math.min(READ_TOOL_MAX_LINES, r.hi - r.lo + 1) * 12);
let unlockableTokens = 0, alreadyServableTokens = 0, allReadTokens = 0;

const buckets = { sameWindow: 0, contained: 0, overlap: 0, disjoint: 0 };
const bucketsUnchanged = { sameWindow: 0, contained: 0, overlap: 0, disjoint: 0 };
const distances = [];       // bytes back to the matching earlier read
let crossFile = 0;
let repeats = 0, rangedRepeats = 0, firstReads = 0;
let nonRangedRedundant = 0;
// Today's Tier A refuses on the INCOMING call's range but knows nothing about
// the range of the EVIDENCE. A session that was handed lines 5000-5100 and
// then issues an unranged read is told "this session already read <path>" --
// true of the path, false of the content it holds. Counted here because it is
// a live claim, not a hypothetical.
let falseTodayCount = 0, falseTodayTokens = 0;
const falseExamples = [];

for (const list of groups.values()) {
  list.sort((a, b) => a.ts - b.ts || a.at - b.at);
  firstReads++;
  let union = [];
  const seenWindows = new Map(); // "lo:hi" -> last read record
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (i > 0) {
      repeats++;
      if (r.ranged) rangedRepeats++;
      const key = `${r.lo}:${r.hi}`;
      const exact = seenWindows.get(key);
      const kind = exact ? 'sameWindow'
        : coveredBy(union, r.lo, r.hi) ? 'contained'
          : intersects(union, r.lo, r.hi) ? 'overlap' : 'disjoint';
      buckets[kind]++;
      const unchanged = !editedBetween(r.key, list[i - 1].ts, r.ts);
      if (unchanged) {
        bucketsUnchanged[kind]++;
        if (!r.ranged && (kind === 'overlap' || kind === 'disjoint')) {
          falseTodayCount++;
          falseTodayTokens += callTokens(r);
          if (falseExamples.length < 4) {
            falseExamples.push(`${r.key}: this call wants [${r.lo}-${r.hi}], the session was handed `
              + `${union.map(([x, y]) => `[${x}-${y}]`).join(' ') || '(nothing)'}`);
          }
        }
        if (kind === 'sameWindow' || kind === 'contained') {
          if (r.ranged) unlockableTokens += callTokens(r);
          else { nonRangedRedundant++; alreadyServableTokens += callTokens(r); }
        }
      }
      if (exact) {
        if (exact.transcript !== r.transcript) crossFile++;
        else distances.push(r.at - exact.at);
      }
    }
    allReadTokens += callTokens(r);
    union = addRange(union, r.lo, r.hi);
    seenWindows.set(`${r.lo}:${r.hi}`, r);
  }
}

const pct = (list, p) => {
  if (!list.length) return NaN;
  const s = list.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const kb = n => (Number.isFinite(n) ? `${(n / 1024).toFixed(0)}KB` : 'n/a');
const share = (n, d) => `${((100 * n) / (d || 1)).toFixed(1)}%`;

console.log(`project   ${PROJECT}`);
console.log(`sources   ${dirs.length} transcript director${dirs.length === 1 ? 'y' : 'ies'}, ${files} files`);
console.log(`reads     ${reads.length} in-project, ${groups.size} (session, path) pairs, ${repeats} repeat reads (${rangedRepeats} ranged)\n`);

console.log('every repeat read, against what the session had ALREADY been handed for that path:');
const rows = [['same window (exact offset+limit)', 'sameWindow'], ['contained in earlier reads', 'contained'],
  ['partial overlap', 'overlap'], ['disjoint — genuinely new lines', 'disjoint']];
for (const [label, k] of rows) {
  console.log(`  ${label.padEnd(34)} ${String(buckets[k]).padStart(4)}  ${share(buckets[k], repeats).padStart(6)}`
    + `   unchanged since: ${String(bucketsUnchanged[k]).padStart(4)}`);
}

const redundant = bucketsUnchanged.sameWindow + bucketsUnchanged.contained;
console.log(`\nREDUNDANT and unchanged (same window + contained)   ${redundant}  of ${repeats} repeats  ${share(redundant, repeats)}`);
console.log(`  ...already servable today (not ranged)            ${nonRangedRedundant}`);
console.log(`  ...unlocked only by narrowing the ranged gate     ${redundant - nonRangedRedundant}`);
console.log(`NOT redundant (overlap + disjoint), unchanged       ${bucketsUnchanged.overlap + bucketsUnchanged.disjoint}`
  + '   <- an agent asking for lines it was never given');

console.log(`\nthe prize, priced with recall.js's own estimateCallTokens:`);
console.log(`  tokens across every in-project read measured here      ${allReadTokens.toLocaleString()}`);
console.log(`  avoidable TODAY (redundant, unchanged, not ranged)     ${alreadyServableTokens.toLocaleString()}   ${share(alreadyServableTokens, allReadTokens)}`);
console.log(`  unlocked by narrowing the ranged gate                  ${unlockableTokens.toLocaleString()}   ${share(unlockableTokens, allReadTokens)}`);

console.log('\nLIVE BUG — Tier A serves these TODAY on evidence that does not cover the call:');
console.log(`  unranged repeats whose earlier reads were RANGED and do not cover them   ${falseTodayCount}`);
console.log(`  tokens the agent is told to skip on that basis                           ${falseTodayTokens.toLocaleString()}`);
for (const ex of falseExamples) console.log(`    ${ex}`);

console.log('\nif proof had to come from the session transcript (tail read), how far back is the earlier read?');
if (distances.length) {
  console.log(`  same-window pairs in one transcript file: ${distances.length} (${crossFile} span a resume/compaction boundary)`);
  console.log(`  bytes back   p50 ${kb(pct(distances, 0.5))}   p75 ${kb(pct(distances, 0.75))}   p90 ${kb(pct(distances, 0.9))}   max ${kb(Math.max(...distances))}`);
  for (const cap of [64, 256, 1024]) {
    const within = distances.filter(d => d <= cap * 1024).length;
    console.log(`    within a ${String(cap).padStart(4)}KB tail: ${String(within).padStart(4)} of ${distances.length}  ${share(within, distances.length)}`);
  }
} else {
  console.log('  (no same-window pairs to measure)');
}
