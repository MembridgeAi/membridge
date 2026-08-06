'use strict';
// #64 — /api/projects now carries the two derived fields the Projects page used
// to compute by fetching a full merged feed page alongside every open.
//
// THE MEASURED PROBLEM. LocalDaemonClient.getProjects() at :387 issues
// Promise.all([get /api/projects, this.feed(), this.getStatus()]) and calls
// mapProjectRow(row, f.entries, ...). Only two fields need those feed entries:
// latestSummary and recentAuthorIds. On a 250ms/request backend, measured with
// the same real-daemon HTTP harness as T-60 and #65:
//
//   /api/projects alone   21ms   backend round trips: 0
//   /api/feed?limit=100   808ms  backend round trips: 2  (my_teams + a
//                                                        member_pubkeys POST — #63)
//   concurrent pair       826ms  — first paint waits for the slower
//
// The feed dominates by 40x, and one of its two round trips is an
// authenticated WRITE on a read path (see #63). This suite pins the daemon
// half of the fix: the two fields are on the row, no new I/O, no writes on the
// read path, so once the client drops the feed call first paint drops with it.
//
// THE BEHAVIOUR CHANGE, DELIBERATE. The old client derivation was
//   "newest headline || summary in this project's slice of the newest 100
//    merged entries across every project"
// — which returned null for a project whose newest activity was #150 in the
// merged feed. Same top-N-page defect the Insights code fixed once already
// (api-insights.js's "97 shared entries" incident note): a per-project figure
// derived from a page shared with every other project cannot be honest at
// scale. Server-side computation is scoped to THIS project's own events, so a
// summary reappears for projects the old code silently dropped. A correction,
// not a regression — the alternative (a per-project /api/projects that still
// consulted the merged feed) would have been the same defect one endpoint
// over.
//
// WHAT THESE CANNOT PROVE. UI-side first-paint. This is the daemon contract;
// the client change (drop this.feed() from getProjects()) is a UI ticket and
// its own suite lives in ui/. Nor do these measure latency — they check
// shape, redaction, freshness ordering, and that the payload reaches the row
// without a new dependency being added along the way.
//
// Run directly, or via `node test/run.js projects-payload`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const memorydb = require('../../lib/memorydb');
const server = require('../../lib/server');

const SECRET = 'sk-live-should-never-appear-on-the-wire';

// A project with a mix of events, including a summary carrying a headline, a
// later summary without one, a team row from a teammate, and a plain-text
// summary that mentions a secret this suite must never see in the payload.
function makeProject(name, opts = {}) {
  const key = path.join(ROOT, 'projects', name);
  fs.mkdirSync(path.join(key, '.git'), { recursive: true });
  fs.mkdirSync(path.join(key, memorydb.DIR_NAME), { recursive: true });

  const st = util.loadState();
  st.projects = st.projects || {};
  st.projects[key] = {
    events: opts.events || [],
    teamEntries: opts.teamEntries || [],
    teamPullTs: opts.teamPullTs || null,
  };
  util.saveState(st);
  return key;
}

const rowFor = key => server.projectsPayload().find(p => p.path === key);

