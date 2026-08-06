'use strict';
// Tier 3 of the measured-savings spec: the clean holdout cohort, the epoch that
// keeps old evidence from mixing with new, and the arithmetic on top.
//
// THE THREE CLAIMS THIS SUITE EXISTS TO PROVE, because each of them is easy to
// assert loosely and easy to regress silently:
//
//  1. Assignment is WHOLE-SESSION. No session is partly served and partly
//     withheld -- proven by driving decide() over many sessions x many paths
//     and asserting every session is unanimous, not by re-implementing the
//     hash and checking it against itself.
//  2. The measurement unit is still the ELIGIBLE READ. These are different
//     choices, and the spec is explicit that getting either one wrong breaks
//     the result: per-read assignment leaves no cohort, per-session
//     measurement throws away most of the power.
//  3. Old and new evidence CANNOT be averaged. Proven at both boundaries --
//     the normalize boundary where a ledger is read, and the pooling boundary
//     where blocks are summed.
//
// Run via `node test/run.js holdout-cohort`, or this file directly.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const util = require('../../lib/util');
const ledgerStore = require('../../lib/ledger-store');
const foldRecall = require('../../lib/ledger-fold-recall');
const recall = require('../../lib/recall');
const roi = require('../../lib/roi');
const { HOLDOUT_EPOCH } = require('../../lib/holdout-epoch');
const { normalizeComparison } = require('../../lib/ledger-fold-state');
const { settleRows } = require('../../lib/ledger-fold-recall-settle');
const { buildOpenServe, applyCorrections } = require('../../lib/ledger-fold-recall-open-serves');

// --- 1. the cohort ----------------------------------------------------------

check('holdout: assignment depends on the session and nothing else', () => {
  const paths = ['src/a.js', 'src/b.js', 'lib/deep/nested/thing.ts', 'README.md', ''];
  for (let i = 0; i < 500; i++) {
    const sid = `session-${i}`;
    const buckets = new Set(paths.map(() => recall.holdoutBucket(sid)));
    assert.strictEqual(buckets.size, 1, `${sid} produced more than one bucket`);
  }
  // The old two-argument shape is gone. A caller that still passes a path gets
  // the session's bucket, because the second argument is not read at all.
  assert.strictEqual(recall.holdoutBucket.length, 1, 'holdoutBucket must take exactly one argument');
  assert.strictEqual(recall.holdoutBucket('s', 'src/a.js'), recall.holdoutBucket('s'));
  // And it is NOT the old hash: sha1(sessionId + relPath) must no longer be
  // what decides. Asserted against a concrete counter-example so this fails if
  // the old expression is ever restored.
  const oldHash = (sid, rel) => crypto.createHash('sha1').update(`${sid}${rel}`).digest().readUInt32BE(0) % 100;
  const differs = ['src/a.js', 'src/b.js', 'x'].some(p => oldHash('session-7', p) !== recall.holdoutBucket('session-7'));
  assert.ok(differs, 'the bucket still matches the old per-read hash -- the cohort change did not take');
});

check('holdout: NO SESSION is both served and withheld, end to end through decide()', () => {
  // The property that makes a cohort a cohort, asserted through the real
  // decision path rather than the hash: every read in a session must reach the
  // same verdict about the holdout.
  const paths = ['src/one.js', 'src/two.js', 'src/three.js', 'docs/four.md', 'lib/five.ts'];
  const fileStat = { size: 40000, hash: 'abc123' };
  const decideFor = (sid, relPath) => recall.decide({
    projectPath: '/proj',
    relPath,
    absPath: `/proj/${relPath}`,
    sessionId: sid,
    toolName: 'Read',
    offset: null,
    limit: null,
    tracked: true,
    fileStat,
    storeEntry: { contentHash: 'abc123', skeleton: 'SKELETON BODY', skeletonTokens: 40, rejections: 0 },
    ledger: { fileReaders: Object.fromEntries(paths.map(p => [p, { sessions: [sid], reads: 1, lastTs: 't', firstTs: 't', firstSession: sid }])) },
    config: {},
  });

  let heldSessions = 0;
  let servedSessions = 0;
  const split = [];
  for (let i = 0; i < 400; i++) {
    const sid = `cohort-session-${i}`;
    const reasons = paths.map(p => decideFor(sid, p));
    const held = reasons.filter(r => r.reason === 'holdout').length;
    if (held === 0) servedSessions++;
    else if (held === paths.length) heldSessions++;
    else split.push({ sid, held, of: paths.length });
  }
  assert.deepStrictEqual(split, [], 'a session was partly served and partly withheld -- the cohort is contaminated');
  assert.ok(heldSessions > 0, 'the fixture must actually contain withheld sessions');
  assert.ok(servedSessions > 0, 'the fixture must actually contain served sessions');
  console.log(`  400 sessions x ${paths.length} paths: ${heldSessions} wholly withheld, ${servedSessions} wholly served, ${split.length} split`);
});

