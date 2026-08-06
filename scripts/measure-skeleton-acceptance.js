#!/usr/bin/env node
'use strict';
// Measure what lib/skeleton.js ACCEPTS, per repo (REV-3 part 2).
//
// WHY. lib/recall-store.js warm() refuses to cache a skeleton when
// skeletonize() returns ok:false, and the store's noStructure counter on the
// author's machine read 6,411 against 27 stored entries. That looked like a
// skeletonizer collapsing on this codebase. It is not: the counter is
// CUMULATIVE and re-counts the same persistently-declined hot files on every
// sync pass, so it says nothing about how many distinct files fail. This
// script measures the thing the counter cannot: per-repo acceptance rate, why
// the failures failed, and the compression distribution of what passes.
//
// ok:false has exactly two causes (lib/skeleton-strip.js):
//   * looksDegenerate  -- a NUL byte, or ANY line longer than MAX_LINE_LEN
//   * the compression floor -- output lines must be < 60% of input lines
// They are reported separately because they have different fixes.
//
// The output/input line ratios are the evidence anyone should want before
// touching COMPRESSION_CEILING (0.60) or lib/recall.js's MIN_COMPRESSION
// (2.25). Do not move either without this distribution for the repo you care
// about: declining to cache a bad skeleton is CORRECT behaviour, and loosening
// the floor buys serve volume by serving worse skeletons.
//
// USAGE
//   node scripts/measure-skeleton-acceptance.js [repoPath ...]
// Defaults to this repo plus any sibling comparison repos that exist.
const fs = require('fs'), path = require('path');
const { skeletonize } = require(path.resolve(__dirname, '..', 'lib', 'skeleton.js'));
const NUL = String.fromCharCode(0);
const MAX_LINE_LEN = 2000;
const EXT = new Set(['.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.php', '.c', '.h', '.cpp', '.swift']);

function walk(d, out = [], depth = 0) {
  if (depth > 6) return out;
  let e = [];
  try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const x of e) {
    if (x.name === 'node_modules' || x.name === '.git' || x.name.startsWith('.')) continue;
    const p = path.join(d, x.name);
    if (x.isDirectory()) walk(p, out, depth + 1);
    else if (EXT.has(path.extname(x.name))) out.push(p);
  }
  return out;
}

// Share of lines that are pure comment or blank — the hypothesis under test.
function commentShare(c) {
  const lines = c.split('\n');
  let n = 0;
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#')) n++;
  }
  return n / Math.max(1, lines.length);
}

async function run(label, root, limit) {
  const files = walk(root).slice(0, limit);
  let ok = 0, badDegen = 0, badFloor = 0;
  const ratios = [], comShareOk = [], comShareBad = [];
  for (const f of files) {
    let c;
    try { c = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!c.trim()) continue;
    let s;
    try { s = await skeletonize(f, c); } catch { continue; }
    const inL = c.split('\n').length, outL = s.text.split('\n').length;
    const cs = commentShare(c);
    if (s.ok) { ok++; ratios.push(outL / inL); comShareOk.push(cs); continue; }
    const degen = c.indexOf(NUL) !== -1 || c.split('\n').some(l => l.length > MAX_LINE_LEN);
    if (degen) badDegen++; else badFloor++;
    comShareBad.push(cs);
  }
  const bad = badDegen + badFloor;
  ratios.sort((a, b) => a - b);
  const p = q => (ratios.length ? ratios[Math.floor(ratios.length * q)].toFixed(2) : 'n/a');
  const avg = a => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length * 100).toFixed(0) + '%' : 'n/a');
  console.log(`\n${label}  (${files.length} source files)`);
  console.log(`  ACCEPTED (ok:true)  ${ok}  (${(ok / Math.max(1, ok + bad) * 100).toFixed(0)}%)`);
  console.log(`  DECLINED (ok:false) ${bad}   degenerate(NUL/long line): ${badDegen}   compression floor: ${badFloor}`);
  console.log(`  output/input LINE ratio of accepted: p10 ${p(0.1)}  p50 ${p(0.5)}  p90 ${p(0.9)}   (must be < 0.60)`);
  console.log(`  comment+blank share: accepted ${avg(comShareOk)}   declined ${avg(comShareBad)}`);
}

(async () => {
  const args = process.argv.slice(2);
  if (args.length) {
    for (const r of args) {
      try { fs.statSync(r); } catch { console.log(`\n${r}: not present`); continue; }
      await run(path.basename(r), path.resolve(r), 220);
    }
    return;
  }
  await run('MemBridge (this repo)', path.resolve(__dirname, '..'), 220);
  for (const r of ['../../PolyBot', '../../AI'].map(x => path.resolve(__dirname, '..', x))) {
    try { fs.statSync(r); await run(`${path.basename(r)} (comparison)`, r, 220); } catch {}
  }
})();
