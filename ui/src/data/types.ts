export type Role = 'owner' | 'admin' | 'member'
export type SyncState = { state: 'up-to-date' } | { state: 'behind'; lastSyncedAt: string | null } | { state: 'paused' }

export interface Status {
  running: boolean
  version: string
  solo: boolean
  setupDone: boolean
  projectCount: number
  lastSync: string | null
  teamLastSync: string | null
  tools: string[]
  encryption: { enabled: boolean; plaintextOff: boolean; paused: string | null; keyAlerts: number }
  auth: { paused: string | null; detail: string | null; since: string | null }
}

export interface Project {
  path: string
  name: string
  exists: boolean
  paused: boolean
  lastSync: string | null
  lastActivity: string | null
  sessionsTotal: number
  tools: string[]
  shared: boolean
  memberIds: string[]
  sessionsThisWeek: number
  dailyCounts: number[]     // exactly 7 entries, oldest first
  latestSummary: { text: string; author: string; at: string } | null
  sync: SyncState
}

export interface LiveSession {
  id: string
  author: string
  authorId: string
  tool: string
  projectName: string
  startedAt: string
  intent: string | null      // the captured opening ask, verbatim; never inferred
}

// "Happening now" row shape: one entry per person+project GOAL, not per
// session (mappers.ts groupLiveSessions) -- a goal persists across however
// many concurrent sessions are working on it. startedAt is the oldest
// session's start (when the work began); intent is the most recent
// non-empty intent seen across the group; sessionCount is how many live
// sessions are folded into this row (the UI shows it only when > 1).
export interface LiveSessionGroup {
  id: string
  author: string
  authorId: string
  tool: string
  projectName: string
  startedAt: string
  sessionCount: number
  intent: string | null
}

export interface StreamEntry {
  id: string
  author: string
  authorId: string
  tool: string
  at: string
  live: boolean
  outcome: string
  intent: string | null
  files: string[]
}

// The Feed screen's entries are the same StreamEntry shape plus the project
// they belong to -- ProjectPage doesn't need this (the project is already
// the page you're on), which is why it isn't on StreamEntry itself.
export interface FeedEntry extends StreamEntry {
  project: string
  projectPath: string | null
}

// `/api/feed` query params (server.js: author/project/source/before/limit).
// null means "no filter" -- never an empty string, so a filter's absence and
// a filter matching nothing can't be confused.
export interface FeedFilters {
  author: string | null
  project: string | null
  source: string | null
}

// feedPayload's own pagination cursor (lib/feed.js buildFeed): the ts of the
// last entry on this page, to pass back as `before` for the next one, or
// null when there is nothing older left.
export interface FeedPage {
  entries: FeedEntry[]
  nextBefore: string | null
}

/** Only what one machine can actually observe about a teammate.
 *  `team_members_list` (supabase/migrations/002_team_v2.sql:267) returns just
 *  user_id, display_name, role, joined_at. A teammate's paused daemon or expired
 *  token lives on THEIR machine and is not knowable here — so this models
 *  "when did anything of theirs last arrive", never a diagnosis. */
export interface Member {
  id: string
  name: string
  email: string
  role: Role
  joinedAt: string
  projectCount: number
  lastSharedAt: string | null   // newest team-feed entry authored by them; null = nothing ever
  keyAlert: boolean             // their encryption key changed since we pinned it (state.keyAlerts)
}

export interface Invite {
  id: string
  email: string
  expiresAt: string
  role: Role
}

export interface AuditEvent {
  id: string
  at: string
  actorName: string
  action: string
  objectType: 'project' | 'member' | 'invite' | 'team' | 'setting'
  objectLabel: string
  detail: string | null
}

// The "how well the skeleton is working" figures (spec §3.5), and Today's
// solo effectiveness stat (Task 7 Finding 3) -- the SAME union in both
// places, because both read the identical /api/savings ledger. `available:
// false` is a real state (the ledger has nothing yet), never collapsed into
// a zero.
export type SkeletonStats = { available: false } | { available: true; repeatOpens: number; answeredFirst: number }

export type Severity = 'broken' | 'minor'

export interface Problem {
  id: string
  severity: Severity
  headline: string
  scale: string                 // e.g. "47 of 47 sessions · hook not installed"
  action: { label: string; kind: string } | null
}

export interface Insights {
  window: 7 | 30 | 90
  sessions: { count: number; deltaPct: number | null }
  membersSyncing: { ok: number; total: number }
  entriesShared: { count: number; delta: number | null }
  skeleton: SkeletonStats
  perPerson: { id: string; name: string; sessions: number; shared: number }[]
  topProjects: { name: string; sessions: number; people: number }[]
  problems: Problem[]
  concentration: { projectName: string; onlyPerson: string; detail: string }[]
  byTool: { tool: string; sessions: number }[]
}

export interface DeliveryChannel {
  id: 'context-block' | 'recall' | 'summaries' | 'mcp'
  label: string
  description: string
  // null = unknown -- the daemon has not reported a real check for this
  // channel yet (e.g. an older daemon whose /api/settings predates this
  // field). Must never collapse to false: false reads as "broken", and an
  // unchecked channel is not known to be broken.
  installed: boolean | null
  enabled: boolean | null
  // Dynamic specifics beyond the static `description` -- which tools, when
  // last checked (e.g. "registered with Claude Code, Codex · checked 2h
  // ago"). '' when there is nothing dynamic to add yet.
  detail: string
}

export interface Settings {
  delivery: DeliveryChannel[]
  // redactionBuiltIn is null, never 0, when the daemon payload carries no
  // built-in-pattern count at all -- lib/redact.js has ~20 active patterns,
  // but nothing in /api/settings reports a count yet (see mapSettings). 0
  // would claim "no protection"; null renders as "unknown" in words instead.
  privacy: {
    endToEnd: boolean; plaintextShared: boolean; redactionBuiltIn: number | null; redactionCustom: number
    excludedPaths: number; redactExtra: string[]; exclude: string[]
  }
  daemon: { running: boolean; port: number | null; version: string; startAtLogin: boolean; intervalSec: number; updateAvailable: string | null }
  team: { id: string; name: string; role: Role; memberCount: number; inviteCode: string | null } | null
  // creds.userId -- the same identity /api/feed already tags entries with as
  // `self`. Null when signed out/solo. This is the ONLY honest source for
  // "which row is me"; a literal 'me' string is never a real user id.
  viewerId: string | null
  contextFiles: { targets: string[]; extraTargets: Record<string, boolean>; extraTargetFiles: Record<string, string> }
}

export interface AccessMatrix {
  members: { id: string; name: string }[]
  rows: { projectPath: string; projectName: string; shared: boolean; access: Record<string, boolean> }[]
}
