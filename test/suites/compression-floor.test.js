'use strict';
// MIN_COMPRESSION, re-measured against the honest tokenizer.
//
// WHY THIS SUITE EXISTS. `MIN_COMPRESSION` (lib/recall.js) gates the ratio
// `callTokens / skeletonTokens` -- "is the skeleton enough cheaper than the
// file to be worth serving instead of it". `2.25` was chosen while BOTH sides
// of that ratio came out of the chars/4 heuristic, an estimator that
// understates real source by ~6% in aggregate AND whose error tracks file type
// (measured in test/suites/token-estimate.test.js). An estimator that is wrong
// by different amounts on the two sides of a ratio does not cancel, so the
// constant was recorded as needing recalibration when Tier 2's BPE tokenizer
// landed (claude/ops/decisions.md).
//
// IT WAS RE-MEASURED, AND IT HELD. The expected effect -- honest pricing makes
// skeletons dearer, pushing files under the floor and shrinking the serve
// population -- does not survive contact with real files. This suite re-derives
// that on every run from the repo's own source, under BOTH estimators, on the
// SAME skeleton text (skeletonize() does not depend on the tokenizer: its own
// keep/drop gate, lib/skeleton-strip.js's computeOk, counts LINES). So the
// comparison isolates exactly one variable: how the two sides are priced.
//
// The reason the feared drop is not real, in one line: the call side rises by a
// fixed ~10% (bytes/4 -> bytes/BYTES_PER_TOKEN) while the skeleton side rises
// by whatever that specific skeleton's BPE-vs-chars/4 error is -- and for CODE,
// which is what the recall store actually caches off hot paths, that error is
// SMALLER than 10%. The ratio therefore rises for code. It falls hard for
// Markdown, whose heading-only skeletons tokenize expensively per character --
// but Markdown ratios sit an order of magnitude above the floor, so the fall
// changes no decision. Aggregating all file types into one mean is what made
// the artefact look like a real threshold problem.
//
// Bands, not points, throughout: the corpus is the live repo and moves with it.
// What is pinned is the DIRECTION and the DECISION, not a decimal.
//
// Run directly, or via `node test/run.js compression-floor`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const recall = require('../../lib/recall');
const te = require('../../lib/token-estimate');
const { skeletonize } = require('../../lib/skeleton');

// ---------------------------------------------------------------------------
// The two pricings, both exact.
// ---------------------------------------------------------------------------
// Pre-Tier-2 arithmetic, copied from git 7d04ab9^:lib/recall.js and
// 7d04ab9^:lib/token-estimate.js. Deliberately hardcoded rather than imported:
// this is a historical baseline, and it must NOT follow the current estimator.
const READ_TOOL_MAX_LINES = 2000;
const oldCallTokens = size => Math.min(Math.round(size / 4), READ_TOOL_MAX_LINES * 12);
const oldSkeletonTokens = s => Math.ceil(String(s).length / 4);
// Current arithmetic, read from the live module so a future change to either
// constant re-runs this calibration rather than silently invalidating it.
const newCallTokens = size => Math.min(
  te.estimateTokensFromBytes(size),
  te.estimateTokensFromLines(READ_TOOL_MAX_LINES),
);
const newSkeletonTokens = s => te.estimateTokens(s);

const CODE_EXTS = new Set(['.js', '.ts', '.tsx', '.jsx']);
const SCAN_EXTS = new Set([...CODE_EXTS, '.md', '.css', '.json']);
const SCAN_DIRS = ['lib', 'ui/src', 'bin', 'scripts', 'docs'];

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(p, out);
    } else if (SCAN_EXTS.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

// Built once and shared by every check below -- skeletonizing the corpus per
// check would multiply the suite's cost for no extra evidence.
async function buildCorpus() {
  const files = [];
  for (const d of SCAN_DIRS) walk(path.join(REPO, d), files);
  const rows = [];
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!content.trim()) continue;
    let sk;
    try { sk = await skeletonize(f, content); } catch { continue; }
    // ok:false is exactly what lib/recall-store.js's warm() refuses to store,
    // so such a file never reaches the compression floor at all. Excluding it
    // here keeps the corpus the population the floor actually judges.
    if (!sk || !sk.ok) continue;
    const size = Buffer.byteLength(content, 'utf8');
    const oldSkel = oldSkeletonTokens(sk.text);
    const newSkel = newSkeletonTokens(sk.text);
    if (oldSkel <= 0 || newSkel <= 0) continue;
    const oldCall = oldCallTokens(size);
    const newCall = newCallTokens(size);
    rows.push({
      file: path.relative(REPO, f),
      ext: path.extname(f),
      oldCall, newCall, oldSkel, newSkel,
      oldRatio: oldCall / oldSkel,
      newRatio: newCall / newSkel,
      // decide() applies MIN_CALL_TOKENS before the compression floor; a file
      // too small to clear it is not in the serve population under either
      // estimator, so the floor never gets a say about it.
      oldEligible: oldCall >= recall.MIN_CALL_TOKENS,
      newEligible: newCall >= recall.MIN_CALL_TOKENS,
    });
  }
  assert.ok(rows.length > 100, `corpus collapsed to ${rows.length} files -- the calibration is not being measured`);
  return rows;
}

