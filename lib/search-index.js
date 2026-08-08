'use strict';
// The storage half of search: a SQLite FTS5 index over every memory entry on
// this machine, ranked by BM25.
//
// WHY THIS EXISTS. lib/search.js scored a plain in-memory array, and its own
// header justified that: "at the observed scale (<= ~200 entries per project)
// a linear scan beats any index we would have to keep consistent." That was
// true when written. lib/team-archive.js then capped the durable archive at
// 50,000 rows and searchMemory started reading it, so a mature team's every
// search linearly scanned tens of thousands of rows -- measured at ~450ms
// against 0.6ms here, cold, including opening the database.
//
// Speed is not the main prize though. BM25 brings real IDF, which the
// hand-rolled scorer has none of: it weights a word present in every entry
// exactly as heavily as one present in a single entry.
//
// ZERO NEW DEPENDENCIES. node:sqlite is built into the runtime, and both the
// shipped Electron binary and modern Node compile in FTS5 and bm25().
//
// DIVISION OF LABOUR. This module owns everything that touches SQLite.
// Ranking POLICY -- tokenizing, the strict/relaxed two-pass, the retrieval
// usage boost -- stays in lib/search.js, which stays pure. This module never
// requires lib/activity.js (that would be a cycle: activity is the caller);
// event keys are handed in by the caller instead.
const fs = require('fs');
const path = require('path');
const util = require('./util');

// node:sqlite is loaded LAZILY, inside open() -- NOT at module scope. Do not
// hoist this back to a top-level require.
//
// bin/membridge.js loads lib/server.js and lib/activity.js on EVERY command,
// and lib/activity.js requires this module, so a top-level require pulled
// node:sqlite into `membridge --version` and `--help` too. node:sqlite is
// unflagged from Node 22.13 but still EXPERIMENTAL for the whole Node 22 LTS
// line, so it emits
//   ExperimentalWarning: SQLite is an experimental feature...
// to stderr before any output -- on every command, for every user on the
// engines floor (`engines.node` is >=22). A CLI that warns about a database it
// never opened is noise, and it lands in the stderr of anything scripting us.
//
// Nothing outside open() touches SQLite, so this costs one cached lookup on the
// paths that DO index or search and nothing at all on the paths that do not.
// require() caches, and the ctor is memoized besides.
let DatabaseSyncCtor = null;
function sqliteCtor() {
  if (DatabaseSyncCtor === null) DatabaseSyncCtor = require('node:sqlite').DatabaseSync;
  return DatabaseSyncCtor;
}

// Bump when the column layout changes: open() drops and recreates on a
// mismatch, because a half-migrated index is worse than a rebuilt one and a
// rebuild is only a few hundred milliseconds.
const SCHEMA_VERSION = 2;

// The UNINDEXED columns carry everything filters and hydration need; the text
// columns are the searchable surface. Order is load-bearing -- the bm25()
// weight vector below is positional and must cover EVERY column.
//
// Every column a FILTER reads is here as its own field rather than being dug
// out of `row`, because filtering is the hot path: a broad query can match
// tens of thousands of rows, and JSON.parsing all of them to answer "is this
// one Andrew's?" cost 88ms of a 90ms search before this split. `row` is read
// only by hydrate(), only for the page actually returned.
const META_COLUMNS = ['key', 'project', 'project_id', 'project_name', 'author', 'author_id',
  'tool', 'ts', 'origin', 'self', 'files_json', 'row'];
const TEXT_COLUMNS = ['headline', 'decisions', 'gotchas', 'files', 'goal', 'ask', 'summary', 'change_notes'];

// Mirrors lib/search.js's FIELD_WEIGHTS exactly: what a teammate wrote
// deliberately (headline, decisions, gotchas) outranks harvested prose, and
// file paths outrank both because on live data 80% of team rows carry no ask.
const TEXT_WEIGHTS = { headline: 4, decisions: 4, gotchas: 4, files: 3, goal: 3, ask: 2, summary: 2, change_notes: 2 };

