'use strict';
// The durable archive must not grow when it is told something it already holds,
// and a rewrite must not discard another process's concurrent append.
//
// TWO defects, one code path (lib/team-archive.js appendRows).
//
// 1. NO COMPACTION ANYWHERE. The append fast path wrote every incoming line
//    unconditionally, including keys already in the file, and the only rewrite
//    in the module ran on an eviction trim. Harmless for an ordinary forward
//    pull (its rows are new by construction) and permanent for anything that
//    re-walks history: a full re-pull roughly DOUBLED the .ndjson forever, and
//    every later loadArchive pays that size again in read+parse — the ~4s per
//    project the upstream read cache exists to hide. This blocks `membridge
//    team repull` outright, which is why it lands first.
//
// 2. THE REWRITE RAN OUTSIDE THE APPEND LOCK. appendRows read the file, then
//    took the lock only around the write, so the rewrite replaced the whole
//    file from a PRE-LOCK snapshot: rows another process appended in between
//    were silently discarded, and the losing pass still reported a row count.
//    Both processes are ordinary — `membridge team sync` and the daemon tick
//    both call syncTeams — and the loss lands on the one store that holds
//    history past the 100-row state cache. Not a compaction precondition: a
//    bug that was already there, which compaction merely rides.
//
// THE INVARIANT the checks below pin: compaction is "fewer bytes, same
// content", NEVER "keep less content". What a rewrite drops is not a row —
// readRows has always been last-line-wins per rowKey, so a superseded line is
// one no reader has ever returned. Age-based dropping and cap enforcement are
// deliberately NOT compaction's business (the long tail is the whole reason
// this file exists; the asymmetric forward trim already owns the cap), and the
// trim/backfill checks here exist to prove compaction did not take either over.
//
// Run directly, or via `node test/run.js team-archive-compaction`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const teamArchive = require('../../lib/team-archive');

// One page of distinct rows.
//
// rowKey is (author, ts, source) and NOTHING ELSE — not session, not summary —
// so the TIMESTAMP is the only thing that makes a row its own here. The page
// prefix therefore has to move the clock, not just the labels: keying two pages
// apart by session id alone would silently make them the same rows, and every
// count below would be measuring a fixture bug instead of the code.
function page(prefix, n, opts = {}) {
  const hour = 10 + (prefix.charCodeAt(0) - 'a'.charCodeAt(0)); // 'a' -> 10:00, 'b' -> 11:00, ...
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    assert.ok(i < 28, 'page() only generates distinct days up to 28 rows');
    rows.push({
      author: opts.author || 'Andrew',
      authorId: opts.authorId,
      ts: `2026-07-${String(i + 1).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`,
      source: 'Claude Code',
      session: `${prefix}-${i}`,
      summary: `${prefix} row ${i}`,
      files: [],
    });
  }
  return rows;
}

// PHYSICAL lines on disk — the thing duplication shows up in. Distinct rows are
// what readRows/loadArchive report, and the two diverging is the bug.
function physicalLines(projectId) {
  try {
    return fs.readFileSync(teamArchive.archivePath(projectId), 'utf8')
      .split('\n').filter(l => l.trim()).length;
  } catch {
    return 0;
  }
}
const distinctRows = projectId => teamArchive.loadArchive(projectId).rows.length;
const fileBytes = projectId => {
  try { return fs.readFileSync(teamArchive.archivePath(projectId), 'utf8'); } catch { return null; }
};

