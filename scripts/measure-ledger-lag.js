#!/usr/bin/env node
// REV-10: how long does a read wait before Tier A can be served from it?
//
// Tier A needs TWO facts. The hook supplies one itself, at the read
// (sessionState.reads, the read-time hash). The other -- proof the read
// actually happened -- comes from the ledger's fileReaders, and the ledger is
// written by the daemon's sync pass, not by the hook. So between a session's
// first read of a path and the moment that path becomes servable for it there
// is a wait, and nothing has measured it.
//
// THE MODEL, stated so it can be argued with:
//
//   * The daemon folds on a fixed period (config.intervalSec, default 60s,
//     floor 15s). A read at t1 reaches the ledger at the FIRST tick after t1.
//   * A later read of the same path by the same session at t2 can be served
//     only if that tick has already happened -- i.e. only if a tick boundary
//     falls in (t1, t2].
//   * Tick phase is arbitrary relative to any session, so for gap = t2 - t1
//     the probability of a boundary inside it is min(1, gap / interval).
//
// Averaged over every real repeat read, that is the share of the Tier A
// ceiling the lag leaves standing. Timestamps come from real Claude Code
// transcripts (the moment the tool call was issued), not simulation.
//
// IDENTITY MATCHES THE LEDGER'S. Reads are keyed with repo-root's own
// ledgerKeyFor, so a read from a linked worktree and one from the main
// checkout collapse to the same key exactly as fileReaders does -- and every
// transcript directory under the project is read, not just the main one.
// Keying any other way makes the same file look like two, which is the bug
// that made repeat reads uncountable in the first place.
//
// Usage: node scripts/measure-ledger-lag.js [projectPath] [intervalSec]
// Read-only: it never writes to a ledger, a project, or the daemon.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const repoRoot = require('../lib/repo-root');

const PROJECT = path.resolve(process.argv[2] || '/Users/marco/Documents/Membridge');
const INTERVAL_SEC = Number(process.argv[3] || 60);
const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const MIN_CALL_BYTES = 1600; // MIN_CALL_TOKENS (400) * 4 chars: below this no tier serves

const root = path.join(os.homedir(), '.claude', 'projects');
const prefix = PROJECT.replace(/[/.]/g, '-');
const dirs = fs.readdirSync(root).filter(d => d === prefix || d.startsWith(`${prefix}-`));