// Positional weight vector: a 0 for every UNINDEXED column, then the text
// weights. Getting the length wrong is silently wrong ranking, not an error,
// so it is derived from the column lists rather than written out.
const BM25_WEIGHTS = [
  ...META_COLUMNS.map(() => '0.0'),
  ...TEXT_COLUMNS.map(c => TEXT_WEIGHTS[c].toFixed(1)),
].join(',');

const RANK = `bm25(entries, ${BM25_WEIGHTS})`;

function indexPath() { return path.join(util.homeDir(), 'search.db'); }

// ---------------------------------------------------------------------------
// Query translation
// ---------------------------------------------------------------------------
// Queries arrive as human words ("who touched auth.js"), never as FTS5 syntax.
// Handing that text to MATCH raw is not just wrong, it THROWS inside SQLite --
// a bare quote, an unbalanced paren or the word NEAR( is a syntax error, and a
// search must never fail because somebody typed a parenthesis.
//
// Wrapping each term in double quotes (doubling any inside) turns every FTS5
// operator into an ordinary string. The trailing * is what preserves the old
// scorer's substring behaviour: it matched "auth" against "auth.js" and
// "authorization", and a prefix query keeps the useful half of that.
function escapeTerm(term) {
  return `"${String(term).replace(/"/g, '""')}"*`;
}

// Beyond this many OR-ed clauses, stop enumerating combinations and fall back
// to a plain OR. 8 terms at a majority of 5 is 56 clauses; the next steps up
// grow fast and buy nothing, because BM25 already ranks a row matching more
// terms above one matching fewer. The fallback is over-broad, never wrongly
// empty -- the failure that actually costs a user something.
const MAX_COMBINATION_CLAUSES = 64;

function chooseCount(n, k) {
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return Math.round(c);
}

// Every way to pick `k` of `terms`, as AND-groups.
function combinations(terms, k) {
  const out = [];
  (function pick(start, acc) {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let i = start; i < terms.length; i++) {
      acc.push(terms[i]);
      pick(i + 1, acc);
      acc.pop();
    }
  })(0, []);
  return out;
}

// Translate "match at least `minTerms` of these terms" into FTS5 syntax.
//
// FTS5 has no at-least-k-of-n operator, and this codebase needs one: the
// in-memory scorer's strict gate is a MAJORITY of query terms, so translating
// it as a plain AND silently narrows the corpus (caught by the recall harness
// scenario "old exact beats recent partial"). The equivalent expression is the
// disjunction of every k-sized combination -- (a AND b) OR (a AND c) OR
// (b AND c) for 2-of-3 -- which is exact for the query lengths people type.
//
// Null -- never an empty string -- when nothing usable survives, because an
// empty MATCH is a syntax error and "no terms" must be a decision the caller
// makes, not an exception it catches.
function buildMatch(terms, opts = {}) {
  const usable = (terms || []).map(t => String(t || '').trim()).filter(Boolean);
  if (!usable.length) return null;
  const escaped = usable.map(escapeTerm);

  // `any` remains an accepted spelling of "one term is enough" for callers
  // that do not think in term counts.
  const k = opts.any ? 1 : Math.min(
    opts.minTerms == null ? usable.length : Math.max(1, opts.minTerms),
    usable.length);

  if (k <= 1) return escaped.join(' OR ');
  if (k >= usable.length) return escaped.join(' AND ');
  if (chooseCount(usable.length, k) > MAX_COMBINATION_CLAUSES) return escaped.join(' OR ');
  return combinations(escaped, k).map(group => `(${group.join(' AND ')})`).join(' OR ');
}

// ---------------------------------------------------------------------------
// Open / schema
// ---------------------------------------------------------------------------
function applySchema(db) {
  db.exec(`create virtual table entries using fts5(
    ${META_COLUMNS.map(c => `${c} UNINDEXED`).join(', ')},
    ${TEXT_COLUMNS.join(', ')},
    tokenize = 'unicode61'
  )`);
  // Default unicode61 on purpose. The obvious-looking tokenchars '_-.$' keeps
  // auth.js whole, which BREAKS a search for "auth" -- the opposite of what it
  // looks like it does.
  //
  // Note the two tokenizers reach that outcome by OPPOSITE mechanisms, and
  // this comment used to claim they agreed: lib/search.js keeps . - _ $ INSIDE
  // a token and then substring-matches ("auth" hits the whole token
  // "auth.js"), while unicode61 splits on them so "auth" hits a token of its
  // own. Close enough that the same queries work, not close enough to reason
  // about interchangeably -- a query token like `foo.bar` is ONE term to
  // lib/search.js and an adjacency-requiring phrase to FTS5.
  db.exec('create table meta (k text primary key, v text)');
  db.prepare('insert into meta values (?, ?)').run('schema_version', String(SCHEMA_VERSION));
}

