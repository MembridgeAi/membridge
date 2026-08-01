'use strict';

// Pure feed read-model. Transforms already-fetched arrays (no fs/network):
// local .membridge entries (memorydb.buildEntries) and team_feed RPC rows are
// normalized to one shape, merged newest-first, deduped where the same pushed
// work appears in both, and paginated with an approximate cross-source cursor.
//
// Redaction: callers pass `redact` (a compiled digest.redactText closure) in
// meta/opts, and the free-text fields (ask, summary) run through it at this
// boundary. Team rows are the point — server content is untrusted, and a
// hostile or legacy backend row must not surface a raw secret in the feed
// (same defense in depth the context-block render path applies). Threading a
// closure keeps this module pure (no fs, no config loading). Falsy fields
// skip redaction so a null ask stays falsy for the "(prompt not shared)"
// rendering, never the string "null".

const util = require('./util');

const applyRedact = (redact, text) => (text && typeof redact === 'function' ? redact(text) : text);

// Liveness is stamped here, at the one point every feed entry passes through,
// so the app's live dot and Today's LIVE NOW count read a single field
// instead of each deriving their own answer (they disagreed: the count and
// the dots were both "has no summary yet", which never expires).
//
// `meta.lastEventBySession` maps a session id to the ts of its newest event of
// ANY kind. That is deliberately not this entry's own ts: a session still
// running is live even when its last *entry* is older than its last activity
// -- it may have been editing files for ten minutes without landing a new
// prompt or summary. Same rule lib/provenance.js has always used locally.
// Falls back to the entry ts when the caller supplies no map.
function localLiveness(e, meta) {
  const byId = meta && meta.lastEventBySession;
  const last = (byId && e.session && byId.get(e.session)) || e.ts;
  return util.isLive(last, meta && meta.now);
}

function normalizeLocal(e, meta) {
  const redact = meta && meta.redact;
  return {
    origin: 'local',
    ts: e.ts || '',
    live: localLiveness(e, meta),
    self: true,
    // Whether this session's verbatim prompt is currently shared with the
    // team (teamsync.isShared is the source of truth; server.js stamps it
    // onto e before normalizing). Lets the session card show the toggle in
    // the right state without a second round trip.
    shared: !!e.shared,
    author: 'You',
    authorId: meta.authorId || null,
    source: e.source || '',
    // Session id (buildEntries carries it on every entry) so the dashboard can
    // group a session's prompts into one thread. Null when absent — the feed
    // renders such rows as single-entry threads, never false-merging them.
    session: e.session || null,
    project: meta.projectName || '',
    projectPath: meta.projectPath || null,
    projectId: meta.projectId || null,
    // Local entries are already redacted by buildEntries; this second pass is
    // defensive and idempotent, mirroring how renderBlock re-redacts them.
    ask: applyRedact(redact, e.ask) || '',
    // Unclipped twin of ask for the day-detail prompt rows; local entries only
    // (team rows are clipped at push time and never carry it).
    askFull: applyRedact(redact, e.askFull) || null,
    summary: applyRedact(redact, e.summary) || null,
    // Unclipped twin of summary for the session detail page; local entries
    // only — team rows ship the full text directly in `summary`, so readers
    // fall back to summary when this is absent.
    summaryFull: applyRedact(redact, e.summaryFull) || null,
    distilled: !!e.distilled,
    files: Array.isArray(e.files) ? e.files.slice() : [],
    tasks: e.tasks || null,
    goal: applyRedact(redact, e.goal) || null,
    headline: applyRedact(redact, e.headline) || null,
    decisions: applyRedact(redact, e.decisions) || null,
    gotchas: applyRedact(redact, e.gotchas) || null,
    changes: Array.isArray(e.changes) ? e.changes.map(c => (c.note ? { ...c, note: applyRedact(redact, c.note) } : c)) : [],
    cursor: null,
    // Internal, feed-only: when buildEntries defers git-change derivation
    // (deferChanges), this carries the highlight set forward so server.js can
    // derive `changes` for just the entries that survive the page slice, then
    // delete it. Absent on the normal (already-derived) path, so it never
    // reaches the JSON response there.
    ...(e._highlights ? { _highlights: e._highlights } : {}),
  };
}

