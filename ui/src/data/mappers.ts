// Pure functions that turn the daemon's real JSON payloads (lib/server.js)
// into the UI's domain types (./types.ts) -- kept separate from
// LocalDaemonClient.ts so every mapping decision is unit-testable without a
// live daemon. Settings' own mapping lives in ./settingsMapper.ts, split out
// to keep this file focused on feed/project/member mapping.
import type { FeedEntry, FeedFilters, FileChange, LiveSession, LiveSessionGroup, Member, Project, Role, Session, StreamEntry, SyncState } from './types'

// ---------------------------------------------------------------------------
// Raw daemon shapes consumed here (subset of the real payloads -- see
// lib/server.js: statusPayload:149, projectsPayload:241, feedPayload:366).
// ---------------------------------------------------------------------------

export interface RawProjectRow {
  path: string
  name: string
  exists: boolean
  paused: boolean
  lastSync: string | null
  lastActivity: string | null
  sessionsTotal: number
  sessionsThisWeek: number
  dailyCounts: number[]
  tools: string[]
  team: { projectId?: string | null; teamId?: string | null } | null
}

// A raw change row off the wire: lib/changes.js emits every field, but rows
// from older daemons or team pushes can be sparse -- everything past `file`
// is optional here and normalized by mapChange, never trusted to be present.
export interface RawFileChange {
  file: string
  status?: string | null
  add?: number | null
  del?: number | null
  note?: string | null
  dep?: boolean
}

export interface RawFeedEntry {
  ts: string
  author: string
  authorId: string | null
  source: string
  session: string | null
  project: string
  projectPath: string | null
  projectId: string | null
  ask: string
  summary: string | null
  distilled: boolean
  files: string[]
  goal: string | null
  headline: string | null
  // Brief fields the daemon has shipped all along (lib/feed.js normalizeLocal
  // emits them on every entry) -- optional here because a team row or an older
  // daemon may omit them; mapStreamEntry normalizes absence to null / [].
  summaryFull?: string | null
  decisions?: string | null
  gotchas?: string | null
  changes?: RawFileChange[] | null
  // Stamped by the daemon (lib/feed.js) from the session's newest event of any
  // kind, against util.LIVE_WINDOW_MS. The UI does not recompute it: this
  // field is the single source both the live dot and Today's LIVE NOW count
  // read, which is what keeps the count equal to the number of dots.
  live: boolean
}

// feedPayload's response shape (server.js:539 feedPayload -> lib/feed.js
// buildFeed): only the two fields the Feed screen actually reads -- the
// entry page and the pagination cursor. The payload carries more (teamStatus
// flags, suggestions, etc.) that no UI consumer needs yet.
export interface RawFeedPayload {
  entries: RawFeedEntry[]
  nextBefore: string | null
}

// GET /api/session's payload (lib/server.js sessionPayload). Everything past
// `session` is optional here: the mapper normalizes absence to null / [] so
// the page never reads undefined off a sparse or older-daemon response.
export interface RawSessionPayload {
  session?: string
  project?: string
  projectPath?: string | null
  author?: string
  authorId?: string | null
  source?: string
  startedAt?: string | null
  endedAt?: string | null
  live?: boolean
  summary?: string | null
  summaryFull?: string | null
  goal?: string | null
  headline?: string | null
  decisions?: string | null
  gotchas?: string | null
  files?: string[]
  changes?: RawFileChange[] | null
  checkpoints?: { ts?: string; text?: string }[] | null
  prompts?: { ts?: string; ask?: string | null; files?: string[]; undecryptable?: boolean }[] | null
}

export function mapSession(raw: RawSessionPayload): Session {
  return {
    session: raw.session || '',
    project: raw.project || '',
    projectPath: raw.projectPath || null,
    author: raw.author || '',
    authorId: raw.authorId || null,
    source: raw.source || '',
    startedAt: raw.startedAt || null,
    endedAt: raw.endedAt || null,
    live: !!raw.live,
    summary: raw.summary || null,
    summaryFull: raw.summaryFull || null,
    goal: raw.goal || null,
    headline: raw.headline || null,
    decisions: raw.decisions || null,
    gotchas: raw.gotchas || null,
    files: Array.isArray(raw.files) ? raw.files : [],
    changes: Array.isArray(raw.changes) ? raw.changes.map(mapChange) : [],
    checkpoints: Array.isArray(raw.checkpoints)
      ? raw.checkpoints.map(c => ({ ts: c.ts || '', text: c.text || '' }))
      : [],
    // ask stays null when the daemon sent null (a team-origin prompt the
    // author did not share) -- `|| null` also normalizes '' and undefined,
    // and never invents text. The undecryptable marker (fail-closed E2E)
    // rides along only when set, mirroring how the daemon sends it.
    prompts: Array.isArray(raw.prompts)
      ? raw.prompts.map(p => ({
          ts: p.ts || '',
          ask: p.ask || null,
          files: Array.isArray(p.files) ? p.files : [],
          ...(p.undecryptable ? { undecryptable: true } : {}),
        }))
      : [],
  }
}

