'use strict';
// Board #6 — a session /api/search offers must be openable by /api/session.
//
// THE FAILURE, observed live on a real install before this fix. Marco searched,
// clicked a result, and the page said "This session isn't in memory anymore."
// The session was not gone. Two surfaces were reading two different stores:
//
//   * SEARCH freshens its FTS index through activity.projectCorpus with
//     `includeArchive: true`, so it reads the working cache PLUS the durable
//     per-project team archive in <homeDir>/team-archive/<projectId>.ndjson.
//   * THE SESSION PAGE (server.sessionPayload) read util.teamRowsFor(proj) —
//     the working cache — and nothing else.
//
// The archive is the long tail past the cache window, so any teammate session
// older than that window was findable and un-openable. On the install this was
// found on: 99 distinct sessions in the index, 39 of them unopenable, and every
// single one a teammate's. On a product whose pitch is shared team memory, that
// is close to the worst shape the bug could take.
//
// It also collapsed two different answers into one. A session that never
// existed and a session this machine demonstrably still held returned the
// byte-identical `404 {"error":"unknown session"}`, so the UI's own comment
// ("null is the daemon's honest 404: evicted from memory or never existed")
// was documenting a distinction the daemon was not making.
//
// WHAT THIS SUITE PINS, in order of what it would cost to get wrong:
//
//   1. THE GATE. sessionPayload now reads a store that survives a state wipe,
//      so the whole safety of this change rests on one predicate:
//      activity.projectArchiveEntries. Both halves (teamAccessLost AND the
//      revocation ledger) must refuse, and — the edge that matters most —
//      the gate must be evaluated on EVERY call rather than short-circuited by
//      loadArchiveEntries' warm memo. A revocation landing mid-process must
//      take effect on the next call with no cache invalidation. Serving a
//      revoked teammate's history is a disclosure, not a bug.
//   2. REDACTION. Anything newly surfaced goes through the same pass the feed
//      uses. An archived summary carrying a secret must come back redacted.
//   3. The actual repair: search offers it, the detail route opens it.
//   4. An id that genuinely never existed still 404s. "Unknown" and "held but
//      past the cache window" must not collapse back into one answer.
//   5. `heldBy` / `unavailable` — the payload says WHICH store answered and
//      what it structurally does not have, rather than leaving an empty array
//      to mean both "none exist" and "never transmitted".
//
// WHAT THIS CANNOT PROVE. No live Supabase, so no RLS or server-side revocation
// is exercised here — this pins the LOCAL reader, which is the layer that
// actually holds (server-side revocation cannot reach local disk). The archive
// is written by the fixture via teamArchive.appendRows, so this tests the
// reader and not teamsync's backfill writer. And nothing here renders anything:
// whether the UI shows `unavailable` is a ui/ concern and a separate ticket.
//
// Run directly, or via `node test/run.js session-archive`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, P } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const memorydb = require('../../lib/memorydb');
const digest = require('../../lib/digest');
const teamArchive = require('../../lib/team-archive');
const revocationLedger = require('../../lib/revocation-ledger');
const activity = require('../../lib/activity');
const server = require('../../lib/server');

const SRV_PORT = P(31);

const PROJECT_ID = 'proj-archived';
const GAP_PROJECT_ID = 'proj-gap';

const ARCHIVED_SESSION = 'sess-archived';   // in the archive ONLY — the bug
const CACHED_SESSION = 'sess-cached';       // in the working cache — the control
const LOCAL_SESSION = 'sess-local';         // this machine's own — the control
const GAP_SESSION = 'sess-gap';             // archive with an unfinished backfill

// A planted secret, and a redaction pattern that catches it. The point is not
// that this string is realistic; it is that it lives in an ARCHIVED summary,
// which is text that reached a payload for the first time in this change.
const SECRET = 'sk-live-ARCHIVESECRET0123456789';
const SECRET_PATTERN = 'sk-live-[A-Za-z0-9]+';

// Real-clock-relative, for the same reason test/suites/team-rows-residual.js
// documents: anything measured against a freshness window with a pinned
// literal is a dated bomb that passes until it silently does not.
const hoursAgo = n => new Date(Date.now() - n * 3600000).toISOString();

