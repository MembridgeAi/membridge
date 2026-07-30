// The daemon-backed DataClient implementation: one fetch per method, mapped
// through the pure functions in ./mappers.ts. Kept thin on purpose -- see
// mappers.ts for every judgment call the daemon's real shape forced.
import type { Capabilities, DataClient } from './DataClient'
import type { AccessMatrix, AuditEvent, Insights, Invite, LiveSession, Member, Project, Role, Settings, Status, StreamEntry } from './types'
import {
  dedupeLiveSessions, lastSharedAtByAuthor, mapLiveSession, mapMember, mapProjectRow, mapSettings, mapStreamEntry,
  projectCountsByAuthor, syncStateOf,
  type RawFeedEntry, type RawMemberRow, type RawProjectRow, type RawSettingsPayload, type RawTeamFeedEntry, type RawTeamRow,
} from './mappers'

export { syncStateOf }

const BASE = '' // same origin as the daemon
const FEED_LIMIT = 100 // covers every tracked project's latest entry in one request
const TEAM_FEED_LIMIT = 200 // team_feed RPC's hard cap (002_team_v2.sql:320)

async function get<T>(pathAndQuery: string): Promise<T> {
  const res = await fetch(`${BASE}${pathAndQuery}`, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${pathAndQuery} failed: ${res.status}`)
  return res.json() as Promise<T>
}

async function post<T>(pathAndQuery: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${pathAndQuery} failed: ${res.status}`)
  return (res.status === 204 ? undefined : await res.json()) as T
}

const feed = (query = '') => get<{ entries: RawFeedEntry[] }>(`/api/feed?limit=${FEED_LIMIT}${query}`)

async function firstTeam(): Promise<RawTeamRow | null> {
  const data = await get<{ teams: RawTeamRow[] }>('/api/team')
  return data.teams[0] || null
}

const missingEndpoint = (method: string, endpoint: string): Error =>
  new Error(`${method} has no daemon endpoint yet -- ${endpoint} does not exist until Task 10 lands.`)

export class LocalDaemonClient implements DataClient {
  readonly capabilities: Capabilities = { daemonControl: true, localPaths: true, teamAdmin: true }

  getStatus(): Promise<Status> {
    return get<Status>('/api/status')
  }

  async getProjects(): Promise<Project[]> {
    const [rows, f] = await Promise.all([get<RawProjectRow[]>('/api/projects'), feed()])
    return rows.map(row => mapProjectRow(row, f.entries))
  }

  async getLiveSessions(): Promise<LiveSession[]> {
    const f = await feed()
    return dedupeLiveSessions(f.entries).map(mapLiveSession)
  }

  async getProjectStream(projectPath: string): Promise<StreamEntry[]> {
    const f = await feed(`&project=${encodeURIComponent(projectPath)}`)
    return f.entries.map(mapStreamEntry)
  }

  syncProject(projectPath: string): Promise<void> {
    return post<void>('/api/sync', { project: projectPath })
  }

  syncAll(): Promise<void> {
    return post<void>('/api/sync', {})
  }

  // /api/projects/toggle flips pause state; it has no "set to X" form. A
  // read-before-write keeps this method's SET semantics honest instead of
  // blindly toggling (which would invert state on a redundant call).
  async setProjectPaused(projectPath: string, paused: boolean): Promise<void> {
    const rows = await get<RawProjectRow[]>('/api/projects')
    const current = rows.find(r => r.path === projectPath)
    if (current && current.paused === paused) return
    await post('/api/projects/toggle', { path: projectPath })
  }

  async copyForAI(projectPath: string): Promise<string> {
    const r = await post<{ text?: string }>('/api/projects/copy', { path: projectPath })
    return r.text || ''
  }

  getProjectAccess(_projectPath: string): Promise<{ memberId: string; canSee: boolean }[]> {
    return Promise.reject(missingEndpoint('getProjectAccess', 'GET /api/project/access'))
  }

  setProjectAccess(_projectPath: string, _memberId: string, _canSee: boolean): Promise<void> {
    return Promise.reject(missingEndpoint('setProjectAccess', 'POST /api/project/access'))
  }

  getAccessMatrix(): Promise<AccessMatrix> {
    return Promise.reject(missingEndpoint('getAccessMatrix', 'GET /api/team/access-matrix'))
  }

  // lastSharedAt needs the raw team stream (author_id, ts), which is a
  // different shape and a different endpoint than the merged /api/feed page
  // already fetched below for project counts -- /api/team/feed does not
  // dedupe against local entries or carry headline/distilled, so it can't be
  // read off that response. That's a third request this method didn't
  // previously make (team, members, feed -> +team/feed), traded for not
  // fabricating a value the daemon can actually answer.
  async getMembers(): Promise<Member[]> {
    const team = await firstTeam()
    if (!team) return []
    const [membersRes, f, teamFeedRes] = await Promise.all([
      get<{ members: RawMemberRow[] }>(`/api/team/members?teamId=${encodeURIComponent(team.team_id)}`),
      feed(),
      get<{ entries: RawTeamFeedEntry[] }>(`/api/team/feed?teamId=${encodeURIComponent(team.team_id)}&limit=${TEAM_FEED_LIMIT}`),
    ])
    const counts = projectCountsByAuthor(f.entries)
    const lastShared = lastSharedAtByAuthor(teamFeedRes.entries)
    return membersRes.members.map(m => mapMember(m, counts, lastShared))
  }

  // The daemon can only mint a generic, role-less invite LINK (POST
  // /api/team/invite) and cannot list the ones already issued -- there is no
  // endpoint backing "invite this email as this role" or "show pending
  // invites" today.
  getInvites(): Promise<Invite[]> {
    return Promise.reject(new Error(
      'getInvites has no daemon endpoint yet -- the daemon can create invite links but cannot list pending ones.'));
  }

  inviteMember(_email: string, _role: Role): Promise<void> {
    return Promise.reject(new Error(
      'inviteMember has no daemon endpoint yet -- POST /api/team/invite creates a generic link and accepts no email or role.'));
  }

  revokeInvite(inviteId: string): Promise<void> {
    return post<void>('/api/team/revoke-invite', { token: inviteId })
  }

  async setMemberRole(memberId: string, role: Role): Promise<void> {
    const team = await firstTeam()
    if (!team) throw new Error('setMemberRole requires a team, and this machine is not on one.')
    await post('/api/team/set-role', { teamId: team.team_id, userId: memberId, role })
  }

  async removeMember(memberId: string): Promise<void> {
    const team = await firstTeam()
    if (!team) throw new Error('removeMember requires a team, and this machine is not on one.')
    await post('/api/team/remove-member', { teamId: team.team_id, userId: memberId })
  }

  getAudit(_limit?: number): Promise<AuditEvent[]> {
    return Promise.reject(missingEndpoint('getAudit', 'GET /api/team/audit'))
  }

  getInsights(_window: 7 | 30 | 90): Promise<Insights> {
    return Promise.reject(missingEndpoint('getInsights', 'GET /api/team/insights'))
  }

  async getSettings(): Promise<Settings> {
    const [raw, status, team] = await Promise.all([
      get<RawSettingsPayload>('/api/settings'),
      get<Status>('/api/status'),
      firstTeam(),
    ])
    return mapSettings(raw, status, team)
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await post('/api/settings', { [key]: value })
  }
}
