'use strict';
// The distilled summary's `ts` is authored by the MODEL via the Stop hook, and
// models have no clock — they estimate, and the estimates are both round
// (03:05:00, 03:40:00) and hours stale. Every liveness and ordering decision
// downstream keys on that field: util.isLive's 15-minute window, the feed sort,
// and api-insights' current/prior window split. A teammate whose rows are
// stamped hours late reads as dead while they are actively working.
//
// So the daemon stamps `ts` itself when it ingests a newly appended line — it
// has a real clock and the model does not. The model's claim is kept as
// `claimedTs` rather than dropped, because a checkpoint may legitimately
// describe earlier work; it just must not drive ordering or liveness.
//
// A full-file read (offset 0 — first adoption, or resetOffsetsForAdoption) is
// backfill of historical lines, so the claim is kept there: collapsing a whole
// history to "now" would be worse than rough timestamps.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scan = require('../../lib/scan');
const memorydb = require('../../lib/memorydb');

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-distill-ts-'));
  fs.mkdirSync(path.join(root, memorydb.DIR_NAME), { recursive: true });
  return root;
}

function summaryLine(over) {
  return JSON.stringify(Object.assign({
    session: 'sess-a',
    did: 'Did a thing that matters.',
    headline: 'Did a thing',
  }, over)) + '\n';
}

function appendSummary(root, over) {
  fs.appendFileSync(path.join(root, memorydb.DIR_NAME, 'summaries.jsonl'), summaryLine(over));
}

async function main() {
  const config = { distill: { enabled: true } };

  check('distill ts: a stale model-authored ts on a newly appended line is replaced by ingest time', () => {
    const root = mkProject();
    const state = { projects: { [root]: {} }, files: {} };

    // First read establishes the offset — this is the backfill path.
    appendSummary(root, { ts: '2026-08-04T00:00:00Z' });
    scan.scanSummaries(state, config);

    // Now the steady-state path: a line appended while the daemon is running,
    // carrying the kind of stale round-number estimate a model actually writes.
    const before = Date.now();
    appendSummary(root, { ts: '2026-08-04T03:05:00Z', session: 'sess-b' });
    const events = scan.scanSummaries(state, config);
    const after = Date.now();

    assert.strictEqual(events.length, 1, 'only the newly appended line should be returned');
    const ev = events[0];

    const stamped = Date.parse(ev.ts);
    assert.ok(!Number.isNaN(stamped), `ts must be a parseable date, got ${ev.ts}`);
    assert.ok(
      stamped >= before && stamped <= after,
      `ts must be stamped at ingest, got ${ev.ts} (expected between ${new Date(before).toISOString()} and ${new Date(after).toISOString()})`
    );
    assert.strictEqual(ev.claimedTs, '2026-08-04T03:05:00Z', 'the model claim must be preserved, not dropped');
  });

  check('distill ts: a line with no ts still gets ingest time and claims nothing', () => {
    const root = mkProject();
    const state = { projects: { [root]: {} }, files: {} };
    appendSummary(root, { ts: '2026-08-04T00:00:00Z' });
    scan.scanSummaries(state, config);

    const before = Date.now();
    appendSummary(root, { session: 'sess-c' }); // no ts at all
    const events = scan.scanSummaries(state, config);
    const after = Date.now();

    assert.strictEqual(events.length, 1);
    const stamped = Date.parse(events[0].ts);
    assert.ok(stamped >= before && stamped <= after, `ts must be ingest time, got ${events[0].ts}`);
    assert.strictEqual(events[0].claimedTs, undefined, 'nothing was claimed, so nothing to preserve');
  });

  check('distill ts: a full-file read keeps the claimed ts, so adoption does not collapse history', () => {
    const root = mkProject();
    const state = { projects: { [root]: {} }, files: {} };

    // Three historical lines already on disk before MemBridge ever reads them.
    appendSummary(root, { ts: '2026-08-01T10:00:00Z', session: 's1' });
    appendSummary(root, { ts: '2026-08-02T11:00:00Z', session: 's2' });
    appendSummary(root, { ts: '2026-08-03T12:00:00Z', session: 's3' });

    const events = scan.scanSummaries(state, config);
    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(
      events.map(e => e.ts),
      ['2026-08-01T10:00:00Z', '2026-08-02T11:00:00Z', '2026-08-03T12:00:00Z'],
      'backfill must preserve the historical spread rather than stamping all three "now"'
    );
  });

  h.finish();
}

main();