export interface RawMemberRow {
  user_id: string
  display_name: string
  role: Role
  joined_at: string | null
}

// /api/team/feed row (server.js:1502, team_feed RPC -- 002_team_v2.sql:285) -- raw team stream, not RawFeedEntry's local-merged feed.
export interface RawTeamFeedEntry {
  author_id: string | null
  project_id: string | null
  ts: string
}

// ---------------------------------------------------------------------------
// Sync state: paused wins outright; otherwise activity after the last sync is
// "behind"; anything else is up to date.
//
// The comparison needs a grace period, because the daemon syncs on a timer
// (config.intervalSec) rather than on every write. Work done at any point
// during a tick is legitimately newer than the last sync until that tick
// fires, so a bare `lastActivity > lastSync` flags every actively-used project
// as a problem for most of every interval -- observed live flipping
// behind/up-to-date every poll on a lag of half a second. "Behind" has to mean
// the daemon missed a cycle, not that it simply has not come around yet.
//
// Two intervals, not one: a project synced at the very start of a tick has a
// full interval to accumulate activity before the next one, and the sync
// itself is not instant. One interval would still flag the ordinary case.
// ---------------------------------------------------------------------------
export const SYNC_GRACE_INTERVALS = 2
const DEFAULT_SYNC_INTERVAL_SEC = 60

export function syncStateOf(
  p: { paused: boolean; lastSync: string | null; lastActivity: string | null },
  intervalSec: number = DEFAULT_SYNC_INTERVAL_SEC,
): SyncState {
  if (p.paused) return { state: 'paused' }
  if (!p.lastActivity) return { state: 'up-to-date' }
  // No sync ever recorded is genuinely behind -- there is no tick to be
  // waiting on, so the grace period below does not apply.
  if (!p.lastSync) return { state: 'behind', lastSyncedAt: null }
  const graceMs = Math.max(0, intervalSec) * SYNC_GRACE_INTERVALS * 1000
  const lagMs = Date.parse(p.lastActivity) - Date.parse(p.lastSync)
  // Unparseable timestamps yield NaN, which fails every comparison -- fall
  // back to the raw string ordering the daemon's ISO stamps already satisfy.
  if (Number.isNaN(lagMs)) {
    return p.lastActivity > p.lastSync ? { state: 'behind', lastSyncedAt: p.lastSync } : { state: 'up-to-date' }
  }
  if (lagMs > graceMs) return { state: 'behind', lastSyncedAt: p.lastSync }
  return { state: 'up-to-date' }
}

// ---------------------------------------------------------------------------
// Feed-entry helpers, shared by Project.latestSummary, LiveSession and
// StreamEntry. Mirrors the retired legacy dashboard's pxGlanceFor/pxHasSummary
// exactly: a headline wins, a distilled summary is the fallback.
//
// This is NOT a liveness signal and must not be used as one again. It was, and
// because it never consults a clock, a session that ended without landing a
// summary read as live forever. Worse, the Stop hook re-summarizes a session
// that is still WORKING every few edits (see collapseSessionCheckpoints), so
// having a summary does not even mean the session finished. Liveness is the
// daemon's `live` flag; this answers the narrower "is there a settled summary
// to show" question its callers actually ask.
// ---------------------------------------------------------------------------
export function hasSummary(e: Pick<RawFeedEntry, 'headline' | 'distilled' | 'summary'>): boolean {
  if (e.headline) return true
  return !!(e.distilled && e.summary)
}

// The daemon's own literal placeholder for "a summary landed but no prompt
// was ever captured for this session" (lib/memorydb.js:155, the `ev.kind ===
// 'summary'` branch that mints a bare entry with no preceding 'prompt'
// event). It is stored and pushed like real text -- redaction doesn't touch
// it, the team wire carries it verbatim -- so nothing upstream of this
// module ever strips it. Rendered as-is it reads as a real (if useless)
// captured intent, which is worse than showing nothing.
const NOT_CAPTURED = '(not captured)'

