// Pure functions that turn the daemon's real JSON payloads (lib/server.js)
// into the UI's domain types (./types.ts) -- kept separate from
// LocalDaemonClient.ts so every mapping decision is unit-testable without a
// live daemon. Settings' own mapping lives in ./settingsMapper.ts, split out
// to keep this file focused on feed/project/member mapping.
import type { FeedEntry, FeedFilters, LiveSession, LiveSessionGroup, Member, Project, Role, StreamEntry, SyncState } from './types'

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
}

// feedPayload's response shape (server.js:539 feedPayload -> lib/feed.js
// buildFeed): only the two fields the Feed screen actually reads -- the
// entry page and the pagination cursor. The payload carries more (teamStatus
// flags, suggestions, etc.) that no UI consumer needs yet.
export interface RawFeedPayload {
  entries: RawFeedEntry[]
  nextBefore: string | null
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
  ts: string
}

// ---------------------------------------------------------------------------
// Sync state (spec rule, verbatim): paused wins outright; otherwise activity
// after the last sync is "behind"; anything else is up to date.
// ---------------------------------------------------------------------------
export function syncStateOf(p: { paused: boolean; lastSync: string | null; lastActivity: string | null }): SyncState {
  if (p.paused) return { state: 'paused' }
  if (p.lastActivity && (!p.lastSync || p.lastActivity > p.lastSync)) {
    return { state: 'behind', lastSyncedAt: p.lastSync }
  }
  return { state: 'up-to-date' }
}

// ---------------------------------------------------------------------------
// Feed-entry helpers, shared by Project.latestSummary, LiveSession and
// StreamEntry. Mirrors lib/dashboard/client.js's pxGlanceFor/pxHasSummary
// exactly: a headline wins, a distilled summary is the fallback, and absence
// of both means "no summary yet" -- the WIP/live signal, not a time window.
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

export function mapStreamEntry(e: RawFeedEntry): StreamEntry {
  return {
    id: streamEntryId(e),
    author: e.author,
    authorId: e.authorId || '',
    tool: e.source,
    at: e.ts,
    live: !hasSummary(e),
    outcome: outcomeOf(e),
    intent: intentOf(e),
    files: e.files,
    session: e.session,
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

// Live sessions are entries with no summary yet, deduped to the newest entry
// per session (a session can have several stream entries; only its latest
// reflects whether it is still live). `entries` is assumed newest-first, the
// order /api/feed already returns.
export function dedupeLiveSessions(entries: RawFeedEntry[]): RawFeedEntry[] {
  const seen = new Set<string>()
  const out: RawFeedEntry[] = []
  for (const e of entries) {
    if (hasSummary(e)) continue
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

export function mapProjectRow(row: RawProjectRow, feedEntries: RawFeedEntry[]): Project {
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
    sync: syncStateOf(row),
  }
}

// ---------------------------------------------------------------------------
// Members: team_members_list (002_team_v2.sql:267) returns only {user_id,
// display_name, role, joined_at} -- a teammate's daemon/token state lives on
// THEIR machine, unseen here. Member models only what this install can
// observe: lastSharedAt (newest /api/team/feed row by them) and keyAlert
// (see mapMember). projectCount is capped to whatever /api/feed page is in hand.
// ---------------------------------------------------------------------------
export function projectCountsByAuthor(entries: RawFeedEntry[]): Record<string, number> {
  const byAuthor = new Map<string, Set<string>>()
  for (const e of entries) {
    if (!e.authorId) continue
    const projectKey = e.projectPath || e.projectId || e.project
    if (!projectKey) continue
    if (!byAuthor.has(e.authorId)) byAuthor.set(e.authorId, new Set())
    byAuthor.get(e.authorId)!.add(projectKey)
  }
  const out: Record<string, number> = {}
  for (const [id, keys] of byAuthor) out[id] = keys.size
  return out
}

// Newest ts per author_id across a page of /api/team/feed (capped at 200 rows,
// 002_team_v2.sql:320) -- "the newest we can see", never a fabricated "never".
export function lastSharedAtByAuthor(entries: RawTeamFeedEntry[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of entries) {
    if (!e.author_id) continue
    const seen = out[e.author_id]
    if (!seen || e.ts > seen) out[e.author_id] = e.ts
  }
  return out
}

export function mapMember(row: RawMemberRow, projectCounts: Record<string, number>, lastSharedAt: Record<string, string>): Member {
  return {
    id: row.user_id,
    name: row.display_name,
    email: '',
    role: row.role,
    // schema.sql has joined_at NOT NULL, but the RPC's return type is
    // nullable -- fall back rather than assert a value we don't have.
    joinedAt: row.joined_at || '',
    projectCount: projectCounts[row.user_id] || 0,
    lastSharedAt: lastSharedAt[row.user_id] || null,
    // Known gap: statusPayload (server.js:197) exposes only a COUNT of state.keyAlerts; no per-member endpoint exists.
    keyAlert: false,
  }
}

