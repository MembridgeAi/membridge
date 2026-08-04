'use strict';
// Extracted verbatim from test/run-tests.js. Shared plumbing lives in
// test/harness.js; run this file directly, or via `node test/run.js save-state`.
// --- 31. saveState: atomic write (temp file + rename) ---
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, BIN, jsonl, read, readSource, count, notRoot, realCanon,
  startJsonMock, waitForHttp, post, httpGet, httpPost } = h;
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('../../lib/util');
const feed = require('../../lib/feed');

async function main() {
  // Suite-local seed: in the monolith this section ran after earlier syncs had
  // already written state.json. Standalone, create the "previously-good file"
  // the atomic-write probes below exist to protect.
  util.saveState({ version: util.STATE_VERSION, files: {}, projects: { '/tmp/seed-project': { events: [] } } });

  // --- 31. saveState: atomic write (temp file + rename) ---
  // The app and CLI daemons can both rewrite state.json; a crash or a write
  // error mid-save must never destroy the previously-good file. We prove
  // this by letting the real write actually land (so old direct-write code
  // truly mutates the file) and then forcing the underlying call to raise —
  // an atomic (write-temp, then rename) implementation only ever writes the
  // temp path, so the real state.json is untouched no matter when the
  // injected failure fires.
  {
    const priorRaw = read(util.statePath());

    check('saveState: a failed write leaves the previous state.json byte-for-byte intact', () => {
      const realWriteFileSync = fs.writeFileSync;
      fs.writeFileSync = function (...args) {
        const result = realWriteFileSync.apply(fs, args); // the write itself really happens...
        throw new Error('simulated disk failure after write'); // ...but the call still reports failure
      };
      try {
        assert.throws(
          () => util.saveState({ version: util.STATE_VERSION, files: {}, projects: { marker: { events: [] } } }),
          /simulated disk failure/,
          'saveState swallowed the write failure instead of propagating it'
        );
      } finally {
        fs.writeFileSync = realWriteFileSync;
      }
      assert.strictEqual(read(util.statePath()), priorRaw,
        'state.json changed even though the save reported failure — writes are not atomic');
      const leftovers = fs.readdirSync(util.homeDir()).filter(f => f.endsWith('.tmp'));
      assert.deepStrictEqual(leftovers, [], 'a temp file was left behind after a failed save');
    });

    check('saveState: happy path still round-trips through loadState', () => {
      const fresh = {
        version: util.STATE_VERSION,
        files: {},
        projects: { '/tmp/atomic-roundtrip-project': { events: [{ kind: 'prompt', session: 's1', ts: '2026-07-18T00:00:00.000Z', text: 'atomic write check' }] } },
        catchup: { ...util.DEFAULT_CATCHUP },
        feedback: { ...util.DEFAULT_FEEDBACK },
      };
      util.saveState(fresh);
      assert.deepStrictEqual(util.loadState(), fresh, 'state did not round-trip through save/load');
      const leftovers = fs.readdirSync(util.homeDir()).filter(f => f.endsWith('.tmp'));
      assert.deepStrictEqual(leftovers, [], 'a temp file was left behind after a successful save');
    });

    // Restore the real accumulated state so nothing after this section (just
    // the summary print below) is affected by these probes.
    fs.writeFileSync(util.statePath(), priorRaw);
  }

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
