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
//
// `live` alone is not self-describing, because local and team entries reach it
// over different evidence and the word does not say which. Every entry
// therefore also carries `liveBasis`: 'session-events' for a local entry
// (the session's own events, below) and 'synced-row' for a team entry (the
// newest row that reached this machine, normalizeTeam). Reading a team row's
// live flag as proof a teammate is working at that moment is the specific
// mistake this names, and it has already been made through the MCP.
// The entry ts is when its ASK happened, which is NOT when its work last
// happened: memorydb buckets a session's distilled checkpoints onto whichever
// prompt was current (lib/memorydb.js:147-163), so a long autonomous session
// absorbs fresh summaries while its ts stays pinned at that prompt. Liveness
// keys on this instead, and every entry exposes it as lastActivityAt so callers
// can render "still working" without re-deriving it.
//
// ORDERING deliberately still keys on ts. Sorting the feed by activity is the
// right end state, but the page cursor rides the same axis as the sort in three
// places that must agree — the local before= filter (server.js), buildFeed's
// nextBefore, and the team RPC's beforeCreatedAt, which differ on inclusivity —
// so moving the sort without moving all three silently returns the wrong page.
// That is its own change; see the note in docs/superpowers or ask before doing
// it piecemeal.
function localActivityAt(e, meta) {
  const byId = meta && meta.lastEventBySession;
  return (byId && e.session && byId.get(e.session)) || e.ts;
}

function localLiveness(e, meta) {
  return util.isLive(localActivityAt(e, meta), meta && meta.now);
}

