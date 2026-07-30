import type {
  AccessMatrix, AuditEvent, FeedFilters, FeedPage, Insights, Invite, LiveSession, Member, Project, Role, Settings, SkeletonStats,
  Status, StreamEntry,
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
  // /app/ bundle there too) -- callers must fall back to manual path entry
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
  syncProject(projectPath: string): Promise<void>
  syncAll(): Promise<void>
  setProjectPaused(projectPath: string, paused: boolean): Promise<void>
  copyForAI(projectPath: string): Promise<string>

  getProjectAccess(projectPath: string): Promise<{ members: { memberId: string; canSee: boolean }[]; defaultAccess: boolean }>
  setProjectAccess(projectPath: string, memberId: string, canSee: boolean): Promise<void>
  // "New members join with access" (Task 17: POST /api/project/access-default).
  // Manager-only; a member's write attempt rejects.
  setProjectAccessDefault(projectPath: string, defaultAccess: boolean): Promise<void>
  getAccessMatrix(): Promise<AccessMatrix>

  getMembers(): Promise<Member[]>
  getInvites(): Promise<Invite[]>
  inviteMember(email: string, role: Role): Promise<void>
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
