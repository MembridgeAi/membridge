'use strict';
// FTS5/BM25 search index (lib/search-index.js): the storage half of search.
// Ranking POLICY (tokenizing, the strict/relaxed two-pass, the usage boost)
// stays in lib/search.js and is tested by test/suites/search.test.js; this
// suite covers everything that touches SQLite, plus the guards that make
// storing full rows safe (redaction signature, revocation, dedup).
//
// Run directly, or via `node test/run.js search-index`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// A normalized feed entry, defaulted so each case overrides only what it means
// to be searchable. Mirrors the shape lib/feed.js hands out.
function entry(overrides) {
  return {
    ts: '2026-07-01T00:00:00.000Z', author: 'Teammate', authorId: null,
    source: 'Claude Code', session: 's1', origin: 'team', self: false,
    projectPath: '/p/app', project: 'app',
    ask: null, goal: null, summary: null, decisions: null, gotchas: null,
    headline: null, files: [], changes: [],
    ...overrides,
  };
}
const item = (key, overrides) => ({ key, entry: entry(overrides) });

async function main() {
  const idx = require('../../lib/search-index');

  // --- query translation: pure, and the place hostile input bites ---
  {
    check('search-index: a term is quoted and prefix-matched', () => {
      assert.strictEqual(idx.escapeTerm('auth'), '"auth"*');
    });

    check('search-index: an embedded quote is doubled, not dropped', () => {
      assert.strictEqual(idx.escapeTerm('x"y'), '"x""y"*');
    });

    check('search-index: terms are AND-joined by default, OR-joined when relaxed', () => {
      assert.strictEqual(idx.buildMatch(['auth', 'vault']), '"auth"* AND "vault"*');
      assert.strictEqual(idx.buildMatch(['auth', 'vault'], { any: true }), '"auth"* OR "vault"*');
    });

    check('search-index: a query with no usable terms is null, never an empty MATCH', () => {
      assert.strictEqual(idx.buildMatch([]), null);
    });
  }

  // --- storage: round-trip, ranking, and the guards ---
  {
    check('search-index: open() creates the db under the membridge home', () => {
      const db = idx.open();
      assert.ok(fs.existsSync(idx.indexPath()), 'no db file was created');
      assert.ok(idx.indexPath().startsWith(path.join(ROOT, 'home')),
        `index escaped the test home: ${idx.indexPath()}`);
      idx.close(db);
    });

    check('search-index: the index is opened in WAL mode with a busy timeout', () => {
      // There are THREE writers in production — the daemon tick, the MCP
      // server and the dashboard — and in SQLite's default journal mode a
      // write during another connection's transaction throws outright
      // (ERR_SQLITE_ERROR, verified). WAL lets readers through during a write;
      // busy_timeout makes a blocked writer wait instead of failing a search.
      const db = idx.open();
      assert.strictEqual(db.prepare('pragma journal_mode').get().journal_mode, 'wal');
      assert.ok(db.prepare('pragma busy_timeout').get().timeout > 0, 'no busy timeout set');
      idx.close(db);
    });

    check('search-index: a search still reads while another connection is mid-write', () => {
      const writer = idx.open();
      idx.replaceAll(writer, [item('w1', { summary: 'concurrenttoken already here' })], { signature: 'sig-1' });
      writer.exec('begin immediate');
      writer.prepare('insert into entries (key, project, summary) values (?, ?, ?)')
        .run('w2', '/p/app', 'concurrenttoken mid transaction');
      const reader = idx.open();
      let hits;
      assert.doesNotThrow(() => { hits = idx.search(reader, { terms: ['concurrenttoken'] }); },
        'a search failed while the daemon was writing');
      assert.strictEqual(hits.length, 1, 'the reader should see the committed row, not the in-flight one');
      writer.exec('commit');
      idx.close(reader);
      idx.close(writer);
    });

    check('search-index: an indexed entry round-trips with its full row intact', () => {
      const db = idx.open();
      idx.replaceAll(db, [item('k1', {
        headline: 'rewrote token refresh',
        decisions: 'token refresh lives in the gotrue passthrough',
        files: ['lib/token-refresh.js'],
      })], { signature: 'sig-1' });
      const hits = idx.search(db, { terms: ['token', 'refresh'] });
      assert.strictEqual(hits.length, 1);
      assert.strictEqual(hits[0].key, 'k1');
      // Metadata comes back on the hit itself (filters read it without paying
      // for a JSON parse); the body only from hydrate().
      assert.deepStrictEqual(hits[0].files, ['lib/token-refresh.js'], 'files metadata lost');
      assert.strictEqual(hits[0].author, 'Teammate');
      const body = idx.hydrate(db, ['k1']).get('k1');
      assert.strictEqual(body.headline, 'rewrote token refresh');
      assert.deepStrictEqual(body.files, ['lib/token-refresh.js'],
        'the stored row did not survive the round-trip');
      idx.close(db);
    });

    check('search-index: scores are positive and higher means better', () => {
      const db = idx.open();
      idx.replaceAll(db, [
        item('strong', { headline: 'vault rotation', decisions: 'vault rotation per epoch' }),
        item('weak', { summary: 'vault mentioned once in passing' }),
      ], { signature: 'sig-1' });
      const hits = idx.search(db, { terms: ['vault'] });
      assert.ok(hits.every(hDoc => hDoc.score > 0), `bm25 was not negated: ${JSON.stringify(hits.map(x => x.score))}`);
      assert.strictEqual(hits[0].key, 'strong');
      idx.close(db);
    });

    check('search-index: a rare term outranks a flooded common one (real IDF)', () => {
      // The property the hand-rolled scorer lacks entirely: it weights a word
      // present in every entry exactly as heavily as one present in a single
      // entry. Both rows here match "deploy"; only one matches the rare term.
      const db = idx.open();
      const items = [];
      for (let i = 0; i < 40; i++) items.push(item(`common-${i}`, { summary: `routine deploy work ${i}` }));
      items.push(item('rare', { summary: 'deploy blocked by gotruepassthrough' }));
      idx.replaceAll(db, items, { signature: 'sig-1' });
      const hits = idx.search(db, { terms: ['deploy', 'gotruepassthrough'], any: true });
      assert.strictEqual(hits[0].key, 'rare',
        'a flooded common term outranked a rare one — IDF is not being applied');
      idx.close(db);
    });

    check('search-index: hostile FTS5 syntax is accepted by SQLite as literal text', () => {
      // Asserted against a RAW prepared statement, deliberately NOT through
      // search(): search() catches and returns [] so a search can never break
      // a tool, which also means assert.doesNotThrow on it can never fail.
      // That made an earlier version of this check a false green — it passed
      // with escapeTerm replaced by a pass-through.
      const db = idx.open();
      idx.replaceAll(db, [item('k1', { summary: 'ordinary prose' })], { signature: 'sig-1' });
      const stmt = db.prepare('select count(*) c from entries where entries match ?');
      for (const bad of ['NEAR(a b)', 'foo* OR "', 'a AND (b', '^caret', 'x"y', '*', 'a OR b']) {
        assert.doesNotThrow(() => stmt.get(idx.buildMatch([bad])),
          `unescaped FTS5 operator reached SQLite: ${bad}`);
      }
      idx.close(db);
    });

    check('search-index: an operator-shaped term still matches its literal text', () => {
      // The other half: escaping must not turn a real query into no query.
      // Without this, search() swallowing the syntax error and returning []
      // would look identical to "escaped correctly, found nothing".
      const db = idx.open();
      idx.replaceAll(db, [item('k1', { summary: 'crashed inside NEAR(a b) during parsing' })],
        { signature: 'sig-1' });
      const hits = idx.search(db, { terms: ['NEAR(a'] });
      assert.strictEqual(hits.length, 1, 'an operator-shaped term found nothing — escaping swallowed the query');
      assert.strictEqual(hits[0].key, 'k1');
      idx.close(db);
    });

    check('search-index: upsert dedups on the event key — one row, last write wins', () => {
      const db = idx.open();
      idx.replaceAll(db, [
        item('same', { author: 'andrewludwigbrown', headline: 'archive twin uniquetoken' }),
        item('same', { author: 'Andrew Brown', headline: 'cache row uniquetoken' }),
      ], { signature: 'sig-1' });
      const hits = idx.search(db, { terms: ['uniquetoken'] });
      assert.strictEqual(hits.length, 1, 'an identity twin was indexed twice');
      assert.strictEqual(hits[0].author, 'Andrew Brown', 'the later write did not win');
      idx.close(db);
    });

    check('search-index: a revoked project serves no team rows, even from a stale index', () => {
      // The reader guard, tested WITHOUT pruning the writer first — that is
      // the whole point. Server-side revocation cannot reach local disk, so
      // the read path must exclude on its own rather than trusting the index.
      const db = idx.open();
      idx.replaceAll(db, [
        item('team-row', { projectPath: '/p/revoked', origin: 'team', summary: 'revokedtoken work' }),
        item('own-row', { projectPath: '/p/revoked', origin: 'local', summary: 'revokedtoken work' }),
      ], { signature: 'sig-1' });
      const hits = idx.search(db, { terms: ['revokedtoken'], excludeTeamFor: ['/p/revoked'] });
      assert.deepStrictEqual(hits.map(x => x.key), ['own-row'],
        'a revoked project still served team memory');
      idx.close(db);
    });

    check('search-index: a redaction-signature change is reported as needing a rebuild', () => {
      const db = idx.open();
      idx.replaceAll(db, [item('k1', { summary: 'prose' })], { signature: 'sig-1' });
      assert.strictEqual(idx.needsRebuild(db, 'sig-1'), false, 'an unchanged signature forced a rebuild');
      assert.strictEqual(idx.needsRebuild(db, 'sig-2'), true,
        'a changed redaction config left stale text searchable');
      idx.close(db);
    });

    // --- per-project incremental freshening ---
    // A full rebuild on every search would be slower than the linear scan it
    // replaces (state.json changes on every daemon tick). Search freshens only
    // the projects whose inputs actually moved, so the common case touches
    // nothing at all.

    check('search-index: replaceProject rewrites one project and leaves the others alone', () => {
      const db = idx.open();
      idx.replaceAll(db, [
        item('a1', { projectPath: '/p/a', summary: 'alphatoken work' }),
        item('b1', { projectPath: '/p/b', summary: 'betatoken work' }),
      ], { signature: 'sig-1' });
      idx.replaceProject(db, '/p/a', [item('a2', { projectPath: '/p/a', summary: 'alphatoken rewritten' })], 'fp-a2');
      assert.deepStrictEqual(idx.search(db, { terms: ['alphatoken'] }).map(x => x.key), ['a2'],
        "the project's old rows survived its rewrite");
      assert.deepStrictEqual(idx.search(db, { terms: ['betatoken'] }).map(x => x.key), ['b1'],
        'rewriting one project disturbed another');
      idx.close(db);
    });

    check('search-index: a search can be scoped to one project', () => {
      // lib/hooks-search.js answers ONE Grep in ONE repo and must not serve
      // another project's memory into it.
      const db = idx.open();
      idx.replaceAll(db, [
        item('a1', { projectPath: '/p/a', summary: 'scopedtoken over here' }),
        item('b1', { projectPath: '/p/b', summary: 'scopedtoken over there' }),
      ], { signature: 'sig-1' });
      assert.strictEqual(idx.search(db, { terms: ['scopedtoken'] }).length, 2, 'fixture: both should match');
      assert.deepStrictEqual(idx.search(db, { terms: ['scopedtoken'], project: '/p/a' }).map(x => x.key), ['a1']);
      idx.close(db);
    });

    check('search-index: replaceProject owns the project column, even for rows carrying no path', () => {
      // Team rows come out of feed.normalizeTeam with projectPath NULL — only
      // local rows carry one. Indexed under that null, a team row is never
      // deleted by its own project's rewrite and never matched by the
      // revocation guard, which keys on the project path. So the owning path
      // passed here must win over whatever the entry says.
      const db = idx.open();
      idx.replaceProject(db, '/p/owner', [
        { key: 't1', entry: entry({ projectPath: null, origin: 'team', summary: 'pathlesstoken work' }) },
      ], 'fp-1');
      assert.strictEqual(idx.search(db, { terms: ['pathlesstoken'] }).length, 1, 'fixture: row not indexed');
      assert.strictEqual(idx.search(db, { terms: ['pathlesstoken'], excludeTeamFor: ['/p/owner'] }).length, 0,
        'a pathless team row escaped its own project\'s revocation guard');
      idx.replaceProject(db, '/p/owner', [], 'fp-2');
      assert.strictEqual(idx.search(db, { terms: ['pathlesstoken'] }).length, 0,
        'a pathless team row survived the rewrite of the project that owns it');
      idx.close(db);
    });

    check('search-index: a project fingerprint round-trips, and is absent before any write', () => {
      const db = idx.open();
      idx.replaceAll(db, [], { signature: 'sig-1' });
      assert.strictEqual(idx.projectFingerprint(db, '/p/a'), null, 'an unindexed project reported a fingerprint');
      idx.replaceProject(db, '/p/a', [item('a1', { projectPath: '/p/a', summary: 'work' })], 'fp-1');
      assert.strictEqual(idx.projectFingerprint(db, '/p/a'), 'fp-1');
      idx.replaceProject(db, '/p/a', [item('a1', { projectPath: '/p/a', summary: 'work' })], 'fp-2');
      assert.strictEqual(idx.projectFingerprint(db, '/p/a'), 'fp-2', 'the fingerprint did not advance');
      idx.close(db);
    });

    check('search-index: replaceAll clears stale per-project fingerprints too', () => {
      // Otherwise a rebuild would leave every project looking already-fresh,
      // and the freshener would skip refilling the index it just emptied.
      const db = idx.open();
      idx.replaceProject(db, '/p/a', [item('a1', { projectPath: '/p/a', summary: 'work' })], 'fp-1');
      idx.replaceAll(db, [], { signature: 'sig-2' });
      assert.strictEqual(idx.projectFingerprint(db, '/p/a'), null,
        'a fingerprint outlived the corpus it described');
      idx.close(db);
    });

    check('search-index: replaceAll leaves nothing from the previous corpus behind', () => {
      const db = idx.open();
      idx.replaceAll(db, [item('old', { summary: 'staletoken here' })], { signature: 'sig-1' });
      idx.replaceAll(db, [item('new', { summary: 'freshtoken here' })], { signature: 'sig-1' });
      assert.strictEqual(idx.search(db, { terms: ['staletoken'] }).length, 0, 'a dropped entry survived');
      assert.strictEqual(idx.search(db, { terms: ['freshtoken'] }).length, 1);
      idx.close(db);
    });
  }

  // --- the daemon lane ---
  // Until now the index was filled by whoever searched first, so the first
  // search after a busy period paid for everyone else's work. The daemon
  // freshens on its own tick instead.
  {
    const util = require('../../lib/util');
    const activity = require('../../lib/activity');

    check('search-index: the daemon refresh makes new work searchable with no search first', () => {
      const projPath = path.join(ROOT, 'projects', 'daemon-refresh-app');
      fs.mkdirSync(path.join(projPath, '.membridge'), { recursive: true });
      const st = util.loadState();
      st.projects[projPath] = {
        events: [],
        teamEntries: [{
          author: 'Teammate', ts: '2026-07-09T00:00:00.000Z', source: 'Claude Code',
          session: 'daemon-s1', ask: null, goal: null, summary: null,
          decisions: 'daemonfreshtoken is resolved on the tick', gotchas: null,
          headline: null, distilled: true, files: [], changes: null,
        }],
      };
      util.saveState(st);

      activity.refreshSearchIndex(); // the daemon's whole contribution

      const db = idx.open();
      try {
        assert.strictEqual(idx.search(db, { terms: ['daemonfreshtoken'] }).length, 1,
          'the daemon refresh left new team work unsearchable');
      } finally {
        idx.close(db);
      }
    });

    check('search-index: refreshSearchIndex is safe to call repeatedly and never throws', () => {
      // It rides a tick that must never be broken by a search-index problem,
      // so it swallows its own failures the way countersTick does.
      assert.doesNotThrow(() => { activity.refreshSearchIndex(); activity.refreshSearchIndex(); });
      const db = idx.open();
      try {
        assert.strictEqual(idx.search(db, { terms: ['daemonfreshtoken'] }).length, 1,
          'a second refresh dropped what the first indexed');
      } finally {
        idx.close(db);
      }
    });
  }

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
