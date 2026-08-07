'use strict';
// NOT_RUN_BY_CI: a manual demonstration harness. CI runs `node test/run.js`,
// which discovers test/suites/*.test.js and test/run-tests.js only. Run by
// hand: `node test/recall-e2e.js` (~0.4s, exits 0 today).
//
// MEASURED, like test/teammate-notes-e2e.js, and the answer is the same —
// though it took a step more work to get there, because the first number
// looked like the opposite. Scored as a mutation runner over lib/recall.js
// (`node test/mutate.js --target lib/recall.js --mode ops --cmd "node
// test/recall-e2e.js"`):
//
//   this file:          21 killed / 48, ALL 21 by a failing assertion
//   split suites:        0 killed / 48
//   the monolith (core): 17 killed / 17 of the sampled subset, 0 survived
//
// So the split suites cover lib/recall.js not at all, and for a moment this
// file looked like the only thing standing over it. It is not: every sampled
// mutant it kills, test/run-tests.js kills too, by assertion. Its coverage is
// real but wholly duplicated by the monolith, so wiring it into CI would add
// wall-clock and no discrimination — the same verdict as the teammate-notes
// harness, reached by a different route.
//
// Sampled, not swept: 8 of the 21 kills were taken to core (expanding to 17
// mutants). The other 13 are UNVERIFIED against core, not cleared.
//
// Task 10: end-to-end proof. Drives the REAL adapter -> ledger -> recall
// store -> PreToolUse hook -> fold pipeline against a throwaway fixture
// repo, so the whole recall-saving-layer feature (docs/superpowers/specs/
// 2026-07-28-membridge-token-reduction-design.md) can be watched working
// before dogfooding it on a real repo.
//
// Opt-in, exactly like test/ledger-equivalence.js -- never wired into
// `npm test` (see package.json's "test" script):
//   node test/recall-e2e.js
//
// Everything lives under a throwaway MEMBRIDGE_HOME; no real network call is
// ever made (MEMBRIDGE_NO_DIAGNOSTICS=1, and nothing here touches
// config.diagnosticsUrl).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'membridge-recall-e2e-'));
process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home');
process.env.MEMBRIDGE_NO_DIAGNOSTICS = '1'; // this run must never attempt a real network call

const util = require('../lib/util');
const claudeAdapter = require('../lib/adapters/claude-code');
const ledgerStore = require('../lib/ledger-store');
const recallStore = require('../lib/recall-store');
const recall = require('../lib/recall');
const hooksRecall = require('../lib/hooks-recall');
const server = require('../lib/server');

const RECALL_ENTRY = path.join(__dirname, '..', 'lib', 'membridge-hook.js');
const PROJECT = path.join(ROOT, 'fixture-repo');
fs.mkdirSync(path.join(PROJECT, 'src'), { recursive: true });
fs.mkdirSync(path.join(PROJECT, '.membridge'), { recursive: true });

console.log(`recall e2e: fixture repo at ${PROJECT}`);

// The PreToolUse hook only ever answers a read inside a project it can
// resolve via state.projects (lib/project-resolve.js's resolveTrackedKey) --
// register the fixture up front, exactly like a real first sync would.
util.saveState({ ...util.loadState(), projects: { [PROJECT]: { events: [], name: 'fixture-repo' } } });

// ---------------------------------------------------------------------------
// Step 1: write real source files. Many small, elidable function bodies so
// the REAL skeletonizer (lib/skeleton.js, falling back to lib/skeleton-strip.js
// when wasm is unavailable) compresses well past the 2.25x serve floor.
// ---------------------------------------------------------------------------
function makeSource(name, n) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(`function ${name}Helper${i}(x) {`);
    lines.push(`  const y = x + ${i};`);
    lines.push(`  doWorkA(y);`);
    lines.push(`  doWorkB(y);`);
    lines.push(`  doWorkC(y);`);
    lines.push(`  return y;`);
    lines.push(`}`);
  }
  return lines.join('\n') + '\n';
}

const FILES = {
  noFollow: 'src/no-follow.js',
  targeted: 'src/targeted.js',
  fullReread: 'src/full-reread.js',
  holdout: 'src/holdout.js',
};
for (const [key, rel] of Object.entries(FILES)) {
  fs.writeFileSync(path.join(PROJECT, rel), makeSource(key, 40));
}

// ---------------------------------------------------------------------------
// Step 2: seed TWO sessions' worth of read history through the REAL adapter
// (lib/adapters/claude-code.js) and the REAL ledger fold (lib/ledger-store.js)
// -- this is what makes each path "hot" (read by more than one session), the
// precondition lib/recall.js's Tier B needs and lib/recall-store.js's warm()
// uses to decide what to skeletonize.
// ---------------------------------------------------------------------------
let clockMs = Date.parse('2026-07-28T09:00:00.000Z');
const clock = () => clockMs;
const nextTs = () => new Date((clockMs += 1000)).toISOString();

function readEntry(sessionId, rel, ts) {
  return {
    type: 'assistant', sessionId, cwd: PROJECT, timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', id: `tu-${crypto.randomUUID()}`, input: { file_path: path.join(PROJECT, rel) } }] },
  };
}