check('holdout: the rate is still 3% of sessions', () => {
  assert.strictEqual(recall.HOLDOUT_PCT, 3, 'the rate is not part of this change');
  let held = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    if (recall.holdoutBucket(`rate-session-${i}`) < recall.HOLDOUT_PCT) held++;
  }
  const pct = (100 * held) / n;
  console.log(`  ${held}/${n} sessions withheld = ${pct.toFixed(2)}%`);
  // Sampling band around 3%: this is a hash over 20k distinct inputs, not a
  // random draw, so it is deterministic -- the band exists to catch a scheme
  // change (a wrong modulus, a wrong comparison), not flakiness.
  assert.ok(pct > 2.5 && pct < 3.5, `holdout rate ${pct.toFixed(2)}% is not 3%`);
});

check('holdout: the withheld side is the RECALL SERVE only', () => {
  // Scope check the spec is explicit about: what is withheld is the serve.
  // decide() is the only thing the holdout gate lives in, and it answers about
  // recall serves and nothing else -- it has no notion of note injection or of
  // the injected CLAUDE.md block, so it cannot withhold either.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'recall.js'), 'utf8');
  assert.ok(!/notes|injection/i.test(src.split('function decide(')[1] || ''),
    'decide() must not have grown any notion of notes -- teammate note injection is never withheld');
});

// --- 2. the epoch -----------------------------------------------------------

const arm = (reads, tokens, tokensSq) => ({ reads, tokens, tokensSq });

check('epoch: a ledger from an older assignment scheme is zeroed, not migrated', () => {
  const contaminated = {
    epoch: 1, // the per-read assignment
    served: arm(5000, 250000, 20000000),
    withheld: arm(900, 900000, 1000000000),
  };
  const out = normalizeComparison(contaminated);
  assert.strictEqual(out.epoch, HOLDOUT_EPOCH);
  assert.deepStrictEqual(out.served, arm(0, 0, 0), 'old served evidence must be dropped');
  assert.deepStrictEqual(out.withheld, arm(0, 0, 0), 'old withheld evidence must be dropped');
  // No residue anywhere in the returned block: nothing for a future reader to
  // find and add back in.
  assert.ok(!JSON.stringify(out).includes('250000'), 'a dropped total must not survive under another key');
});

check('epoch: a ledger with NO epoch (everything written before this change) is dropped too', () => {
  const legacy = { served: arm(1000, 50000, 4000000), withheld: arm(40, 40000, 50000000) };
  const out = normalizeComparison(legacy);
  assert.deepStrictEqual(out, { epoch: HOLDOUT_EPOCH, served: arm(0, 0, 0), withheld: arm(0, 0, 0) });
  // The important consequence, stated as an assertion: such a machine reports
  // "measuring" from zero rather than inheriting a count it cannot use.
  const m = roi.measurement(legacy);
  assert.strictEqual(m.state, 'measuring');
  assert.strictEqual(m.servedReads, 0);
  assert.strictEqual(m.withheldReads, 0);
  assert.strictEqual(m.effect, null);
});

