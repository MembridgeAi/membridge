export type Role = 'owner' | 'admin' | 'member'
export type SyncState = { state: 'up-to-date' } | { state: 'behind'; lastSyncedAt: string | null } | { state: 'paused' }

/**
 * The sync loop's own health, as the daemon reports it (lib/server.js's
 * tickHealth). Four reachable states, and the distinction between the last two
 * is the point: a WEDGED loop is not a dead process, and telling someone their
 * daemon is not running when it is sends them to start something already
 * started.
 *
 * 'ok'       — a pass completed inside the freshness window.
 * 'erroring' — the newest pass threw, but the loop is alive and rescheduling.
 *              Neither healthy nor dead; `lastTickError` says what failed.
 * 'stalled'  — nothing completed inside the window. The loop is wedged.
 * 'unknown'  — no pass has ever been observed in this process. Not a verdict:
 *              nobody has checked yet.
 */
export type DaemonHealthState = 'ok' | 'erroring' | 'stalled' | 'unknown'

export interface DaemonHealth {
  state: DaemonHealthState
  /** When the newest pass was observed. Null in 'unknown'. */
  lastTickAt: string | null
  /** The newest pass's failure, present in 'erroring'. Null otherwise. */
  lastTickError: string | null
  /** How stale the newest pass is. Null in 'unknown'. */
  staleForSec: number | null
}

export interface Status {
  // Still a required boolean, still sent by every daemon: `health` below is
  // ADDITIVE and this stays the field a client can always rely on. The daemon
  // derives it as `health.state === 'ok' || health.state === 'erroring'` -- an
  // erroring loop is a running one -- so it can never disagree with `health`.
  running: boolean
  // OPTIONAL on purpose, and the absence is a real shape to defend against, not
  // a hypothetical: a daemon older than this field sends `running` alone, and
  // rendering "not checked yet" at that user would be reporting our own ignorance
  // as theirs. Every consumer must fall back to `running` when this is missing.
  health?: DaemonHealth
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
  /** Authors seen on this project's slice of the ONE capped feed page
   *  getProjects() fetches. Named for what it is after it spent a release
   *  called `memberIds`, which invited every reader to treat it as a roster:
   *  it answers "who has shown up here lately", and it is NOT who can see the
   *  project and NOT a count of people.
   *
   *  Two independent reasons it cannot carry either of those meanings: the page
   *  is shared across every project, so a busy project fills it and a quiet
   *  shared project's set comes back EMPTY while the whole team has access; and
   *  it has no time window at all, so it cannot be paired with a windowed
   *  figure like sessionsThisWeek. Faces are a fair rendering. A number is not.
   *  For access use getAccessMatrix() or getProjectAccess(path); see
   *  mappers.ts recentAuthorIdsFor. */
  recentAuthorIds: string[]
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
  // The session's GOAL, verbatim: "the why behind the session in your own
  // words ... never a restated prompt" (lib/digest.js's own instruction to the
  // agent that writes it). Carried SEPARATELY from `intent`, which is already
  // goal-or-ask (mappers.intentOf), because the two are not interchangeable
  // copy: a goal is a written statement of purpose, an ask is whatever the
  // person typed, and on real data that is routinely "continue", "yes" or
  // "fill it in". A surface that wants purpose has to tell them apart.
  // Optional, so every hand-built fixture keeps compiling.
  goal?: string | null
  // The daemon's own two markers about WHY this row's text is what it is
  // (lib/feed.js normalizeLocal/normalizeTeam ship both on every entry).
  // Optional, so a caller that builds a StreamEntry by hand -- and every
  // existing fixture -- keeps compiling; absence is read as false everywhere.
  //
  // `distilled`: a real summarizing pass ran, as opposed to a harvested line.
  // Already the gate mappers.ts's hasSummary uses; carried here so a consumer
  // can prefer a distilled row without re-deriving that judgement.
  //
  // `undecryptable`: fail-closed E2E -- this client held ciphertext it could
  // not read, so `outcome` is empty ON PURPOSE (lib/feed.js:136). Without this
  // field an unreadable row and a genuinely un-summarized one are byte
  // identical to the UI, and both render the same "No summary yet". They are
  // different facts and must stay tellable apart.
  distilled?: boolean
  undecryptable?: boolean
  // `self`: the daemon's own answer to "is this row the viewer's work". Carried
  // through mapStreamEntry because it is the ONLY field that answers it --
  // `authorId` is null on every row the daemon actually serves, local and
  // teammate alike. Nothing reads this yet on purpose; see the person-filter
  // note in features/search/SearchPage.tsx.
  self?: boolean
}