function main() {
  util.ensureConfig();

  // ---- latestSummary: newest headline OR summary text, from THIS project ---
  const projA = makeProject('a', {
    events: [
      { ts: '2026-08-01T10:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 's1', text: 'plumb the counter' },
      { ts: '2026-08-01T10:05:00.000Z', source: 'Claude Code', kind: 'summary', session: 's1',
        text: 'wired the counter end-to-end', headline: 'counter wired' },
      { ts: '2026-08-02T10:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 's2', text: 'ship the label' },
      { ts: '2026-08-02T10:07:00.000Z', source: 'Claude Code', kind: 'summary', session: 's2',
        text: 'shipped the label without a headline' },
    ],
  });

  check('latestSummary carries the newest summary EVENT, not the newest prompt', () => {
    const row = rowFor(projA);
    assert.ok(row.latestSummary, 'expected a latestSummary for a project with summary events');
    assert.strictEqual(row.latestSummary.text, 'shipped the label without a headline',
      'the newest summary has no headline, so its text is what surfaces');
    assert.strictEqual(row.latestSummary.at, '2026-08-02T10:07:00.000Z');
  });

  check('latestSummary prefers a headline over the body when the summary has one', () => {
    // Make the older, headline-carrying summary the newest by removing the
    // second summary and re-running the pass.
    const st = util.loadState();
    st.projects[projA].events = st.projects[projA].events.slice(0, 2);
    util.saveState(st);
    const row = rowFor(projA);
    assert.strictEqual(row.latestSummary.text, 'counter wired',
      'when a summary carries a headline, that is what a card should read');
  });

  check('latestSummary is null when the project has only prompts (no summary events)', () => {
    const key = makeProject('prompt-only', {
      events: [
        { ts: '2026-08-01T10:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 's1', text: 'no summary yet' },
      ],
    });
    const row = rowFor(key);
    assert.strictEqual(row.latestSummary, null, 'a project without summaries has nothing to summarise');
  });

  check('latestSummary is null on an empty project record', () => {
    const key = makeProject('empty');
    const row = rowFor(key);
    assert.strictEqual(row.latestSummary, null);
  });

  check('latestSummary re-runs redaction at the payload boundary — secrets never leak on the wire', () => {
    // The rule every free-text field on this daemon follows: server content is
    // re-redacted at the read boundary, same as the feed and the injected
    // block. redactDefaults is on in the test config.
    const key = makeProject('secretive', {
      events: [
        { ts: '2026-08-01T10:00:00.000Z', source: 'Claude Code', kind: 'summary', session: 's1',
          text: `landed the change; do not commit ${SECRET}` },
      ],
    });
    const row = rowFor(key);
    assert.ok(row.latestSummary.text.includes('[redacted'),
      `expected a redaction marker, got: ${row.latestSummary.text}`);
    assert.ok(!row.latestSummary.text.includes(SECRET),
      'the secret must never reach the JSON — this endpoint is behind loopback but the rule holds regardless');
  });

  // ---- recentAuthorIds: distinct teammate ids from the cached row set ----
  check('recentAuthorIds is drawn from cached teammate rows, deduped, ordered stably', () => {
    // The old client-side derivation scanned merged feed entries filtered to
    // this project — normalized team rows carry projectPath=null (lib/feed.js
    // normalizeTeam), so it filtered by projectId; that means only projects
    // whose newest team row survived the 100-row page cap contributed IDs.
    // Server-side reads teamRowsFor directly, so the top-N cap is gone.
    const now = '2026-08-05T12:00:00.000Z';
    const key = makeProject('team', {
      teamEntries: [
        { id: '1', ts: now, created_at: now, author_id: 'mate-1', author_name: 'One' },
        { id: '2', ts: now, created_at: now, author_id: 'mate-2', author_name: 'Two' },
        { id: '3', ts: now, created_at: now, author_id: 'mate-1', author_name: 'One' }, // dup
      ],
    });
    const row = rowFor(key);
    assert.deepStrictEqual(row.recentAuthorIds.sort(), ['mate-1', 'mate-2'],
      'exactly the distinct set of author_ids on cached team rows');
  });

  check('recentAuthorIds is [] when the project has no cached team rows', () => {
    // The common solo/unlinked case must not fabricate a set from local
    // events — recentAuthorIds is about who ELSE has been here.
    const key = makeProject('solo', {
      events: [
        { ts: '2026-08-01T10:00:00.000Z', source: 'Claude Code', kind: 'summary', session: 's1',
          text: 'ships alone', headline: 'solo work' },
      ],
    });
    const row = rowFor(key);
    assert.deepStrictEqual(row.recentAuthorIds, [], 'a solo project has no teammate ids');
  });

  check('recentAuthorIds is [] on a project with teamAccessLost — the row gate covers it', () => {
    // teamRowsFor returns [] for a teamAccessLost project, so a revoked
    // project's cached rows never surface here. Same rule every other reader
    // of team rows follows; this endpoint inherits it because it reads through
    // util.teamRowsFor and not around it.
    const key = makeProject('revoked', {
      teamEntries: [{ id: '1', ts: '2026-08-01T00:00:00.000Z', author_id: 'mate-x', author_name: 'X' }],
    });
    const st = util.loadState();
    st.projects[key].teamAccessLost = '2026-08-02T00:00:00.000Z';
    util.saveState(st);
    const row = rowFor(key);
    assert.deepStrictEqual(row.recentAuthorIds, [],
      'a revoked project must not surface teammate ids from stale cached rows');
  });

  // ---- the property the whole ticket exists to fix ------------------------
  check('projectsPayload makes no network call and does not shell out to git', () => {
    // The two things the coordinator told me to check early. `fetch` is
    // overridden to a rejecting stub, and child_process.spawn is patched to
    // throw on any call. Both raise on the payload path if anything sneaks in.
    const realFetch = global.fetch;
    const cp = require('child_process');
    const realSpawn = cp.spawn;
    const realSpawnSync = cp.spawnSync;
    let netCalls = 0; let gitCalls = 0;
    global.fetch = () => { netCalls++; throw new Error('projectsPayload must not open a network connection'); };
    cp.spawn = (bin, args) => {
      if (/git/.test(String(bin))) { gitCalls++; throw new Error(`projectsPayload must not fork git: ${bin} ${(args||[]).join(' ')}`); }
      return realSpawn.apply(cp, arguments);
    };
    cp.spawnSync = (bin, args) => {
      if (/git/.test(String(bin))) { gitCalls++; throw new Error(`projectsPayload must not fork git: ${bin} ${(args||[]).join(' ')}`); }
      return realSpawnSync.apply(cp, arguments);
    };
    try {
      // Run against the whole set the earlier checks built, not just one row.
      const rows = server.projectsPayload();
      assert.ok(Array.isArray(rows) && rows.length > 0, 'sanity: some projects should exist');
      assert.strictEqual(netCalls, 0);
      assert.strictEqual(gitCalls, 0);
    } finally {
      global.fetch = realFetch;
      cp.spawn = realSpawn;
      cp.spawnSync = realSpawnSync;
    }
  });

  check('every row carries the two new fields, so the client can drop the feed call without a shape branch', () => {
    // The contract half. If any row is missing one of the fields, the client
    // is forced to keep the feed fetch as a fallback — which is exactly the
    // dependency this ticket removes.
    const rows = server.projectsPayload();
    for (const r of rows) {
      assert.ok(Object.prototype.hasOwnProperty.call(r, 'latestSummary'),
        `every row must carry latestSummary; missing on ${r.path}`);
      assert.ok(Object.prototype.hasOwnProperty.call(r, 'recentAuthorIds'),
        `every row must carry recentAuthorIds; missing on ${r.path}`);
      assert.ok(Array.isArray(r.recentAuthorIds), 'recentAuthorIds must be an array (possibly empty)');
    }
  });

  h.finish();
}

main();
