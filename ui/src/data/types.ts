export type Role = 'owner' | 'admin' | 'member'
export type SyncState = { state: 'up-to-date' } | { state: 'behind'; lastSyncedAt: string | null } | { state: 'paused' }

export interface Status {
  running: boolean
  version: string
  solo: boolean
  setupDone: boolean
  projectCount: number
  /** Daemon sync period (/api/status, server.js:303). Drives the grace period
   *  in syncStateOf -- a project is only "behind" once a tick has been missed. */
  intervalSec: number
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
  // The raw session id this checkpoint belongs to (RawFeedEntry.session,
  // untouched) -- carried through so a feed/stream can collapse several
  // checkpoint summaries of the SAME session (mappers.ts
  // collapseSessionCheckpoints) without ever merging entries from two
  // DIFFERENT sessions that happen to render identical text. null for the
  // rare session-less row (bare plumbing); such a row is never merged with
  // anything, including another session-less row.
  session: string | null
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
  // Distinct projects this member has POSTED team-feed entries into -- NOT
  // "projects they have access to" (that's a different, already-modeled
  // concept: AccessMatrix / getProjectAccess). Computed from that member's
  // own team-feed rows only, never a shared page other members' rows also
  // sit in -- see mappers.ts's memberActivity for why that distinction is
  // load-bearing.
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

// Every discrete instance where memory actually helped -- recall serving a
// file, a teammate note landing in a session, an MCP memory query -- broader
// than SkeletonStats above, which only ever covered the first channel.
// Counting an instance is not a token-avoidance claim (spec §9 stays intact:
// see lib/server.js above savingsPayload), so `total` is a plain count, never
// tokens and never a dollar figure. `byKind` is what makes the headline
// auditable rather than a magic number. `available: false` on a daemon whose
// /api/savings predates the notes-injection COUNT field.
export type AssistsStats =
  | { available: false }
  | { available: true; total: number; byKind: { recallServed: number; teammateNotes: number; mcpQueries: number } }

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
  assists: AssistsStats
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
  // redactionBuiltIn is null only when the daemon payload predates the field
  // entirely (an older daemon's /api/settings carries no redactionBuiltIn at
  // all -- see mapSettings). A present daemon always reports the real
  // lib/redact.js DEFAULT_PATTERNS.length, derived server-side so it cannot
  // drift; 0 would claim "no protection", so null renders as "unknown" in
  // words instead of ever being confused with a real zero.
  privacy: {
    endToEnd: boolean; plaintextShared: boolean; redactionBuiltIn: number | null; redactionCustom: number
    excludedPaths: number; redactExtra: string[]; exclude: string[]
    // The subset of `exclude` whose path no longer exists on disk (Task 4a).
    // Surfaced, never auto-removed -- the owner decides whether a stale
    // entry (e.g. a leaked test fixture path) gets deleted.
    excludeStale: string[]
  }
  daemon: { running: boolean; port: number | null; version: string; startAtLogin: boolean; intervalSec: number; updateAvailable: string | null }
  team: { id: string; name: string; role: Role; memberCount: number; inviteCode: string | null } | null
  // creds.userId -- the same identity /api/feed already tags entries with as
  // `self`. Null when signed out/solo. This is the ONLY honest source for
  // "which row is me"; a literal 'me' string is never a real user id.
  viewerId: string | null
  // Base URL of the hosted onboarding-invite landing page (teamsync.webUrl,
  // GET /api/team's plain webUrl field -- lib/backend.json's baked default is
  // https://join.membridge.me). Null on a build with no hosted join page
  // configured (a self-hosted install shipping an empty lib/backend.json), in
  // which case the Members page falls back to sharing the standing invite
  // code instead of minting a link nothing can redeem.
  webUrl: string | null
  contextFiles: { targets: string[]; extraTargets: Record<string, boolean>; extraTargetFiles: Record<string, string> }
}

export interface AccessMatrix {
  members: { id: string; name: string }[]
  rows: { projectPath: string; projectName: string; shared: boolean; access: Record<string, boolean> }[]
}

// POST /api/mcp/register's response (DataClient.registerMcp) -- one row per
// AI tool lib/mcp-register.js's registerNow() attempted, mirroring
// settingsMapper.ts's RawMcpRow (kept as its own type rather than imported
// from there, to avoid a circular import back into this file). Only the
// fields Settings' Re-register result actually renders are declared here.
export type McpRowStatus = 'registered' | 'removed' | 'unchanged' | 'skipped' | 'failed'
export interface McpRegisterRow {
  agent: string
  status: McpRowStatus
  detail: string | null
}
export interface McpRegisterResult {
  rows: McpRegisterRow[]
}