function normalizeTeam(row, opts) {
  const self = !!(opts && opts.selfUserId && row.author_id === opts.selfUserId);
  const redact = opts && opts.redact;
  return {
    origin: 'team',
    ts: row.ts || '',
    // A teammate's raw events never leave their machine -- all we hold is the
    // pushed row -- so recency is judged on the row's own ts. Same compromise
    // lib/provenance.js makes for team rows, and the same window, so a
    // teammate's session and yours mean the same thing by "live".
    live: util.isLive(row.ts, opts && opts.now),
    self,
    // Team rows are never self-toggleable from the feed; keep the field
    // present so every entry has a uniform shape regardless of origin.
    shared: false,
    author: self ? 'You' : (row.author_name || ''),
    authorId: row.author_id || null,
    source: row.source || '',
    // Rows pushed before the session column existed come back null and render
    // as single-entry threads (same graceful fallback as teamInjectSlice).
    session: row.session || null,
    project: row.project_name || '',
    projectPath: null,
    projectId: row.project_id || null,
    ask: applyRedact(redact, row.ask) || '',
    summary: applyRedact(redact, row.summary) || null,
    // Fail-closed E2E marker: the row carried ciphertext this client could
    // not decrypt, so content fields are null ON PURPOSE (the server's
    // plaintext columns are untrusted). Renderers show an "encrypted" state
    // instead of "(prompt not shared)".
    ...(row.undecryptable ? { undecryptable: true } : {}),
    // Propagated over team sync (pushed by entryToRow, stored on pull): a
    // teammate's distilled summary must read as distilled here, not be lumped
    // in with harvested. Absent on pre-migration rows -> falsy -> harvested.
    distilled: !!row.distilled,
    files: Array.isArray(row.files) ? row.files.slice() : [],
    tasks: null,
    goal: applyRedact(redact, row.goal) || null,
    headline: applyRedact(redact, row.headline) || null,
    decisions: applyRedact(redact, row.decisions) || null,
    gotchas: applyRedact(redact, row.gotchas) || null,
    changes: Array.isArray(row.changes)
      ? row.changes.map(c => (c.note ? { ...c, note: applyRedact(redact, c.note) } : c))
      : [],
    cursor: (row.created_at != null && row.id != null)
      ? { createdAt: row.created_at, id: row.id } : null,
  };
}

// Collision key for "the same pushed work in both sources". A linked local
// project shares projectId with its team rows; unlinked locals fall back to
// path, which no team row carries, so they never collide.
function dedupeKey(e) {
  const proj = e.projectId || e.projectPath || e.project || '';
  return proj + ' ' + (e.ts || '') + ' ' + (e.ask || '');
}

function buildFeed(input) {
  const local = Array.isArray(input.local) ? input.local : [];
  const team = Array.isArray(input.team) ? input.team : [];
  const limit = input.limit > 0 ? input.limit : 50;

  const seen = new Set(local.map(dedupeKey));
  const merged = local.concat(team.filter(t => !seen.has(dedupeKey(t))));
  merged.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  // Rolling-window floor: windowStart (ISO, inclusive) marks the oldest ts
  // page one must still include — "the Activity feed always shows the last
  // 24 hours". The floor only ever GROWS the page past `limit`; a sparse
  // window still fills to `limit` so a quiet day doesn't render two rows
  // above a View more button. Entries with a falsy ts sort to the tail and
  // can never satisfy the >= comparison, so they stay behind the cursor.
  let size = limit;
  if (input.windowStart) {
    const cutoff = String(input.windowStart);
    let inWindow = 0;
    while (inWindow < merged.length && String(merged[inWindow].ts) >= cutoff) inWindow++;
    size = Math.max(limit, inWindow);
  }

  const page = merged.slice(0, size);
  const nextBefore = merged.length > size && page.length ? page[page.length - 1].ts : null;
  return { entries: page, teamUnavailable: !!input.teamUnavailable, nextBefore };
}

module.exports = { normalizeLocal, normalizeTeam, buildFeed, dedupeKey };