check('epoch: current-epoch evidence survives untouched', () => {
  const current = {
    epoch: HOLDOUT_EPOCH,
    served: arm(120, 6000, 400000),
    withheld: arm(40, 40000, 45000000),
  };
  assert.deepStrictEqual(normalizeComparison(current), current);
});

check('epoch: pooling REFUSES wrong-epoch blocks and says how many it dropped', () => {
  // The second boundary. Even if a wrong-epoch block reaches the pooler --
  // from a stale file, a hand-edited ledger, a future team payload -- it must
  // not be summed in, and the caller must be able to tell that it was skipped.
  const good = { epoch: HOLDOUT_EPOCH, served: arm(100, 5000, 300000), withheld: arm(50, 50000, 60000000) };
  const old1 = { epoch: 1, served: arm(9999, 999999, 9e12), withheld: arm(9999, 999999, 9e12) };
  const future = { epoch: HOLDOUT_EPOCH + 1, served: arm(7777, 777777, 7e12), withheld: arm(7777, 777777, 7e12) };
  const pooled = roi.poolComparisons([good, old1, future, good]);
  assert.strictEqual(pooled.pooled, 2);
  assert.strictEqual(pooled.droppedForEpoch, 2);
  assert.deepStrictEqual(pooled.served, arm(200, 10000, 600000), 'only the two current-epoch blocks may be summed');
  assert.deepStrictEqual(pooled.withheld, arm(100, 100000, 120000000));
  const m = roi.poolMeasurement([good, old1, future, good]);
  assert.strictEqual(m.projectsPooled, 2);
  assert.strictEqual(m.projectsDroppedForEpoch, 2);
});

check('epoch: mixing is impossible even when the two totals would look plausible together', () => {
  // The failure this design exists to prevent, written as the attacker would:
  // a big old sample and a small new one, where averaging them silently would
  // look like "more data" and would in fact be a contaminated number.
  const oldBig = { epoch: 1, served: arm(10000, 100000, 2e9), withheld: arm(3000, 9000000, 5e13) };
  const newSmall = { epoch: HOLDOUT_EPOCH, served: arm(60, 3000, 200000), withheld: arm(35, 35000, 40000000) };
  const m = roi.poolMeasurement([oldBig, newSmall]);
  assert.strictEqual(m.servedReads, 60, 'the old served arm leaked into the pool');
  assert.strictEqual(m.withheldReads, 35, 'the old withheld arm leaked into the pool');
  assert.strictEqual(m.projectsDroppedForEpoch, 1);
});

// --- 3. the arithmetic ------------------------------------------------------

check('roi: the pooled mean from sums and counts equals the mean of the raw values', () => {
  // The property that makes storing four numbers per arm legitimate.
  const rawServed = [40, 55, 61, 38, 44, 90, 12, 33, 47, 51];
  const rawWithheld = [820, 1100, 640, 970, 1230, 880];
  const armOf = xs => ({
    reads: xs.length,
    tokens: xs.reduce((a, x) => a + x, 0),
    tokensSq: xs.reduce((a, x) => a + (x * x), 0),
  });
  const sServed = roi.armStats(armOf(rawServed));
  const sWithheld = roi.armStats(armOf(rawWithheld));
  const meanOf = xs => xs.reduce((a, x) => a + x, 0) / xs.length;
  const varOf = xs => {
    const m = meanOf(xs);
    return xs.reduce((a, x) => a + ((x - m) ** 2), 0) / (xs.length - 1);
  };
  assert.ok(Math.abs(sServed.mean - meanOf(rawServed)) < 1e-9);
  assert.ok(Math.abs(sWithheld.mean - meanOf(rawWithheld)) < 1e-9);
  assert.ok(Math.abs(sServed.variance - varOf(rawServed)) < 1e-6, 'variance from sums must match the direct computation');
  assert.ok(Math.abs(sWithheld.variance - varOf(rawWithheld)) < 1e-6);
  // And splitting one arm across two "projects" pools back to the same thing.
  const half1 = armOf(rawServed.slice(0, 4));
  const half2 = armOf(rawServed.slice(4));
  assert.deepStrictEqual(roi.addArms(half1, half2), armOf(rawServed));
});