function normalizeLocal(e, meta) {
  const redact = meta && meta.redact;
  return {
    origin: 'local',
    ts: e.ts || '',
    lastActivityAt: localActivityAt(e, meta) || '',
    live: localLiveness(e, meta),
    liveBasis: 'session-events',
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
    // pushed row -- so recency is judged on the row itself. Same compromise
    // lib/provenance.js makes for team rows, and the same window.
    //
    // This is a WEAKER claim than a local entry's, in both directions, and
    // liveBasis below is what says so: a teammate working right now reads as
    // not-live until one of their rows is pushed and pulled, and a teammate
    // who pushed a row and then stopped reads as live for the rest of the
    // window. It is evidence of recent synced activity, never proof of a
    // current remote session. Real presence is a separate, unbuilt feature
    // (docs/guide.md's roadmap); do not let this field stand in for it.
    // ...and `ts` is the WRONG clock to judge it on. That field is authored on
    // the pushing machine (an entry's ask time, or — before the ingest stamp in
    // lib/scan.js — a model's estimate), so it read hours stale while a
    // teammate was actively working. `created_at` is the backend's own insert
    // time: the row demonstrably reached the table then, and the daemon pushes
    // within ~60s of the work. Arrival also can't be forged forward by a
    // future-dated ts. Backends predating the column send none, so ts remains
    // the fallback.
    //
    // Note this makes the claim honest rather than strong: a first-join
    // backfill inserts historical rows with a fresh created_at and they will
    // read live. That is exactly what 'synced-row' already means — recent
    // arrival, never proof of a current remote session.
    lastActivityAt: row.created_at || row.ts || '',
    live: util.isLive(row.created_at || row.ts, opts && opts.now),
    liveBasis: 'synced-row',
    self,
    // Team rows are never self-toggleable from the feed; keep the field
    // present so every entry has a uniform shape regardless of origin.
    shared: false,
    author: self ? 'You' : (row.author_name || ''),
    authorId: row.author_id || null,
    source: row.source || '',
    // `session text` is NULLABLE, and has been since the original CREATE TABLE
    // (supabase/schema.sql) -- no migration ever added it, so a null here means
    // the push carried no session id, never that the row predates the column.
    // Such a row renders as a single-entry thread (the same graceful fallback
    // teamInjectSlice applies). The distinction matters: a comment that
    // documents a defense against an impossible state teaches the next reader
    // something false, and this file's neighbouring claim about author_id
    // (`author_id uuid not null`, also original, also never altered) had
    // already propagated into a second file that way.
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

// THE INSTANT, not the spelling of it.
//
// A local entry's ts is a JS toISOString() Z-form string (lib/scan.js), pushed
// verbatim (lib/teamsync.js) into a `timestamptz` column. team_feed declares
// that column timestamptz too, and PostgREST renders its JSON through
// Postgres's own to_json, which does NOT hand back the string that went up.
// Verified against Postgres 17 (Supabase runs 17.6.1):
//
//   input:   '2026-08-05T12:00:00.550Z'::timestamptz
//   to_json: "2026-08-05T12:00:00.55+00:00"
//
// Z becomes +00:00, and trailing zeros in the fraction are trimmed. So every
// comparison below that used to compare raw ts strings was comparing two
// spellings of one instant and concluding they were two different rows: on a
// linked project your own work came back as a second, unfoldable copy of
// itself. It was invisible for two reasons, and both are gone now -- the UI's
// collapseSessionCheckpoints folded the pair by accident on session id alone
// (the feed rewrite removes it), and test/mock-supabase.js returned pushed
// rows byte-identical to what it stored (it now renders them the way Postgres
// does). Do not reintroduce a raw-string ts comparison anywhere on this path.
//
// Junk that is not a timestamp keys as ITSELF, never as NaN: a shared NaN key
// would collide every unparseable row with every other and silently delete
// rows from the feed.
const instantKey = ts => {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? String(t) : `raw:${ts == null ? '' : ts}`;
};

// Collision key for "the same pushed work in both sources". A linked local
// project shares projectId with its team rows; unlinked locals fall back to
// path, which no team row carries, so they never collide. The project
// component must lead with projectId for the same reason the ts is parsed:
// normalizeTeam nulls projectPath on purpose and the backend capitalises the
// project name, so those two components differ on the twin as well.
function dedupeKey(e) {
  const proj = e.projectId || e.projectPath || e.project || '';
  return proj + ' ' + instantKey(e.ts) + ' ' + (e.ask || '');
}

// Drop the team rows that are this machine's own local entries coming back.
//
// Your own work always lives in the LOCAL source with its verbatim prompt
// intact -- you can always read your own messages. When one of your sessions
// is on a linked team it is ALSO pushed to the backend (summary always; ask
// null unless you shared it), so the SAME entry returns as a self-authored
// team row. dedupeKey collapses the SHARED twin (its ask matches the local
// one), but the UNSHARED twin has a null ask, legitimately dodges that key,
// and renders a duplicate "(prompt not shared)" row for a prompt the local
// copy shows in full.
//
// ONLY THE FEED PATH IS EXPOSED TO THIS. team_feed's WHERE clause has no
// self-exclusion (025_enforce_project_access.sql), so the twin genuinely
// reaches the client here. The cached path does not have the problem at all:
// pullProject and the archive backfill both request author_id=neq.<self>, so
// a self row never enters proj.teamEntries. Do not "simplify" by assuming the
// two paths behave alike.
//
// THE KEY IS THE BACKEND'S OWN ROW IDENTITY: memory_entries carries
// `unique (project_id, author_id, ts, source)` (supabase/schema.sql) and the
// push upserts on exactly that conflict key (lib/teamsync.js). For a row
// already known to be SELF, author_id is fixed, so project + instant + source
// is precisely what the backend itself treats as one row. That is why this
// cannot over-fold: the backend is physically incapable of holding two rows
// that this key would confuse, so anything it matches was one row upstream.
//
// It also means the session id is not part of the key, which is deliberate.
// Keying on session would leave a session-less entry unfoldable, and that is
// the one shape with no accidental protection anywhere else in the stack.
//
// Still narrow on the two counts that would delete real history if loosened:
//   * SELF rows only. A teammate's row at the same instant is a different
//     person's work, and no dedupe may ever cross an author.
//   * self rows with no local twin are KEPT. Those are this account's work
//     from another machine, and this machine holds no other record of it.
//
// Lives here rather than inline in server.js so it can be tested against the
// real round-trip ts format without standing up an HTTP server; see
// test/suites/feed-twin-dedupe.test.js.
function selfTwinKey(e) {
  const proj = e.projectId || e.projectPath || e.project || '';
  return proj + '|' + instantKey(e.ts) + '|' + (e.source || '');
}

function dropSelfTwins(local, team) {
  const localSelfKeys = new Set(
    (local || []).filter(e => e && e.self).map(selfTwinKey));
  if (!localSelfKeys.size) return (team || []).slice();
  return (team || []).filter(e => !(e && e.self && localSelfKeys.has(selfTwinKey(e))));
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

module.exports = { normalizeLocal, normalizeTeam, buildFeed, dedupeKey, dropSelfTwins, instantKey };
