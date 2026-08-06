'use strict';
// /api/live-sessions — the "happening now" read, and the one property that
// matters about it: IT MAKES NO NETWORK CALL.
//
// WHY IT EXISTS. The strip used to be served by /api/feed?limit=100, which is
// server.feedPayload: a token refresh, my_teams, a team_feed RPC per membership
// and a crypto-context build, then every entry of every project assembled,
// merged, sorted, sliced and git-diffed. Measured on a real install (10
// projects, 5,227 events, 200 cached team rows) that is ~900ms, ~560ms of it
// network — and it is mounted by the LANDING route and polled every 10s, so a
// Supabase round trip sat on first paint and then repeated forever. Its yield on
// that install was ONE live session.
//
// WHAT THESE CHECKS PIN, in order of how much they would cost to get wrong:
//
//   1. ZERO ROUND TRIPS. Asserted by counting requests against a stub backend
//      that would happily answer them. This is the whole ticket: a passing
//      latency number today does not stop someone adding an `await` tomorrow,
//      but this check does.
//   2. TEAMMATES STILL APPEAR, from util.teamRowsFor's cache. Dropping them
//      would be a silent product regression that no timing number would catch,
//      and the local-only design is only defensible because the cache carries
//      them.
//   3. REVOCATION REACHES THIS PATH. teamAccessLost must suppress the cached
//      rows here exactly as it does everywhere else. A new reader of team rows
//      that forgets the flag is this repo's documented five-readers-one-guard
//      mistake, and a derived read is precisely where it recurs.
//   4. The live WINDOW is honoured in both directions and on the right clock:
//      a session's newest event of ANY kind for local rows, `created_at` (not
//      the pushing machine's `ts`) for team rows.
//   5. One person is one person: a row this account pushed from another machine
//      reads as "You", which needs selfUserId — read off disk, never fetched.
//
// WHAT THESE CANNOT PROVE: real first paint. This suite measures the daemon; the
// client still has to stop asking /api/feed for the strip and paint a skeleton,
// which is a ui/ change and is not in here. Nor do these numbers say anything
// about a real Supabase latency — the stub answers instantly, which is what
// makes "zero requests" the load-bearing assertion rather than a duration.
//
// Run directly, or via `node test/run.js live-sessions`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P } = h;
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const util = require('../../lib/util');
const server = require('../../lib/server');

const STUB_PORT = P(72);
const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const SELF_ID = '11111111-1111-1111-1111-111111111111';
const MATE_ID = '22222222-2222-2222-2222-222222222222';
const iso = minsAgo => new Date(NOW - minsAgo * 60000).toISOString();

// A backend that answers everything and RECORDS every request. If the payload
// path ever reaches the network, this fills up and check 1 fails.
let requests = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/auth/v1/token')) {
      return res.end(JSON.stringify({
        access_token: 'stub-access', refresh_token: 'stub-refresh', expires_in: 3600,
        user: { id: SELF_ID, email: 'self@test.dev', user_metadata: {} },
      }));
    }
    res.end('[]');
  });
});

// A prompt plus a later edit in the same session: the edit is why liveness must
// key on the session's newest event of ANY kind rather than on the entry ts.
function localSession(session, promptMinsAgo, lastEventMinsAgo, text) {
  return [
    { ts: iso(promptMinsAgo), source: 'Claude Code', kind: 'prompt', session, text },
    { ts: iso(lastEventMinsAgo), source: 'Claude Code', kind: 'edit', session, file: 'lib/thing.js' },
  ];
}

// A pulled teammate row in wire shape, as syncTeams caches it in
// proj.teamEntries. `created_at` is ARRIVAL and is what liveness is judged on;
// `ts` is authored on the pushing machine and is deliberately stale here.
function teamRow({ author, authorId, session, tsMinsAgo, arrivedMinsAgo, summary }) {
  return {
    id: `row-${session}`,
    ts: iso(tsMinsAgo),
    created_at: iso(arrivedMinsAgo),
    author, author_id: authorId, author_name: author,
    source: 'Codex', session, project_name: 'shared-app',
    ask: 'teammate ask', summary, files: ['lib/other.js'],
  };
}