const geo = a => Math.exp(a.reduce((s, x) => s + Math.log(x), 0) / a.length);
const servedOld = r => r.oldEligible && r.oldRatio >= recall.MIN_COMPRESSION;
const servedNew = r => r.newEligible && r.newRatio >= recall.MIN_COMPRESSION;

// ---------------------------------------------------------------------------

async function main() {
  const rows = await buildCorpus();

  await check('compression floor: the constant is 2.25 and there is exactly one of it', () => {
  assert.strictEqual(recall.MIN_COMPRESSION, 2.25);
  // lib/mcp.js has its own tiering and its own floor check, and it must read
  // this constant rather than keep a second copy -- two floors that agree today
  // and drift tomorrow is how a "recalibration" gets half-applied.
  const mcpSrc = fs.readFileSync(path.join(REPO, 'lib', 'mcp.js'), 'utf8');
  assert.ok(/recall\.MIN_COMPRESSION/.test(mcpSrc),
    'lib/mcp.js must gate on recall.MIN_COMPRESSION, not a local literal');
  assert.ok(!/MIN_COMPRESSION\s*=/.test(mcpSrc),
    'lib/mcp.js has grown its own MIN_COMPRESSION -- there must be one');
  });

  await check('calibration: the honest tokenizer does not shrink the serve population at 2.25', async () => {
  const before = rows.filter(servedOld);
  const after = rows.filter(servedNew);
  const lost = before.filter(r => !servedNew(r));
  const gained = after.filter(r => !servedOld(r));
  console.log(`  corpus: ${rows.length} files that skeletonize ok`);
  console.log(`  served at ${recall.MIN_COMPRESSION}x: chars/4 ${before.length} -> BPE ${after.length}`
    + ` (${lost.length} lost, ${gained.length} gained)`);
  console.log(`  files losing the floor: ${lost.map(r => r.file).join(', ') || '(none)'}`);

  // THE HEADLINE. Ticket #55 predicted honest pricing would push files under
  // the floor and cut serves. Measured, it does the opposite: more files clear
  // 2.25x, not fewer. If this ever inverts, the recalibration argument becomes
  // real again and this constant genuinely needs re-deriving -- so the
  // assertion is the trigger for that work, not decoration.
  assert.ok(after.length >= before.length,
    `the serve population SHRANK (${before.length} -> ${after.length}); MIN_COMPRESSION now needs re-deriving`);
  // And the churn is small in absolute terms -- this is not two large sets that
  // happen to be the same size.
  assert.ok(lost.length <= 0.05 * before.length,
    `${lost.length} of ${before.length} served files lost the floor -- more than incidental churn`);
  });

  await check('calibration: the ratio shift decomposes, and on code the skeleton side does not outrun the call side', async () => {
  const callShift = geo(rows.map(r => r.newCall / r.oldCall));
  const code = rows.filter(r => CODE_EXTS.has(r.ext));
  const codeSkelShift = geo(code.map(r => r.newSkel / r.oldSkel));
  const codeRatioShift = geo(code.map(r => r.newRatio / r.oldRatio));
  console.log(`  call-side shift (bytes/4 -> bytes/${te.BYTES_PER_TOKEN}): ${callShift.toFixed(4)}`);
  console.log(`  code skeleton-side shift (chars/4 -> BPE): ${codeSkelShift.toFixed(4)} over ${code.length} files`);
  console.log(`  code ratio shift: ${codeRatioShift.toFixed(4)}`);

  // The call side rises by a fixed factor -- it is one division by one
  // constant, so this is arithmetic, not a corpus property.
  assert.ok(Math.abs(callShift - 4 / te.BYTES_PER_TOKEN) < 0.02,
    `call-side shift ${callShift.toFixed(4)} should be ~4/BYTES_PER_TOKEN`);
  // The whole argument in one assertion: for code, honest pricing costs the
  // skeleton LESS than it costs the call, so the ratio improves.
  assert.ok(codeSkelShift < callShift,
    `code skeletons got dearer (${codeSkelShift.toFixed(4)}) than calls did (${callShift.toFixed(4)}) -- `
    + 'the premise behind recalibrating MIN_COMPRESSION would now hold');
  assert.ok(codeRatioShift > 1,
    `code compression ratios fell (${codeRatioShift.toFixed(4)}) -- re-derive the floor`);
  });

  await check('calibration: Markdown ratios fall sharply and it changes no decision', async () => {
  const md = rows.filter(r => r.ext === '.md');
  assert.ok(md.length > 10, `only ${md.length} markdown files -- not enough to measure the artefact`);
  const mdShift = geo(md.map(r => r.newRatio / r.oldRatio));
  const mdMin = Math.min(...md.map(r => r.newRatio));
  console.log(`  markdown: ${md.length} files, ratio shift ${mdShift.toFixed(4)}, lowest ratio ${mdMin.toFixed(2)}x`);
  console.log(`  markdown served at ${recall.MIN_COMPRESSION}x: `
    + `${md.filter(servedOld).length} -> ${md.filter(servedNew).length}`);

  // Markdown really does get dearer to serve -- this is the true observation
  // underneath ticket #55, and it is not disputed.
  assert.ok(mdShift < 0.95, `markdown ratio shift ${mdShift.toFixed(4)} -- the artefact this test explains is gone`);
  // It is also irrelevant to the floor, because no markdown file is near it.
  // A heading-only skeleton of a prose file compresses enormously.
  assert.ok(mdMin > 2 * recall.MIN_COMPRESSION,
    `a markdown file is now within reach of the floor (${mdMin.toFixed(2)}x) -- the artefact has become a real effect`);
  assert.strictEqual(md.filter(servedOld).length, md.filter(servedNew).length,
    'markdown changed sides at the floor');
  });

  await check('calibration: no threshold in the searched band beats 2.25 on preserved serves', async () => {
  const before = rows.filter(servedOld).length;
  const table = [];
  for (let t = 1.9; t <= 2.65001; t += 0.05) {
    const T = +t.toFixed(2);
    const n = rows.filter(r => r.newEligible && r.newRatio >= T).length;
    table.push({ T, n, delta: n - before });
  }
  for (const c of table) console.log(`  T=${c.T.toFixed(2)}  served ${c.n}  (${c.delta >= 0 ? '+' : ''}${c.delta} vs chars/4)`);

  // THE DECISION CRITERION the recalibration was supposed to apply: pick the
  // threshold that preserves the INTENDED serve population, not the one that
  // preserves the old numeric value. Measured, the unchanged 2.25 already does
  // -- it reproduces the chars/4 population to within a few percent.
  const at225 = table.find(c => Math.abs(c.T - 2.25) < 1e-9);
  console.log(`  2.25 preserves the chars/4 population to within `
    + `${(100 * Math.abs(at225.delta) / before).toFixed(1)}% (${before} -> ${at225.n})`);
  assert.ok(Math.abs(at225.delta) <= 0.05 * before,
    `2.25 moves the serve population by ${at225.delta} of ${before} files -- that IS a recalibration case`);

  // And nothing nearby does meaningfully better, which is what makes "leave it
  // alone" the right answer rather than merely a defensible one. The
  // best-matching threshold wins by a margin far inside the noise of a corpus
  // that moves with the repo -- so moving the constant would buy nothing, and
  // would cost the one thing the honest estimator just bought: that 2.25 now
  // means an actual 2.25x, in tokens, on both sides of the ratio.
  const best = table.reduce((a, b) => (Math.abs(b.delta) < Math.abs(a.delta) ? b : a));
  const margin = (Math.abs(at225.delta) - Math.abs(best.delta)) / rows.length;
  console.log(`  best-matching threshold is ${best.T.toFixed(2)} (${best.n} served); `
    + `it beats 2.25 by ${(100 * margin).toFixed(1)}% of the corpus`);
  assert.ok(margin < 0.05,
    `T=${best.T} preserves the population materially better than 2.25 (${(100 * margin).toFixed(1)}% of corpus) -- re-derive the floor`);
  });

  await check('honesty: the compression floor is the only thing MIN_COMPRESSION gates', async () => {
  // Auto-pause and rejection learning are DECISIONS driven by estimates, and
  // the measured-savings spec keeps them that way. Neither may acquire a
  // dependency on this threshold -- if one did, re-tuning the floor would
  // silently change when a project auto-pauses, which is a behaviour change
  // wearing a calibration's clothes.
  const diagnostics = fs.readFileSync(path.join(REPO, 'lib', 'diagnostics.js'), 'utf8');
  const code = diagnostics.split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  assert.ok(!/MIN_COMPRESSION/.test(code),
    'lib/diagnostics.js now READS MIN_COMPRESSION -- auto-pause must not depend on the serve floor');
  // Rejection learning counts rejections and never reads a token figure.
  assert.strictEqual(recall.REJECTION_LIMIT, 3);
  assert.ok(rows.length > 0);
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
