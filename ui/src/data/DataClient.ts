import type {
  AccessMatrix, AuditEvent, DeleteProjectResult, FeedFilters, FeedPage, HookUpdateResult, Insights, Invite, LiveSession, McpRegisterResult,
  Member, Project, Role, Session, Settings, SkeletonStats, Status, StreamEntry,
} from './types'

/** What the active TRANSPORT supports — never what the current USER is allowed
 *  to do. Conflating the two let a member see admin screens: a transport that
 *  *can* carry admin calls is not permission to make them. Authorization is the
 *  viewer's role, read from `Settings.team.role`, and is checked separately. */
export interface Capabilities {
  daemonControl: boolean   // restart, start-at-login, interval
  localPaths: boolean      // show filesystem paths, open files
  teamAdminSupported: boolean  // the transport exposes admin endpoints at all
  // The Electron bridge (app/preload.js's window.membridge) is present, so
  // pickPaths() can open a real native Finder/Explorer dialog. False when
  // this UI is loaded in a plain browser tab (the daemon serves the same
  // bundle there too, at /) -- callers must fall back to manual path entry
  // rather than rendering a picker button that silently does nothing.
  filePicker: boolean
}

export interface DataClient {
  readonly capabilities: Capabilities

  getStatus(): Promise<Status>
  getProjects(): Promise<Project[]>
  getLiveSessions(): Promise<LiveSession[]>
  getProjectStream(projectPath: string): Promise<StreamEntry[]>
  // The Feed screen: every session across every project the viewer can see,
  // newest first. Filtering is server-side (author/project/source all
  // forward straight to /api/feed's query params) so paging stays correct
  // -- a client-side filter over an already-paged slice would silently
  // shrink each page instead of asking the daemon for more. `before` pages
  // backwards using the cursor the previous call returned as `nextBefore`.
  getFeed(filters: FeedFilters, opts: { limit: number; before: string | null }): Promise<FeedPage>
  // The session detail page: ONE session, unsliced and uncollapsed (GET
  // /api/session?id=). Resolves null for an unknown or evicted id -- that is
  // a real page state ("isn't in memory anymore"), not a failure, so it must
  // be distinguishable from a rejected fetch (which renders the retryable
  // error affordance instead).
  getSession(sessionId: string): Promise<Session | null>
  syncProject(projectPath: string): Promise<void>
  syncAll(): Promise<void>
  setProjectPaused(projectPath: string, paused: boolean): Promise<void>
  // Archive a project out of the Projects list without destroying anything
  // (POST /api/projects/archive): the daemon pauses it and strips its context
  // block, keeping .membridge/, memory and state intact. Local-only, needs no
  // role. Unarchive is total (POST /api/projects/unarchive): both config
  // entries drop and the next sync re-adds the block.
  archiveProject(projectPath: string): Promise<void>
  unarchiveProject(projectPath: string): Promise<void>
  // Destructive, single-project only (POST /api/team/archive-project): wipes
  // .membridge/, strips the context-file blocks and prunes the team archive.
  // Routed through the daemon's SHARED-gated handler (archiveSharedProject),
  // so a shared project keeps today's owner/manager gate: a plain member's
  // delete only unlinks their own machine. An unlinked path falls back to a
  // plain local delete server-side.
  //
  // Resolves with the daemon's BODY, never void: that handler answers 200 on
  // a refusal too (see DeleteProjectResult), so a caller that discards the
  // body cannot tell a completed delete from a refused one.
  deleteProject(projectPath: string): Promise<DeleteProjectResult>
  copyForAI(projectPath: string): Promise<string>

  getProjectAccess(projectPath: string): Promise<{ members: { memberId: string; canSee: boolean }[]; defaultAccess: boolean }>
  setProjectAccess(projectPath: string, memberId: string, canSee: boolean): Promise<void>
  // "New members join with access" (Task 17: POST /api/project/access-default).
  // Manager-only; a member's write attempt rejects.
  setProjectAccessDefault(projectPath: string, defaultAccess: boolean): Promise<void>
  getAccessMatrix(): Promise<AccessMatrix>

  getMembers(): Promise<Member[]>
  // No daemon endpoint can LIST pending invites yet -- LocalDaemonClient
  // resolves []. (An email-invite method was removed outright: POST
  // /api/team/invite mints a generic link and accepts no email or role, so
  // "invite this email as this role" is structurally impossible today.)
  getInvites(): Promise<Invite[]>
  // Mints a fresh onboarding-invite token for `teamId` (POST /api/team/invite)
  // -- a DIFFERENT mechanism from the standing, never-rotated `team.inviteCode`
  // (Settings.team): each call produces a new one-time token that the hosted
  // join page (cloudflare/join, redeeming via redeem_onboarding_invite) can
  // exchange for team membership. Callers build the shareable link themselves
  // as `${settings.webUrl}/#${token}` -- matching exactly how
  // cloudflare/ops-dashboard's own JOIN_BASE + token construction works --
  // since settings.webUrl is null on a build with no hosted join page
  // configured (self-hosted, empty lib/backend.json).
  createInviteLink(teamId: string): Promise<{ token: string }>
  revokeInvite(inviteId: string): Promise<void>
  setMemberRole(memberId: string, role: Role): Promise<void>
  removeMember(memberId: string): Promise<void>
  getAudit(limit?: number): Promise<AuditEvent[]>

  getInsights(window: 7 | 30 | 90): Promise<Insights>

  // Today's "repeat opens answered by memory" solo stat (Task 7 Finding 3):
  // the real /api/savings ledger, not a session-count proxy. Same union as
  // Insights.skeleton, read independently so Today never has to wait on the
  // full Insights payload (getInsights covers a team-only screen) just to
  // show its one solo number.
  getSkeletonStats(): Promise<SkeletonStats>

  getSettings(): Promise<Settings>
  setSetting(key: string, value: unknown): Promise<void>
  // Owner-triggered MCP re-registration (POST /api/mcp/register): always
  // callable, regardless of the delivery channel's current reported install
  // state -- the real fix for "it claims installed but is misbehaving".
  // Resolves with the same per-tool rows `membridge mcp register` prints.
  registerMcp(): Promise<McpRegisterResult>

  // Owner-triggered force-update (POST /api/hooks/update): rewrites the Stop
  // and recall hooks to the current build regardless of Settings.hooksVersion's
  // current reading -- the way to actually get from 'outdated'/'unknown' to
  // 'current'. Always callable, same "not gated on the reported state" shape
  // as registerMcp above.
  updateHooks(): Promise<HookUpdateResult>

  // Task 17/18: daemon- and machine-level controls the mockups show with no
  // backing method until now.
  restartDaemon(): Promise<void>
  checkForUpdates(): Promise<{ current: string; latest: string | null; updateAvailable: string | null }>
  openConfigFile(): Promise<void>
  openMemoryFile(projectPath: string): Promise<void>
  leaveTeam(teamId: string): Promise<void>
  addProject(path: string): Promise<void>

  // Opens a native OS file/folder picker via the Electron bridge and
  // resolves to the chosen absolute paths, or [] when the user cancels.
  // Only call this when capabilities.filePicker is true -- there is no
  // daemon-side fallback, so an unguarded call in a plain-browser session
  // rejects.
  pickPaths(options: { kind: 'file' | 'folder'; multiple?: boolean }): Promise<string[]>
}