function readMeta(db, key) {
  try { return (db.prepare('select v from meta where k = ?').get(key) || {}).v || null; }
  catch { return null; }
}

// A corrupt or stale-schema file is rebuilt, never migrated: the rebuild path
// is also the recovery path, it costs a few hundred milliseconds, and every
// row in here is derived data that exists elsewhere. Deleting search.db by
// hand is always safe.
// How long a blocked writer waits before giving up. Generous on purpose: the
// longest write here is a full rebuild (~450ms for 50k rows), so a search that
// arrives mid-rebuild should wait it out rather than fail.
const BUSY_TIMEOUT_MS = 5000;

// THREE processes touch this file -- the daemon on its tick, the MCP server on
// a search, and the dashboard -- and SQLite's default journal mode fails a
// write outright while another connection holds a transaction
// (ERR_SQLITE_ERROR, not a wait). WAL lets readers through during a write, and
// busy_timeout turns a writer collision into a wait instead of a thrown error.
// Without both, a daemon tick and a search landing together break the search.
function configure(db) {
  db.exec('pragma journal_mode = WAL');
  db.exec(`pragma busy_timeout = ${BUSY_TIMEOUT_MS}`);
}

function open(opts = {}) {
  // The one place node:sqlite is needed; see sqliteCtor() above.
  const DatabaseSync = sqliteCtor();
  const file = opts.path || indexPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db = new DatabaseSync(file);
  configure(db);
  const version = readMeta(db, 'schema_version');
  if (version === String(SCHEMA_VERSION)) return db;
  db.close();
  // WAL keeps its own sidecar files; a stale one beside a deleted database is
  // how a "rebuilt" index comes back holding the old schema's rows.
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
  db = new DatabaseSync(file);
  configure(db);
  applySchema(db);
  return db;
}

function close(db) { try { db.close(); } catch { /* already closed */ } }

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
const textOf = (entry, column) => {
  if (column === 'files') return (entry.files || []).join(' ');
  if (column === 'change_notes') return (entry.changes || []).map(c => (c && c.note) || '').join(' ');
  return entry[column] || '';
};

// Replace the whole corpus in one transaction. A transaction is not a nicety
// here: the same 50k rows take 443ms inside one and 76 SECONDS outside it.
//
// Dedup is by construction. FTS5 tables cannot carry a PRIMARY KEY, so twins
// are collapsed in JS on the way in, keyed on the caller's event key with the
// LAST write winning -- which is how the cache-beats-archive precedence in
// lib/activity.js is expressed: hand cache rows in last.
//
// The `entry` written to `row` is whatever the caller passes, and the caller
// is corpus assembly, whose output has already been through the redaction
// closure. Raw team rows never reach this function, so unredacted text cannot
// physically land in the index.
// `owningProject`, when given, is AUTHORITATIVE for the project column and
// overrides whatever the entry carries. That is not a convenience: team rows
// come out of feed.normalizeTeam with projectPath NULL (only local rows carry
// one), so trusting the entry would file every team row under '' — where its
// own project's rewrite would never delete it and the revocation guard, which
// matches on project path, would never see it. Stamping the owner here makes
// delete and insert symmetric by construction.
function insertRows(db, items, owningProject) {
  const byKey = new Map();
  for (const it of items || []) {
    if (it && it.key) byKey.set(it.key, it.entry || {});
  }
  const columns = [...META_COLUMNS, ...TEXT_COLUMNS];
  const insert = db.prepare(
    `insert into entries (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`);
  for (const [key, entry] of byKey) {
    insert.run(
      key,
      owningProject != null ? owningProject : (entry.projectPath || ''),
      entry.projectId || '',
      entry.project || '',
      entry.author || '',
      entry.authorId || '',
      entry.source || '',
      entry.ts || '',
      entry.origin || '',
      entry.self ? 1 : 0,
      JSON.stringify(entry.files || []),
      JSON.stringify(entry),
      ...TEXT_COLUMNS.map(c => textOf(entry, c)),
    );
  }
}

