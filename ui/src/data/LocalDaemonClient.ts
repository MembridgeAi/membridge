// The daemon-backed DataClient implementation: one fetch per method, mapped
// through the pure functions in ./mappers.ts. Kept thin on purpose -- see
// mappers.ts for every judgment call the daemon's real shape forced.
import type { Capabilities, DataClient } from './DataClient'
import type {
  AccessMatrix, AuditEvent, FeedFilters, FeedPage, HookUpdateResult, Insights, Invite, LiveSession, McpRegisterResult, Member, Project, Role,
  Settings, SkeletonStats, Status, StreamEntry,
} from './types'
import {
  dedupeLiveSessions, feedQueryString, mapFeedEntry, mapLiveSession, mapMember, mapProjectRow,
  mapStreamEntry, memberActivity, syncStateOf,
  type RawFeedEntry, type RawFeedPayload, type RawMemberRow, type RawProjectRow, type RawTeamFeedEntry,
} from './mappers'
import { mapSettings, type RawSettingsPayload, type RawTeamMeta, type RawTeamRow } from './settingsMapper'
import { skeletonStatsFrom, type RawSavingsPayload } from './skeletonStats'
import { ShortTtlCache } from './requestCache'

export { syncStateOf }

// app/preload.js's contextBridge.exposeInMainWorld('membridge', ...) is the
// only thing that ever sets this -- a plain browser tab (the daemon serves
// this same UI at / over vanilla http) never has it, since there is no
// Electron main process on the other end to answer the IPC call.
declare global {
  interface Window {
    membridge?: {
      pickPaths(options: { kind: 'file' | 'folder'; multiple?: boolean }): Promise<string[]>
    }
  }
}

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

// TTL for the coalesced request cache below -- long enough to absorb a burst
// of same-tick callers (Today mounts useProjects()+useLiveSessions()
// together, and useLiveSessions() re-polls every 10s; every screen mounts
// useStatus()+useSettings() together, and getSettings() independently
// re-fetches /api/status internally), short enough that the UI never reads
// meaningfully stale data.
const REQUEST_CACHE_TTL_MS = 5000

export class LocalDaemonClient implements DataClient {
  readonly capabilities: Capabilities = {
    daemonControl: true,
    localPaths: true,
    teamAdminSupported: true,
    filePicker: typeof window !== 'undefined' && typeof window.membridge?.pickPaths === 'function',
  }

  // The Today screen mounts useProjects() and useLiveSessions() together, and
  // useLiveSessions() polls every 10s on top -- both hit the SAME /api/feed
  // page (spec §7: one request per screen). getStatus() and teamMeta() have
  // the same shape of duplicate: useStatus()+useSettings() mount together on
  // every screen, and getSettings() below independently re-fetches
  // /api/status and /api/team. One cache, keyed by endpoint+query, coalesces
  // all of these: a call that lands while a previous one for the same key is
  // still in flight (or finished less than REQUEST_CACHE_TTL_MS ago) gets the
  // same promise instead of firing again.
  private requestCache = new ShortTtlCache(REQUEST_CACHE_TTL_MS)

  private feed(query = ''): Promise<{ entries: RawFeedEntry[] }> {
    return this.requestCache.get(`feed:${query}`, () => get<{ entries: RawFeedEntry[] }>(`/api/feed?limit=${FEED_LIMIT}${query}`))
  }

  // syncProject/syncAll can add events the cached feed page doesn't have yet;
  // clearing here (rather than waiting out the TTL) keeps the post-sync read
  // honest without reintroducing a duplicate-fetch window on every render.
  private invalidateFeedCache(): void {
    this.requestCache.deleteMatching('feed:')
  }

  private teamMeta(): Promise<{ team: RawTeamRow | null } & RawTeamMeta> {
    return this.requestCache.get('team', async () => {
      const data = await get<{ teams: RawTeamRow[]; viewerId: string | null; inviteCode: string | null; webUrl?: string | null }>('/api/team')
      return {
        team: data.teams[0] || null, viewerId: data.viewerId ?? null, inviteCode: data.inviteCode ?? null,
        // Optional on the wire: an older daemon's /api/team predates webUrl
        // entirely (Task 17 shipped viewerId/inviteCode first) -- absence maps
        // to null (no hosted join page known), never a fabricated default.
        webUrl: data.webUrl ?? null,
      }
    })
  }

