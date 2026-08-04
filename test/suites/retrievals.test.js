'use strict';
// Retrieval tracking (lib/retrievals.js): which memories actually get used.
// Run directly, or via `node test/run.js retrievals`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function main() {
  const util = require('../../lib/util');
  const retrievals = require('../../lib/retrievals');
  const activity = require('../../lib/activity');
  const teamArchive = require('../../lib/team-archive');

  // --- unit: the fold ---
  {
    check('retrievals: no log on disk means empty counts, never a throw', () => {
      assert.deepStrictEqual(retrievals.readCounts(), {});
      assert.deepStrictEqual(retrievals.countsFor(['nope|x|y']), {});
    });

    check('retrievals: record + readCounts round-trips n and last per key', () => {
      retrievals.record('search', ['k1', 'k2'], { now: Date.parse('2026-08-01T10:00:00.000Z') });
      retrievals.record('why', ['k1'], { now: Date.parse('2026-08-02T10:00:00.000Z') });
      const counts = retrievals.readCounts();
      assert.strictEqual(counts.k1.n, 2);
      assert.strictEqual(counts.k2.n, 1);
      assert.strictEqual(counts.k1.last, '2026-08-02T10:00:00.000Z');
    });

    check('retrievals: a torn tail line is skipped without losing earlier counts', () => {
      fs.appendFileSync(retrievals.logPath(), '{"ts":"2026-08-03T', 'utf8'); // killed mid-append
      const counts = retrievals.readCounts();
      assert.strictEqual(counts.k1.n, 2, 'a corrupt tail took healthy lines with it');
    });

    check('retrievals: countsFor returns only asked-for keys, absent means never retrieved', () => {
      const sub = retrievals.countsFor(['k2', 'never-served']);
      assert.deepStrictEqual(Object.keys(sub), ['k2']);
      assert.strictEqual(sub.k2.n, 1);
    });

    check('retrievals: MEMBRIDGE_NO_RETRIEVALS=1 disables recording entirely', () => {
      process.env.MEMBRIDGE_NO_RETRIEVALS = '1';
      try {
        retrievals.record('search', ['killswitched']);
      } finally {
        delete process.env.MEMBRIDGE_NO_RETRIEVALS;
      }
      assert.strictEqual(retrievals.readCounts().killswitched, undefined);
    });

    check('retrievals: config.trackRetrievals === false disables recording', () => {
      retrievals.record('search', ['configoff'], { config: { trackRetrievals: false } });
      assert.strictEqual(retrievals.readCounts().configoff, undefined);
    });

    check('retrievals: empty key lists are not recorded as lines', () => {
      const before = fs.existsSync(retrievals.logPath()) ? fs.readFileSync(retrievals.logPath(), 'utf8') : '';
      retrievals.record('search', [], {});
      const after = fs.existsSync(retrievals.logPath()) ? fs.readFileSync(retrievals.logPath(), 'utf8') : '';
      assert.strictEqual(after, before);
    });

    check('retrievals: compaction folds log into base and truncates, with no count change', () => {
      const before = retrievals.readCounts();
      // Exercise the fold directly rather than appending 4MB of fixtures:
      // temporarily drop the threshold by writing enough for statSync,
      // then call maybeCompact with the real path.
      const logFile = retrievals.logPath();
      const sizeBefore = fs.statSync(logFile).size;
      assert.ok(sizeBefore > 0, 'fixture: expected a non-empty log to fold');
      // maybeCompact only folds past COMPACT_BYTES; simulate crossing it by
      // calling the internals the way record() would once the file is big.
      const padded = Buffer.alloc(retrievals.COMPACT_BYTES, '\n'); // newline padding parses to zero records
      fs.appendFileSync(logFile, padded);
      retrievals.maybeCompact(logFile);
      assert.ok(fs.existsSync(retrievals.basePath()), 'compaction wrote no base file');
      assert.strictEqual(fs.statSync(logFile).size, 0, 'compaction did not truncate the log');
      assert.deepStrictEqual(retrievals.readCounts(), before,
        'folding to base changed the counts');
    });

    check('retrievals: recording continues on top of a compacted base', () => {
      retrievals.record('search', ['k1']);
      assert.strictEqual(retrievals.readCounts().k1.n, 3, 'base + fresh log did not add up');
    });
  }

  // --- integration: searchMemory annotates and records ---
  {
    const projPath = path.join(ROOT, 'projects', 'retrievals-app');
    fs.mkdirSync(path.join(projPath, '.membridge'), { recursive: true });
    {
      const state = util.loadState();
      state.projects[projPath] = {
        events: [],
        teamEntries: [
          {
            author: 'Teammate', ts: '2026-07-01T00:00:00.000Z', source: 'Claude Code',
            session: 'retr-s1', ask: null, goal: null, summary: null,
            decisions: 'retrievaltoken lives in middleware', gotchas: null,
            headline: null, distilled: true, files: [], changes: null,
          },
          {
            author: 'Teammate', ts: '2026-07-02T00:00:00.000Z', source: 'Claude Code',
            session: 'retr-s2', ask: null, goal: null, summary: 'unrelated deploy work',
            decisions: null, gotchas: null, headline: null, distilled: true,
            files: [], changes: null,
          },
        ],
      };
      util.saveState(state);
    }

    const first = activity.searchMemory({ query: 'retrievaltoken' });
    check('retrievals: a first-ever serve reports retrievals: 0 (history, not this call)', () => {
      assert.strictEqual(first.results.length, 1, 'fixture: expected exactly the planted row');
      assert.strictEqual(first.results[0].retrievals, 0);
    });

    const second = activity.searchMemory({ query: 'retrievaltoken' });
    check('retrievals: the second serve of the same entry reports retrievals: 1', () => {
      assert.strictEqual(second.results.length, 1);
      assert.strictEqual(second.results[0].retrievals, 1);
    });

    check('retrievals: entries never served accrue nothing — only the returned slice records', () => {
      const key = activity.eventKey({ session: 'retr-s2', ts: '2026-07-02T00:00:00.000Z', source: 'Claude Code' });
      assert.strictEqual(retrievals.readCounts()[key], undefined,
        'a row that matched no query gained a retrieval count');
    });

    check('retrievals: recording never mutates state.json (the log is the only write)', () => {
      const state = util.loadState();
      const proj = state.projects[projPath];
      assert.strictEqual(proj.teamEntries.length, 2);
      assert.strictEqual(Object.keys(proj).some(k => /retriev/i.test(k)), false,
        'a retrieval-shaped field leaked into memory state');
    });

    check('retrievals: the archive lane counts under the same key as the cache lane', () => {
      // The same event served out of the durable archive must accrue onto the
      // same eventKey — session|ts|source, author-independent (identity twins).
      const pid = 'retrievals-archive-pid';
      const projArc = path.join(ROOT, 'projects', 'retrievals-archive-app');
      fs.mkdirSync(path.join(projArc, '.membridge'), { recursive: true });
      const st = util.loadState();
      st.projects[projArc] = { events: [], teamEntries: [] };
      util.saveState(st);
      fs.writeFileSync(path.join(projArc, '.membridge', 'team.json'),
        JSON.stringify({ teamId: 't', projectId: pid, teamName: 'T' }));
      teamArchive.appendRows(pid, [{
        author: 'Old Name', ts: '2026-06-01T00:00:00.000Z', source: 'Codex', session: 'arc-1',
        ask: null, summary: null, goal: null, decisions: 'archivedretrievaltoken decision',
        gotchas: null, headline: null, distilled: true, files: [], changes: null,
      }]);
      const served = activity.searchMemory({ query: 'archivedretrievaltoken' });
      assert.strictEqual(served.results.length, 1, 'fixture: archive row not served');
      const key = activity.eventKey({ session: 'arc-1', ts: '2026-06-01T00:00:00.000Z', source: 'Codex' });
      assert.strictEqual(retrievals.readCounts()[key].n, 1);
    });

    check('retrievals: a why row accrues onto the SAME key as a search hit for that session', () => {
      // Serve one session through BOTH surfaces and assert one shared count —
      // the whole point of keying on event identity instead of per-tool logs.
      const projWhy = path.join(ROOT, 'projects', 'retrievals-why-app');
      fs.mkdirSync(path.join(projWhy, '.membridge'), { recursive: true });
      const st = util.loadState();
      st.projects[projWhy] = {
        events: [],
        teamEntries: [{
          author: 'Teammate', ts: '2026-07-03T00:00:00.000Z', source: 'Claude Code',
          session: 'why-s1', ask: null, goal: null, summary: 'whyretrievaltoken threaded through scan',
          decisions: null, gotchas: null, headline: null, distilled: true,
          files: ['lib/scan.js'], changes: null,
        }],
      };
      util.saveState(st);
      const mcp = require('../../lib/mcp');

      const whyRes = mcp.whyFile(projWhy, 'lib/scan.js');
      assert.strictEqual(whyRes.sessions.length, 1, 'fixture: why found no sessions for the file');
      assert.strictEqual(whyRes.sessions[0].retrievals, 0, 'first why serve must report prior history (0)');

      const searched = activity.searchMemory({ query: 'whyretrievaltoken' });
      assert.strictEqual(searched.results.length, 1, 'fixture: search missed the planted row');
      assert.strictEqual(searched.results[0].retrievals, 1,
        'the why serve did not accrue onto the same event key the search reads');
    });
  }

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
