// Durable per-project archive of pulled teammate rows.
//
// proj.teamEntries in state.json is a WORKING CACHE: pullProject truncates
// it to the newest MAX_TEAM_ENTRIES (100) — roughly 20 days for a 2-person
// team, under a week for a busy 5-person one — and the pull cursor advances,
// so older rows are gone from this machine forever. Search needs the long
// tail (cross-teammate overlap has a ~50-day median), so every pull also
// appends its mapped rows here, and search reads cache + archive merged.
//
// Storage: two files per server-side project id under
// <homeDir>/team-archive/:
//   <projectId>.ndjson     — the rows, one JSON object per line, append-only
//   <projectId>.meta.json  — format version + backfill cursor + row count
// projectId is the team backend's UUID — stable across machines and
// worktrees, never derived from a path (lib/repo-root.js documents why
// path-derived keys fragment).
//
// Why two files, why NDJSON: the previous format was one whole-file JSON
// blob, parsed and rewritten on every single pull — at the row cap that is a
// multi-MB read+write on the sync hot path, for what is usually just a
// handful of new rows. NDJSON's append-only shape means a forward pull's
// common case is `fs.appendFileSync` of just the new lines — no rewrite of
// existing content. Collision handling ("replace on collision", below) falls
// out for free: a later line for the same (author, ts, source) key simply
// wins when the file is read back, so an update never has to find and
// rewrite the earlier line. The backfill cursor lives in its own tiny
// sidecar so `backfillArchivePage`'s "is there anything to do" check — the
// common case on every sync tick once a team's backfill has finished, or has
// hit the cap — never has to touch the (potentially large) rows file.
//
// THE RETENTION BUG THIS FIXES: the row cap used to be enforced by keeping
// only the newest N rows, full stop. That is correct for the FORWARD pull
// (new rows are always the most recent; trimming the oldest is exactly
// right). It is catastrophic for the BACKWARD backfill walker
// (lib/teamsync.js backfillArchivePage): every page it fetches is, by
// definition, OLDER than everything already archived — so at a full archive,
// a naive "keep the newest N" trim discarded the backfill's page the instant
// it landed, on every single sync pass, while the walker's cursor still
// advanced and it eventually declared `done: true` — a lie: it never
// actually captured any of that history. This module now enforces the cap
// asymmetrically by writer (`appendRows`' `source` option): FORWARD appends
// still trim the oldest; BACKFILL appends are never trimmed. Once a backfill
// append would put the archive over the cap, `backfillArchivePage` records
// an honest `stopped: 'archive-full'` instead of `done: true`, and stops
// asking — never a false claim of having walked to the true start of
// history.
//
// Rows are stored in pullProject's `mapped` shape, RAW at rest — exactly
// like proj.teamEntries. Redaction happens at every read boundary (the feed
// normalizers' redact closure), never trusted from rest.
//
// Every function fails open: an unreadable/corrupt archive (rows file OR
// sidecar) reads as empty, a failed write must never break a pull or a
// search, and a legacy single-file install that cannot be migrated is
// treated the same way — never a crash, never a silently-invented "backfill
// done".
//
// Fix wave (review of the above rework, before this landed on master):
// migrateLegacy RENAMES the old file to "<id>.json.migrated" instead of
// deleting it — writeAtomic has no fsync, so a crash right after an unlink
// could leave a zero-length rows file next to a sidecar claiming the full
// row count, an empty archive that believes it is complete. appendLines now
// (a) prepends a newline before appending if the file's last byte isn't
// already one, so a crash mid-append can never glue the next append's first
// row onto a truncated final line and lose both, and (b) takes a short-lived
// "<id>.lock" (fs.openSync 'wx') around the actual append, because the CLI
// and the daemon tick both call syncTeams and can otherwise interleave two
// processes' writes mid-file; a lock older than a couple of minutes is
// treated as abandoned so a crashed holder can never wedge the archive.

const fs = require('fs');
const path = require('path');
const util = require('./util');