// Run `fn` inside a transaction, rolling back on any throw. A transaction is
// not a nicety here: the same 50k rows take 443ms inside one and 76 SECONDS
// outside it.
function inTransaction(db, fn) {
  db.exec('begin');
  try {
    fn();
    db.exec('commit');
  } catch (err) {
    try { db.exec('rollback'); } catch { /* transaction already unwound */ }
    throw err;
  }
}

const FP_PREFIX = 'fp:';

function replaceAll(db, items, opts = {}) {
  inTransaction(db, () => {
    db.exec('delete from entries');
    // Per-project fingerprints describe a corpus that no longer exists. Left
    // behind, every project would look already-fresh and the freshener would
    // skip refilling the index this call just emptied.
    db.prepare('delete from meta where k like ?').run(`${FP_PREFIX}%`);
    insertRows(db, items);
    db.prepare('insert or replace into meta values (?, ?)')
      .run('redaction_signature', String(opts.signature == null ? '' : opts.signature));
  });
}

// Rewrite exactly one project's rows. This is the common path: state.json
// changes on every daemon tick, so a full rebuild per search would be slower
// than the linear scan this index replaces. The caller freshens only projects
// whose inputs actually moved and skips the rest on a fingerprint compare.
function replaceProject(db, projectPath, items, fingerprint) {
  inTransaction(db, () => {
    db.prepare('delete from entries where project = ?').run(projectPath);
    insertRows(db, items, projectPath);
    db.prepare('insert or replace into meta values (?, ?)')
      .run(FP_PREFIX + projectPath, String(fingerprint == null ? '' : fingerprint));
  });
}

// Null — never a sentinel string — for a project this index has never held, so
// "absent" and "unchanged" can never be confused by a caller comparing values.
function projectFingerprint(db, projectPath) {
  return readMeta(db, FP_PREFIX + projectPath);
}