// Archive rows are stored in pullProject's `mapped` shape (lib/teamsync.js),
// which is what teamArchive.appendRows takes and what activity.mapTeamRow
// normalizes back out. Kept minimal but complete enough that a rendered page
// would have something on it.
const archiveRow = (session, ts, over) => ({
  author: 'Andrew Brown',
  authorId: 'mate-uuid',
  ts,
  source: 'Claude Code',
  session,
  ask: 'why does the pull cursor reset',
  goal: null,
  decisions: 'cursor is per project, not per machine',
  gotchas: 'a cleared cursor re-pulls the whole window',
  summary: 'Traced the cursor reset to a per-machine assumption.',
  headline: 'cursor reset traced',
  distilled: true,
  files: ['lib/teamsync.js'],
  changes: [{ file: 'lib/teamsync.js', action: 'edited', note: 'made the cursor per project' }],
  ...over,
});

function makeProject(name, projectId) {
  const key = path.join(h.ROOT, 'projects', name);
  fs.mkdirSync(path.join(key, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(key, memorydb.DIR_NAME), { recursive: true });
  fs.writeFileSync(path.join(key, 'lib', 'teamsync.js'), '// fixture\n');
  // The team link. loadTeamLink reads <project>/.membridge/team.json, and its
  // projectId is what names the archive file — without it there is no archive
  // to reach, and the gate's third check refuses.
  fs.writeFileSync(path.join(key, memorydb.DIR_NAME, 'team.json'),
    JSON.stringify({ teamId: 'team-1', projectId, name }, null, 2));
  return key;
}

function main() {
  util.ensureConfig();

  // Redaction pattern in the real config, so compileRedactions picks it up on
  // every path under test rather than being injected into one of them.
  {
    const raw = util.loadUserConfig();
    raw.redact = [...(raw.redact || []), SECRET_PATTERN];
    util.saveUserConfig(raw);
  }

  const key = makeProject('archived', PROJECT_ID);
  const gapKey = makeProject('gapped', GAP_PROJECT_ID);

  // The archive: the session under test, plus a second row so the payload has a
  // real start/end span rather than a single instant.
  teamArchive.appendRows(PROJECT_ID, [
    archiveRow(ARCHIVED_SESSION, hoursAgo(50)),
    archiveRow(ARCHIVED_SESSION, hoursAgo(49), {
      summary: `Rotated the key ${SECRET} and pinned the cursor test.`,
    }),
  ]);
  teamArchive.setBackfill(PROJECT_ID, { done: true, beforeId: 1, stopped: null });

  // A second project whose backward backfill has NOT finished — the only case
  // in which the archive is genuinely allowed to be missing earlier rows.
  teamArchive.appendRows(GAP_PROJECT_ID, [archiveRow(GAP_SESSION, hoursAgo(60))]);
  teamArchive.setBackfill(GAP_PROJECT_ID, { done: false, beforeId: 42, stopped: null });

  // State: a LOCAL session, and a working-cache team row for a DIFFERENT
  // session. The archived session is deliberately absent from teamEntries —
  // that absence is the whole fixture.
  {
    const st = util.loadState();
    st.projects[key] = {
      events: [
        { ts: hoursAgo(3), session: LOCAL_SESSION, source: 'Claude Code', kind: 'prompt',
          text: 'add the archive fallback', files: ['lib/server.js'] },
      ],
      teamEntries: [{
        author: 'Andrew Brown', authorId: 'mate-uuid', ts: hoursAgo(2), source: 'Claude Code',
        session: CACHED_SESSION, ask: 'still in the window',
        summary: 'A row the working cache still holds.', files: ['lib/feed.js'], changes: [],
      }],
    };
    st.projects[gapKey] = { events: [], teamEntries: [] };
    util.saveState(st);
  }

  const regexesNow = () => digest.compileRedactions(util.getConfig());
  const archiveEntriesFor = k => activity.projectArchiveEntries(k, util.loadState().projects[k], regexesNow());

  // ---- precondition: the fixture tests the ARCHIVE, not the cache ---------
  check('precondition: the archived session is absent from the working cache', () => {
    const proj = util.loadState().projects[key];
    const cached = util.teamRowsFor(proj).filter(r => r.session === ARCHIVED_SESSION);
    assert.strictEqual(cached.length, 0,
      'the archived session must NOT be in teamEntries, or this suite would pass via the cache path and prove nothing');
    assert.strictEqual(util.teamRowsFor(proj).length, 1, 'the cache should hold exactly the control row');
  });

  check('precondition: the durable archive holds the session', () => {
    const rows = archiveEntriesFor(key).filter(r => r.session === ARCHIVED_SESSION);
    assert.strictEqual(rows.length, 2, `the archive must hold both rows; got ${rows.length}`);
  });

  // ---- 3. the repair -----------------------------------------------------
  check('search offers the archived session (unchanged — no recall may be lost)', () => {
    const found = activity.searchMemory({ query: 'cursor reset', limit: 25 });
    const sessions = new Set(found.results.map(r => r.session));
    assert.ok(sessions.has(ARCHIVED_SESSION),
      `search must still return the archived session; got ${[...sessions].join(', ')}`);
  });

  check('THE BUG: a session search offers can be opened by sessionPayload', () => {
    const s = server.sessionPayload(ARCHIVED_SESSION);
    assert.ok(s, 'sessionPayload returned null for a session the archive holds — this is the reported bug');
    assert.strictEqual(s.session, ARCHIVED_SESSION);
    assert.strictEqual(s.author, 'Andrew Brown');
    assert.strictEqual(s.projectPath, key);
    assert.ok(s.summary, 'the page must carry the archived summary, not an empty shell');
    assert.ok(s.decisions && /per project/.test(s.decisions), 'decisions must survive the archive path');
    assert.ok(s.files.includes('lib/teamsync.js'), 'files must survive the archive path');
    // Both rows, so the span is the real session and not one instant.
    assert.strictEqual(s.prompts.length, 2, `both archived rows must appear as prompts; got ${s.prompts.length}`);
    assert.ok(s.startedAt < s.endedAt, 'the session must span its rows');
  });

  // ---- 2. redaction ------------------------------------------------------
  check('REDACTION: a secret in an archived summary never reaches the payload', () => {
    const s = server.sessionPayload(ARCHIVED_SESSION);
    const blob = JSON.stringify(s);
    assert.ok(!blob.includes(SECRET),
      'the planted secret reached the session payload — the archive path is bypassing the redaction pass');
    assert.ok(/redacted/.test(blob), 'the redaction pass must have left its marker, proving it actually ran');
  });

  // ---- 5. provenance and honest partiality -------------------------------
  check('heldBy names the store that answered, on all three paths', () => {
    assert.strictEqual(server.sessionPayload(ARCHIVED_SESSION).heldBy, 'team-archive');
    assert.strictEqual(server.sessionPayload(CACHED_SESSION).heldBy, 'team-cache');
    assert.strictEqual(server.sessionPayload(LOCAL_SESSION).heldBy, 'local-events');
  });

  check('unavailable names what a team page structurally lacks, and is empty for your own session', () => {
    const arch = server.sessionPayload(ARCHIVED_SESSION);
    const cached = server.sessionPayload(CACHED_SESSION);
    const local = server.sessionPayload(LOCAL_SESSION);
    for (const s of [arch, cached]) {
      assert.ok(s.unavailable.includes('checkpoints'),
        'the checkpoint trail never crosses team sync and the payload must say so rather than sending a bare []');
      assert.ok(s.unavailable.includes('commits'), 'commits are never attributed for a teammate');
    }
    assert.deepStrictEqual(local.unavailable, [],
      'your own session is assembled unsliced from your own events — nothing is structurally missing');
    // Complete backfill: the archive is NOT allowed to claim a gap it does not
    // have. A partiality marker that fires when nothing is partial is the same
    // lie pointed the other way.
    assert.ok(!arch.unavailable.includes('earlier-activity'),
      'backfill.done is true for this project, so no gap may be reported');
  });

  check('an unfinished backfill IS reported as a gap', () => {
    const s = server.sessionPayload(GAP_SESSION);
    assert.ok(s, 'the gapped project session must still open');
    assert.ok(s.unavailable.includes('earlier-activity'),
      'backfill.done is false, so the payload must admit earlier activity may be missing');
  });

  // ---- 1. THE GATE -------------------------------------------------------
  check('GATE: teamAccessLost suppresses the archive, and the session 404s again', () => {
    const st = util.loadState();
    st.projects[key].teamAccessLost = true;
    util.saveState(st);
    try {
      assert.strictEqual(archiveEntriesFor(key).length, 0, 'projectArchiveEntries must refuse on teamAccessLost');
      assert.strictEqual(server.sessionPayload(ARCHIVED_SESSION), null,
        'a project this install may no longer read must not serve its archive through the session page');
    } finally {
      const back = util.loadState();
      delete back.projects[key].teamAccessLost;
      util.saveState(back);
    }
  });

  check('GATE: the revocation ledger suppresses the archive even with teamAccessLost absent', () => {
    // The ledger is the half that matters here: it outlives state.json, and the
    // archive lives in <homeDir> untouched by a state discard. A rebuilt
    // project record with a fresh (absent) flag must NOT reopen the history.
    const proj = util.loadState().projects[key];
    assert.ok(!proj.teamAccessLost, 'precondition: the in-state flag is clear, so only the ledger can refuse');
    revocationLedger.record(key, 'revoked', { reason: 'suite' });
    try {
      assert.strictEqual(revocationLedger.isRevoked(key), true, 'precondition: the ledger must consider this revoked');
      assert.strictEqual(archiveEntriesFor(key).length, 0, 'projectArchiveEntries must refuse on a ledger revocation');
      assert.strictEqual(server.sessionPayload(ARCHIVED_SESSION), null,
        'a revoked project must not serve its archive through the session page');
    } finally {
      fs.rmSync(revocationLedger.ledgerPath(), { force: true });
    }
    assert.strictEqual(revocationLedger.isRevoked(key), false, 'cleanup: the ledger must be clear again');
  });

  check('GATE: a WARM memo cannot short-circuit the gate (revocation lands mid-process)', () => {
    // The edge that makes this design safe rather than merely correct.
    // loadArchiveEntries memoizes on the archive file's stat, and the memo sits
    // INSIDE it — behind the predicate. So warming the cache with a successful
    // read and THEN revoking, with the archive file untouched (so the memo
    // stays valid), must still refuse. If the gate were ever hoisted below the
    // memo, this is the only check that would catch it, and the failure would
    // be a revoked teammate's history served until the process restarted.
    const warm = archiveEntriesFor(key);
    assert.ok(warm.length >= 2, 'precondition: the memo must be warm from a successful read');
    assert.ok(server.sessionPayload(ARCHIVED_SESSION), 'precondition: the session opens before revocation');

    const before = fs.statSync(teamArchive.archivePath(PROJECT_ID)).mtimeMs;
    revocationLedger.record(key, 'revoked', { reason: 'mid-process' });
    try {
      assert.strictEqual(fs.statSync(teamArchive.archivePath(PROJECT_ID)).mtimeMs, before,
        'precondition: the archive file must be untouched, so the memo is still valid and this really tests the gate');
      assert.strictEqual(archiveEntriesFor(key).length, 0,
        'a warm memo served a revoked project — the gate is being short-circuited by the cache');
      assert.strictEqual(server.sessionPayload(ARCHIVED_SESSION), null,
        'the session page served a revoked project from a warm memo');
    } finally {
      fs.rmSync(revocationLedger.ledgerPath(), { force: true });
    }
  });

  // ---- 4. unknown stays unknown ------------------------------------------
  check('a session that genuinely never existed still returns null', () => {
    assert.strictEqual(server.sessionPayload('sess-never-existed'), null,
      '"unknown" and "past the cache window" must not collapse into one answer');
  });

  return { key };
}

async function httpChecks() {
  const srv = server.startServer(SRV_PORT, { retries: 0 });
  await h.waitForHttp(`http://127.0.0.1:${SRV_PORT}/api/status`);
  const get = p => fetch(`http://127.0.0.1:${SRV_PORT}${p}`)
    .then(async r => ({ status: r.status, body: await r.json() }));
  try {
    await check('END TO END: /api/search offers it and /api/session opens it', async () => {
      const found = await get('/api/search?q=cursor%20reset&limit=25');
      assert.strictEqual(found.status, 200);
      const offered = found.body.results.filter(r => r.session === ARCHIVED_SESSION);
      assert.ok(offered.length, 'search must offer the archived session over HTTP');

      const detail = await get(`/api/session?id=${encodeURIComponent(ARCHIVED_SESSION)}`);
      assert.strictEqual(detail.status, 200,
        `every session search offers must open; got ${detail.status} ${JSON.stringify(detail.body)}`);
      assert.strictEqual(detail.body.session, ARCHIVED_SESSION);
      assert.strictEqual(detail.body.heldBy, 'team-archive');
    });

    await check('END TO END: an unknown id still 404s with the unchanged error body', async () => {
      const r = await get('/api/session?id=sess-never-existed');
      assert.strictEqual(r.status, 404);
      assert.deepStrictEqual(r.body, { error: 'unknown session' },
        'the 404 body is unchanged, so the client keeps its existing null handling');
    });
  } finally {
    srv.close();
  }
}

main();
httpChecks().then(() => h.finish());