// `let`, not `const`: MAX_ARCHIVE_ROWS is exported via a getter/setter (see
// module.exports at the bottom) so tests can inject a tiny cap instead of
// building a real 50,000-row archive to exercise cap-adjacent behavior —
// production code never writes it, so this changes no runtime behavior.
let maxArchiveRows = 50000; // ~3 years of history for a busy 20-person team
const FORMAT_VERSION = 2;
const STALE_TMP_MS = 60 * 60 * 1000; // 1 hour — old enough that no live write still owns it
const APPEND_LOCK_STALE_MS = 2 * 60 * 1000; // ~2 minutes — long enough no live append still legitimately owns it, short enough a crashed process can never wedge the archive for long
const rowKey = r => `${r.author}|${r.ts}|${r.source}`;

function archiveDir() {
  return path.join(util.homeDir(), 'team-archive');
}

// projectId is a server-issued UUID; strip anything path-hostile anyway.
function sanitize(projectId) {
  return String(projectId).replace(/[^A-Za-z0-9-]/g, '_');
}

function rowsPath(projectId) {
  return path.join(archiveDir(), `${sanitize(projectId)}.ndjson`);
}
function metaPath(projectId) {
  return path.join(archiveDir(), `${sanitize(projectId)}.meta.json`);
}
// The previous (version 1) whole-file format — read once for migration.
function legacyPath(projectId) {
  return path.join(archiveDir(), `${sanitize(projectId)}.json`);
}
// Held for the duration of one appendLines() call — see withAppendLock.
function lockPath(projectId) {
  return path.join(archiveDir(), `${sanitize(projectId)}.lock`);
}
// Kept for callers that just want "the archive's main file" (tests, mostly).
const archivePath = rowsPath;

function emptyMeta(projectId) {
  return { version: FORMAT_VERSION, projectId, backfill: { done: false, beforeId: null, stopped: null }, rowCount: 0 };
}

// backfill.beforeId is an id cursor (memory_entries.id, a total-ordered
// bigint identity column) into the backward walk (lib/teamsync.js
// backfillArchivePage) — null means "not started yet, walk from the newest
// row". It replaces an earlier created_at-based cursor: created_at is
// timestamptz default now(), and Postgres's now() is constant within a
// transaction, so a batch upsert can write many rows with an IDENTICAL
// created_at — ties a created_at cursor has no way to page past safely.
//
// backfill.stopped is null while the walk is still live or has genuinely
// finished. A non-null reason (currently only 'archive-full') means the
// walker stopped for a reason OTHER than reaching the true start of
// history — set alongside `done: false`, never `done: true`, so nothing
// downstream can mistake "we gave up" for "we walked it all".
function normalizeBackfill(bf) {
  if (!bf || typeof bf !== 'object' || !('beforeId' in bf)) {
    // Either malformed, or written by the PREVIOUS (created_at-based)
    // format — its `before` timestamp cannot be reinterpreted as an id
    // cursor, so restart the walk from the newest row rather than guess.
    // That never skips history: appendRows merges by (author, ts, source),
    // so re-covering already-archived ground on the next pass is just a
    // handful of redundant fetches, not lost data. A finished legacy
    // backfill (done: true) stays finished — there is nothing to redo.
    return { done: !!(bf && bf.done), beforeId: null, stopped: null };
  }
  return {
    done: !!bf.done,
    beforeId: bf.beforeId != null ? bf.beforeId : null,
    stopped: bf.stopped || null,
  };
}

function serializeRows(rows) {
  return rows.length ? rows.map(r => JSON.stringify(r)).join('\n') + '\n' : '';
}

// Throwing, atomic tmp+rename write — pid-suffixed: syncTeams runs from both
// the CLI and the daemon tick, so two processes can race to write the same
// project's files — a fixed tmp name would let one process's rename land on
// the other's half-written file mid-write.
function writeAtomic(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, p);
}

// ---- sidecar: format version + backfill cursor + row count (tiny) ----

function readMeta(projectId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath(projectId), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      version: FORMAT_VERSION,
      projectId,
      backfill: normalizeBackfill(parsed.backfill),
      rowCount: Number.isInteger(parsed.rowCount) ? parsed.rowCount : 0,
    };
  } catch {
    return null; // missing or corrupt — caller falls back to an empty meta
  }
}

function saveMeta(meta) {
  try {
    writeAtomic(metaPath(meta.projectId), JSON.stringify({
      version: FORMAT_VERSION, projectId: meta.projectId, backfill: meta.backfill, rowCount: meta.rowCount,
    }));
  } catch { /* fail-open: the sidecar is an accelerator, never a blocker */ }
}