// Has the redaction config changed since this index was built? A mismatch must
// force a rebuild: adding a redaction pattern that the index never saw would
// otherwise leave the old, unredacted text searchable forever. Same one-shot
// signature shape as lib/block-signature.js.
function needsRebuild(db, signature) {
  return readMeta(db, 'redaction_signature') !== String(signature == null ? '' : signature);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
// opts.excludeTeamFor: project paths whose TEAM rows must not be served. This
// is the second of two revocation layers and the one that actually holds.
// Server-side revocation has no way to reach local disk (the index, like every
// other local read, makes no network call), so the reader excludes on its own
// rather than trusting the writer to have pruned. A person's own local rows
// are never excluded -- losing team access does not delete your own work.
function search(db, opts = {}) {
  const match = buildMatch(opts.terms, { any: opts.any, minTerms: opts.minTerms });
  if (!match) return [];
  return runMatch(db, match, opts);
}

// Entries touching any of these files, whatever their text says.
//
// This is the file graph's reach into the index, and the reason it is a
// SEPARATE query rather than a re-rank of what search() returned: an entry
// that shares code but no vocabulary never matched the lexical query at all,
// so it is not in that candidate set and no amount of reordering can surface
// it. Reranking changes which of the found entries lead; only a second query
// changes what was found.
//
// `files` is a real indexed column (TEXT_COLUMNS above), so this is one more
// FTS5 MATCH and not a scan. Paths are phrase-quoted: under unicode61 a path
// tokenizes to lib/quant/js, and as a phrase it requires that adjacency, so
// "lib/quant.js" does not also match "lib/quant.ts".
function neighboursByFiles(db, opts = {}) {
  const files = (opts.files || []).map(f => String(f || '').trim()).filter(Boolean);
  if (!files.length) return [];
  const match = files.map(f => `files:"${f.replace(/"/g, '""')}"`).join(' OR ');
  return runMatch(db, match, opts);
}

// The one place a MATCH becomes SQL. search() and neighboursByFiles() share
// it deliberately: the revoked-team exclusion below is a privacy filter, and
// a second hand-written copy of it is exactly how one query keeps honouring a
// revocation while the other quietly stops.
function runMatch(db, match, opts = {}) {
  const params = [match];
  // Deliberately NOT selecting `row`. A broad query legitimately matches tens
  // of thousands of rows, and every one of them would be JSON.parsed just to
  // be filtered out or ranked below the page -- measured at 88ms of a 90ms
  // search. Callers filter and rank on this metadata, then hydrate() the page.
  let sql = `select key, project, project_id, project_name, author, author_id,
    tool, ts, origin, files_json, ${RANK} as rank from entries where entries match ?`;
  // Scope to one project. The PreToolUse Grep hook answers inside a single
  // repo and must never serve another project's memory into it.
  if (opts.project) {
    sql += ' and project = ?';
    params.push(opts.project);
  }
  const revoked = (opts.excludeTeamFor || []).filter(Boolean);
  if (revoked.length) {
    sql += ` and not (origin = 'team' and project in (${revoked.map(() => '?').join(', ')}))`;
    params.push(...revoked);
  }
  sql += ' order by rank';
  if (opts.limit) { sql += ' limit ?'; params.push(opts.limit); }

  let rows;
  try {
    rows = db.prepare(sql).all(...params);
  } catch (err) {
    // Every operator a user could type is already neutralised by escapeTerm,
    // so reaching here means something we did not anticipate. A search that
    // returns nothing is a bad answer; a search that throws is a broken tool.
    //
    // LOGGED, not silent. This catch makes the failure indistinguishable from
    // "found nothing", which is exactly the shape that let a false-green test
    // pass with escaping removed entirely. The log line is the only way a real
    // bug in here ever surfaces.
    try { util.log(`search-index query failed: ${err && err.message ? err.message : err}`); } catch {}
    return [];
  }
  // Shaped like a normalized feed entry for the fields filters read, so
  // lib/activity.js's matchers (matchesAuthor/matchesProject/matchesTool) run
  // against these unchanged rather than growing an index-only dialect.
  return rows.map(r => ({
    key: r.key,
    // bm25() scores are NEGATIVE, more negative being better. Negate once,
    // here, so every consumer above this line sees the same convention as the
    // old scorer -- higher is better -- and lib/search.js's usage boost keeps
    // multiplying in the right direction.
    score: -r.rank,
    projectPath: r.project || null,
    projectId: r.project_id || null,
    project: r.project_name || null,
    author: r.author || null,
    authorId: r.author_id || null,
    source: r.tool || null,
    ts: r.ts || null,
    origin: r.origin || null,
    files: safeParse(r.files_json, []),
  }));
}

// Full entries for a page of keys. THE only reader of `row`, and the reason
// search() can stay cheap: parsing is paid for the results actually served,
// never for the candidate set.
function hydrate(db, keys) {
  const out = new Map();
  const wanted = (keys || []).filter(Boolean);
  if (!wanted.length) return out;
  // Chunked: SQLite's default parameter ceiling is well above a page of
  // results, but a caller asking for a large limit must not hit it.
  const CHUNK = 400;
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const slice = wanted.slice(i, i + CHUNK);
    const rows = db.prepare(
      `select key, row from entries where key in (${slice.map(() => '?').join(', ')})`).all(...slice);
    for (const r of rows) out.set(r.key, safeParse(r.row, {}));
  }
  return out;
}

function safeParse(json, fallback) {
  try {
    const parsed = JSON.parse(json);
    return parsed == null ? fallback : parsed;
  } catch { return fallback; }
}

module.exports = {
  open, close, indexPath, replaceAll, replaceProject, projectFingerprint,
  search, neighboursByFiles, hydrate, needsRebuild, escapeTerm, buildMatch,
  SCHEMA_VERSION, TEXT_COLUMNS, TEXT_WEIGHTS,
};