function project(name, patch) {
  const key = path.join(ROOT, 'live-projects', name);
  fs.mkdirSync(key, { recursive: true });
  const st = util.loadState();
  st.projects[key] = { events: [], ...patch };
  util.saveState(st);
  return key;
}

const sessionsOf = out => (out.sessions || []).map(s => `${s.origin}:${s.author}:${s.session}`).sort();

async function main() {
  await new Promise(r => stub.listen(STUB_PORT, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${STUB_PORT}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'stub-anon';
  // Credentials on disk, as a signed-in install has them. The payload must read
  // its own user id from HERE (a JSON.parse) and never from a token refresh.
  fs.mkdirSync(util.homeDir(), { recursive: true });
  fs.writeFileSync(path.join(util.homeDir(), 'credentials.json'), JSON.stringify({
    userId: SELF_ID, accessToken: 'stored-access', refreshToken: 'stored-refresh',
    expiresAt: new Date(NOW - 3600000).toISOString(), // EXPIRED: a refresh would be tempting
  }));

  // Project A: one live local session, one long-dead one.
  const LIVE_MINS = 2;
  const DEAD_MINS = 120;
  const projA = project('alpha', {
    events: [
      ...localSession('sess-live', 30, LIVE_MINS, 'make the strip fast'),
      ...localSession('sess-dead', DEAD_MINS + 10, DEAD_MINS, 'something from this morning'),
    ],
  });
  // Project B: no local events at all, only cached teammate rows — one that
  // arrived just now, one that arrived hours ago, and one whose AUTHORED ts is
  // fresh while its arrival is stale (the wrong-clock catcher).
  const projB = project('beta', {
    teamPullTs: iso(1),
    teamEntries: [
      teamRow({ author: 'Mate', authorId: MATE_ID, session: 'mate-live', tsMinsAgo: 200, arrivedMinsAgo: 3, summary: 'Mate is on it.' }),
      teamRow({ author: 'Mate', authorId: MATE_ID, session: 'mate-old', tsMinsAgo: 300, arrivedMinsAgo: 300, summary: 'Old news.' }),
      teamRow({ author: 'Mate', authorId: MATE_ID, session: 'mate-freshts', tsMinsAgo: 1, arrivedMinsAgo: 400, summary: 'Authored recently, arrived long ago.' }),
    ],
  });

  const call = () => { requests = []; return server.liveSessionsPayload({ now: NOW }); };

  await check('makes ZERO network requests — the property the whole endpoint exists for', () => {
    const out = call();
    assert.ok(out && Array.isArray(out.sessions), 'must return a payload');
    assert.deepStrictEqual(requests, [],
      `a polled read must not touch the backend, got: ${requests.join(' | ')}`);
    // And it is synchronous, which is what makes the above hard to regress: a
    // function that returns a value cannot await a round trip.
    assert.strictEqual(typeof out.then, 'undefined', 'liveSessionsPayload must not return a promise');
  });

  await check('a live local session is served, and a dead one is not', () => {
    const out = call();
    const local = out.sessions.filter(s => s.origin === 'local');
    assert.deepStrictEqual(local.map(s => s.session), ['sess-live'],
      'only the session whose newest event is inside the window');
    assert.strictEqual(local[0].live, true);
    assert.strictEqual(local[0].liveBasis, 'session-events', 'a local row is judged on its own events');
    assert.strictEqual(local[0].author, 'You');
    assert.strictEqual(local[0].authorId, SELF_ID, 'own id must come off disk, not from a refresh');
    assert.strictEqual(local[0].projectPath, projA);
    assert.deepStrictEqual(local[0].changes, [],
      'no git derivation on this path — the strip shows no file list');
    assert.strictEqual('_highlights' in local[0], false,
      'the deferred-change carrier must never reach the JSON');
  });

  await check('liveness keys on the session\'s newest event of ANY kind, not on the entry ts', () => {
    // sess-live's PROMPT is 30 minutes old — twice the window. It is live only
    // because of its 2-minute-old edit. A payload that judged the entry ts would
    // return nothing here, which is the flicker this rule exists to prevent.
    const out = call();
    const row = out.sessions.find(s => s.session === 'sess-live');
    assert.ok(row, 'sess-live must be live on the strength of its newest EVENT');
    assert.ok(util.isLive(row.lastActivityAt, NOW), 'lastActivityAt must be the recent one');
    assert.strictEqual(util.isLive(row.ts, NOW), false, 'while its own ts is outside the window');
  });

  await check('teammates still appear — from the cached rows, with no network call', () => {
    const out = call();
    const team = out.sessions.filter(s => s.origin === 'team');
    assert.deepStrictEqual(team.map(s => s.session), ['mate-live'],
      'the teammate row that ARRIVED inside the window, and only that one');
    assert.strictEqual(team[0].author, 'Mate');
    assert.strictEqual(team[0].authorId, MATE_ID);
    assert.strictEqual(team[0].live, true);
    assert.strictEqual(team[0].liveBasis, 'synced-row',
      'and it must say so: a cached row is recent synced activity, never proof of a current remote session');
    assert.deepStrictEqual(requests, [], 'still no network');
  });

  await check('a team row is judged on ARRIVAL, not on the ts the pushing machine authored', () => {
    // mate-freshts has a 1-minute-old `ts` and a 400-minute-old `created_at`.
    // Reading ts would report a teammate as working now on the strength of a
    // clock this machine does not control.
    const out = call();
    assert.strictEqual(out.sessions.some(s => s.session === 'mate-freshts'), false,
      'a stale arrival with a fresh authored ts must not read as live');
  });

  await check('the payload says how stale the team half is, instead of implying presence', () => {
    const out = call();
    assert.strictEqual(out.teamPulledAt, iso(1), 'newest per-project pull timestamp');
    assert.strictEqual(out.teamCachedRows, 3, 'how many cached rows were considered');
    assert.strictEqual(out.liveWindowMs, util.LIVE_WINDOW_MS, 'the window the flags were judged over');
    assert.strictEqual(out.now, new Date(NOW).toISOString(), 'and the instant they were judged at');
  });

  await check('teamAccessLost suppresses the cached rows here too — revocation reaches this reader', () => {
    // The five-readers-one-guard mistake, guarded. util.teamRowsFor is the only
    // supported reader of these rows; a new surface that walked proj.teamEntries
    // directly would keep serving a project this install may no longer read.
    const st = util.loadState();
    st.projects[projB].teamAccessLost = iso(5);
    util.saveState(st);
    try {
      const out = call();
      assert.strictEqual(out.sessions.some(s => s.origin === 'team'), false,
        'a revoked project must contribute no teammate rows');
      assert.strictEqual(out.teamCachedRows, 0, 'and must not even count them as considered');
      // The local half of an unrelated project is untouched: this is a
      // per-project revocation, not a kill switch for the whole endpoint.
      assert.strictEqual(out.sessions.some(s => s.session === 'sess-live'), true,
        'the local session in the OTHER project still shows');
    } finally {
      const back = util.loadState();
      delete back.projects[projB].teamAccessLost;
      util.saveState(back);
    }
  });

  await check('a row this account pushed from another machine folds into the same person', () => {
    // The identity-as-display-string catcher. The client groups live rows on
    // `authorId || author`; if selfUserId were absent here, the local row would
    // key on the string "You" and this row on its uuid, rendering one person as
    // two. normalizeTeam needs selfUserId to mark it self, and selfUserId comes
    // off disk.
    const st = util.loadState();
    st.projects[projB].teamEntries = st.projects[projB].teamEntries.concat([
      teamRow({ author: 'Self Elsewhere', authorId: SELF_ID, session: 'self-other-machine', tsMinsAgo: 4, arrivedMinsAgo: 4, summary: 'Same account, different laptop.' }),
    ]);
    util.saveState(st);
    try {
      const out = call();
      const row = out.sessions.find(s => s.session === 'self-other-machine');
      assert.ok(row, 'the row must be served');
      assert.strictEqual(row.self, true, 'and recognised as this account');
      assert.strictEqual(row.author, 'You', 'not as a stranger with the same id');
      assert.strictEqual(row.authorId, SELF_ID);
    } finally {
      const back = util.loadState();
      back.projects[projB].teamEntries = back.projects[projB].teamEntries.filter(r => r.session !== 'self-other-machine');
      util.saveState(back);
    }
  });

  await check('nothing live anywhere returns an empty list rather than an error or the whole feed', () => {
    // The all-quiet case is the common one: a laptop that has been idle for an
    // hour. It must cost nothing and say nothing.
    const out = server.liveSessionsPayload({ now: NOW + 1000 * 60 * 60 * 24 });
    assert.deepStrictEqual(out.sessions, [], 'a day later, nobody is live');
    assert.deepStrictEqual(requests, [], 'and still no network');
  });

  await check('rows come back newest-activity first, across both origins', () => {
    const out = call();
    const order = out.sessions.map(s => s.lastActivityAt || s.ts);
    const sorted = order.slice().sort((a, b) => String(b).localeCompare(String(a)));
    assert.deepStrictEqual(order, sorted, 'newest first, the order /api/feed already returns');
  });

  await check('the served set is exactly what the old feed path would have yielded after the client filter', () => {
    // The equivalence that makes this a performance change rather than a
    // behaviour change. dedupeLiveSessions is the client's own filter
    // (ui/src/data/mappers.ts), reproduced here: what it kept from the merged
    // feed is what this endpoint must serve.
    const dedupeLiveSessions = entries => {
      const seen = new Set();
      const out = [];
      for (const e of entries) {
        if (!e.live) continue;
        const key = `${e.projectPath || e.projectId || e.project}::${e.session || e.ts}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(e);
      }
      return out;
    };
    const mine = call();
    assert.deepStrictEqual(sessionsOf({ sessions: dedupeLiveSessions(mine.sessions) }), sessionsOf(mine),
      'the endpoint must already be deduped — the client filter should be a no-op over it');
  });

  // ---- the ROUTE, not just the payload function -------------------------
  // The route reads the WALL CLOCK (it passes no injected now), so the fixture
  // for these two checks has to be live against real time rather than the pinned
  // NOW the checks above use.
  const realNow = Date.now();
  project('gamma', {
    events: [
      { ts: new Date(realNow - 60000).toISOString(), source: 'Claude Code', kind: 'prompt', session: 'sess-http', text: 'serve this over http' },
      { ts: new Date(realNow - 30000).toISOString(), source: 'Claude Code', kind: 'edit', session: 'sess-http', file: 'lib/http.js' },
    ],
  });
  const SRV_PORT = P(73);
  // Raw http.request, not fetch: undici will not let a caller set `Host`, so a
  // fetch-based version of the rebinding check silently tests nothing (it sent
  // 127.0.0.1 and got a 200 — observed while writing this).
  const rawGet = (p, headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: SRV_PORT, path: p, method: 'GET', headers: headers || {} }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(body); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    req.end();
  });
  const srv = server.startServer(SRV_PORT, { retries: 0 });
  await h.waitForHttp(`http://127.0.0.1:${SRV_PORT}/api/status`);
  try {
    await check('GET /api/live-sessions serves the payload and still makes no backend request', async () => {
      requests = [];
      const r = await rawGet('/api/live-sessions');
      assert.strictEqual(r.status, 200);
      assert.ok(r.body && Array.isArray(r.body.sessions), 'sessions must be an array');
      assert.strictEqual(r.body.sessions.some(s => s.session === 'sess-http'), true,
        'the session that is live against the real clock must be served');
      assert.deepStrictEqual(requests, [], 'the route must not reach the backend either');
    });

    await check('a non-loopback Host is refused — this endpoint returns captured prompt text', async () => {
      // The DNS-rebinding gate is global and runs before route dispatch, so a
      // new endpoint inherits it. Pinned anyway because this one serves `ask`
      // text: if the gate were ever moved per-route, a read endpoint added after
      // the move is exactly what would be forgotten.
      const r = await rawGet('/api/live-sessions', { Host: 'attacker.example.com' });
      assert.strictEqual(r.status, 403, 'a rebound GET must not read prompt text');
      assert.match(String(r.body && r.body.error), /host not allowed/);
    });
  } finally {
    await new Promise(r => srv.close(r));
  }

  await new Promise(r => stub.close(r));
  h.finish();
}

main().catch(err => { console.error(err); process.exit(1); });
