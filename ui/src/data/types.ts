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
  // Archived is a flag on the one projects list (the UI sections on it, it
  // never re-fetches a second list). `missing` marks an archived row whose
  // folder no longer exists on disk: rendered with a muted note, and its
  // Unarchive still works. Both normalize to false on rows from an older
  // daemon that predates the fields.
  archived: boolean
  missing: boolean
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
  // What the session has landed so far (headline, else the summary's first
  // sentence). The row's fallback when no intent was captured: a teammate who
  // does not share prompts otherwise renders as a bare name and a clock.
  outcome: string | null
}

// "Happening now" row shape: one entry per person+project GOAL, not per
// session (mappers.ts groupLiveSessions) -- a goal persists across however
// many concurrent sessions are working on it. startedAt is the oldest
// session's start (when the work began); intent is the most recent
// non-empty intent seen across the group; sessionCount is how many live
// sessions are folded into this row (the UI shows it only when > 1).
export interface LiveSessionGroup {
  id: string
  // The NEWEST session in the group, so the card can link at it. The row
  // already describes that session (author, tool, project all come from it),
  // so anything else would send you somewhere the card is not about.
  sessionId: string
  author: string
  authorId: string
  tool: string
  projectName: string
  startedAt: string
  sessionCount: number
  intent: string | null
  outcome: string | null
}