check('roi: the effect is the difference of per-read means, with an interval', () => {
  // Hand-derived fixture: served reads cost 100 tokens each, withheld 1000.
  const served = { reads: 200, tokens: 200 * 100, tokensSq: 200 * 100 * 100 };
  const withheld = { reads: 50, tokens: 50 * 1000, tokensSq: 50 * 1000 * 1000 };
  const m = roi.measurement({ epoch: HOLDOUT_EPOCH, served, withheld });
  assert.strictEqual(m.state, 'sufficient');
  assert.strictEqual(m.effect.servedMeanTokens, 100);
  assert.strictEqual(m.effect.withheldMeanTokens, 1000);
  assert.strictEqual(m.effect.tokensPerReadAvoided, 900);
  // Zero variance in both arms here, so the interval is a point.
  assert.strictEqual(m.effect.standardError, 0);
  assert.strictEqual(m.effect.ci95.low, 900);
  assert.strictEqual(m.effect.ci95.high, 900);
  assert.strictEqual(m.effect.significant, true);
  assert.strictEqual(m.kind, 'estimate', 'a controlled comparison of two estimates is still an estimate');
});

check('roi: a real-variance fixture produces an interval that straddles zero when it should', () => {
  // Both arms drawn around the same mean: there is no effect here, and the
  // engine must say so with an interval containing zero rather than reporting
  // whatever small difference the sample happened to show.
  const mk = xs => ({ reads: xs.length, tokens: xs.reduce((a, x) => a + x, 0), tokensSq: xs.reduce((a, x) => a + x * x, 0) });
  const a = [];
  const b = [];
  for (let i = 0; i < 60; i++) { a.push(500 + ((i * 37) % 400)); b.push(500 + ((i * 53) % 400)); }
  const m = roi.measurement({ epoch: HOLDOUT_EPOCH, served: mk(a), withheld: mk(b) });
  assert.strictEqual(m.state, 'sufficient');
  console.log(`  no-effect fixture: ${m.effect.tokensPerReadAvoided} tokens/read, `
    + `95% CI [${m.effect.ci95.low}, ${m.effect.ci95.high}], significant=${m.effect.significant}`);
  assert.ok(m.effect.ci95.low < 0 && m.effect.ci95.high > 0, 'the interval must contain zero on a no-effect fixture');
  assert.strictEqual(m.effect.significant, false);
});

check('roi: BOTH thresholds gate independently, and an unmet gate reports null not zero', () => {
  const big = n => ({ reads: n, tokens: n * 100, tokensSq: n * 100 * 100 });
  const mk = (s, w) => roi.measurement({ epoch: HOLDOUT_EPOCH, served: big(s), withheld: big(w) });

  // The case one threshold would miss: the served arm is far past its
  // threshold and the withheld arm is one short.
  const servedRich = mk(100000, roi.MIN_WITHHELD_READS - 1);
  assert.strictEqual(servedRich.state, 'measuring');
  assert.strictEqual(servedRich.effect, null, 'an unmet withheld threshold must report null');
  assert.notStrictEqual(servedRich.effect, 0, 'a null effect must never be reported as zero');
  assert.strictEqual(servedRich.servedReads, 100000, 'it still reports what it does have, on both arms');
  assert.strictEqual(servedRich.withheldReads, roi.MIN_WITHHELD_READS - 1);

  // And the mirror case, which is rarer but must gate too.
  assert.strictEqual(mk(roi.MIN_SERVED_READS - 1, 100000).state, 'measuring');
  assert.strictEqual(mk(roi.MIN_SERVED_READS - 1, 100000).effect, null);

  // Both boundaries exactly met: the figure appears.
  const atBoundary = mk(roi.MIN_SERVED_READS, roi.MIN_WITHHELD_READS);
  assert.strictEqual(atBoundary.state, 'sufficient');
  assert.ok(atBoundary.effect, 'at both thresholds a figure is produced');

  // A day-one install: zero evidence, and emphatically not a measured zero.
  const dayOne = mk(0, 0);
  assert.strictEqual(dayOne.state, 'measuring');
  assert.strictEqual(dayOne.effect, null);
});

