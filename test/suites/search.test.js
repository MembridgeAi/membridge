'use strict';
// Extracted verbatim from test/run-tests.js. Shared plumbing lives in
// test/harness.js; run this file directly, or via `node test/run.js search`.
// --- 14b. search engine (lib/search.js): pure ranked scoring ---
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, BIN, jsonl, read, readSource, count, notRoot, realCanon,
  startJsonMock, waitForHttp, post, httpGet, httpPost } = h;
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  // --- 14b. search engine (lib/search.js): pure ranked scoring ---
  {
    const search = require('../../lib/search');

    check('search: tokenize keeps identifiers and file names whole, drops stopwords', () => {
      assert.deepStrictEqual(search.tokenize('Rotated auth.js and JWT_SECRET handling.'),
        ['rotated', 'auth.js', 'jwt_secret', 'handling']);
      assert.deepStrictEqual(search.tokenize('the and of'), []);
      assert.deepStrictEqual(search.tokenize(''), []);
      assert.deepStrictEqual(search.tokenize(null), []);
    });

    check('search: deliberate fields (decisions) outrank harvested prose (summary)', () => {
      const a = { ts: '2026-07-01T00:00:00.000Z', summary: 'touched auth flow' };
      const b = { ts: '2025-01-01T00:00:00.000Z', decisions: 'auth stays in middleware' };
      const ranked = search.rankEntries([a, b], 'auth');
      assert.strictEqual(ranked.length, 2);
      assert.strictEqual(ranked[0].decisions, 'auth stays in middleware');
      assert.ok(ranked[0].score > ranked[1].score);
    });

    check('search: an old exact hit beats a recent partial one (no recency weighting)', () => {
      const recentPartial = { ts: '2026-07-01T00:00:00.000Z', summary: 'token cleanup pass' };
      const oldExact = {
        ts: '2026-01-01T00:00:00.000Z', headline: 'rewrote token refresh',
        decisions: 'token refresh lives in the gotrue passthrough',
        files: ['lib/token-refresh.js'],
      };
      const ranked = search.rankEntries([recentPartial, oldExact], 'token refresh');
      assert.strictEqual(ranked[0].headline, 'rewrote token refresh');
    });

    check('search: multi-term queries are AND-biased — one flooded term is not a match', () => {
      const noise = { ts: '2026-07-01T00:00:00.000Z', summary: 'auth auth auth everywhere auth' };
      assert.deepStrictEqual(search.rankEntries([noise], 'auth vault rotation epochs'), []);
    });

    // Fix #1 (final whole-branch review, Finding #1): rankEntries/scoreEntry
    // grew an opts.minTerms override so lib/mcp.js can relax the AND-bias as
    // a fallback pass without this module holding any fallback policy itself.
    check('search: minTerms is off by default — omitting opts is byte-identical to the old strict-majority behavior', () => {
      const partial = { ts: '2026-07-01T00:00:00.000Z', summary: 'only vault, no other terms' };
      assert.deepStrictEqual(search.rankEntries([partial], 'vault rotation epochs'), [],
        'a one-of-three-term match must still score 0 with no opts passed');
    });

    check('search: minTerms:1 relaxes the AND-bias — a one-term match now scores', () => {
      const partial = { ts: '2026-07-01T00:00:00.000Z', summary: 'only vault, no other terms' };
      const ranked = search.rankEntries([partial], 'vault rotation epochs', { minTerms: 1 });
      assert.strictEqual(ranked.length, 1, 'minTerms:1 must let a single matched term through');
      assert.deepStrictEqual(ranked[0].matched, ['summary']);
    });

    check('search: minTerms never loosens a query that already has a strict match — the AND-bias survives when results exist', () => {
      const full = { ts: '2026-07-01T00:00:00.000Z', decisions: 'vault rotation happens every epoch' };
      const partial = { ts: '2026-06-01T00:00:00.000Z', decisions: 'vault only, nothing else here' };
      const ranked = search.rankEntries([full, partial], 'vault rotation epochs');
      assert.strictEqual(ranked.length, 1, 'the strict pass must exclude the one-term partial match');
      assert.strictEqual(ranked[0].decisions, 'vault rotation happens every epoch');
    });

    check('search: file-only team rows are findable (ask/summary null on most team rows)', () => {
      const row = { ts: '2026-07-01T00:00:00.000Z', ask: null, summary: null, files: ['infra/vault.tf'] };
      const ranked = search.rankEntries([row], 'vault');
      assert.strictEqual(ranked.length, 1);
      assert.deepStrictEqual(ranked[0].matched, ['files']);
    });

    check('search: rankEntries never mutates its inputs', () => {
      const e = { ts: '2026-07-01T00:00:00.000Z', summary: 'auth' };
      const before = JSON.stringify(e);
      search.rankEntries([e], 'auth');
      assert.strictEqual(JSON.stringify(e), before);
    });

    check('search: equal scores tiebreak newest-first', () => {
      const older = { ts: '2026-01-01T00:00:00.000Z', summary: 'vault work' };
      const newer = { ts: '2026-06-01T00:00:00.000Z', summary: 'vault work' };
      const ranked = search.rankEntries([older, newer], 'vault');
      assert.strictEqual(ranked[0].ts, '2026-06-01T00:00:00.000Z');
    });
  }

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
