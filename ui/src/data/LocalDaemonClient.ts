// The daemon-backed DataClient implementation: one fetch per method, mapped
// through the pure functions in ./mappers.ts. Kept thin on purpose -- see
// mappers.ts for every judgment call the daemon's real shape forced.
import type { Capabilities, DataClient } from './DataClient'
import type {
  AccessMatrix, AdoptResult, AuditEvent, DaemonHealthState, DeleteMyDataResult, DeleteProjectResult, DiscoveredProject, FeedFilters, FeedPage, HookUpdateResult, Insights, Invite, LiveSession, SignOutResult, SignUpResult, McpRegisterResult,
  Member, MyData, Project, Role, SearchPage, InviteOptions, Session, Settings, SkeletonStats, Status, StreamEntry, TeamAccount,
} from './types'
import {
  dedupeLiveSessions, feedQueryString, mapDayDigests, mapFeedEntry, mapLiveSession, mapMember, mapProjectRow,
  mapSession, mapStreamEntry, memberActivity, syncStateOf,
  type RawFeedEntry, type RawFeedPayload, type RawMemberRow, type RawProjectRow, type RawSearchPayload, type RawSessionPayload, type RawTeamFeedEntry,
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

// GET /api/team's body, verbatim (lib/server.js teamPayload). Every field is
// optional-tolerant at the boundary -- see teamAccountPayload() for why an
// older daemon's narrower payload must degrade closed rather than be trusted.
interface RawTeamPayload {
  configured?: boolean
  authenticated?: boolean
  user?: { userId: string; email: string; displayName: string } | null
  teams?: RawTeamRow[]
  viewerId?: string | null
  inviteCode?: string | null
  webUrl?: string | null
  error?: string | null
}

// GET /api/scan's per-project row, verbatim (lib/server.js scanPayload).
interface RawScanProject {
  path?: string
  name?: string
  tracked?: boolean
  paused?: boolean
  sessionCount?: number
  bySource?: Record<string, number>
}

// The same payload after teamAccountPayload() has defaulted every field --
// nothing downstream has to re-decide what an absent field meant.
interface TeamPayload {
  configured: boolean
  authenticated: boolean
  user: { userId: string; email: string; displayName: string } | null
  teams: RawTeamRow[]
  viewerId: string | null
  inviteCode: string | null
  webUrl: string | null
  error: string | null
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

// Same POST, except the daemon's own error text is kept. The generic post()
// above throws "<path> failed: <status>", which is all a caller needs for a
// write it triggered itself -- but the team auth routes answer 400/500 with
// { error } carrying the ONLY explanation the user can act on ("email and
// password are required", "Invalid login credentials"). That text is rendered
// as-is; nothing the user typed is ever added to it here or by the caller.
async function postReadingError<T>(pathAndQuery: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  // A body that is not JSON at all (a proxy's HTML error page) must not throw
  // a parse error over the top of the real status.
  const data = await res.json().catch(() => null) as ({ error?: string } & T) | null
  if (!res.ok) throw new Error((data && data.error) || `${pathAndQuery} failed: ${res.status}`)
  return data as T
}

// TTL for the coalesced request cache below -- long enough to absorb a burst
// of same-tick callers (Today mounts useProjects()+useLiveSessions()
// together, and useLiveSessions() re-polls every 10s; every screen mounts
// useStatus()+useSettings() together, and getSettings() independently
// re-fetches /api/status internally), short enough that the UI never reads
// meaningfully stale data.
const REQUEST_CACHE_TTL_MS = 5000

// requestCache key for GET /api/live-sessions. Named rather than inlined
// because invalidateFeedCache() has to clear the same key from a second place.
const LIVE_SESSIONS_KEY = 'live-sessions'

// Where the chosen team is remembered between sessions.
const SELECTED_TEAM_KEY = 'membridge.selectedTeam'

function readStoredTeamId(): string | null {
  try {
    return window.localStorage.getItem(SELECTED_TEAM_KEY) || null
  } catch {
    return null // storage disabled: fall back to the daemon's first team
  }
}

// /api/status as it arrives: `health` is additive, so a daemon older than that
// field sends this payload without it. Typed as `unknown` rather than
// `DaemonHealth` because a cast is not a check -- this is the boundary, and an
// unrecognised `state` string reaching the UI would be rendered as a state
// nothing knows how to describe.
type RawStatus = Omit<Status, 'health'> & { health?: unknown }

const HEALTH_STATES: readonly DaemonHealthState[] = ['ok', 'erroring', 'stalled', 'unknown']

function isHealthState(v: unknown): v is DaemonHealthState {
  return typeof v === 'string' && (HEALTH_STATES as readonly string[]).includes(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/**
 * Normalizes `health` at the boundary, tolerantly, the same way every other raw
 * payload in this client is.
 *
 * ABSENT stays ABSENT. It is tempting to synthesise `{ state: 'unknown' }` for
 * an older daemon and give consumers one shape to handle, and it would be
 * wrong: 'unknown' means the DAEMON has not observed a pass yet, whereas a
 * missing field means THIS CLIENT cannot see the answer. Collapsing them would
 * show "not checked yet" to someone whose daemon simply predates the field,
 * which is reporting our own ignorance as theirs. Consumers fall back to
 * `running` instead.
 *
 * A present-but-unrecognised `state` is also dropped rather than passed
 * through: a future fifth state must degrade to today's running/not-running
 * rendering, not to a chip with a raw token in it.
 */
function normalizeStatus(raw: RawStatus): Status {
  const { health, ...rest } = raw
  if (!health || typeof health !== 'object') return rest
  const h = health as Record<string, unknown>
  if (!isHealthState(h.state)) return rest
  return {
    ...rest,
    health: {
      state: h.state,
      lastTickAt: str(h.lastTickAt),
      lastTickError: str(h.lastTickError),
      staleForSec: typeof h.staleForSec === 'number' && Number.isFinite(h.staleForSec) ? h.staleForSec : null,
    },
  }
}

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

  // Restored at construction so a switch survives a reload -- the app would
  // otherwise snap back to teams[0] every time the window reopened, which
  // reads as the switcher not working.
  private teamId: string | null = readStoredTeamId()

  private feed(query = ''): Promise<{ entries: RawFeedEntry[] }> {
    return this.requestCache.get(`feed:${query}`, () => get<{ entries: RawFeedEntry[] }>(`/api/feed?limit=${FEED_LIMIT}${query}`))
  }

  // syncProject/syncAll can add events the cached feed page doesn't have yet;
  // clearing here (rather than waiting out the TTL) keeps the post-sync read
  // honest without reintroducing a duplicate-fetch window on every render.
  // LIVE_SESSIONS_KEY is cleared alongside: a sync can bring a teammate's row
  // into the live window, and that read is cached under its own key rather
  // than the 'feed:' prefix (see getLiveSessions).
  private invalidateFeedCache(): void {
    this.requestCache.deleteMatching('feed:')
    this.requestCache.deleteMatching(LIVE_SESSIONS_KEY)
  }

  // ONE cached read of GET /api/team, shared by getSettings (which only wants
  // teams[0] plus the meta fields) and getTeamAccount (which wants the whole
  // account state, `authenticated` above all). Keyed 'team', the same key
  // both used before the Team page existed, so adding a second consumer adds
  // no second request per screen.
  private teamAccountPayload(): Promise<TeamPayload> {
    return this.requestCache.get('team', async (): Promise<TeamPayload> => {
      const data = await get<RawTeamPayload>('/api/team')
      return {
        // Every field defaulted rather than trusted: an older daemon's
        // /api/team predates webUrl and even `authenticated` (Task 17 shipped
        // viewerId/inviteCode first). Absence maps to the closed answer --
        // not configured, not authenticated, no join page -- never a
        // fabricated default that would claim a signed-in session.
        configured: data.configured ?? false,
        authenticated: data.authenticated ?? false,
        user: data.user ?? null,
        teams: Array.isArray(data.teams) ? data.teams : [],
        viewerId: data.viewerId ?? null,
        inviteCode: data.inviteCode ?? null,
        webUrl: data.webUrl ?? null,
        error: data.error ?? null,
      }
    })
  }

  // The chosen team, or the first one. Selection is matched against the list
  // the DAEMON returned rather than trusted: a stale id in localStorage (a
  // team since left, or one belonging to a different account signed in on
  // this machine) matches nothing and quietly falls back to first, instead of
  // pinning the whole app to a team the viewer is no longer on.
  private async teamMeta(): Promise<{ team: RawTeamRow | null } & RawTeamMeta> {
    const data = await this.teamAccountPayload()
    const chosen = this.teamId ? data.teams.find(t => t.team_id === this.teamId) : undefined
    return { team: chosen ?? data.teams[0] ?? null, viewerId: data.viewerId, inviteCode: data.inviteCode, webUrl: data.webUrl }
  }

  private async firstTeam(): Promise<RawTeamRow | null> {
    return (await this.teamMeta()).team
  }

  // Appended to the team-scoped GETs so the daemon answers about the same
  // team the UI is showing (lib/api-access.js selectTeam). Omitted entirely
  // when nothing is selected, which keeps those URLs -- and their cache keys
  // -- byte-identical to what a single-team install always sent.
  private teamParam(prefix: '?' | '&'): string {
    return this.teamId ? `${prefix}teamId=${encodeURIComponent(this.teamId)}` : ''
  }

  // Settings' "Recheck" (see DataClient.forgetCachedReads). Same instrument
  // leaveTeam() reaches for, and for the same reason: the effect wanted here
  // spans several endpoints, so scoping by key would just be a list to forget
  // to update. The cost of over-clearing is at most a few requests the app was
  // about to make anyway; the cost of under-clearing is a button that lies.
  forgetCachedReads(): void {
    this.requestCache.clear()
  }

  selectedTeamId(): string | null {
    return this.teamId
  }

  selectTeam(teamId: string | null): void {
    if (this.teamId === teamId) return
    this.teamId = teamId
    // Every cached response was an answer about the OLD team. Not a
    // deleteMatching on some prefix: the team a request was about is not in
    // its URL for most of these (members, settings, status all derive it),
    // so nothing short of the whole cache is safe to keep.
    this.requestCache.clear()
    try {
      if (teamId) window.localStorage.setItem(SELECTED_TEAM_KEY, teamId)
      else window.localStorage.removeItem(SELECTED_TEAM_KEY)
    } catch {
      // A browser with storage disabled still switches for this session; the
      // choice just doesn't survive a reload. Silently losing persistence is
      // acceptable here, silently losing the switch would not be.
    }
  }

  async getTeamAccount(): Promise<TeamAccount> {
    const data = await this.teamAccountPayload()
    return {
      configured: data.configured,
      authenticated: data.authenticated,
      user: data.user,
      teams: data.teams.map(t => ({
        id: t.team_id,
        name: t.team_name,
        role: t.role,
        memberCount: typeof t.memberCount === 'number' ? t.memberCount : null,
      })),
      inviteCode: data.inviteCode,
      webUrl: data.webUrl,
      error: data.error,
    }
  }

  // Sign-in / sign-up / sign-out and team creation all change what
  // /api/status, /api/settings and /api/team answer, in ways no URL-keyed
  // rule could infer -- so each clears the whole request cache, the same
  // wide-effect handling leaveTeam() already uses.
  //
  // CREDENTIALS: `credentials.password` is forwarded to the local daemon in
  // this one request body and is never held, logged, retried, or echoed back.
  // The resolved value is the daemon's confirmed identity only.
  async signIn(credentials: { email: string; password: string }): Promise<{ email: string; displayName: string | null }> {
    const r = await postReadingError<{ email: string; displayName?: string | null }>('/api/team/login', {
      email: credentials.email, password: credentials.password,
    })
    this.requestCache.clear()
    return { email: r.email, displayName: r.displayName ?? null }
  }

  async signUp(credentials: { displayName: string; email: string; password: string }): Promise<SignUpResult> {
    const r = await postReadingError<{ emailExists?: boolean; needsConfirmation?: boolean; email: string }>('/api/team/signup', {
      email: credentials.email, password: credentials.password, displayName: credentials.displayName,
    })
    this.requestCache.clear()
    // emailExists is checked FIRST. The two are mutually exclusive coming out
    // of the daemon, and if a future one ever sent both, "this address is
    // taken" is the answer that leaves the user able to act.
    if (r.emailExists) return { status: 'email-exists', email: r.email }
    if (r.needsConfirmation) return { status: 'needs-confirmation', email: r.email }
    return { status: 'signed-in' }
  }

  async signOut(): Promise<SignOutResult> {
    const r = await postReadingError<{ authenticated: boolean; revoked?: boolean; revokeError?: string | null }>('/api/team/logout')
    this.requestCache.clear()
    // `revoked` FAILS CLOSED to false. A daemon too old to send the field has
    // not revoked anything -- it only deleted the local file -- so treating a
    // missing field as success would restore exactly the false assurance this
    // reports. Defaulting the other way is the security-relevant direction.
    return {
      revoked: r.revoked === true,
      revokeError: r.revoked === true ? null : (r.revokeError ?? null),
    }
  }

  // postReadingError, not post: every reason a join fails is a sentence the
  // backend already worded for a human ("this invite link has expired", "this
  // invite link has been revoked"), and it is the only thing the user can act
  // on. The generic post() would replace all of them with "404".
  async joinTeam(codeOrLink: string): Promise<{ id: string; name: string }> {
    const r = await postReadingError<{ team_id: string; team_name?: string | null }>(
      '/api/team/join', { inviteCode: codeOrLink },
    )
    // Team membership just changed: every cached read (status, team, members)
    // is now stale in a way the URL-keyed cache can't infer. Same clear
    // leaveTeam does for the mirror-image event.
    this.requestCache.clear()
    return { id: r.team_id, name: r.team_name ?? '' }
  }

  async renameTeam(teamId: string, name: string): Promise<void> {
    await postReadingError<{ name: string }>('/api/team/rename', { teamId, name })
    // The name is on the cached /api/team read that the rail, Settings and the
    // Team page all render from.
    this.requestCache.clear()
  }

  async rotateInviteCode(teamId: string): Promise<string> {
    const r = await postReadingError<{ inviteCode: string }>('/api/team/rotate-invite', { teamId })
    this.requestCache.clear()
    return String(r.inviteCode ?? '')
  }

  async createTeam(name: string): Promise<{ id: string; inviteCode: string | null }> {
    const r = await postReadingError<{ team_id: string; invite_code?: string | null }>('/api/team/create', { name })
    this.requestCache.clear()
    return { id: r.team_id, inviteCode: r.invite_code ?? null }
  }

  getStatus(): Promise<Status> {
    return this.requestCache.get('status', async () => normalizeStatus(await get<RawStatus>('/api/status')))
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

  /**
   * The "Happening now" strip's own endpoint: GET /api/live-sessions.
   *
   * WHY NOT feed() ANY MORE. This routed through the private feed() helper
   * above, which means the strip that says who is working right now dragged the
   * entire merged local+team feed page onto FIRST PAINT of the landing route,
   * and then re-dragged it every 10s for as long as the window stayed open
   * (useLiveSessions() is a LIVE query, queries.ts). Measured on Marco's
   * install, same method both sides:
   *
   *   /api/feed?limit=100   850ms, 2 backend round trips, 184,882 bytes/100 entries
   *   /api/live-sessions     39ms, 0 backend round trips,   4,668 bytes/1 row
   *
   * The 39ms holds whether the backend answers in 0ms or 250ms, because
   * liveSessionsPayload is synchronous by construction -- a polled read cannot
   * make a round trip. That is the property being bought here; the byte count
   * is a side effect.
   *
   * NOT A NARROWER ANSWER. Teammates still appear (served from the cache the
   * team sync already wrote), and the rows come out of the same unfiltered
   * buildEntries the feed uses, so an intent shown in this strip can never
   * disagree with the same session on the Feed screen.
   *
   * NO FALLBACK TO feed() ON 404, on purpose. The daemon serves this bundle
   * (app/main.js loads the dashboard over HTTP from the daemon itself), so the
   * UI and the endpoint ship together and cannot skew. A silent fallback would
   * buy nothing real and would hide the one failure worth seeing: the strip
   * quietly going back to an 850ms polled request would look like a fixed
   * screen that is slow again for no reason.
   *
   * Cache key is NOT under the 'feed:' prefix -- this is a different endpoint
   * with a different payload -- but invalidateFeedCache() clears it too, since
   * a sync can produce live rows this read has already cached.
   */
  async getLiveSessions(): Promise<LiveSession[]> {
    const payload = await this.requestCache.get(LIVE_SESSIONS_KEY, () =>
      get<{ sessions?: RawFeedEntry[] }>('/api/live-sessions'))
    // Array-checked rather than trusted, same as every other payload at this
    // boundary: an absent `sessions` must read as "nobody is working right
    // now", never throw over the whole landing route.
    const rows = Array.isArray(payload.sessions) ? payload.sessions : []
    // dedupeLiveSessions stays even though the endpoint already folds one row
    // per (author, session): the strip's grouping contract belongs to this
    // client, not to whichever endpoint happens to feed it.
    return dedupeLiveSessions(rows).map(mapLiveSession)
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
    return { entries: raw.entries.map(mapFeedEntry), nextBefore: raw.nextBefore ?? null, dayDigests: mapDayDigests(raw.dayDigests) }
  }

  async search(query: string, filters: FeedFilters, limit: number): Promise<SearchPage> {
    const q = query.trim()
    if (!q) return { query: '', total: 0, results: [] }
    const params = new URLSearchParams({ q, limit: String(limit) })
    // Same filter vocabulary as the feed, mapped to the search endpoint's
    // names: `source` is `tool` there (it matches the entry's source exactly,
    // where author/project are substring matches).
    if (filters.author) params.set('author', filters.author)
    if (filters.project) params.set('project', filters.project)
    if (filters.source) params.set('tool', filters.source)
    const raw = await get<RawSearchPayload>(`/api/search?${params.toString()}`)
    return {
      query: raw.query,
      total: raw.total,
      results: raw.results.map(r => ({
        ...mapFeedEntry(r),
        score: typeof r.score === 'number' ? r.score : 0,
        matched: Array.isArray(r.matched) ? r.matched : [],
      })),
    }
  }

  // Not routed through get(): a 404 here is a real page state (the session
  // was evicted or never existed), so it resolves null instead of throwing --
  // only non-404 failures reject and reach the retryable error affordance.
  async getSession(sessionId: string): Promise<Session | null> {
    const pathAndQuery = `/api/session?id=${encodeURIComponent(sessionId)}`
    const res = await fetch(`${BASE}${pathAndQuery}`, { headers: { accept: 'application/json' } })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`${pathAndQuery} failed: ${res.status}`)
    return mapSession(await res.json() as RawSessionPayload)
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

  // Archive/unarchive (Task 1's endpoints). A failure surfaces to the caller
  // (the daemon 404s an untracked path and 500s a failed strip) -- the UI
  // shows the inline error rather than optimistically hiding the row.
  async archiveProject(projectPath: string): Promise<void> {
    await post('/api/projects/archive', { path: projectPath })
  }

  async unarchiveProject(projectPath: string): Promise<void> {
    await post('/api/projects/unarchive', { path: projectPath })
  }

  // Deliberately NOT /api/projects/delete: the team-archive route
  // (lib/server.js archiveSharedProject) is what enforces the owner/manager
  // gate on a shared project and falls back to a plain local delete for an
  // unlinked path -- the ungated endpoint would let any member's UI delete a
  // shared project's local state with no role check at all.
  //
  // The body is RETURNED, not discarded: that handler answers 200 with
  // { archived: false, message } when it refuses a member's delete of a
  // shared project, and post() only throws on !res.ok -- so discarding it
  // reported a refusal as a completed destruction.
  async deleteProject(projectPath: string): Promise<DeleteProjectResult> {
    return post<DeleteProjectResult>('/api/team/archive-project', { path: projectPath })
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
    return get<AccessMatrix>(`/api/team/access-matrix${this.teamParam('?')}`)
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

  // GET /api/team/invites (lib/api-access.js readInvites). This used to
  // resolve [] unconditionally because no listing endpoint existed, which
  // meant an issued invite could never be reviewed and the revoke button --
  // which only ever appears on a listed row -- was unreachable.
  //
  // Revoked rows are dropped here rather than rendered struck through: the
  // section is "outstanding invites", and a revoked token is not one. They
  // stay readable in the audit trail, which is where a history belongs.
  async getInvites(): Promise<Invite[]> {
    const r = await get<{ invites: Invite[] }>(`/api/team/invites${this.teamParam('?')}`)
    return (r.invites ?? []).filter(i => !i.revoked)
  }

  // POST /api/team/invite (lib/teamsync.js createInvite) also returns
  // expires_at/max_uses/url, but url is the legacy /join/<token> path shape
  // (teamsync.inviteUrl -- the CLI/app/settings consumer), not the hash-based
  // shape the Members-page UI needs, so only the token is taken here; the
  // caller builds `${webUrl}/#${token}` itself.
  // INV-1: the caller always decides now -- see DataClient.ts's
  // createInviteLink header for why `options` is required rather than
  // optional. Passing 0 for either field is the explicit opt-out that
  // restores the old unlimited behaviour (lib/server.js's asLimit).
  async createInviteLink(teamId: string, options: InviteOptions): Promise<{ token: string }> {
    const inv = await post<{ token: string }>('/api/team/invite', { teamId, expiresDays: options.expiresDays, maxUses: options.maxUses })
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
    // Same reason as leaveTeam below: remove_member raises "only a team owner
    // or admin can remove members" and "the team owner cannot be removed"
    // (002:179). Both are answers the person clicking Remove needs to read.
    await postReadingError('/api/team/remove-member', { teamId: team.team_id, userId: memberId })
  }

  // GET /api/team/audit (lib/api-access.js readAudit) is also already wired
  // server-side -- found while adding the Task 9/10 contract test below,
  // same shipped-endpoint-dead-stub shape as getAccessMatrix. It wraps the
  // array in { events }, and each event already carries id/at/actorName/
  // action/objectType/objectLabel/detail matching AuditEvent verbatim, so
  // this only unwraps.
  async getAudit(limit?: number): Promise<AuditEvent[]> {
    const query = limit === undefined ? '' : `?limit=${limit}`
    const r = await get<{ events: (AuditEvent & { objectName?: string | null; targetName?: string | null })[] }>(
      `/api/team/audit${query}${this.teamParam(query ? '&' : '?')}`,
    )
    // objectName/targetName are newer than the rest of the row: an older
    // daemon omits them entirely, and `undefined` reaching the renderer would
    // read as "the daemon said there is no name" instead of "this daemon
    // cannot say". Normalized to null, which is what "none" means everywhere
    // else in this file.
    return (r.events ?? []).map(e => ({
      ...e,
      objectName: e.objectName ?? null,
      targetName: e.targetName ?? null,
    }))
  }

  // GET /api/team/my-data. The daemon answers {projects:[], total:0} rather
  // than an error when this machine is on no team, so there is nothing to
  // special-case here -- an empty preview is the honest answer to "what of
  // mine is on the backend" when the answer is nothing.
  async getMyData(): Promise<MyData> {
    const r = await get<MyData>(`/api/team/my-data${this.teamParam('?')}`)
    return { projects: r.projects ?? [], total: r.total ?? 0 }
  }

  // POST /api/team/delete-my-data. `confirm: 'DELETE'` is the daemon's own
  // second gate (it answers 400, not 403, without it) and is sent literally
  // here; it is NOT the user-facing confirmation, which happens in the UI
  // before this method is ever called.
  //
  // teamId is resolved rather than left to the daemon's firstTeamId() fallback
  // so that a machine on more than one team deletes from the team the user is
  // actually looking at -- the fallback would silently pick the first.
  async deleteMyData(projectId?: string | null): Promise<DeleteMyDataResult> {
    const teamId = this.selectedTeamId() ?? (await this.firstTeam())?.team_id
    if (!teamId) throw new Error('deleteMyData requires a team, and this machine is not on one.')
    return post<DeleteMyDataResult>('/api/team/delete-my-data', {
      teamId, projectId: projectId ?? null, confirm: 'DELETE',
    })
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
    return get<Insights>(`/api/team/insights?window=${window}${this.teamParam('&')}`)
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
    // postReadingError, not post: /api/team/leave is a POLICY gate, not just a
    // write. leave_team raises "the owner cannot leave their own team"
    // (045:96), the daemon's catch-all forwards that message in the 500 body,
    // and plain post() threw it away and reported "/api/team/leave failed:
    // 500" -- a refusal the system could explain exactly, rendered as an
    // unexplained server fault. Every other RPC-backed team mutation here
    // (rename, rotate, create, join) already reads the body; this one was the
    // holdout.
    await postReadingError<{ left: boolean }>('/api/team/leave', { teamId })
    // Wide-reaching effect (this machine's team membership just changed) that
    // the request cache can't infer from the URL alone -- clear it all
    // rather than risk a stale team/status read for the rest of the TTL.
    this.requestCache.clear()
  }

  async transferOwnership(teamId: string, userId: string): Promise<void> {
    // Every refusal here is one the person needs to read verbatim -- "only the
    // team owner can transfer ownership", "that person is not a member of this
    // team" -- so the body is kept, like every other RPC-backed team mutation.
    await postReadingError<{ transferred: boolean }>('/api/team/transfer-ownership', { teamId, userId })
    // The caller's OWN role just changed from owner to admin, which gates
    // controls across Settings, the members list and the rail. Nothing in the
    // URL tells the cache that, so clear it wholesale rather than serve an
    // owner-shaped UI to someone who is now an admin.
    this.requestCache.clear()
  }

  async disbandTeam(teamId: string): Promise<void> {
    await postReadingError<{ disbanded: boolean }>('/api/team/disband', { teamId })
    // The team this machine was reading from no longer exists. Same reasoning
    // as leaveTeam, one step further: every cached team-scoped read is now
    // about something deleted.
    this.requestCache.clear()
  }

  // GET /api/scan (lib/server.js scanPayload). Tolerant at the boundary the
  // same way every other raw payload is: a row with no path is dropped rather
  // than rendered as a nameless checkbox that adopts nothing.
  async discoverProjects(): Promise<DiscoveredProject[]> {
    const payload = await get<{ projects?: RawScanProject[] }>('/api/scan')
    return (payload.projects ?? [])
      .map(raw => ({
        path: String(raw.path ?? ''),
        name: String(raw.name ?? '') || String(raw.path ?? '').split('/').filter(Boolean).pop() || '',
        tracked: !!raw.tracked,
        sessionCount: Number(raw.sessionCount ?? 0),
        // bySource is { 'Claude Code': 12, Codex: 3 } -- the UI only ever
        // names the tools, so the counts are dropped here rather than
        // carried through the whole UI unused.
        tools: Object.keys(raw.bySource ?? {}),
      }))
      .filter(p => p.path !== '')
  }

  // POST /api/projects/adopt. postReadingError, not post: the daemon answers
  // 400 with { error } text ("paths required", "not a directory") that is the
  // only actionable thing the user gets back.
  adoptProjects(paths: string[]): Promise<AdoptResult> {
    return postReadingError<AdoptResult>('/api/projects/adopt', { paths })
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