  private async firstTeam(): Promise<RawTeamRow | null> {
    return (await this.teamMeta()).team
  }

  getStatus(): Promise<Status> {
    return this.requestCache.get('status', () => get<Status>('/api/status'))
  }

  // getStatus() here is for intervalSec, which sizes the "behind" grace period
  // (mappers.ts syncStateOf). It routes through the same 'status' requestCache
  // key as useStatus(), which every screen already mounts -- so this is a cache
  // hit, not a third request per poll.
  //
  // Its failure is swallowed on purpose: intervalSec only tunes one badge's
  // tolerance, and syncStateOf falls back to the shipped 60s default without
  // it. Letting a status hiccup reject here would blank the entire projects
  // list over a cosmetic detail.
  async getProjects(): Promise<Project[]> {
    const [rows, f, status] = await Promise.all([
      get<RawProjectRow[]>('/api/projects'),
      this.feed(),
      this.getStatus().catch(() => null),
    ])
    return rows.map(row => mapProjectRow(row, f.entries, status?.intervalSec))
  }

  async getLiveSessions(): Promise<LiveSession[]> {
    const f = await this.feed()
    return dedupeLiveSessions(f.entries).map(mapLiveSession)
  }

  async getProjectStream(projectPath: string): Promise<StreamEntry[]> {
    const f = await this.feed(`&project=${encodeURIComponent(projectPath)}`)
    return f.entries.map(mapStreamEntry)
  }

  // The Feed screen's cross-project, filtered, paged request -- deliberately
  // NOT routed through the private feed() helper above, which hardcodes
  // limit=FEED_LIMIT ahead of its query string: appending a second `limit`
  // here would produce `?limit=100&limit=<n>`, and URLSearchParams.get on
  // the server keeps the FIRST value, silently discarding the caller's page
  // size. Keyed under the same 'feed:' prefix as that helper's cache entries
  // so syncProject/syncAll's invalidateFeedCache() clears both.
  async getFeed(filters: FeedFilters, opts: { limit: number; before: string | null }): Promise<FeedPage> {
    const qs = feedQueryString(filters, opts)
    const raw = await this.requestCache.get(`feed:page:${qs}`, () => get<RawFeedPayload>(`/api/feed?${qs}`))
    return { entries: raw.entries.map(mapFeedEntry), nextBefore: raw.nextBefore ?? null }
  }

  async syncProject(projectPath: string): Promise<void> {
    await post<void>('/api/sync', { project: projectPath })
    this.invalidateFeedCache()
  }

