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
  }

  // --- the log SHAPE: what a serve records beyond the bare count ---
  // These are the write-time-or-never fields. A count can be recomputed from
  // a log forever; the query that caused it cannot be recovered from anything
  // once the call returns, so each of these asserts it reached disk.
  {
    // Close the torn tail line the fold block above deliberately left behind,
    // WITHOUT discarding the log — later checks still count what is in it.
    // That line has no trailing newline, so the next append concatenates onto
    // it and is skipped as corrupt: accepted, documented behaviour for this
    // file, but it would silently eat the first serve recorded here and make
    // it read as a shape failure rather than the torn-line tolerance it is.
    if (!fs.readFileSync(retrievals.logPath(), 'utf8').endsWith('\n')) {
      fs.appendFileSync(retrievals.logPath(), '\n', 'utf8');
    }
    const servesFor = tool => retrievals.readServes().filter(r => r.tool === tool);

    check('shape: a search serve records the QUERY that caused it, not just the keys', () => {
      retrievals.record('search', ['shape-k1', 'shape-k2'], { query: 'vault rotation' });
      const rec = servesFor('search').pop();
      assert.strictEqual(rec.q, 'vault rotation',
        'the query was dropped — nothing downstream can ever reconstruct it');
      assert.deepStrictEqual(rec.keys, ['shape-k1', 'shape-k2']);
    });

    check('shape: keys keep SERVED RANK ORDER, so a key position is its index', () => {
      retrievals.record('search', ['rank-a', 'rank-b', 'rank-c'], { query: 'ordering' });
      const rec = servesFor('search').pop();
      assert.deepStrictEqual(rec.keys, ['rank-a', 'rank-b', 'rank-c'],
        'rank order was not preserved; a hit at 1 and a hit at 20 became the same event');
    });

    check('shape: project, total and files ride along when the caller knows them', () => {
      retrievals.record('search', ['shape-k3'], {
        query: 'q', project: 'proj-x', total: 42, files: ['lib/a.js'],
      });
      const rec = servesFor('search').pop();
      assert.strictEqual(rec.project, 'proj-x');
      assert.strictEqual(rec.total, 42, 'served-vs-ranked is what makes recall@k mean anything');
      assert.deepStrictEqual(rec.files, ['lib/a.js']);
    });

    check('shape: fields the caller does not know are OMITTED, never written as null', () => {
      retrievals.record('search', ['shape-k4'], {});
      const rec = servesFor('search').pop();
      for (const f of ['q', 'project', 'total', 'files']) {
        assert.ok(!(f in rec), `${f} was written with no value; a reader cannot tell that from a real one`);
      }
    });

    check('shape: a secret pasted into a QUERY is redacted at this boundary', () => {
      // The caller is not trusted to have redacted it — this file is at rest
      // on disk, and a search box is a place people paste things.
      retrievals.record('search', ['shape-k5'], { query: 'why did sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF fail' });
      const rec = servesFor('search').pop();
      assert.ok(!/sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF/.test(rec.q),
        'an API key in a query came to rest unredacted in retrievals.jsonl');
      assert.ok(/redacted/i.test(rec.q), `expected a redaction marker, got: ${rec.q}`);
    });

    check('shape: OLD lines (no q) still count, and read back as unlabelled not empty', () => {
      // Written in the pre-shape format, exactly as months of existing logs are.
      fs.appendFileSync(retrievals.logPath(),
        JSON.stringify({ ts: '2026-07-01T00:00:00.000Z', tool: 'search', keys: ['legacy-k'] }) + '\n', 'utf8');
      assert.strictEqual(retrievals.readCounts()['legacy-k'].n, 1,
        'the shape change broke counting for lines written before it');
      const rec = retrievals.readServes().filter(r => r.keys.includes('legacy-k')).pop();
      assert.strictEqual(rec.q, undefined, 'a legacy serve must be unlabelled, not a serve of ""');
    });

    check('shape: readServes tolerates a torn tail line like readCounts does', () => {
      fs.appendFileSync(retrievals.logPath(), '{"ts":"2026-08-09T', 'utf8');
      const serves = retrievals.readServes();
      assert.ok(serves.some(r => r.keys.includes('legacy-k')),
        'a corrupt tail took the healthy serves with it');
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

    // The shape is only worth anything if the REAL search path fills it in;
    // a writer that can carry a query and a caller that never passes one
    // would still leave the log unlabelled forever.
    check('wiring: a real searchMemory call lands the query and pool size on the log line', () => {
      const rec = retrievals.readServes().filter(r => r.tool === 'search').pop();
      assert.strictEqual(rec.q, 'retrievaltoken',
        'searchMemory recorded a serve without the query that caused it');
      assert.strictEqual(rec.total, 1, 'the ranked pool size did not reach the log');
      assert.deepStrictEqual(rec.keys, [activity.eventKey(
        { session: 'retr-s1', ts: '2026-07-01T00:00:00.000Z', source: 'Claude Code' })],
      'the served keys on the line are not the ones the caller got back');
    });

    check('wiring: the query is redacted on the way to the log by searchMemory itself', () => {
      activity.searchMemory({ query: 'retrievaltoken sk-ant-api03-ZZZZYYYYXXXXWWWWVVVVUUUU' });
      const rec = retrievals.readServes().filter(r => r.tool === 'search').pop();
      assert.ok(!/sk-ant-api03-ZZZZYYYYXXXXWWWWVVVVUUUU/.test(rec.q),
        'a secret in a live search query reached retrievals.jsonl unredacted');
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

    check('retrievals: usage reorders the next search — a proven entry beats its newer twin', () => {
      // Two rows saying the SAME thing, so lexical scoring cannot separate them
      // and the newest-first tiebreak decides. Then one of them earns a usage
      // history, and the next search must put it first.
      const projRank = path.join(ROOT, 'projects', 'retrievals-rank-app');
      fs.mkdirSync(path.join(projRank, '.membridge'), { recursive: true });
      const twin = extra => ({
        author: 'Teammate', source: 'Claude Code', ask: null, goal: null, summary: null,
        decisions: 'rankingtoken is resolved in the middleware', gotchas: null,
        headline: null, distilled: true, files: [], changes: null, ...extra,
      });
      const st = util.loadState();
      st.projects[projRank] = {
        events: [],
        teamEntries: [
          twin({ session: 'rank-old', ts: '2026-05-01T00:00:00.000Z' }),
          twin({ session: 'rank-new', ts: '2026-06-01T00:00:00.000Z' }),
        ],
      };
      util.saveState(st);

      const before = activity.searchMemory({ query: 'rankingtoken' });
      assert.strictEqual(before.results.length, 2, 'fixture: both twins should match');
      assert.strictEqual(before.results[0].session, 'rank-new',
        'fixture: with no usage history the newest twin must lead on the ts tiebreak');

      // Give the older twin a real history (that first search already gave both one).
      const oldKey = activity.eventKey({ session: 'rank-old', ts: '2026-05-01T00:00:00.000Z', source: 'Claude Code' });
      retrievals.record('search', [oldKey]);
      retrievals.record('why', [oldKey]);
      retrievals.record('search', [oldKey]);

      const after = activity.searchMemory({ query: 'rankingtoken' });
      assert.strictEqual(after.results[0].session, 'rank-old',
        'the entry the team keeps coming back to did not rise');
      assert.strictEqual(after.results[0].retrievals, 4, 'fixture: expected 1 serve + 3 recorded');
    });
  }

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