const reads = [];
const edits = [];
let files = 0, foreign = 0, rangedAll = 0, readsAll = 0;
for (const d of dirs) {
  const dir = path.join(root, d);
  let names;
  try { names = fs.readdirSync(dir); } catch { continue; }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    files++;
    let raw;
    try { raw = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
      const session = typeof e.sessionId === 'string' && e.sessionId ? e.sessionId : name.replace(/\.jsonl$/, '');
      const ts = Date.parse(e.timestamp);
      if (!Number.isFinite(ts)) continue;
      for (const c of e.message.content) {
        if (!c || c.type !== 'tool_use' || !c.input) continue;
        const file = c.input.file_path || c.input.notebook_path || c.input.path || null;
        if (!file) continue;
        const isRead = READ_TOOLS.has(c.name);
        if (isRead) readsAll++;
        const key = repoRoot.ledgerKeyFor(PROJECT, file);
        if (!key) { if (isRead) foreign++; continue; }
        if (isRead) {
          const rangedRead = typeof c.input.offset === 'number' && c.input.offset > 0;
          if (rangedRead) rangedAll++;
          reads.push({ session, key, abs: file, ts, ranged: rangedRead });
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

// Current on-disk size, for the MIN_CALL_TOKENS floor. A file that no longer
// exists is counted as eligible rather than dropped: its size then is unknown,
// and silently excluding it would flatter the result.
const sizeCache = new Map();
const bigEnough = (abs) => {
  if (!sizeCache.has(abs)) {
    let size = Infinity;
    try { size = fs.statSync(abs).size; } catch {}
    sizeCache.set(abs, size);
  }
  return sizeCache.get(abs) >= MIN_CALL_BYTES;
};

const groups = new Map();
for (const r of reads) {
  const k = `${r.session}\u0000${r.key}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

const pct = (list, p) => {
  if (!list.length) return NaN;
  const s = list.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const fmt = ms => (!Number.isFinite(ms) ? 'n/a' : ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`);

const gapsAll = [];
const gapsEligible = [];  // survives ranged + edited + token-floor
const gapsIfUnranged = []; // the same, but WITHOUT the ranged refusal --
                           // the counterfactual that says what the lag would
                           // cost if ranged reads were ever made servable
let firstReads = 0, repeats = 0, ranged = 0, changed = 0, tooSmall = 0;
const byQuartile = [[], [], [], []];
for (const list of groups.values()) {
  list.sort((a, b) => a.ts - b.ts);
  firstReads++;
  const t1 = list[0].ts;
  for (let i = 1; i < list.length; i++) {
    const r = list[i];
    repeats++;
    gapsAll.push(r.ts - t1);
    // Buckets are exclusive and ordered the way decide() itself refuses:
    // ranged (step 2.6) before the tier, the token floor after it. So these
    // four lines add up to `repeats`, and each read is counted once.
    const edited = editedBetween(r.key, list[i - 1].ts, r.ts);
    const small = !bigEnough(r.abs);
    if (!edited && !small) gapsIfUnranged.push(r.ts - t1); // ranged included, on purpose
    if (r.ranged) { ranged++; continue; }
    if (edited) { changed++; continue; }
    if (small) { tooSmall++; continue; }
    gapsEligible.push(r.ts - t1);
    const q = Math.min(3, Math.floor((4 * (i - 1)) / Math.max(1, list.length - 1)));
    byQuartile[q].push(r.ts - t1);
  }
}

const serveShare = (list, ms) => (list.length
  ? list.reduce((acc, g) => acc + Math.min(1, g / ms), 0) / list.length
  : 0);

console.log(`project        ${PROJECT}`);
console.log(`transcripts    ${dirs.length} director${dirs.length === 1 ? 'y' : 'ies'} (main + linked worktrees), ${files} files`);
console.log(`reads          ${readsAll} total, ${reads.length} in-project (${foreign} outside it), ${groups.size} (session, path) pairs`);
console.log(`               ${rangedAll} of ${reads.length} in-project reads are RANGED (offset > 0) — ${((100 * rangedAll) / reads.length).toFixed(1)}%`);
console.log(`fold interval  ${INTERVAL_SEC}s\n`);

console.log(`first read of a path in a session (never servable — it IS the evidence)  ${firstReads}`);
console.log(`repeat reads                                                             ${repeats}`);
console.log(`  - ranged (offset > 0: refused at EVERY tier since 2026-08-02)          ${ranged}`);
console.log(`  - written between the two reads (correctly refused, REV-4)             ${changed}`);
console.log(`  - under the 400-token floor                                            ${tooSmall}`);
console.log(`  = Tier A candidates before the lag is applied                          ${gapsEligible.length}\n`);

console.log("gap from a session's FIRST read of a path to a later read of it:");
for (const [label, list] of [['all repeats', gapsAll], ['Tier A candidates', gapsEligible]]) {
  if (!list.length) continue;
  console.log(`  ${label.padEnd(18)} p10 ${fmt(pct(list, 0.1)).padStart(7)}  p25 ${fmt(pct(list, 0.25)).padStart(7)}`
    + `  p50 ${fmt(pct(list, 0.5)).padStart(7)}  p75 ${fmt(pct(list, 0.75)).padStart(7)}  p90 ${fmt(pct(list, 0.9)).padStart(7)}`);
}

console.log('\nmodelled Tier A serve rate — P(serve) = min(1, gap / interval), averaged over candidates:');
for (const secs of [15, 30, 60, 120, 300]) {
  const share = serveShare(gapsEligible, secs * 1000);
  const inside = gapsEligible.filter(g => g < secs * 1000).length;
  console.log(`  interval ${String(secs).padStart(3)}s   ${(100 * share).toFixed(1)}% survives`
    + `   (~${Math.round(share * gapsEligible.length)} of ${gapsEligible.length})`
    + `   ${inside} candidate(s) fall inside one interval${secs === INTERVAL_SEC ? '   <- configured' : ''}`);
}

// The lag looks harmless above only because the ranged gate has already
// removed every FAST repeat. This is the same model over the repeats the
// ranged gate refuses -- i.e. what the lag would cost the day that gate is
// narrowed. Reported so the first number is not mistaken for "the lag is fine".
console.log('\nCOUNTERFACTUAL — if ranged reads were made servable, the lag would bind:');
for (const secs of [15, 30, 60, 120]) {
  const share = serveShare(gapsIfUnranged, secs * 1000);
  const inside = gapsIfUnranged.filter(g => g < secs * 1000).length;
  console.log(`  interval ${String(secs).padStart(3)}s   ${(100 * share).toFixed(1)}% would survive`
    + `   (${inside} of ${gapsIfUnranged.length} repeats fall inside one interval)`
    + `${secs === INTERVAL_SEC ? '   <- configured' : ''}`);
}

console.log("\nby position among a path's repeat reads (is an early read served worse?):");
byQuartile.forEach((list, i) => {
  if (!list.length) return;
  console.log(`  quartile ${i + 1}  n=${String(list.length).padStart(4)}  median gap ${fmt(pct(list, 0.5)).padStart(7)}`
    + `  modelled serve rate ${(100 * serveShare(list, INTERVAL_SEC * 1000)).toFixed(1)}%`);
});
