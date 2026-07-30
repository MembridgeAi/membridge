import type {
  AccessMatrix, AuditEvent, Insights, Invite, LiveSession, Member, Project, Role, Settings, Status, StreamEntry,
} from './types'

/** What the active transport can do. Screens hide what is unsupported. */
export interface Capabilities {
  daemonControl: boolean   // restart, start-at-login, interval
  localPaths: boolean      // show filesystem paths, open files
  teamAdmin: boolean       // roles, invites, audit, access matrix
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

  getSettings(): Promise<Settings>
  setSetting(key: string, value: unknown): Promise<void>
}
