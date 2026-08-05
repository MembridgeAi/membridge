'use strict';
// "What is Andrew doing right now" — the teammate-presence read.
//
// This question had no answer before: get_recent_activity took a limit and
// nothing else, so narrowing to one person meant pulling a page of everyone
// and hoping they appeared in it. search_memory ranks by relevance with
// deliberately NO recency weighting, so it answers "what has Andrew worked on"
// and cannot answer "what is he on now".
//
// The honest part matters as much as the filter. This is a LOCAL read of rows
// team sync already pulled, so the truthful answer is "as of N minutes ago",
// never a bare "right now" — and after the ingest-stamp fix (PR #17) the
// freshness figure is finally trustworthy, because a teammate row's
// lastActivityAt is when it reached the backend rather than a timestamp a
// model estimated.
//
// Run directly, or via `node test/run.js presence`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const iso = msAgo => new Date(Date.now() - msAgo).toISOString();

function teamRow(overrides) {
  return {
    author: 'andrewludwigbrown', ts: iso(3 * 60 * 1000), source: 'Claude Code',
    session: 't1', ask: null, goal: null, summary: null, decisions: null,
    gotchas: null, headline: null, distilled: true, files: [], changes: null,
    ...overrides,
  };
}

async function main() {
  const util = require('../../lib/util');
  const activity = require('../../lib/activity');

  const projPath = path.join(ROOT, 'projects', 'presence-app');
  fs.mkdirSync(path.join(projPath, '.membridge'), { recursive: true });
  {
    const state = util.loadState();
    state.projects[projPath] = {
      events: [],
      teamEntries: [
        teamRow({
          session: 'andrew-now', ts: iso(2 * 60 * 1000), created_at: iso(2 * 60 * 1000),
          headline: 'Rewriting the invite redemption path',
          summary: 'invite links now redeem against the right table',
          files: ['lib/teamsync.js'],
        }),
        teamRow({
          session: 'andrew-old', ts: iso(40 * 24 * 3600 * 1000), created_at: iso(40 * 24 * 3600 * 1000),
          headline: 'Old vault rotation work',
          summary: 'rotated the vault credentials',
          files: ['infra/vault.tf'],
        }),
        teamRow({
          author: 'priya', session: 'priya-now', ts: iso(60 * 1000), created_at: iso(60 * 1000),
          headline: 'Tuning the redaction patterns',
          summary: 'added two redaction patterns',
          files: ['lib/redact.js'],
        }),
      ],
    };
    util.saveState(state);
  }

  check('presence: recentActivity narrows to ONE teammate by name substring', () => {
    const { entries } = activity.recentActivity(50, { author: 'andrew' });
    assert.ok(entries.length > 0, 'no entries came back for a teammate who has some');
    for (const e of entries) {
      assert.ok(/andrew/i.test(e.author || ''),
        `an unrelated author leaked into a filtered read: ${e.author}`);
    }
    assert.ok(!entries.some(e => e.session === 'priya-now'), "another teammate's work was returned");
  });

  check('presence: the newest entry leads, so "right now" gets the current work', () => {
    const { entries } = activity.recentActivity(50, { author: 'andrew' });
    assert.strictEqual(entries[0].session, 'andrew-now',
      'a 40-day-old session outranked work from two minutes ago');
    assert.strictEqual(entries[0].headline, 'Rewriting the invite redemption path');
  });

  check('presence: the filter binds BEFORE the limit, not after the page is cut', () => {
    // The failure this pins: filtering a page of N would return however many of
    // that person happened to make the cut — often zero on a busy team — which
    // reads as "Andrew is doing nothing" rather than "ask for more rows".
    const { entries } = activity.recentActivity(1, { author: 'andrew' });
    assert.strictEqual(entries.length, 1, 'a limit of 1 did not yield that teammate\'s newest row');
    assert.strictEqual(entries[0].session, 'andrew-now');
  });

  check('presence: every entry says HOW FRESH it is, so the answer can be honest', () => {
    const { entries } = activity.recentActivity(50, { author: 'andrew' });
    const top = entries[0];
    assert.ok(top.lastActivityAt, 'no lastActivityAt — the agent cannot say how stale this is');
    assert.ok(Number.isFinite(Date.parse(top.lastActivityAt)), 'lastActivityAt is not a real instant');
    assert.strictEqual(top.liveBasis, 'synced-row',
      'a teammate row must declare that its liveness rests on a synced row, not a live session');
  });

  check('presence: a teammate whose newest row is 40 days old does not read as live', () => {
    const { entries } = activity.recentActivity(50, { author: 'andrew' });
    const stale = entries.find(e => e.session === 'andrew-old');
    assert.strictEqual(stale.live, false, 'a 40-day-old row claimed to be live');
  });

  check('presence: an unknown name returns empty, never everybody', () => {
    const { entries } = activity.recentActivity(50, { author: 'nobody-by-this-name' });
    assert.deepStrictEqual(entries, [],
      'an unmatched author filter fell back to returning the whole feed');
  });

  check('presence: no author filter still returns everyone (unchanged contract)', () => {
    const { entries } = activity.recentActivity(50);
    const authors = new Set(entries.map(e => e.author));
    assert.ok(authors.size >= 2, `expected several authors unfiltered, got ${[...authors]}`);
  });

  // --- graded presence ---
  // `live` alone is one flat 15-minute flag, so a row that arrived 20 seconds
  // ago and one that arrived 14 minutes ago are indistinguishable — which is
  // why the tool had to caveat every live flag equally and say "never report
  // this as presence". Grading it removes the need for that blanket hedge:
  // a row inside one sync interval really does mean someone is working.
  //
  // The threshold is DERIVED, not picked. A row's created_at lags the actual
  // work by at most one push interval (config.intervalSec, default 60s), so
  // arrival within one interval bounds the real work at ~2 intervals ago.
  {
    const util2 = require('../../lib/util');

    check('presence: a row that arrived seconds ago is ACTIVE, not merely live', () => {
      assert.strictEqual(util2.presenceOf(iso(20 * 1000), { intervalSec: 60 }), 'active');
    });

    check('presence: a row from several minutes ago is RECENT, not active', () => {
      assert.strictEqual(util2.presenceOf(iso(5 * 60 * 1000), { intervalSec: 60 }), 'recent',
        'five minutes old must not claim someone is at the keyboard');
    });

    check('presence: a row older than the live window is IDLE', () => {
      assert.strictEqual(util2.presenceOf(iso(40 * 60 * 1000), { intervalSec: 60 }), 'idle');
      assert.strictEqual(util2.presenceOf(iso(40 * 24 * 3600 * 1000), { intervalSec: 60 }), 'idle');
    });

    check('presence: the active window SCALES with the configured sync interval', () => {
      // A team syncing every 5 minutes cannot know anything to 60-second
      // precision, and one syncing every 10 seconds should not be told to wait
      // a minute. Hardcoding 90s would be wrong for both.
      const ts = iso(150 * 1000); // 2.5 min old
      assert.strictEqual(util2.presenceOf(ts, { intervalSec: 300 }), 'active',
        'a slow-syncing team never reaches active');
      assert.strictEqual(util2.presenceOf(ts, { intervalSec: 10 }), 'recent',
        'a fast-syncing team called a 2.5-minute-old row active');
    });

    check('presence: garbage or missing timestamps are idle, never active', () => {
      for (const bad of [null, undefined, '', 'not-a-date']) {
        assert.strictEqual(util2.presenceOf(bad, { intervalSec: 60 }), 'idle',
          `presence guessed on ${JSON.stringify(bad)}`);
      }
    });

    check('presence: a future timestamp does not read as active', () => {
      // Exactly the shape the model-authored ts bug produced: 69 minutes ahead.
      assert.strictEqual(util2.presenceOf(iso(-69 * 60 * 1000), { intervalSec: 60 }), 'idle',
        'a future-dated row claimed someone was working');
    });

    check('presence: a LONG session reads as working — prompted long ago, still active', () => {
      // The case a single timestamp cannot express. Someone asks a question,
      // then the agent runs tools for twenty minutes. Judged on the ask, they
      // look gone; judged on their newest activity, they are plainly working.
      // presence is therefore computed from lastActivityAt, never from ts.
      const promptedAt = iso(13 * 60 * 1000);
      const stillGoing = iso(15 * 1000);
      assert.strictEqual(util2.presenceOf(promptedAt, { intervalSec: 60 }), 'recent',
        'fixture: a 13-minute-old prompt is not itself active');
      assert.strictEqual(util2.presenceOf(stillGoing, { intervalSec: 60 }), 'active',
        'the newest activity is what says someone is still working');
    });

    check('presence: entries carry the graded field, so the answer can say "now"', () => {
      const { entries } = activity.recentActivity(50, { author: 'priya' });
      assert.ok(entries.length, 'fixture: priya has a row');
      assert.ok(['active', 'recent', 'idle'].includes(entries[0].presence),
        `expected a graded presence, got ${entries[0].presence}`);
    });
  }

  check('presence: the MCP tool accepts an author and passes it through', () => {
    const mcp = require('../../lib/mcp');
    const out = mcp.getRecentActivity(50, { author: 'andrew' });
    assert.ok(out.entries.length > 0, 'the MCP surface dropped the author filter');
    for (const e of out.entries) {
      assert.ok(/andrew/i.test(e.author || ''), `MCP returned ${e.author} for an andrew filter`);
    }
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