check('roi: no dollar figure, no path, no session id can reach the measurement block', () => {
  const m = roi.poolMeasurement([{
    epoch: HOLDOUT_EPOCH,
    served: arm(100, 5000, 300000),
    withheld: arm(50, 50000, 60000000),
    // Junk a hand-edited or foreign ledger might carry. None of it is read.
    relPath: 'src/secret.js', sessionId: 'sess-abc', inCost: 12.5, usd: 3,
  }]);
  const json = JSON.stringify(m);
  assert.ok(!/inCost|outCost|usd|\$/i.test(json), 'a dollar figure reached the measurement block');
  assert.ok(!/secret|relPath|sessionId/i.test(json), 'a path or session id reached the measurement block');
  assert.deepStrictEqual(Object.keys(m).sort(), [
    'effect', 'epoch', 'kind', 'minServedReads', 'minWithheldReads',
    'projectsDroppedForEpoch', 'projectsPooled', 'servedReads', 'state', 'withheldReads',
  ], 'the measurement block shape is pinned -- a new key here is a wire change');
});

// --- 4. the arms are filled by the fold, in the same units ------------------

const serveRow = (sessionId, relPath, ts, callTokens, skeletonTokens) => ([
  { kind: 'recall_serve', ts, sessionId, relPath, tier: 'B', callTokens, skeletonTokens, holdout: false, committed: false },
  { kind: 'recall_serve', ts, sessionId, relPath, tier: 'B', callTokens, skeletonTokens, holdout: false, committed: true },
]);

check('fold: a settled serve fills the served arm at what the read COST, not what it saved', () => {
  const rows = [
    ...serveRow('s1', 'src/a.js', '2026-08-06T00:00:00.000Z', 4000, 300),
    ...serveRow('s2', 'src/b.js', '2026-08-06T00:01:00.000Z', 2000, 200),
    { kind: 'recall_holdout', ts: '2026-08-06T00:02:00.000Z', sessionId: 's3', relPath: 'src/c.js', tier: 'B', callTokens: 3500, holdout: true },
  ];
  const out = settleRows(rows, Date.parse('2026-08-06T01:00:00.000Z'), buildOpenServe, new Set(), new Set(), new Set());
  assert.strictEqual(out.comparisonDelta.served.reads, 2);
  assert.strictEqual(out.comparisonDelta.served.tokens, 300 + 200, 'served cost is the body served, not the tokens avoided');
  assert.strictEqual(out.comparisonDelta.served.tokensSq, (300 * 300) + (200 * 200));
  assert.strictEqual(out.comparisonDelta.withheld.reads, 1);
  assert.strictEqual(out.comparisonDelta.withheld.tokens, 3500, 'withheld cost is the read that actually happened');
  assert.strictEqual(out.comparisonDelta.withheld.tokensSq, 3500 * 3500);
  // The withheld arm and the lifetime holdout counter must agree about counts.
  assert.strictEqual(out.holdoutDelta.skips, out.comparisonDelta.withheld.reads);
  assert.strictEqual(out.holdoutDelta.callTokens, out.comparisonDelta.withheld.tokens);
});