function main() {
  // ---- 1. the core case: re-appending what we already hold does not grow ----
  {
    const pid = 'compact-repull';
    const p = page('a', 20);
    teamArchive.appendRows(pid, p, { source: 'forward' });
    const linesAfterFirst = physicalLines(pid);
    const rowsAfterFirst = teamArchive.loadArchive(pid).rows;
    const metaAfterFirst = teamArchive.backfillStatus(pid);

    const returned = teamArchive.appendRows(pid, p, { source: 'forward' });

    check('re-appending an identical page leaves the file the same size', () => {
      assert.strictEqual(linesAfterFirst, 20, `fixture: expected 20 lines, got ${linesAfterFirst}`);
      assert.strictEqual(physicalLines(pid), 20,
        `the .ndjson grew on a re-pull of rows it already held (${physicalLines(pid)} lines for 20 rows)`);
    });

    check('and reports exactly the same content, in the same order', () => {
      assert.deepStrictEqual(teamArchive.loadArchive(pid).rows, rowsAfterFirst,
        'compaction changed what readers see — it must be byte-different and meaning-identical');
      assert.strictEqual(returned, 20, `appendRows reported ${returned} rows instead of the 20 distinct ones`);
    });

    check('the sidecar is untouched apart from the row count', () => {
      const now = teamArchive.backfillStatus(pid);
      assert.deepStrictEqual(now.backfill, metaAfterFirst.backfill,
        'compaction disturbed the backfill cursor — that would restart or falsely finish the backward walk');
      assert.strictEqual(now.rowCount, 20, `rowCount drifted from the deduped set: ${now.rowCount}`);
    });

    check('repeated re-appends never accumulate', () => {
      for (let i = 0; i < 3; i += 1) teamArchive.appendRows(pid, p, { source: 'forward' });
      assert.strictEqual(physicalLines(pid), 20,
        `three more identical passes grew the file to ${physicalLines(pid)} lines`);
      assert.strictEqual(distinctRows(pid), 20, 'distinct rows changed under repeated compaction');
    });
  }

  // ---- 2. a partly-overlapping page keeps the new rows and drops nothing ----
  // The realistic re-pull shape: a page that straddles what is already held.
  {
    const pid = 'compact-overlap';
    teamArchive.appendRows(pid, page('a', 10), { source: 'forward' });
    const overlapping = [...page('a', 10).slice(5), ...page('b', 5)];
    teamArchive.appendRows(pid, overlapping, { source: 'forward' });

    check('an overlapping page compacts the duplicates and keeps every new row', () => {
      assert.strictEqual(distinctRows(pid), 15, `expected 15 distinct rows, got ${distinctRows(pid)}`);
      assert.strictEqual(physicalLines(pid), 15,
        `the overlap was written as duplicate lines (${physicalLines(pid)} lines for 15 rows)`);
    });
  }

  // ---- 3. a re-pull's replacement WINS: this is what heals the author id ----
  // The whole point of `membridge team repull`. Same rowKey, now carrying an
  // authorId — the later line must beat the original.
  {
    const pid = 'compact-heal-id';
    teamArchive.appendRows(pid, page('a', 6), { source: 'forward' }); // no authorId
    assert.ok(teamArchive.loadArchive(pid).rows.every(r => !r.authorId), 'fixture: rows should start id-less');
    teamArchive.appendRows(pid, page('a', 6, { authorId: 'uuid-1' }), { source: 'forward' });

    check('a re-pulled row carrying an author id replaces the id-less original', () => {
      const rows = teamArchive.loadArchive(pid).rows;
      assert.strictEqual(rows.length, 6, `the heal duplicated the archive: ${rows.length} rows`);
      assert.ok(rows.every(r => r.authorId === 'uuid-1'),
        'the id-less rows survived the re-pull — the walk cannot heal identity');
      assert.strictEqual(physicalLines(pid), 6, `the heal doubled the file: ${physicalLines(pid)} lines`);
    });
  }

  // ---- 4. the append FAST PATH is still the fast path ----
  // A page of entirely new keys must not trigger a rewrite. Proven by planting
  // a duplicate line by hand: a rewrite would compact it away, an append leaves
  // it. This is what stops "compact on every append" creeping in — that would
  // put a whole-file write on the sync hot path.
  {
    const pid = 'compact-fastpath';
    teamArchive.appendRows(pid, page('a', 4), { source: 'forward' });
    const planted = fileBytes(pid);
    fs.appendFileSync(teamArchive.archivePath(pid), planted.split('\n')[0] + '\n'); // a hand-made duplicate line
    assert.strictEqual(physicalLines(pid), 5, 'fixture: the planted duplicate did not land');

    teamArchive.appendRows(pid, page('b', 3), { source: 'forward' }); // all-new keys
    check('a page of all-new rows appends rather than rewriting the whole file', () => {
      assert.strictEqual(physicalLines(pid), 8,
        `expected 5 existing lines + 3 appended = 8; got ${physicalLines(pid)} (a rewrite would report 7)`);
      assert.strictEqual(distinctRows(pid), 7, 'the distinct set is wrong regardless of path');
    });
  }

  // ---- 5. the cap is still the cap: compaction did not take eviction over ----
  {
    const pid = 'compact-trim';
    const original = teamArchive.MAX_ARCHIVE_ROWS;
    teamArchive.MAX_ARCHIVE_ROWS = 10;
    try {
      teamArchive.appendRows(pid, page('a', 8), { source: 'forward' });
      teamArchive.appendRows(pid, page('b', 8), { source: 'forward' });
      check('a forward append past the cap still evicts the oldest rows', () => {
        const rows = teamArchive.loadArchive(pid).rows;
        assert.strictEqual(rows.length, 10, `the cap stopped being enforced: ${rows.length} rows`);
        assert.strictEqual(physicalLines(pid), 10, 'the trim left duplicate lines behind');
      });

      // And a BACKFILL append is still never trimmed — the retention bug this
      // module was rewritten to fix. Compaction must not reintroduce it.
      const backfillRow = [{
        author: 'Andrew', ts: '2020-01-01T00:00:00.000Z', source: 'Claude Code',
        session: 'ancient', summary: 'the oldest thing there is', files: [],
      }];
      teamArchive.appendRows(pid, backfillRow, { source: 'backfill' });
      check('a backfill append past the cap is still never trimmed', () => {
        const rows = teamArchive.loadArchive(pid).rows;
        assert.ok(rows.some(r => r.session === 'ancient'),
          'the backward walk’s page was discarded the instant it landed — the retention bug is back');
        assert.strictEqual(rows.length, 11, `expected the cap to be exceeded by the backfill row, got ${rows.length}`);
      });
    } finally {
      teamArchive.MAX_ARCHIVE_ROWS = original;
    }
  }

  // ---- 6. the lock covers the READ, so a contended rewrite writes NOTHING ----
  // The second defect. With the read outside the lock, the rewrite path ignored
  // the lock entirely: it replaced the file from a stale snapshot and reported
  // a row count. A foreign lock is exactly what the other process holds while
  // its own append is in flight.
  {
    const pid = 'compact-locked';
    const original = teamArchive.MAX_ARCHIVE_ROWS;
    teamArchive.MAX_ARCHIVE_ROWS = 10;
    try {
      teamArchive.appendRows(pid, page('a', 8), { source: 'forward' });
      const before = fileBytes(pid);

      // Freshly created, so withAppendLock cannot treat it as abandoned.
      const lock = teamArchive.lockPath(pid);
      fs.writeFileSync(lock, String(process.pid));
      let returned;
      try {
        // Would-trim (rewrite) AND would-compact: both rewrite paths at once.
        returned = teamArchive.appendRows(pid, [...page('a', 8), ...page('b', 8)], { source: 'forward' });
      } finally {
        fs.unlinkSync(lock);
      }

      check('a rewrite skipped for a held lock changes nothing on disk', () => {
        assert.strictEqual(fileBytes(pid), before,
          'the rewrite replaced the file while another process held the append lock — its concurrent rows are gone');
      });
      check('and reports null rather than a row count it did not write', () => {
        assert.strictEqual(returned, null,
          `a skipped write reported ${returned}, which would advance the backfill cursor past rows never persisted`);
      });
      check('the sidecar row count is not updated for a write that did not happen', () => {
        assert.strictEqual(teamArchive.backfillStatus(pid).rowCount, 8,
          'rowCount claims rows the file does not contain');
      });

      // Once the lock is free the same call lands, so this is a deferral and
      // never data loss — the rows are still in the cache and the next pull.
      check('the same append lands once the lock is released', () => {
        const after = teamArchive.appendRows(pid, [...page('a', 8), ...page('b', 8)], { source: 'forward' });
        assert.strictEqual(after, 10, `expected the capped 10 rows, got ${after}`);
        assert.strictEqual(physicalLines(pid), 10, 'the landed write left duplicates behind');
      });
    } finally {
      teamArchive.MAX_ARCHIVE_ROWS = original;
    }
  }

  h.finish();
}

main();