// Absent, whitespace-only, and the "(not captured)" sentinel all normalize
// to the same null -- every caller downstream must treat them identically,
// never render a blank line or the placeholder string for any of them.
function normalizedIntentText(text: string | null): string | null {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed || trimmed === NOT_CAPTURED) return null
  return trimmed
}

// Intent rule: goal first, ask as fallback, null when both are absent, are
// whitespace, or are the daemon's "(not captured)" placeholder -- the UI
// must render nothing, never a placeholder sentence dressed up as content.
export function intentOf(e: Pick<RawFeedEntry, 'goal' | 'ask'>): string | null {
  return normalizedIntentText(e.goal) ?? normalizedIntentText(e.ask)
}

export function outcomeOf(e: Pick<RawFeedEntry, 'headline' | 'summary'>): string {
  return e.headline || e.summary || ''
}

// `session` alone is not unique per entry (a session can carry several
// prompts/entries before it lands a summary), so the id is a composite.
export function streamEntryId(e: Pick<RawFeedEntry, 'session' | 'ts'>): string {
  return `${e.session || 'none'}|${e.ts}`
}

// Normalizes one raw change row: a valid status survives, anything else
// (absent, unknown string) falls back to 'edited' -- the daemon's own
// fallback in lib/changes.js -- and every other field lands as null/false
// rather than undefined.
function mapChange(c: RawFileChange): FileChange {
  const status = c.status === 'new' || c.status === 'deleted' ? c.status : 'edited'
  return {
    file: c.file,
    status,
    add: typeof c.add === 'number' ? c.add : null,
    del: typeof c.del === 'number' ? c.del : null,
    note: c.note || null,
    dep: !!c.dep,
  }
}

export function mapStreamEntry(e: RawFeedEntry): StreamEntry {
  return {
    id: streamEntryId(e),
    author: e.author,
    authorId: e.authorId || '',
    tool: e.source,
    at: e.ts,
    live: !!e.live,
    outcome: outcomeOf(e),
    intent: intentOf(e),
    files: e.files,
    session: e.session,
    summaryFull: e.summaryFull || null,
    decisions: e.decisions || null,
    gotchas: e.gotchas || null,
    changes: Array.isArray(e.changes) ? e.changes.map(mapChange) : [],
  }
}

// The Feed screen's entry: everything mapStreamEntry already carries, plus
// which project it belongs to (server.js's `project` display name and its
// `projectPath`, for the "project name (mono)" column a cross-project
// stream needs and a single-project stream -- StreamEntry -- doesn't.
export function mapFeedEntry(e: RawFeedEntry): FeedEntry {
  return { ...mapStreamEntry(e), project: e.project, projectPath: e.projectPath }
}

// ---------------------------------------------------------------------------
// Checkpoint collapsing: the Stop hook re-summarizes a WORKING session every
// few edits (lib/digest.js re-asks; lib/memorydb.js keeps every checkpoint
// line), so one session can land several rows on a single /api/feed page --
// only the newest reflects where that session actually stands. Left
// uncollapsed, the Feed (and a project's own stream, which renders the same
// entries through the same EntryRow) read as the same long summary repeated
// several times in a row. Grouping keys strictly on session id so two
// DIFFERENT sessions that happen to render byte-identical text never merge
// -- this codebase has a prior bug (groupLiveSessions' author+project key)
// where a non-session-scoped key silently merged unrelated sessions into one
// card, and this collapse must not repeat it. A session-less row (`session:
// null`, the rare bare-plumbing entry) keys off its own entry id instead, so
// it is treated as its own one-off group and never merges with any other
// row, session-less or not.
// ---------------------------------------------------------------------------
function checkpointGroupKey(e: Pick<StreamEntry, 'id' | 'session'>): string {
  return e.session || `entry:${e.id}`
}

// Collapses every entry sharing a session id down to that session's single
// newest row (by `at`); older checkpoints of the same session are dropped,
// never merged or concatenated. Output is re-sorted newest-first by the
// surviving rows' `at` -- callers (Feed, the project stream) then bucket
// that into day groups exactly as they already do.
export function collapseSessionCheckpoints<T extends StreamEntry>(entries: T[]): T[] {
  const newestByKey = new Map<string, T>()
  for (const e of entries) {
    const key = checkpointGroupKey(e)
    const current = newestByKey.get(key)
    if (!current || e.at > current.at) newestByKey.set(key, e)
  }
  return [...newestByKey.values()].sort((a, b) => b.at.localeCompare(a.at))
}