check('fold: a correction raises the served arm cost by exactly the follow-up read', () => {
  // The anti-flattery property. A served read whose session went and read the
  // file anyway cost the skeleton PLUS the read, and the served arm must say so
  // -- otherwise the served side is priced optimistically while the withheld
  // side is priced at what happened.
  const ts = '2026-08-06T00:00:00.000Z';
  const open = [buildOpenServe(
    { ts, sessionId: 's1', relPath: 'src/a.js', callTokens: 4000, skeletonTokens: 300 },
    4000 - 300,
    Date.parse(ts),
  )];
  const followUp = [{
    kind: 'read', ts: '2026-08-06T00:05:00.000Z', session: 's1',
    file: '/proj/src/a.js', toolUseId: 'tool-1', limit: 100, tool: 'Read',
  }];
  const out = applyCorrections(open, followUp, '/proj', Date.parse('2026-08-06T00:10:00.000Z'));
  const followCost = recall.estimateCallTokens(100, null);
  assert.strictEqual(out.avoidedDelta.tokens, -followCost, 'the avoidance is revised down by the follow-up read');
  assert.strictEqual(out.comparisonDelta.served.tokens, followCost,
    'the served arm cost rises by the same amount the avoidance fell');
  assert.strictEqual(out.comparisonDelta.served.reads, 0, 'a correction re-prices a read, it does not add one');
  // The sum of squares moves from the old cost to the new one, so a later
  // variance is computed on what the reads actually cost.
  const oldCost = 300;
  const newCost = 300 + followCost;
  assert.strictEqual(out.comparisonDelta.served.tokensSq, (newCost * newCost) - (oldCost * oldCost));
});

check('fold: a real updateLedger pass writes the epoch-stamped comparison block to disk', () => {
  // End to end through the production path, not just the pure helpers above:
  // a queued serve and a queued holdout row, one real fold, and the block must
  // land ON DISK with the current epoch. Everything else in this suite is
  // arithmetic; this is the wiring, and wiring is what silently does not run.
  const proj = path.join(h.ROOT, 'roi-e2e-proj');
  fs.mkdirSync(path.join(proj, '.membridge'), { recursive: true });
  util.saveState({ ...util.loadState(), projects: { [proj]: { events: [] } } });
  const ts = '2026-08-06T10:00:00.000Z';
  fs.mkdirSync(path.dirname(foldRecall.eventsPath(proj)), { recursive: true });
  fs.appendFileSync(foldRecall.eventsPath(proj), `${[
    JSON.stringify({ ts, sessionId: 's1', relPath: 'src/a.js', tier: 'B', callTokens: 4000, skeletonTokens: 300, holdout: false, committed: false }),
    JSON.stringify({ ts, sessionId: 's1', relPath: 'src/a.js', committed: true }),
    JSON.stringify({ ts, sessionId: 's2', relPath: 'src/b.js', holdout: true, wouldServe: 'B', callTokens: 3500 }),
  ].join('\n')}\n`);

  const led = ledgerStore.updateLedger(proj, [], util.getConfig(), () => Date.parse(ts) + 10);
  const onDisk = JSON.parse(fs.readFileSync(path.join(proj, '.membridge', 'ledger.json'), 'utf8'));
  const expected = {
    epoch: HOLDOUT_EPOCH,
    served: { reads: 1, tokens: 300, tokensSq: 300 * 300 },
    withheld: { reads: 1, tokens: 3500, tokensSq: 3500 * 3500 },
  };
  assert.deepStrictEqual(led.comparison, expected, 'the fold result must carry the comparison block');
  assert.deepStrictEqual(onDisk.comparison, expected, 'and it must survive to disk, or nothing ever accumulates');
  // Two eligible reads is nowhere near either threshold, so the payload this
  // feeds still reports null -- the point being that the accumulation is real
  // and the gate is what withholds the figure, not an absence of plumbing.
  const m = roi.poolMeasurement([onDisk.comparison]);
  assert.strictEqual(m.servedReads, 1);
  assert.strictEqual(m.withheldReads, 1);
  assert.strictEqual(m.effect, null);
});

check('fold: both arms are priced by the same estimator, so their difference means something', () => {
  // The bias the spec names: one side counted bytes, the other characters.
  // Same file, same size, priced by each side's own path.
  const bytes = 4000;
  const callSide = recall.estimateCallTokens(null, { size: bytes });
  const bodySide = require('../../lib/token-estimate').estimateTokensFromBytes(bytes);
  assert.strictEqual(callSide, bodySide, 'the two sides must price the same quantity identically');
  assert.notStrictEqual(callSide, Math.round(bytes / 4), 'the old bytes/4 divisor must be gone');
});

h.finish();