// The Feed screen's entries are the same StreamEntry shape plus the project
// they belong to -- ProjectPage doesn't need this (the project is already
// the page you're on), which is why it isn't on StreamEntry itself.
export interface FeedEntry extends StreamEntry {
  project: string
  projectPath: string | null
  // The backend's id for that project, carried through untouched. This is the
  // ONE project component that survives a round trip through team sync: work
  // done in a linked project reaches this machine twice, and the synced-back
  // twin has projectPath nulled (lib/feed.js normalizeTeam) and a differently
  // capitalised display name, but the SAME projectId. lib/feed.js's own
  // dedupeKey already keys on it first for exactly this reason; the Feed's day
  // cards do the same (features/feed/dayCards.ts projectPart), and without it
  // one person's afternoon renders as two copies of itself.
  //
  // Optional, so every hand-built fixture keeps compiling; null is the honest
  // value for an unlinked local project, which genuinely has no backend id.
  projectId?: string | null
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
/** One source the daemon's day digest drew a clause from. `entryId` is exactly
 *  mappers.streamEntryId (`${session||'none'}|${ts}`), so a rendered digest
 *  sentence can be linked back at the session it describes. */
export interface DayDigestSource {
  entryId: string
  session: string | null
  ts: string
  project: string
  projectId: string | null
  distilled: boolean
  text: string
}

/** The daemon's own one-sentence statement of a person's whole day (GET
 *  /api/feed `dayDigests`, derived on read from the page it is served with).
 *
 *  This is the general day header the owner asked for -- "Worked on UI fixes,
 *  app install and dmg" -- and it exists on the daemon because it CANNOT be
 *  built here: composing it out of the day's headline fragments produces
 *  garbage on real rows, which features/feed/dayCards.ts has a test forbidding.
 *
 *  `kind` reuses the client's own DayOverviewKind vocabulary exactly, and its
 *  'none'/'undecryptable' text matches the client's constants, so the
 *  distinction between "nobody summarized this" and "this machine could not
 *  read this" survives the swap unchanged.
 *
 *  Every field is optional at this boundary: the digest ships on a branch that
 *  may not be deployed against a given daemon, and an older daemon simply omits
 *  the whole array. Absence must degrade to the client's own pick, never to a
 *  blank card. */
export interface RawDayDigest {
  key?: string
  day?: string
  tz?: string
  author?: string
  authorId?: string | null
  kind?: string
  text?: string
  sources?: Partial<DayDigestSource>[]
  sessions?: number
  summarized?: number
  omittedSessions?: number
  entries?: number
  complete?: boolean
  /** The honesty valve for a capped or half-loaded day, and the one field here
   *  that MUST be rendered whenever it is non-null: it is the difference
   *  between a day summary that is true and one that quietly describes only
   *  part of the day. */
  coverageNote?: string | null
}

export interface DayDigest {
  /** Normalized to the client's own dayCardKey form. The daemon joins the day
   *  and the author part with a SPACE where dayCardKey uses NUL, and that
   *  conversion happens in exactly one place (features/feed/dayCards.ts
   *  digestKey) rather than at each join. */
  key: string
  kind: string
  text: string
  sources: DayDigestSource[]
  /** Distinct sessions the digest SAW on its page. */
  sessions: number
  /** Distinct session statements it had to work with. The honest measure of
   *  how much of a day a sentence accounts for: `entries` counts prompt rows,
   *  and a page boundary can hand one page most of a day's rows and none of
   *  its summarized sessions. */
  summarized: number
  /** Statements the daemon had but dropped to its own clause cap. Unlike
   *  `complete`, this is page-independent: no amount of paging brings them
   *  back, so it is the one coverage fact a client can never supersede. */
  omittedSessions: number
  entries: number
  /** Whether the page this digest came from reached back past the START of
   *  this day. A PER-PAGE fact, not a statement about the day: a client
   *  holding several pages can have loaded the rest itself. */
  complete: boolean
  coverageNote: string | null
}

export interface FeedPage {
  entries: FeedEntry[]
  nextBefore: string | null
  /** Newest day first. Empty against a daemon that does not serve them yet,
   *  which is a supported state and not an error. */
  dayDigests: DayDigest[]
}

/** Only what one machine can actually observe about a teammate.
 *  `team_members_list` (supabase/migrations/002_team_v2.sql:267) returns just
 *  user_id, display_name, role, joined_at. A teammate's paused daemon or expired
 *  token lives on THEIR machine and is not knowable here — so this models
 *  "when did anything of theirs last arrive", never a diagnosis. */
/**
 * What signing out actually achieved. TWO outcomes, not one.
 *
 * This machine forgetting the session always happens: teamsync.signOut deletes
 * credentials.json unconditionally, so a user offline or behind an outage can
 * still sign out of their own laptop. Ending the session on the BACKEND can
 * fail independently.
 *
 * `revoked` is true ONLY when the backend confirmed it -- never inferred from
 * the absence of an error. When it is false, any copy of credentials.json
 * taken before the sign-out (a backup, a synced folder, another process as the
 * same user) still mints valid tokens until the session expires, and no retry
 * from here can change that: the credentials are already gone from this
 * machine, so there is nothing left to revoke WITH. Changing the account
 * password is the only certain remedy.
 */
export interface SignOutResult {
  revoked: boolean
  /** The backend's own wording for why revocation failed; null when revoked. */
  revokeError: string | null
}

export interface Member {
  id: string
  name: string
  // There is no `email`. The members RPC has never returned one, so mapMember
  // filled this with '' on every row and MemberRow rendered a permanently
  // blank address line under every name -- the same defect, and the same
  // remedy, as `Invite.email` above. It survived because FakeDataClient
  // authored Member literals with plausible addresses instead of going
  // through mapMember, so every test and every screenshot saw data the app
  // could not produce. Removed from the TYPE, not just the row, so nothing
  // can render it again.
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
  /**
   * Whether this member's encryption key still matches the one we pinned.
   *
   * A STRING, not a boolean, and that is the point. A teammate's box pubkey
   * comes from the server, so a compromised backend could substitute its own
   * and read the sealed team key; lib/teampins.js catches that. But a boolean
   * cannot carry "we don't know", so that state collapses into `false` and
   * renders identically to "verified" -- the user reads the absence of a
   * warning as an assurance nobody made. That was the original bug here
   * (mapMember hardcoded `keyAlert: false` for everyone), and a boolean would
   * reintroduce it in a new costume.
   *
   *   'alert'   -- disagrees with our pin. Show the chip.
   *   'ok'      -- we hold a pin and the running gate agreed with it.
   *   'unknown' -- we cannot say. NEVER render this as "verified".
   *
   * 'unknown' is the honest answer in three real situations: no pin for the
   * member (they have published no key, so TOFU never happened and there is
   * nothing to disagree with), encryption switched off, and the crypto gate
   * PAUSED, where the pins on disk may be stale and nothing re-checks them.
   * An 'alert' outranks all three -- a key change that was found stays found,
   * and turning encryption off must not silence it.
   *
   * READ IT AS `=== 'alert'`. All three values are truthy, so `if (keyStatus)`
   * lights the chip for everybody, which is the one edit that silently puts
   * the original bug back.
   */
  keyStatus: 'alert' | 'ok' | 'unknown'
  /**
   * #59. How much of this member's local history a person filter CANNOT reach.
   *
   * Team rows pulled before the daemon projected `author_id` carry an author
   * NAME and no id. The person picker's option value is the member's uuid and
   * the daemon matches on that uuid first, so those rows are invisible to the
   * filter -- and the empty result they produce is byte-identical to the empty
   * result for someone who has genuinely done nothing. This field is what
   * tells the two apart.
   *
   *   entries  -- local team rows with no author_id whose author name is this
   *               member's display name.
   *   projects -- how many DISTINCT local projects those rows sit in. A count,
   *               never a list: it lets the UI say "across 3 projects" without
   *               putting teammate project paths into an identity payload.
   *
   * BOTH COUNT THIS MACHINE ONLY -- a pre-fix row is a local storage property,
   * so no server can answer this.
   *
   * ALWAYS PRESENT, carrying zero when there is nothing to report. Not
   * optional, and deliberately so: an absent field is indistinguishable from
   * "no problem", which is the same silent zero the ticket exists to fix. The
   * UI condition is `m.preFixLocal.entries > 0`, and it can only be written
   * that way because the zero is explicit.
   */
  preFixLocal: { entries: number; projects: number }
}

// One outstanding invite link (GET /api/team/invites, lib/api-access.js
// readInvites). There is no `email` and no `role`: nothing in this product
// mails an invite or pre-assigns a role -- an invite is a token somebody
// pastes, and everyone who redeems one joins as a member. Those two fields
// existed on this type before any endpoint could fill them, which is why the
// row rendered a permanently blank address.
/** Lifetime bounds for a freshly minted invite. `0` means "no limit" -- the
 *  daemon's deliberate opt-out -- and is NOT the same as omitting the field,
 *  which is why both are always sent explicitly. */
export interface InviteOptions {
  expiresDays: number
  maxUses: number
}

export interface Invite {
  /** The invite token. Also the id: it is the primary key AND exactly what
   *  revoking takes, so a row needs nothing else to be revocable. */
  id: string
  createdAt: string
  /** Null means it never expires -- a real and different state from expired. */
  expiresAt: string | null
  /** Null means unlimited uses. */
  maxUses: number | null
  useCount: number
  revoked: boolean
}

export interface AuditEvent {
  id: string
  at: string
  actorName: string
  action: string
  objectType: 'project' | 'member' | 'invite' | 'team' | 'setting'
  /** The raw backend key: a project UUID, a user id, an invite token. Kept
   *  for exactness (it is what the row is really about) but never the thing a
   *  human is shown -- see objectName/targetName. */
  objectLabel: string
  /** The friendly name of the object: a project's folder path. Null when the
   *  event carries none -- absent and unknown must stay distinguishable, so
   *  this is never backfilled with the UUID. */
  objectName: string | null
  /** The OTHER person in the event: whose access changed, who was removed.
   *  Resolved to a display name by the daemon while the roster still has
   *  them; falls back to their user id, null when the event has no subject. */
  targetName: string | null
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
  // Counts came from the database's own aggregate (027_team_feed_counts.sql)
  // rather than from measuring fetched rows, so they are true totals at any
  // window size. False only on a backend predating that migration.
  exact: boolean
  // Un-masked as of #79: the feed fetch really did stop at the 10-page cap,
  // regardless of whether the two headline COUNTS are exact. Under the old
  // masked wire (`feedTruncated && !exact`) this was always false against a
  // 027+ backend; T-76 shipped against that mask and was dormant on production.
  // Now this fires whenever the fetch saturated, and the T-76 UI (truncation
  // notice, silent-teammate demotion, floor-mark on members-syncing) is what
  // that boolean is for. `exact` still covers the two headline counts
  // (sessions, entries) independently -- both flags carry their own meaning.
  truncated: boolean
  // How far back the paged fetch actually reached, in days. Untruncated, this
  // equals `window * 2` (the daemon requests the two-window span for the
  // current-vs-prior comparison). Truncated, it shrinks to the floor the fetch
  // hit -- and this is the ONE number that lets the UI say "30 days requested,
  // N days reached" rather than "some part of it was cut".
  //
  // WHY TWO FIELDS FOR THE SAME NUMBER. The daemon's own silent-teammate and
  // concentration sentences quote `lookbackDays` ("in the last Nd") and always
  // will; `coveredDays` is the same integer under a UI-facing name for "days
  // reached" in the truncation notice. They hold the same value today (see the
  // #79 commit body). Deliberately no helper abstracting across them: a helper
  // is how the two drift when the daemon later diverges them, so each site
  // reads the name it means and cites the other in a comment.
  lookbackDays: number
  coveredDays: number
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
  // 'mcp' only. The per-tool registration rows the daemon already recorded,
  // carried through UNSUMMARISED. `detail` above names only the tools that
  // DID register, which is exactly the wrong half when nothing did: the
  // skipped/failed rows are the ones whose `detail` names the config key
  // that fixes them (the same lines `membridge status` prints). Undefined
  // for every other channel, and for an older daemon that sent no rows.
  mcpRows?: McpRegisterRow[]
}

// Force-update hooks (lib/hooks.js's hooksVersionStatus/forceUpdateHooks):
// 'current' -- the registered hook is stamped with today's build.
// 'outdated' -- registered, but stamped with an older build (or never
//   stamped at all, i.e. it predates this feature) -- an update is real.
// 'newer' -- registered by a NEWER build than the daemon answering this
//   request (a dev checkout next to an installed app, most often). The right
//   action is to do nothing: "update" here would be a downgrade, which is
//   exactly what this state was previously mislabelled 'outdated' to invite.
// 'unknown' -- nothing owned is registered to compare, or settings.json
//   could not be read. Never guessed as either of the other two.
export type HookVintage = 'current' | 'outdated' | 'newer' | 'unknown'
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
//
// WHY it was refused arrives as `refusal` + `retryable` (lib/server.js REFUSAL
// / RETRYABLE_REFUSALS). Both are absent from every SUCCESS body and from an
// older daemon's refusal, which is why they are optional -- absent reads as
// "not retryable", the safe default, and preserves the behaviour this client
// had before the fields existed.
export interface DeleteProjectResult {
  path?: string
  scope?: 'team' | 'local'
  archived?: boolean
  deleted?: boolean
  unlinked?: boolean
  message?: string
  /** The three codes the daemon ships today. NOT to be treated as exhaustive
   *  and NOT to be switched on: the daemon may add a fourth, and a client that
   *  branched on the value list would then have to be taught about it before it
   *  could behave correctly. Branch on `retryable` instead -- see below. Kept
   *  here because it is the contract, and because a log or a bug report wants
   *  the code rather than a translated sentence. */
  refusal?: 'role-unknown' | 'not-manager' | 'not-a-member'
  /** Could the very same delete succeed on a second attempt? True only for an
   *  INDETERMINATE refusal -- the daemon could not establish the caller's role
   *  (no connection, expired sign-in, a backend that listed no teams) and so
   *  changed nothing locally. Derived by the daemon from its own set, never
   *  re-derived here: that is what makes a future determinate refusal correctly
   *  non-retryable for a client that never hears about it. */
  retryable?: boolean
}

// GET /api/scan's per-project row (lib/server.js scanPayload): every folder
// on this machine that has real AI activity, whether MemBridge watches it or
// not. Discovery only -- an untracked row here contributes NOTHING until it
// is adopted, because syncOnce drops every session whose project is not
// tracked (scan.filterTrackedSessions).
export interface DiscoveredProject {
  path: string
  name: string
  /** Already watched. Rendered as "already added", never offered again. */
  tracked: boolean
  /** Narrative sessions found in this folder -- the "how much work is here"
   *  count, plumbing excluded (scanPayload computes it that way). */
  sessionCount: number
  /** The AI tools that produced them, e.g. ['Claude Code', 'Codex']. */
  tools: string[]
}

// POST /api/projects/adopt's result (lib/server.js adoptProjects). Bulk by
// construction and per-path in its reporting: one unreadable folder must not
// abandon the rest of the sweep, so a partial success is a 200 with the
// failures named in `skipped` -- callers have to read it.
export interface AdoptResult {
  adopted: string[]
  skipped: { path: string; reason: string }[]
  /** Adopted WITHOUT their history, because they were deleted on purpose
   *  before (the tombstone `membridge remove` writes). */
  historyWithheld: string[]
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