// ---- rows file: NDJSON, one JSON row per line ----
// Merge-by-key with replace-on-collision falls out of the format for free: a
// row re-arriving under the same (author, ts, source) key is by definition a
// NEWER version (drift re-push, reshare — same rule as pullProject's cache
// merge), and the LATER line in the file wins here.
function readRows(projectId) {
  let text;
  try {
    text = fs.readFileSync(rowsPath(projectId), 'utf8');
  } catch {
    return []; // missing file — a fresh archive, or one that failed open
  }
  const byKey = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let r;
    try {
      r = JSON.parse(trimmed);
    } catch {
      continue; // one corrupt/truncated line (e.g. a crash mid-append) never sinks the rest
    }
    if (!r || !r.author || !r.ts) continue;
    byKey.set(rowKey(r), r);
  }
  return Array.from(byKey.values()).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

// True if the rows file exists, is non-empty, and its LAST byte is not '\n'
// — the signature a crash mid-appendFileSync leaves behind. Reads exactly
// one byte (open + fstat + pread of 1 byte), never the whole file: this
// runs on every append, including at the 50,000-row cap, and the whole
// point of the NDJSON format is that an append never costs an O(file size)
// read (see the module header).
function needsLeadingNewline(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] !== 10; // 10 === '\n'
  } catch {
    return false; // missing/unreadable — nothing to glue onto
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best-effort */ } }
  }
}

// Mutual exclusion for the actual append syscalls: syncTeams runs from both
// the CLI (`membridge team sync`) and the daemon tick, so two SEPARATE
// PROCESSES can both be mid-append to the same rows file at once.
// fs.appendFileSync loops individual write() calls for any payload bigger
// than one syscall's worth of buffer (a 200-row backfill page is commonly
// 100-400KB), and while O_APPEND makes each individual write land
// atomically, two processes' writes can still interleave BETWEEN those
// calls — gluing lines at both seams and losing rows on both sides. (The
// previous whole-file format could only lose an update to a race, never
// corrupt the file — this closes that regression.)
//
// A crashed process's lock must never wedge the archive forever, so a lock
// older than APPEND_LOCK_STALE_MS is treated as abandoned and reclaimed —
// exactly one reclaim attempt, so a genuinely live holder still wins.
// Fail-open throughout: if the lock can't be acquired for any reason
// (someone else holds it, or locking itself errors), skip this append
// rather than risk an interleaved write or throw into a team pull. A
// skipped append is not silent data loss — the same rows are still sitting
// in proj.teamEntries / the next pull's re-fetch; only this one tick's
// archive write is deferred.
// Returns TRUE only if fn() ran to completion. Skipping (lock held by a
// live process) and throwing are both reported as false, because a caller
// that advances a cursor on the strength of an append MUST be able to tell
// "written" from "silently did nothing" — see appendRows.
function withAppendLock(projectId, fn) {
  const p = lockPath(projectId);
  let fd;
  try {
    fd = fs.openSync(p, 'wx');
  } catch (err) {
    if (!err || err.code !== 'EEXIST') return false; // locking itself failed — skip this append
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > APPEND_LOCK_STALE_MS) {
        fs.unlinkSync(p); // abandoned by a crashed process — reclaim it
        fd = fs.openSync(p, 'wx');
      }
    } catch {
      return false; // still held, or reclaiming raced with someone else — skip
    }
  }
  if (fd === undefined) return false; // a live process holds it — skip this append
  let ok = false;
  try {
    fn();
    ok = true;
  } catch {
    /* fail-open: never let an append error escape into a pull */
  } finally {
    try { fs.closeSync(fd); } catch { /* best-effort */ }
    try { fs.unlinkSync(p); } catch { /* best-effort */ }
  }
  return ok;
}