  async syncAll(): Promise<void> {
    await post<void>('/api/sync', {})
    this.invalidateFeedCache()
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

  // The real endpoint (lib/api-access.js readAccess, wired in Task 8) also
  // returns each member's name -- dropped here because DataClient's shape
  // predates that response and Task 9's UI already resolves names/roles via
  // getMembers(), joined by memberId. Task 17 added defaultAccess ("new
  // members join with access") to the same response -- carried straight
  // through, defaulting true to match the daemon's own default when a
  // legacy caller's response predates the field.
  async getProjectAccess(projectPath: string): Promise<{ members: { memberId: string; canSee: boolean }[]; defaultAccess: boolean }> {
    const r = await get<{ members: { memberId: string; name: string; canSee: boolean }[]; defaultAccess?: boolean }>(
      `/api/project/access?path=${encodeURIComponent(projectPath)}`)
    return { members: r.members.map(m => ({ memberId: m.memberId, canSee: m.canSee })), defaultAccess: r.defaultAccess ?? true }
  }

  async setProjectAccess(projectPath: string, memberId: string, canSee: boolean): Promise<void> {
    await post<{ ok: boolean }>('/api/project/access', { path: projectPath, memberId, canSee })
  }

  async setProjectAccessDefault(projectPath: string, defaultAccess: boolean): Promise<void> {
    await post<{ ok: boolean; defaultAccess: boolean }>('/api/project/access-default', { path: projectPath, defaultAccess })
  }

  // GET /api/team/access-matrix (lib/api-access.js accessMatrix, wired in
  // lib/server.js since e70744a) already returns exactly this shape -- members
  // as {id, name} and rows as {projectPath, projectName, shared, access},
  // every field name matching AccessMatrix verbatim -- so, unlike
  // getProjectAccess above, there is nothing here to map or drop.
  getAccessMatrix(): Promise<AccessMatrix> {
    return get<AccessMatrix>('/api/team/access-matrix')
  }

  // projectCount and lastSharedAt used to come off ONE shared, newest-first
  // /api/feed or /api/team/feed page, bucketed by author -- whichever member
  // is most active fills that page, so every quieter teammate's own rows
  // never made it into the page at all (see mappers.ts's memberActivity
  // comment; this is the third time this exact assumption has failed here,
  // same shape of bug lib/api-insights.js already found and fixed once).
  // Fix: one /api/team/feed request PER MEMBER, scoped with `author=<their
  // id>` and run in parallel, so the rows this reads for any one member can
  // never contain another member's entries -- a noisy teammate's volume
  // structurally cannot crowd out a quiet one anymore.
  //
  // allSettled, not all: with one request per member, a single failed
  // request used to reject the WHOLE call and blank the Members page. A
  // per-member failure now degrades that one member to zero-activity
  // ({projectCount: 0, lastSharedAt: null} -- indistinguishable from "has
  // shared nothing", which is the honest floor) and every other row keeps
  // its real numbers.
  async getMembers(): Promise<Member[]> {
    const team = await this.firstTeam()
    if (!team) return []
    const membersRes = await get<{ members: RawMemberRow[] }>(`/api/team/members?teamId=${encodeURIComponent(team.team_id)}`)
    const settled = await Promise.allSettled(membersRes.members.map(m =>
      get<{ entries: RawTeamFeedEntry[] }>(
        `/api/team/feed?teamId=${encodeURIComponent(team.team_id)}&author=${encodeURIComponent(m.user_id)}&limit=${TEAM_FEED_LIMIT}`,
      ).then(res => memberActivity(res.entries))))
    const activity = settled.map(r => r.status === 'fulfilled' ? r.value : { projectCount: 0, lastSharedAt: null })
    return membersRes.members.map((m, i) => mapMember(m, activity[i]))
  }

  // The daemon can only mint a generic, role-less invite LINK (POST
  // /api/team/invite) and cannot list the ones already issued -- there is no
  // endpoint backing "show pending invites" today. Resolving [] (rather than
  // rejecting with developer text the user then saw, retried 3x per Members
  // mount) is the honest degraded answer until a listing endpoint lands:
  // "no pending invites known", which for this daemon is always true.
  getInvites(): Promise<Invite[]> {
    return Promise.resolve([])
  }

  // POST /api/team/invite (lib/teamsync.js createInvite) also returns
  // expires_at/max_uses/url, but url is the legacy /join/<token> path shape
  // (teamsync.inviteUrl -- the CLI/app/settings consumer), not the hash-based
  // shape the Members-page UI needs, so only the token is taken here; the
  // caller builds `${webUrl}/#${token}` itself.
  async createInviteLink(teamId: string): Promise<{ token: string }> {
    const inv = await post<{ token: string }>('/api/team/invite', { teamId })
    return { token: inv.token }
  }

  revokeInvite(inviteId: string): Promise<void> {
    return post<void>('/api/team/revoke-invite', { token: inviteId })
  }

  async setMemberRole(memberId: string, role: Role): Promise<void> {
    const team = await this.firstTeam()
    if (!team) throw new Error('setMemberRole requires a team, and this machine is not on one.')
    await post('/api/team/set-role', { teamId: team.team_id, userId: memberId, role })
  }

  async removeMember(memberId: string): Promise<void> {
    const team = await this.firstTeam()
    if (!team) throw new Error('removeMember requires a team, and this machine is not on one.')
    await post('/api/team/remove-member', { teamId: team.team_id, userId: memberId })
  }

  // GET /api/team/audit (lib/api-access.js readAudit) is also already wired
  // server-side -- found while adding the Task 9/10 contract test below,
  // same shipped-endpoint-dead-stub shape as getAccessMatrix. It wraps the
  // array in { events }, and each event already carries id/at/actorName/
  // action/objectType/objectLabel/detail matching AuditEvent verbatim, so
  // this only unwraps.
  async getAudit(limit?: number): Promise<AuditEvent[]> {
    const query = limit === undefined ? '' : `?limit=${limit}`
    const r = await get<{ events: AuditEvent[] }>(`/api/team/audit${query}`)
    return r.events
  }

  // GET /api/team/insights (lib/api-insights.js insightsPayload, wired in
  // lib/server.js since 98546a1) already returns exactly this shape -- every
  // field name matches Insights verbatim, right down to `skeleton`, which
  // the daemon folds with its own copy of this same rule (lib/api-insights.js
  // skeletonStatsFrom mirrors ./skeletonStats.ts) -- so, like getAccessMatrix
  // above, there is nothing here to map or drop. `assists` is the same
  // pattern: computed entirely server-side by api-insights.js's assistsFrom,
  // no client-side counterpart the way skeleton has one for Today.
  getInsights(window: 7 | 30 | 90): Promise<Insights> {
    return get<Insights>(`/api/team/insights?window=${window}`)
  }

  async getSkeletonStats(): Promise<SkeletonStats> {
    const raw = await get<RawSavingsPayload>('/api/savings')
    return skeletonStatsFrom(raw)
  }

  // getStatus()/teamMeta() route through the same requestCache keys ('status',
  // 'team') that the standalone getStatus() method and useStatus() query use
  // -- so a screen that mounts useStatus()+useSettings() together (every
  // screen does) fires ONE /api/status request and ONE /api/team request,
  // not two of each.
  async getSettings(): Promise<Settings> {
    const [raw, status, meta] = await Promise.all([
      get<RawSettingsPayload>('/api/settings'),
      this.getStatus(),
      this.teamMeta(),
    ])
    return mapSettings(raw, status, meta.team, { viewerId: meta.viewerId, inviteCode: meta.inviteCode, webUrl: meta.webUrl })
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await post('/api/settings', { [key]: value })
  }

  // Always available -- not gated on the mcp channel's current reported
  // install state -- so the owner has a real way to force a fresh reconcile
  // when a tool claims installed but is actually misbehaving.
  async registerMcp(): Promise<McpRegisterResult> {
    return post<McpRegisterResult>('/api/mcp/register')
  }

  // Same "always available" shape as registerMcp above, for the Stop and
  // recall hooks: force-rewrites both to the current build and reports each
  // one's own ok/detail (lib/hooks.js's forceUpdateHooks), regardless of what
  // Settings.hooksVersion currently reads.
  async updateHooks(): Promise<HookUpdateResult> {
    return post<HookUpdateResult>('/api/hooks/update')
  }

  // Task 17: respond BEFORE the daemon restarts -- the promise resolves once
  // the OLD process has flushed its response, which is all a caller can
  // observe from here; the new process taking over is verified server-side.
  async restartDaemon(): Promise<void> {
    await post<{ ok: boolean; restarting: boolean }>('/api/daemon/restart')
  }

  // Forces a real network check (bypasses the 6h cache) -- the one place in
  // this client that is allowed to be slow/flaky, matching the daemon's own
  // "only /api/updates/check may hit the network" rule.
  async checkForUpdates(): Promise<{ current: string; latest: string | null; updateAvailable: string | null }> {
    return post<{ current: string; latest: string | null; updateAvailable: string | null }>('/api/updates/check')
  }

  async openConfigFile(): Promise<void> {
    await post<{ ok: boolean }>('/api/open', { kind: 'config' })
  }

  async openMemoryFile(projectPath: string): Promise<void> {
    await post<{ ok: boolean }>('/api/open', { kind: 'memory', path: projectPath })
  }

  async leaveTeam(teamId: string): Promise<void> {
    await post<{ left: boolean }>('/api/team/leave', { teamId })
    // Wide-reaching effect (this machine's team membership just changed) that
    // the request cache can't infer from the URL alone -- clear it all
    // rather than risk a stale team/status read for the rest of the TTL.
    this.requestCache.clear()
  }

  async addProject(path: string): Promise<void> {
    await post<{ path?: string; error?: string }>('/api/projects/add', { path })
  }

  // Routed through the Electron bridge, never the daemon -- the daemon is a
  // separate process with no GUI to show a dialog from. Callers must check
  // capabilities.filePicker first; this rejects rather than silently
  // returning [] when the bridge is missing, so a caller that forgets the
  // check fails loudly instead of reading "cancelled" for "unavailable".
  pickPaths(options: { kind: 'file' | 'folder'; multiple?: boolean }): Promise<string[]> {
    if (!window.membridge?.pickPaths) {
      return Promise.reject(new Error('pickPaths is unavailable: this window has no Electron bridge (window.membridge).'))
    }
    return window.membridge.pickPaths(options)
  }
}
