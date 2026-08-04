'use strict';
// An entry's `ts` is when its ASK happened, not when its work last happened.
// memorydb buckets a session's distilled checkpoints onto the entry of whichever
// prompt was current (lib/memorydb.js:147-163), so a long autonomous session
// keeps absorbing fresh summaries while its ts stays pinned at that prompt.
// Observed: session af8d0a70 wrote a summary at 04:06 and its row still read
// 00:40:51.080Z.
//
// localLiveness already knew this and judged local `live` on the session's
// newest event. Sorting did not — it ordered on ts — so an actively running
// session sank below older idle work in the feed, both locally and for the
// teammate reading it. Team rows had the matching hole: `live` was judged on
// the row's authored ts rather than when the row actually arrived.
//
// So both now key on lastActivityAt: the session's newest event for a local
// entry, and the row's created_at (the backend's own insert time) for a team
// row. created_at is real by construction — the daemon pushes within ~60s of
// the work — where the authored ts is not.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const feed = require('../../lib/feed');
const provenance = require('../../lib/provenance');

async function main() {
  const NOW = Date.parse('2026-08-04T05:00:00.000Z');
  const iso = ms => new Date(ms).toISOString();

  check('feed: a long session exposes when it last worked, not just when it was asked', () => {
    // Asked at 00:40, still emitting events a minute ago — the af8d0a70 shape.
    const running = { ts: '2026-08-04T00:40:51.080Z', session: 'long', ask: 'scope the UI work', source: 'Claude Code' };
    const lastEventBySession = new Map([['long', iso(NOW - 60 * 1000)]]);
    const meta = { projectName: 'membridge', authorId: 'me', lastEventBySession, now: NOW };

    const out = feed.normalizeLocal(running, meta);

    assert.strictEqual(out.ts, '2026-08-04T00:40:51.080Z', 'ts still means when the ask happened');
    assert.strictEqual(out.lastActivityAt, iso(NOW - 60 * 1000),
      'lastActivityAt exposes the session\'s newest event, so a caller need not re-derive it');
    assert.strictEqual(out.live, true, 'and four hours after its ask it still reads live');
  });

  check('feed: a team row is judged live on when it arrived, not on the ts it claims', () => {
    // Exactly the shape Marco measured: written minutes ago, stamped hours ago.
    const row = {
      ts: '2026-08-04T00:40:51.080Z',          // authored, stale by 4+ hours
      created_at: iso(NOW - 2 * 60 * 1000),    // actually reached us 2 minutes ago
      author_id: 'marco', author_name: 'marco', source: 'Claude Code', session: 'their-long-one',
    };
    const out = feed.normalizeTeam(row, { selfUserId: 'me', now: NOW });

    assert.strictEqual(out.live, true,
      'a row that arrived two minutes ago is evidence of recent activity, whatever ts claims');
    assert.strictEqual(out.liveBasis, 'synced-row', 'the weaker basis must still be named honestly');
  });

  check('feed: a team row that arrived long ago is not live, however new its claimed ts', () => {
    // The inverse guard: a model that overshoots must not manufacture liveness.
    const row = {
      ts: iso(NOW + 60 * 60 * 1000),            // claims the future
      created_at: '2026-08-04T00:10:00.000Z',   // actually arrived ~5 hours ago
      author_id: 'marco', author_name: 'marco', source: 'Claude Code', session: 'stale',
    };
    const out = feed.normalizeTeam(row, { selfUserId: 'me', now: NOW });
    assert.strictEqual(out.live, false, 'arrival time governs, so a future-dated ts cannot fake live');
  });

  check('feed: a team row with no created_at still falls back to its ts', () => {
    const row = {
      ts: iso(NOW - 60 * 1000),
      author_id: 'marco', author_name: 'marco', source: 'Claude Code', session: 'nocreated',
    };
    const out = feed.normalizeTeam(row, { selfUserId: 'me', now: NOW });
    assert.strictEqual(out.live, true, 'older backends send no created_at; ts remains the fallback');
  });

  // fileProvenance is what the MCP's get_recent_activity answers from, so it is
  // the surface a teammate literally asks "what is Andrew doing" through. It
  // carried the same team-row hole as the feed.
  check('provenance: a team row is judged live on arrival, matching the feed', () => {
    const projectPath = '/tmp/mb-prov-fixture';
    const proj = {
      events: [],
      teamEntries: [{
        author: 'marco', source: 'Claude Code', session: 'their-long-one',
        ts: '2026-08-04T00:40:51.080Z',         // authored, hours stale
        created_at: iso(NOW - 2 * 60 * 1000),   // actually arrived 2 minutes ago
        files: ['a.js'], summary: 'still working on it',
      }],
    };
    const rows = provenance.fileProvenance(projectPath, proj, {}, `${projectPath}/a.js`, NOW);
    const theirs = rows.find(r => r.who === 'marco');
    assert.ok(theirs, 'the team row must be returned for the file it touched');
    assert.strictEqual(theirs.live, true,
      'a row that arrived two minutes ago reads live here exactly as it does in the feed');
    assert.strictEqual(theirs.liveBasis, 'synced-row');
  });

  h.finish();
}

main();
