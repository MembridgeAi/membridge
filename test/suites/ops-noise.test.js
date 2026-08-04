'use strict';
// Extracted verbatim from test/run-tests.js. Shared plumbing lives in
// test/harness.js; run this file directly, or via `node test/run.js ops-noise`.
// --- ops-noise suppression (classify + feed/push/block filters) ---
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, BIN, jsonl, read, readSource, count, notRoot, realCanon,
  startJsonMock, waitForHttp, post, httpGet, httpPost } = h;
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('../../lib/util');
const digest = require('../../lib/digest');
const memorydb = require('../../lib/memorydb');
const feed = require('../../lib/feed');

async function main() {
  // --- ops-noise suppression (classify + feed/push/block filters) ---
  {
    const classify = require('../../lib/classify');
    // Edit file lives OUTSIDE the project so it is dropped from rendered files
    // (no git/deriveChanges on a fake path) — the edit EVENT still marks the
    // session shareable, which is what these filters key on.
    const opsProj = { events: [
      { ts: '2026-07-20T09:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'ops', text: 'open browser' },
      { ts: '2026-07-20T09:01:00.000Z', source: 'Claude Code', kind: 'summary', session: 'ops', text: 'the tab is open now' }, // no edit -> ops noise
      { ts: '2026-07-20T09:02:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'code', text: 'fix bug' },
      { ts: '2026-07-20T09:03:00.000Z', source: 'Claude Code', kind: 'edit', session: 'code', file: '/outside-proj/a.js' },
      // Codex never emits edit events, so its zero-edit sessions must still show.
      { ts: '2026-07-20T09:04:00.000Z', source: 'Codex', kind: 'prompt', session: 'cx', text: 'refactor the parser' },
      { ts: '2026-07-20T09:05:00.000Z', source: 'Codex', kind: 'summary', session: 'cx', text: 'parser refactor done' },
    ] };

    check('classify: suppresses zero-edit sessions from edit-capturing tools, exempts Codex', () => {
      const set = classify.shareableSessions(opsProj.events);
      assert.ok(!set.has('ops'), 'zero-edit Claude Code session must be suppressed');
      assert.ok(set.has('code'), 'a Claude Code session with an edit must be shareable');
      assert.ok(set.has('cx'), 'a Codex session (never emits edits) must always be shareable');
      assert.strictEqual(classify.isShareableLocal(opsProj.events, 'ops'), false);
      assert.strictEqual(classify.isShareableLocal(opsProj.events, 'cx'), true);
      const filtered = classify.filterShareableEntries(
        [{ session: 'ops' }, { session: 'code' }, { session: 'cx' }], opsProj.events);
      assert.deepStrictEqual(filtered.map(e => e.session), ['code', 'cx']);
      // Fail-open: garbage never throws.
      assert.deepStrictEqual([...classify.shareableSessions(null)], []);
      assert.strictEqual(classify.isShareableLocal(null, 'x'), false);
    });

    check('feed/push: buildEntries source drops zero-edit Claude Code sessions, keeps edits and Codex', () => {
      const all = memorydb.buildEntries(ROOT, opsProj, util.getConfig());
      const sessions = new Set(classify.filterShareableEntries(all, opsProj.events).map(e => e.session));
      assert.ok(!sessions.has('ops'), 'ops-noise session leaked into the feed/push source');
      assert.ok(sessions.has('code'), 'edit session missing from feed/push source');
      assert.ok(sessions.has('cx'), 'Codex session missing from feed/push source');
    });

    check('block: sessionGroups drops zero-edit Claude Code sessions, keeps edits and Codex', () => {
      const groups = digest.sessionGroups(ROOT, opsProj, util.getConfig());
      const asks = new Set(groups.map(g => (g.prompts[0] && g.prompts[0].text) || ''));
      assert.ok(!asks.has('open browser'), 'ops-noise session leaked into the context block');
      assert.ok(asks.has('fix bug'), 'edit session missing from the context block');
      assert.ok(asks.has('refactor the parser'), 'Codex session missing from the context block');
    });
  }

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
