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

  // --- the edit-capturing inference: what it costs, pinned deliberately ---
  //
  // classify decides shareability from edits, and decides WHICH SOURCES CAN BE
  // JUDGED BY EDITS by observing whether that source has emitted at least one
  // edit in this project's retained history. That is order-dependent, and the
  // question of whether it should instead key on a DECLARED per-adapter
  // capability was investigated and answered NO. These two checks record both
  // halves of the answer so the next person does not repeat the attempt without
  // seeing the cost.
  //
  // THE COST OF KEEPING IT (check 1). On a project with no recorded Claude Code
  // edits, Claude Code does not yet look edit-capturing, so its zero-edit ops
  // sessions are shareable — they reach the feed, the CLAUDE.md block and the
  // team push. Identical sessions are suppressed later in the same project's
  // life, once any edit has been recorded. The push is one-way and filtered on
  // the emitting machine, so the later re-classification CANNOT retract what the
  // earlier one already sent: a teammate keeps those ops sessions permanently.
  //
  // THE COST OF REPLACING IT, measured rather than assumed. Declaring
  // `reportsEdits: true` on the Claude Code adapter and consulting that instead
  // failed 21 checks across the whole product — team push, injection, feed, MCP
  // and, decisively, backfill/adoption. Those are the HISTORY-RECOVERY paths: a
  // project adopted with `add --backfill` recovers prompts and summaries from
  // transcripts without necessarily reconstructing edits, so a declaration would
  // suppress genuinely useful history exactly where a user is trying to get it
  // back. Silently hiding real work is a worse failure than showing some ops
  // noise, so the fail-open bias stays.
  //
  // What would change the answer: making edit capture reliable enough on the
  // recovery paths that absence of edits really does mean absence of work. That
  // is a product decision about prompt-only history, not a mechanical fix.
  {
    const classify = require('../../lib/classify');
    const ccOps = [
      { ts: '2026-07-20T09:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'ops1', text: 'what does this do' },
      { ts: '2026-07-20T09:01:00.000Z', source: 'Claude Code', kind: 'summary', session: 'ops1', text: 'explained it' },
    ];

    check('classify: a zero-edit session IS shareable while its source has no recorded edits (fresh/backfilled project)', () => {
      assert.ok(classify.isShareableLocal(ccOps, 'ops1'),
        'with no Claude Code edit anywhere in history, edits cannot be the yardstick yet — '
        + 'this is what keeps backfilled prompt-only history visible, and it is also how '
        + 'fresh-project ops noise reaches the team push');
    });

    check('classify: the SAME session stops being shareable once any edit is recorded — the verdict is history-dependent', () => {
      // One unrelated edit, in a DIFFERENT session, flips the verdict for ops1.
      // Nothing about ops1 changed. That is the order-dependence, stated as a
      // property rather than left to be rediscovered.
      const withEdit = ccOps.concat([
        { ts: '2026-07-20T10:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'work1', text: 'fix the bug' },
        { ts: '2026-07-20T10:01:00.000Z', source: 'Claude Code', kind: 'edit', session: 'work1', file: '/p/a.js' },
      ]);
      assert.ok(!classify.isShareableLocal(withEdit, 'ops1'),
        'once Claude Code is observed edit-capturing, its zero-edit sessions are suppressed');
      assert.ok(classify.isShareableLocal(withEdit, 'work1'), 'and the session that edited stays');
      // Codex is never judged by edits, whatever else is in history.
      const withCodex = withEdit.concat([
        { ts: '2026-07-20T11:00:00.000Z', source: 'Codex', kind: 'prompt', session: 'cx1', text: 'review this' },
      ]);
      assert.ok(classify.isShareableLocal(withCodex, 'cx1'),
        'a source that never reports edits must never be suppressed by another source\'s edits');
    });
  }

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
