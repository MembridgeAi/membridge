// Pure functions that turn the daemon's real JSON payloads (lib/server.js)
// into the UI's domain types (./types.ts) -- kept separate from
// LocalDaemonClient.ts so every mapping decision is unit-testable without a live daemon.
import type { LiveSession, Member, Project, Role, Settings, Status, StreamEntry, SyncState } from './types'

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

export interface RawTeamRow {
  team_id: string
  team_name: string
  role: Role
  memberCount: number | null
}

export interface RawSettingsPayload {
  intervalSec: number
  hookInstalled: boolean
  distill: { enabled: boolean }
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

// Intent rule: goal first, ask as fallback, null when both are absent -- the
// UI must render nothing, never a placeholder sentence.
export function intentOf(e: Pick<RawFeedEntry, 'goal' | 'ask'>): string | null {
  return e.goal || e.ask || null
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
  }
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

// ---------------------------------------------------------------------------
// Settings: /api/settings predates this screen's redesigned shape (delivery
// channels, privacy counters, daemon control) -- it was built for the old
// dashboard's API-key/advisor form. Fields with a real source are mapped;
// fields with none are zeroed/nulled rather than invented (see Task 4 report
// for the full list and why each one is unavailable today).
// ---------------------------------------------------------------------------
export function mapSettings(raw: RawSettingsPayload, status: Status, team: RawTeamRow | null): Settings {
  return {
    delivery: [
      {
        id: 'context-block', label: 'Context block',
        description: 'A small skeleton written into CLAUDE.md, AGENTS.md and other context files your AI tools read at startup.',
        installed: true, enabled: null,
      },
      {
        id: 'summaries', label: 'Session summaries',
        description: 'A Claude Code Stop-hook that distills each session into a summary as it ends.',
        installed: raw.hookInstalled, enabled: raw.distill.enabled,
      },
      {
        id: 'recall', label: 'Recall',
        description: 'Surfaces a relevant past note the moment a matching file is opened.',
        installed: false, enabled: null,
      },
      {
        id: 'mcp', label: 'MCP server',
        description: 'Lets any MCP-capable tool query team memory directly.',
        installed: false, enabled: null,
      },
    ],
    privacy: {
      endToEnd: status.encryption.enabled,
      plaintextShared: !status.encryption.plaintextOff,
      redactionBuiltIn: 0,
      redactionCustom: 0,
      excludedPaths: 0,
    },
    daemon: {
      running: status.running,
      port: null,
      version: status.version,
      startAtLogin: false,
      intervalSec: raw.intervalSec,
      updateAvailable: null,
    },
    team: status.solo || !team ? null : { name: team.team_name, role: team.role, memberCount: team.memberCount ?? 0 },
  }
}
