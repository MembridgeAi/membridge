import type {
  AccessMatrix, AuditEvent, Insights, Invite, LiveSession, Member, Project, Role, Settings, SkeletonStats, Status, StreamEntry,
} from './types'

/** What the active TRANSPORT supports — never what the current USER is allowed
 *  to do. Conflating the two let a member see admin screens: a transport that
 *  *can* carry admin calls is not permission to make them. Authorization is the
 *  viewer's role, read from `Settings.team.role`, and is checked separately. */
export interface Capabilities {
  daemonControl: boolean   // restart, start-at-login, interval
  localPaths: boolean      // show filesystem paths, open files
  teamAdminSupported: boolean  // the transport exposes admin endpoints at all
}

export interface DataClient {
  readonly capabilities: Capabilities

  getStatus(): Promise<Status>
  getProjects(): Promise<Project[]>
  getLiveSessions(): Promise<LiveSession[]>
  getProjectStream(projectPath: string): Promise<StreamEntry[]>
  syncProject(projectPath: string): Promise<void>
  syncAll(): Promise<void>
  setProjectPaused(projectPath: string, paused: boolean): Promise<void>
  copyForAI(projectPath: string): Promise<string>

  getProjectAccess(projectPath: string): Promise<{ memberId: string; canSee: boolean }[]>
  setProjectAccess(projectPath: string, memberId: string, canSee: boolean): Promise<void>
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
}