function appendLines(projectId, rows) {
  try {
    const p = rowsPath(projectId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return withAppendLock(projectId, () => {
      let payload = serializeRows(rows);
      if (needsLeadingNewline(p)) payload = '\n' + payload;
      fs.appendFileSync(p, payload, { mode: 0o600 });
    });
  } catch { /* fail-open: the archive is an accelerator, never a blocker */ }
  return false;
}

function rewriteRows(projectId, rows) {
  try {
    writeAtomic(rowsPath(projectId), serializeRows(rows));
    return true;
  } catch { /* fail-open */ }
  return false;
}

// ---- legacy (version 1, whole-file) migration ----
// Existing installs have <projectId>.json: one JSON blob, `rows` plus a
// `backfill` cursor possibly mid-walk. Migrated transparently the first time
// this project's archive is touched, preserving both. A missing, corrupt, or
// otherwise unmigratable legacy file yields no migration at all — the
// project simply starts from an empty archive on the new format, which is
// the fail-open contract this whole module promises (never invent a
// "backfill done" out of a migration failure).
function migrateLegacy(projectId) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(legacyPath(projectId), 'utf8'));
  } catch {
    return null; // no legacy file, or unreadable — nothing to migrate
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rows = Array.isArray(parsed.rows)
    ? parsed.rows.filter(r => r && r.author && r.ts).sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    : [];
  const backfill = normalizeBackfill(parsed.backfill);
  try {
    // Raw, throwing writes here (not the fail-open wrappers above) — this
    // function needs to KNOW whether the new format actually landed before
    // it retires the source; the fail-open wrappers swallow failure by
    // design and would look identical to success.
    writeAtomic(rowsPath(projectId), serializeRows(rows));
    writeAtomic(metaPath(projectId), JSON.stringify({
      version: FORMAT_VERSION, projectId, backfill, rowCount: rows.length,
    }));
  } catch {
    return null; // couldn't persist the new format — leave the legacy file, retry next touch
  }
  // Rename, never delete: writeAtomic (tmp+rename, no fsync) can have its
  // rename journaled before the data blocks actually hit disk, so a power
  // loss right after an unlink here could leave a zero-length .ndjson beside
  // a .meta.json claiming the full rowCount (and possibly `done: true`) —
  // an empty archive that believes it holds everything, which the backfill
  // walker would then never re-fetch. Renaming instead removes that failure
  // class outright: the legacy file is never gone, only relocated, and
  // pruneArchive already sweeps the whole "<id>." prefix, so the leftover
  // costs nothing extra to clean up once the project goes away.
  try { fs.renameSync(legacyPath(projectId), `${legacyPath(projectId)}.migrated`); } catch { /* best-effort; a lingering legacy file is harmless either way */ }
  return { backfill, rows };
}

// Runs the one-time legacy migration exactly once: as soon as either
// new-format file exists (including an empty/fresh project that has never
// had a legacy file at all), this is a no-op two-stat check.
function ensureMigrated(projectId) {
  if (fs.existsSync(metaPath(projectId)) || fs.existsSync(rowsPath(projectId))) return;
  try { migrateLegacy(projectId); } catch { /* fail-open: migration must never break a read/write */ }
}

function loadArchive(projectId) {
  ensureMigrated(projectId);
  const meta = readMeta(projectId) || emptyMeta(projectId);
  return { version: FORMAT_VERSION, projectId, backfill: meta.backfill, rows: readRows(projectId) };
}

// Cheap peek at just the backfill cursor + row count — reads the small
// sidecar only, never the (potentially large) rows file. This is what makes
// backfillArchivePage's per-tick "is there anything to do" check tiny.
function backfillStatus(projectId) {
  ensureMigrated(projectId);
  const meta = readMeta(projectId) || emptyMeta(projectId);
  return { backfill: meta.backfill, rowCount: meta.rowCount };
}