const seedRaw = [];
for (const sid of ['seed-session-1', 'seed-session-2']) {
  for (const rel of Object.values(FILES)) seedRaw.push(readEntry(sid, rel, nextTs()));
}
const seedEvents = claudeAdapter.extractEvents(seedRaw, { pendingCreates: {}, tasks: {} });
assert.strictEqual(seedEvents.length, 8, 'expected 2 sessions x 4 files of seeded read events');

const config = util.getConfig();
ledgerStore.updateLedger(PROJECT, seedEvents, config, clock);
const seededLedger = ledgerStore.readLedger(PROJECT);
for (const rel of Object.values(FILES)) {
  const rec = seededLedger.fileReaders[rel];
  assert.ok(rec && rec.sessions.length === 2, `${rel} must show 2 distinct reading sessions after seeding`);
}
console.log('recall e2e: seeded 2 sessions x 4 files of read history via the real adapter + ledger fold');

// ---------------------------------------------------------------------------
// Step 3: warm the recall store (lib/recall-store.js) off the ledger's own
// hot set -- exactly what lib/scan.js's syncOnce does in production.
// ---------------------------------------------------------------------------
(async () => {
  const warmed = await recallStore.warm(PROJECT, seededLedger.hotPaths, config);
  assert.strictEqual(warmed, Object.keys(FILES).length, 'every hot path must warm to a skeleton entry');
  for (const rel of Object.values(FILES)) {
    const entry = recallStore.get(PROJECT, rel);
    assert.ok(entry && entry.skeleton, `${rel} must have a cached skeleton after warm()`);
  }
  console.log('recall e2e: recall store warmed -- skeletons cached for all 4 hot paths');

  // -------------------------------------------------------------------------
  // Step 4: drive the REAL PreToolUse hook (lib/hooks-recall.js's runRecall,
  // invoked as `membridge hook recall` -- see lib/membridge-hook.js) with
  // realistic payloads, exactly the way test/run-tests.js's recall-hook
  // section does: spawn the entry point and feed the payload on stdin.
  // -------------------------------------------------------------------------
  const bucketFor = (sid, relPath) => crypto.createHash('sha1').update(`${sid}${relPath}`).digest().readUInt32BE(0) % 100;
  function nonHoldoutSession(rel, base) {
    for (let i = 0; i < 1000; i++) {
      const sid = `${base}-${i}`;
      if (bucketFor(sid, rel) >= recall.HOLDOUT_PCT) return sid;
    }
    throw new Error(`could not find a non-holdout session id for ${rel}`);
  }
  function holdoutSession(rel, base) {
    for (let i = 0; i < 1000; i++) {
      const sid = `${base}-${i}`;
      if (bucketFor(sid, rel) < recall.HOLDOUT_PCT) return sid;
    }
    throw new Error(`could not find a holdout-bucket session id for ${rel}`);
  }

  function runHook(sessionId, rel, extra) {
    const payload = { session_id: sessionId, cwd: PROJECT, tool_name: 'Read', tool_input: { file_path: path.join(PROJECT, rel), ...extra } };
    const res = spawnSync(process.execPath, [RECALL_ENTRY, 'recall'], { input: JSON.stringify(payload), encoding: 'utf8' });
    assert.strictEqual(res.status, 0, `hook exited nonzero: ${res.stderr}`);
    assert.strictEqual(res.stderr, '', `hook wrote to stderr: ${res.stderr}`);
    return res.stdout;
  }

  function lastEventTs() {
    const lines = fs.readFileSync(hooksRecall.eventsPath(PROJECT), 'utf8').split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]).ts;
  }

  const sessNoFollow = nonHoldoutSession(FILES.noFollow, 'sess-nofollow');
  const outNoFollow = runHook(sessNoFollow, FILES.noFollow); // full read: no offset/limit
  assert.ok(outNoFollow.includes('noFollowHelper0'), 'served body must include a real, surviving function signature');
  assert.ok(!outNoFollow.toLowerCase().includes('saved'), 'the word "saved" must never appear in served output');
  // No follow-up read is ever simulated for this file -- the serve stays
  // classified 'full' (full avoidance) all the way through the fold below;
  // that is the scenario itself, so there is nothing further to capture here.

  const sessTargeted = nonHoldoutSession(FILES.targeted, 'sess-targeted');
  const outTargeted = runHook(sessTargeted, FILES.targeted);
  assert.ok(outTargeted.includes('targetedHelper0'), 'targeted-scenario serve must include a real function signature');
  const tsTargeted = lastEventTs();

  const sessFullReread = nonHoldoutSession(FILES.fullReread, 'sess-fullreread');
  const outFullReread = runHook(sessFullReread, FILES.fullReread);
  assert.ok(outFullReread.includes('fullRereadHelper0'), 'full-reread-scenario serve must include a real function signature');
  const tsFullReread = lastEventTs();

  const sessHoldout = holdoutSession(FILES.holdout, 'sess-holdout');
  const outHoldout = runHook(sessHoldout, FILES.holdout);
  assert.strictEqual(outHoldout, '', 'a held-out read must produce no served output -- the read proceeds untouched');

  console.log('recall e2e: drove the real hook for 4 scenarios (served x3, held out x1); every served body carries real skeleton content');

  // -------------------------------------------------------------------------
  // Step 5: fold -- settlement pass. Every confirmed serve settles
  // immediately and optimistically (followTokens=0, full avoidance); the
  // held-out read tallies into holdout.skips/callTokens. Clock is injected
  // (lib/ledger-store.js's updateLedger nowFn param) so this pass is
  // deterministic rather than racing the real wall clock.
  // -------------------------------------------------------------------------
  ledgerStore.updateLedger(PROJECT, [], config, () => Date.parse(tsFullReread) + 5000);
  const settledLedger = ledgerStore.readLedger(PROJECT);
  assert.strictEqual(settledLedger.avoided.serves, 3, 'exactly 3 confirmed serves must have settled');
  assert.strictEqual(settledLedger.holdout.skips, 1, 'exactly 1 held-out read must be on record');
  console.log(`recall e2e: settlement pass -- ${settledLedger.avoided.serves} serves settled optimistically, ${settledLedger.holdout.skips} held out`);

  // -------------------------------------------------------------------------
  // Step 6: simulate the session's own follow-up reads and fold a SECOND,
  // CORRECTION pass (spec §7.1's net = callTokens - (skeletonTokens +
  // followTokens)) -- this is the formula Task 6 revised and the one this
  // script exists to prove end to end for all three outcomes.
  // -------------------------------------------------------------------------
  const followTargeted = {
    ts: new Date(Date.parse(tsTargeted) + 120000).toISOString(), // 2 minutes later
    project: PROJECT, source: 'Claude Code', kind: 'read', session: sessTargeted,
    file: path.join(PROJECT, FILES.targeted), tool: 'Read', toolUseId: `tu-follow-${crypto.randomUUID()}`,
    offset: null, limit: 5, // small, TARGETED follow-up -- the skeleton did its job
  };
  const followFullReread = {
    ts: new Date(Date.parse(tsFullReread) + 120000).toISOString(),
    project: PROJECT, source: 'Claude Code', kind: 'read', session: sessFullReread,
    file: path.join(PROJECT, FILES.fullReread), tool: 'Read', toolUseId: `tu-follow-${crypto.randomUUID()}`,
    offset: null, limit: null, // full re-read -- the whole file, again
  };

  const correctClock = Date.parse(followFullReread.ts) + 5000;
  ledgerStore.updateLedger(PROJECT, [followTargeted, followFullReread], config, () => correctClock);
  const finalLedger = ledgerStore.readLedger(PROJECT);

  console.log('recall e2e: correction pass applied (targeted follow-up + full re-read)');

  // -------------------------------------------------------------------------
  // Step 7: assert all THREE outcomes of the §7.1 formula.
  // -------------------------------------------------------------------------
  assert.strictEqual(finalLedger.avoided.serves, 3, 'serves must not change across the correction pass');
  assert.strictEqual(finalLedger.avoided.partialWins, 1, 'exactly the targeted follow-up must classify as a partial win');
  assert.strictEqual(finalLedger.avoided.netNegatives, 1, 'exactly the full re-read must classify as net negative');
  assert.ok(finalLedger.avoided.tokens > 0, 'the project total must still be net positive (§7.1 headline)');

  const targetedRejections = recallStore.get(PROJECT, FILES.targeted).rejections;
  const fullRereadRejections = recallStore.get(PROJECT, FILES.fullReread).rejections;
  assert.strictEqual(targetedRejections, 0, 'a partial win must NEVER trip the rejection counter (spec §7.3)');
  assert.strictEqual(fullRereadRejections, 1, 'a net-negative full re-read must trip the rejection counter exactly once');

  console.log('recall e2e: verified -- no-follow-up (full avoidance), targeted follow-up (partial win, no rejection), full re-read (net negative, 1 rejection)');

  // -------------------------------------------------------------------------
  // Step 8: /api/savings end to end. The fixture project was already
  // registered in state.projects up front (so the hook itself could resolve
  // it) -- savingsPayload reads straight off the ledger this fold just wrote.
  // -------------------------------------------------------------------------
  const savings = server.savingsPayload();
  assert.ok(savings.totals.avoided.tokens > 0, '/api/savings.avoided.tokens must be > 0 end to end');

  // -------------------------------------------------------------------------
  // Step 9: the human-readable summary Marco actually reads.
  // -------------------------------------------------------------------------
  const summary = `answered ${finalLedger.avoided.serves} reads, ${finalLedger.avoided.tokens} tokens of file reading avoided ` +
    `(${finalLedger.avoided.partialWins} partial wins, ${finalLedger.avoided.netNegatives} net-negative), holdout skipped ${finalLedger.holdout.skips}`;
  assert.ok(!summary.toLowerCase().includes('saved'), 'the word "saved" must never appear (spec §8.2)');
  console.log(`\nrecall e2e: ${summary}`);
  console.log('recall e2e: PASSED');

  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
})().catch(err => {
  console.error('recall e2e: FAILED');
  console.error(err);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