// One file's change model (lib/changes.js deriveChanges: status + line counts
// + the agent's highlight note). add/del are null when git could not count
// (binary, rename, no repo); dep marks lockfile/vendor noise the UI de-emphasizes.
export interface FileChange {
  file: string
  status: 'new' | 'edited' | 'deleted'
  add: number | null
  del: number | null
  note: string | null
  dep: boolean
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
  // The brief fields the daemon already ships on every /api/feed entry
  // (lib/feed.js normalizeLocal/normalizeTeam) -- carried, not derived.
  // Absent fields normalize to null / [], never undefined.
  summaryFull: string | null
  decisions: string | null
  gotchas: string | null
  changes: FileChange[]
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

// ---------------------------------------------------------------------------
// Search (GET /api/search, lib/activity.js searchMemory): the SAME ranked
// corpus the MCP tools answer from, so a person and their agent searching one
// machine can never be told different things. Reaches further back than the
// feed does -- the feed pages a working cache, search also reads the durable
// per-project team archive.
// ---------------------------------------------------------------------------
export interface SearchResult extends FeedEntry {
  /** lib/search.js's weighted score. Ordering only -- never rendered as a
   *  number, which would imply a precision this does not have. */
  score: number
  /** Which fields the query actually hit ('decisions', 'files', ...). This is
   *  the "why is this row here" answer for a result whose visible outcome
   *  line does not contain the query at all. */
  matched: string[]
}

export interface SearchPage {
  query: string
  /** Matches before the page limit -- the count the UI reports. */
  total: number
  results: SearchResult[]
}

// ---------------------------------------------------------------------------
// The session detail page's payload (GET /api/session?id=, lib/server.js
// sessionPayload): one session, unsliced and uncollapsed. Everything here is
// redacted by the daemon with the same closure /api/feed uses.
// ---------------------------------------------------------------------------

// One prompt of the session's chain, newest-first in Session.prompts. `ask`
// is null for a team-origin prompt the author did not share -- the daemon
// never fabricates prompt text, so "(prompt not shared)" is a render concern.
// `undecryptable` marks the OTHER null-ask state (fail-closed E2E: this
// client could not decrypt the row) -- rendered as an encrypted state, never
// as an author's sharing choice.
export interface SessionPrompt {
  ts: string
  ask: string | null
  files: string[]
  undecryptable?: boolean
}

// One distilled checkpoint of the session's trail, oldest-first in
// Session.checkpoints.
export interface SessionCheckpoint {
  ts: string
  text: string
}

export interface Session {
  session: string
  project: string
  projectPath: string | null
  author: string
  authorId: string | null
  source: string
  // The session's extreme event timestamps. Either can be null/unparseable on
  // damaged history -- renderers omit the duration line rather than show NaN.
  startedAt: string | null
  endedAt: string | null
  // Daemon-stamped (util.isLive over the session's newest event), same as the
  // feed's flag. The UI never recomputes liveness.
  live: boolean
  summary: string | null
  summaryFull: string | null
  goal: string | null
  headline: string | null
  decisions: string | null
  gotchas: string | null
  files: string[]
  changes: FileChange[]
  checkpoints: SessionCheckpoint[]
  prompts: SessionPrompt[]
  // How many commits this session produced. NOT SERVED YET: lib/server.js's
  // sessionPayload does not carry it, so on a real daemon this is always
  // undefined and the analytics header's Commits tile degrades to a muted
  // dash. Optional rather than `number | null` precisely so the absence is a
  // shape difference the compiler keeps honest.
  //
  // The attribution already exists server-side (lib/commits.js attributes a
  // commit's changed files to the session that last edited them, and
  // .membridge/commits.jsonl is the durable map) -- it needs plumbing onto the
  // payload, not new invention. See the note in SessionAnalytics.tsx.
  commits?: number
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
// file, a teammate note landing in a session -- broader than SkeletonStats
// above, which only ever covered the first channel. Counting an instance is
// not a token-avoidance claim (spec §9 stays intact: see lib/server.js above
// savingsPayload), so `total` is a plain count, never tokens and never a
// dollar figure. `byKind` is what makes the headline auditable rather than a
// magic number.
//
// `mcpTools` is deliberately NOT part of `total` and not a channel of
// `byKind`. The daemon's tally records which memory MCP tools have seen use,
// never how often (lib/mcp-usage.js, a privacy stance), so `inUse` is capped
// by `total` -- the size of the tool allowlist -- however many calls happen.
// It is a coverage fraction, and summing it into a per-instance total made
// that total meaningless.
//
// `available: false` on a daemon whose /api/savings predates the
// notes-injection COUNT field.
export type AssistsStats =
  | { available: false }
  | {
      available: true
      total: number
      byKind: { recallServed: number; teammateNotes: number }
      mcpTools: { inUse: number; total: number }
    }

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
  // The team feed fetch hit its page cap (lib/api-insights.js MAX_PAGES *
  // TEAM_FEED_PAGE). Paging runs newest-first, so the cap drops the OLDEST
  // rows: every count below becomes a FLOOR rather than a total, and the
  // deltas are nulled server-side because their baseline window is the part
  // that went missing. Render counts as "at least", never as totals.
  truncated: boolean
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

// Force-update hooks (lib/hooks.js's hooksVersionStatus/forceUpdateHooks):
// 'current' -- the registered hook is stamped with today's build.
// 'outdated' -- registered, but stamped with an older build (or never
//   stamped at all, i.e. it predates this feature) -- an update is real.
// 'unknown' -- nothing owned is registered to compare, or settings.json
//   could not be read. Never guessed as either of the other two.
export type HookVintage = 'current' | 'outdated' | 'unknown'
export interface HooksVersionStatus {
  stop: HookVintage
  recall: HookVintage
}
// POST /api/hooks/update's response (DataClient.updateHooks) -- one outcome
// per hook, so a Stop-hook failure can never hide behind a successful recall
// result. `detail` is always a human-readable sentence, on success and on
// failure alike (never a bare boolean with nothing to say why).
export interface HookUpdateOutcome {
  ok: boolean
  detail: string
}
export interface HookUpdateResult {
  stop: HookUpdateOutcome
  recall: HookUpdateOutcome
  // The PreToolUse Grep/Glob search hook (lib/hooks-search.js). Reported
  // separately for the same reason recall is: "Update hooks" reconciles it
  // too, so a failure there must be visible rather than hiding behind two
  // green chips.
  search: HookUpdateOutcome
}

// GET /api/team, read as the ACCOUNT state rather than the settings state.
// Settings.team only ever answers "which team is this machine on", which a
// signed-out machine and a signed-in machine with no team answer identically
// (null) -- the exact ambiguity that let a silent sign-out look like nothing
// was wrong. `authenticated` is the field that separates them, so the Team
// page reads this payload instead.
export interface TeamAccount {
  // Does this BUILD have a backend baked in at all (teamsync.isConfigured)?
  // False on a self-hosted build with an empty lib/backend.json, where no
  // sign-in could succeed however correct the credentials are.
  configured: boolean
  // Are there credentials on this machine right now (teamsync.loadCredentials)?
  authenticated: boolean
  user: { userId: string; email: string; displayName: string } | null
  // One team per user in the product today (see lib/api-access.js's identical
  // teams[0] simplification), but carried as the list the daemon actually
  // sends rather than pre-collapsed here.
  teams: TeamSummary[]
  // teams[0]'s standing invite code, never rotated by reading it. Null when
  // signed out or between teams.
  inviteCode: string | null
  // Base URL of the hosted join page (teamsync.webUrl). Null on a build with
  // none configured -- the invite control degrades to the standing code.
  webUrl: string | null
  // GET /api/team answers 200 with this set when it is signed in but could
  // not LIST the teams (teamPayload catches listTeams' failure). Carried
  // rather than dropped: without it, a failed listing is indistinguishable
  // from genuinely having no team, and the page would invite the user to
  // create a second one.
  error: string | null
}

export interface TeamSummary {
  id: string
  name: string
  role: Role
  // Null when the daemon's row carries no member_count (an older backend),
  // never a fabricated 0 -- "unknown" and "empty" are different facts.
  memberCount: number | null
}

export interface Settings {
  delivery: DeliveryChannel[]
  // Independent of delivery[].installed above (which only answers "is it
  // there at all") -- this answers "is what's there the current build".
  // Only meaningful once a hook is actually installed; see HookVintage.
  hooksVersion: HooksVersionStatus
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

// POST /api/team/archive-project's body (lib/server.js archiveSharedProject).
// This endpoint answers 200 even when it REFUSED to delete: a plain member
// deleting a shared project gets { archived: false, unlinked, message } after
// their local team link and durable teammate archive were already pruned, and
// the project itself still exists. Callers must read this body -- treating the
// 200 as success tells the user a destruction they typed a name to confirm
// happened when it did not.
//   scope 'team'  -> archived for the whole team (owner/manager path)
//   scope 'local' -> local-only outcome: `deleted` true is a real delete of an
//                    unlinked project; `archived: false` with a `message` is a
//                    refusal.
export interface DeleteProjectResult {
  path?: string
  scope?: 'team' | 'local'
  archived?: boolean
  deleted?: boolean
  unlinked?: boolean
  message?: string
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