// `opts.source`: 'forward' (default) or 'backfill' — see the module header
// for why the cap is enforced asymmetrically by writer. Returns the
// resulting distinct row count.
function appendRows(projectId, mappedRows, opts = {}) {
  if (!Array.isArray(mappedRows) || !mappedRows.length) return 0;
  ensureMigrated(projectId);
  const source = (opts && opts.source === 'backfill') ? 'backfill' : 'forward';
  const valid = mappedRows.filter(r => r && r.author && r.ts);
  if (!valid.length) return 0;

  const existing = readRows(projectId);
  const byKey = new Map(existing.map(r => [rowKey(r), r]));
  for (const r of valid) byKey.set(rowKey(r), r);
  const merged = Array.from(byKey.values()).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  // FORWARD rows are always the newest, so trimming the oldest is correct —
  // the cap keeps whatever matters most for recency. BACKFILL rows are
  // always the oldest thing being added, so the same trim would discard
  // exactly what was just fetched; never trim on that path (the crux of the
  // bug this module fixes — see the header comment).
  const mustTrim = source === 'forward' && merged.length > maxArchiveRows;
  const finalRows = mustTrim ? merged.slice(-maxArchiveRows) : merged;

  const wrote = mustTrim
    ? rewriteRows(projectId, finalRows) // eviction happened — only case that needs a full rewrite
    : appendLines(projectId, valid);    // fast path: just the new lines, no rewrite

  // A skipped or failed write must not be papered over: writing rowCount
  // here would claim rows the file does not contain, and returning a count
  // would tell backfillArchivePage to advance its cursor past rows that
  // were never persisted — permanently skipping them. Contention is the
  // NORMAL case (the CLI and the daemon tick both call syncTeams), not an
  // exotic failure, so this path is reached in ordinary use.
  if (!wrote) return null;

  const meta = readMeta(projectId) || emptyMeta(projectId);
  saveMeta({ projectId, backfill: meta.backfill, rowCount: finalRows.length });
  return finalRows.length;
}

function setBackfill(projectId, backfill) {
  ensureMigrated(projectId);
  // Fail-open like everything else here: a missing/malformed backfill arg
  // (a caller bug, not a disk failure) must not throw past this module's
  // documented contract — treat it as "not done, no checkpoint" instead.
  const safe = (backfill && typeof backfill === 'object') ? backfill : {};
  const meta = readMeta(projectId) || emptyMeta(projectId);
  saveMeta({
    projectId,
    backfill: {
      done: !!safe.done,
      beforeId: safe.beforeId != null ? safe.beforeId : null,
      stopped: safe.stopped || null,
    },
    rowCount: meta.rowCount,
  });
}

// Sweep <homeDir>/team-archive for stray `.<pid>.tmp` files left behind by a
// process that crashed between the write and the rename. Only removes tmp
// files old enough that they cannot belong to a write still in flight.
function sweepStaleTmp() {
  try {
    const dir = archiveDir();
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.tmp')) continue;
      const p = path.join(dir, name);
      try {
        if (now - fs.statSync(p).mtimeMs > STALE_TMP_MS) fs.unlinkSync(p);
      } catch { /* best-effort */ }
    }
  } catch { /* fail-open: cleanup must never break a caller */ }
}

// Remove every file belonging to this project's archive (rows + sidecar,
// plus a lingering legacy file if migration never ran) — called when a
// project is unlinked or removed so archives don't outlive the project.
// Also sweeps stale .tmp leftovers dir-wide while it's already listing the
// directory. Fail-open: pruning is best-effort cleanup, never allowed to
// break an unlink/delete flow.
function pruneArchive(projectId) {
  try {
    const dir = archiveDir();
    if (fs.existsSync(dir)) {
      const prefix = `${sanitize(projectId)}.`;
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(prefix)) {
          try { fs.unlinkSync(path.join(dir, name)); } catch { /* best-effort */ }
        }
      }
    }
  } catch { /* fail-open */ }
  sweepStaleTmp();
}

module.exports = {
  archivePath, metaPath, legacyPath, lockPath, loadArchive, appendRows, setBackfill,
  backfillStatus, pruneArchive, sweepStaleTmp,
};
// MAX_ARCHIVE_ROWS as a live getter/setter, not a plain exported value: a
// plain `module.exports.MAX_ARCHIVE_ROWS = maxArchiveRows` would export a
// frozen COPY of the number, so a test assignment to it would never be seen
// by this module's own internal cap checks (or by teamsync.js's, which
// reads `teamArchive.MAX_ARCHIVE_ROWS` on every backfillArchivePage call).
// The getter/setter keeps every reader and writer pointed at the same
// `maxArchiveRows` binding. Reading it (100% of production call sites)
// behaves exactly as a plain exported constant always did; only a test
// deliberately assigning to it changes anything.
Object.defineProperty(module.exports, 'MAX_ARCHIVE_ROWS', {
  enumerable: true,
  configurable: true,
  get() { return maxArchiveRows; },
  set(v) { if (Number.isInteger(v) && v > 0) maxArchiveRows = v; },
});