// Builds the /api/feed query string for the Feed screen's filtered, paged
// requests (server.js:1569 -- author/project/source/before/limit are the
// only params it reads). A filter of `null` is omitted entirely rather than
// sent as an empty string, matching how feedPayload treats a missing param
// as "no filter" (server.js:1570's `q()` also collapses '' to null on the
// way in, but the client side owns not sending it in the first place).
export function feedQueryString(filters: FeedFilters, opts: { limit: number; before: string | null }): string {
  const params = new URLSearchParams()
  params.set('limit', String(opts.limit))
  if (filters.author) params.set('author', filters.author)
  if (filters.project) params.set('project', filters.project)
  if (filters.source) params.set('source', filters.source)
  if (opts.before) params.set('before', opts.before)
  return params.toString()
}

// Live sessions are the entries the daemon marked live, deduped to the newest
// entry per session (a session can have several stream entries; only its
// latest reflects whether it is still live). `entries` is assumed
// newest-first, the order /api/feed already returns.
//
// This used to filter on `hasSummary`, which is why Today read "29 live now"
// against a feed of week-old rows: a session that ended without landing a
// summary satisfied "no summary yet" forever. Filtering on the same `live`
// flag the rows render is what makes the count and the dots one set.
export function dedupeLiveSessions(entries: RawFeedEntry[]): RawFeedEntry[] {
  const seen = new Set<string>()
  const out: RawFeedEntry[] = []
  for (const e of entries) {
    if (!e.live) continue
    const key = `${e.projectPath || e.projectId || e.project}::${e.session || e.ts}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

export function mapLiveSession(e: RawFeedEntry): LiveSession {
  return {
    id: e.session || `${e.projectPath || e.project}|${e.ts}`,
    author: e.author,
    authorId: e.authorId || '',
    tool: e.source,
    projectName: e.project,
    startedAt: e.ts,
    intent: intentOf(e),
  }
}

// "One intent per goal, not one per session": a person can have several
// sessions open at once against the same project, and one near-identical
// "Happening now" row per session is noise, not signal -- a goal persists
// across every session doing it. Groups by person + project into one row:
// startedAt is the group's OLDEST session (when the work began), intent is
// the most recent NON-EMPTY intent in the group (even from an older session
// than the newest one), sessionCount is how many are folded in. Every field
// is derived by comparing startedAt directly, never by trusting input order.
export function groupLiveSessions(sessions: LiveSession[]): LiveSessionGroup[] {
  const order: string[] = []
  const byKey = new Map<string, LiveSession[]>()
  for (const s of sessions) {
    const key = `${s.authorId || s.author}::${s.projectName}`
    const bucket = byKey.get(key)
    if (bucket) bucket.push(s)
    else { byKey.set(key, [s]); order.push(key) }
  }
  return order.map(key => {
    const group = byKey.get(key)!
    const oldest = group.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b))
    const newest = group.reduce((a, b) => (a.startedAt >= b.startedAt ? a : b))
    const withIntent = group.filter(s => s.intent)
    const latestIntent = withIntent.length > 0
      ? withIntent.reduce((a, b) => (a.startedAt >= b.startedAt ? a : b)).intent
      : null
    return {
      id: key,
      author: newest.author,
      authorId: newest.authorId,
      tool: newest.tool,
      projectName: newest.projectName,
      startedAt: oldest.startedAt,
      sessionCount: group.length,
      intent: latestIntent,
    }
  })
}

// ---------------------------------------------------------------------------
// Projects: /api/projects carries the lifetime/week/day counters directly
// (Step 1b). latestSummary and memberIds are not on that payload at all --
// they are derived from the SAME /api/feed page getProjects() already fetches
// for the Today screen, never a second per-project request.
// ---------------------------------------------------------------------------
function entriesForProject(row: RawProjectRow, entries: RawFeedEntry[]): RawFeedEntry[] {
  const teamProjectId = row.team && row.team.projectId ? row.team.projectId : null
  return entries.filter(e =>
    (e.projectPath && e.projectPath === row.path) || (!!teamProjectId && e.projectId === teamProjectId));
}

// Newest-first entries in, so the first one carrying a headline or summary is
// the latest. Literal `headline || summary` per the resolved field source --
// no distilled gate here (that gate is what decides `live`, not this text).
export function latestSummaryFor(entries: RawFeedEntry[]): Project['latestSummary'] {
  for (const e of entries) {
    const text = e.headline || e.summary
    if (text) return { text, author: e.author, at: e.ts }
  }
  return null
}

// Distinct authors seen on this project's feed entries -- the closest thing
// to "who has access" the daemon exposes today without a dedicated access
// endpoint (that's Task 10's getAccessMatrix).
export function memberIdsFor(entries: RawFeedEntry[]): string[] {
  const ids = new Set<string>()
  for (const e of entries) if (e.authorId) ids.add(e.authorId)
  return [...ids]
}

export function mapProjectRow(row: RawProjectRow, feedEntries: RawFeedEntry[], intervalSec?: number): Project {
  const entries = entriesForProject(row, feedEntries)
  return {
    path: row.path,
    name: row.name,
    exists: row.exists,
    paused: row.paused,
    lastSync: row.lastSync,
    lastActivity: row.lastActivity,
    sessionsTotal: row.sessionsTotal,
    tools: row.tools,
    shared: !!row.team,
    memberIds: memberIdsFor(entries),
    sessionsThisWeek: row.sessionsThisWeek,
    dailyCounts: row.dailyCounts,
    latestSummary: latestSummaryFor(entries),
    sync: syncStateOf(row, intervalSec),
  }
}

// ---------------------------------------------------------------------------
// Members: team_members_list (002_team_v2.sql:267) returns only {user_id,
// display_name, role, joined_at} -- a teammate's daemon/token state lives on
// THEIR machine, unseen here. Member models only what this install can
// observe: lastSharedAt (newest /api/team/feed row by them), projectCount
// (distinct projects they've POSTED into -- see the Member.projectCount doc
// in types.ts, which this derivation must keep agreeing with), and keyAlert.
//
// THIRD TIME THIS EXACT PAGING ASSUMPTION HAS FAILED: a member's facts used
// to be read off ONE shared, newest-first, capped page (either /api/feed's
// merged local+team page, or a bare /api/team/feed?limit=200 page) and
// bucketed by author. Whichever author is most active fills that page
// entirely, so every quieter teammate's own rows never appear in it at all
// -- they read as "0 projects, nothing shared yet" while their real rows sit
// just past the cutoff. This is the identical shape of bug lib/api-insights.js
// already found and fixed once (a capped page for "last arrived" disagreeing
// with a full-window count of "how much they shared" in the SAME response --
// search that file for "97 shared entries"), and it re-appeared here as the
// reason a "this is their last project" warning couldn't be built on top of
// Member.projectCount at all: the number was never trustworthy.
//
// Fix: memberActivity below takes ONE member's own /api/team/feed rows only
// (LocalDaemonClient.getMembers() issues one author-scoped request per
// member, run in parallel, instead of scanning a page shared by everyone).
// A noisy teammate's volume can no longer crowd a quiet one out, because
// their rows are never in the same array to begin with -- there is no shared
// cap left for that to happen to. The trade-off this keeps: each member's
// OWN request is still capped (TEAM_FEED_LIMIT, LocalDaemonClient.ts) at
// their 200 most recent rows, so an extremely prolific single member's
// oldest projects could still be missed -- but that bound is a function of
// their own volume alone, never a teammate's.
// ---------------------------------------------------------------------------
export interface MemberActivity {
  projectCount: number
  lastSharedAt: string | null
}

// Distinct project_id count + newest ts, computed from a single author's own
// team-feed rows. Deliberately takes no author_id/bucketing step -- unlike
// the two functions this replaced, there is nothing to bucket: every entry
// passed in already belongs to the one member this result is for.
export function memberActivity(entries: RawTeamFeedEntry[]): MemberActivity {
  const projects = new Set<string>()
  let lastSharedAt: string | null = null
  for (const e of entries) {
    if (e.project_id) projects.add(e.project_id)
    if (!lastSharedAt || e.ts > lastSharedAt) lastSharedAt = e.ts
  }
  return { projectCount: projects.size, lastSharedAt }
}

export function mapMember(row: RawMemberRow, activity: MemberActivity): Member {
  return {
    id: row.user_id,
    name: row.display_name,
    email: '',
    role: row.role,
    // schema.sql has joined_at NOT NULL, but the RPC's return type is
    // nullable -- fall back rather than assert a value we don't have.
    joinedAt: row.joined_at || '',
    projectCount: activity.projectCount,
    lastSharedAt: activity.lastSharedAt,
    // Known gap: statusPayload (server.js:197) exposes only a COUNT of state.keyAlerts; no per-member endpoint exists.
    keyAlert: false,
  }
}

