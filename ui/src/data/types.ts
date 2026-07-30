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
  installed: boolean
  enabled: boolean | null
}

export interface Settings {
  delivery: DeliveryChannel[]
  privacy: { endToEnd: boolean; plaintextShared: boolean; redactionBuiltIn: number; redactionCustom: number; excludedPaths: number }
  daemon: { running: boolean; port: number | null; version: string; startAtLogin: boolean; intervalSec: number; updateAvailable: string | null }
  team: { name: string; role: Role; memberCount: number } | null
}

export interface AccessMatrix {
  members: { id: string; name: string }[]
  rows: { projectPath: string; projectName: string; shared: boolean; access: Record<string, boolean> }[]
}
