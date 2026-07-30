import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { syncStateOf, LocalDaemonClient } from './LocalDaemonClient'

// Finding 1: the Today screen mounts useProjects() + useLiveSessions()
// together, and useLiveSessions() re-polls every 10s -- both used to fire
// their own independent /api/feed request. These tests drive the real
// fetch-counting behavior a browser would see, not the cache's internals.
describe('LocalDaemonClient feed coalescing', () => {
  const emptyFeed = { entries: [] }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function stubFetch() {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).startsWith('/api/projects') ? [] : emptyFeed),
    }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  const feedCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/feed')).length

  it('fires exactly one /api/feed request when getProjects() and getLiveSessions() run concurrently', async () => {
    const fetchMock = stubFetch()
    const client = new LocalDaemonClient()

    await Promise.all([client.getProjects(), client.getLiveSessions()])

    // getProjects() also hits /api/projects, so the /api/feed count -- not
    // the total call count -- is what proves the coalescing.
    expect(feedCalls(fetchMock)).toBe(1)
  })

  it('refetches once the TTL has elapsed', async () => {
    const fetchMock = stubFetch()
    const client = new LocalDaemonClient()

    await client.getLiveSessions()
    expect(feedCalls(fetchMock)).toBe(1)

    await client.getLiveSessions()
    expect(feedCalls(fetchMock)).toBe(1) // still within TTL -- cached

    vi.advanceTimersByTime(5001) // just past FEED_CACHE_TTL_MS
    await client.getLiveSessions()
    expect(feedCalls(fetchMock)).toBe(2)
  })

  it('invalidates the cache on syncProject so the next read is fresh', async () => {
    const fetchMock = stubFetch()
    const client = new LocalDaemonClient()

    await client.getLiveSessions()
    expect(feedCalls(fetchMock)).toBe(1)

    await client.syncProject('/Users/x/membridge')
    await client.getLiveSessions()
    expect(feedCalls(fetchMock)).toBe(2) // invalidated, not waiting out the TTL
  })
})

// Finding 2: every screen mounts useStatus() + useSettings() together (Shell
// always does, and most feature pages call both directly too), and
// getSettings() independently re-fetches /api/status and /api/team inside
// itself -- so every screen used to fire /api/status and /api/team TWICE
// each on mount. These tests drive the real fetch-counting behavior a
// browser would see, same approach as the feed-coalescing tests above.
describe('LocalDaemonClient status/team coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const fakeStatus = {
    running: true, version: '0.1.7', solo: true, setupDone: true, projectCount: 0,
    lastSync: null, teamLastSync: null, tools: [],
    encryption: { enabled: true, plaintextOff: true, paused: null, keyAlerts: 0 },
    auth: { paused: null, detail: null, since: null },
  }
  const fakeSettingsRaw = {
    intervalSec: 300, hookInstalled: true, distill: { enabled: true },
    startAtLogin: true, daemonPort: 7391, updateAvailable: null,
    redactExtra: [], exclude: [], targets: [], extraTargets: {}, extraTargetFiles: {},
  }

  function stubFetch() {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => {
        const u = String(url)
        if (u.startsWith('/api/team/members')) return { members: [] }
        if (u.startsWith('/api/team/feed')) return { entries: [] }
        if (u.startsWith('/api/team')) return { teams: [], viewerId: null, inviteCode: null }
        if (u.startsWith('/api/status')) return fakeStatus
        if (u.startsWith('/api/settings')) return fakeSettingsRaw
        if (u.startsWith('/api/feed')) return { entries: [] }
        return {}
      },
    }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  const callsTo = (fetchMock: ReturnType<typeof vi.fn>, prefix: string) =>
    fetchMock.mock.calls.filter(([url]) => String(url).startsWith(prefix)).length

  it('fires exactly one /api/status request when getStatus() and getSettings() run concurrently', async () => {
    const fetchMock = stubFetch()
    const client = new LocalDaemonClient()

    await Promise.all([client.getStatus(), client.getSettings()])

    expect(callsTo(fetchMock, '/api/status')).toBe(1)
  })

  it('fires exactly one /api/team request when getMembers() and getSettings() run concurrently', async () => {
    const fetchMock = stubFetch()
    const client = new LocalDaemonClient()

    await Promise.all([client.getMembers(), client.getSettings()])

    expect(callsTo(fetchMock, '/api/team')).toBe(1)
  })

  it('clears the cache on leaveTeam so the next read is fresh', async () => {
    const fetchMock = stubFetch()
    const client = new LocalDaemonClient()

    await client.getStatus()
    expect(callsTo(fetchMock, '/api/status')).toBe(1)

    await client.leaveTeam('team-1')
    await client.getStatus()
    expect(callsTo(fetchMock, '/api/status')).toBe(2)
  })
})

describe('LocalDaemonClient capabilities', () => {
  // teamAdminSupported says the daemon transport CAN carry admin calls -- it
  // is not, and must never be read as, permission for the current viewer to
  // make them. Authorization is Settings.team.role, gated in Shell.tsx.
  it('reports teamAdminSupported as transport support only', () => {
    expect(new LocalDaemonClient().capabilities.teamAdminSupported).toBe(true)
  })
})

describe('syncStateOf', () => {
  it('is paused when the project is paused, regardless of timestamps', () => {
    expect(syncStateOf({ paused: true, lastSync: null, lastActivity: '2026-07-29T00:00:00Z' })).toEqual({ state: 'paused' })
  })
  it('is behind when activity postdates the last sync', () => {
    expect(syncStateOf({ paused: false, lastSync: '2026-07-23T10:00:00Z', lastActivity: '2026-07-29T08:00:00Z' }))
      .toEqual({ state: 'behind', lastSyncedAt: '2026-07-23T10:00:00Z' })
  })
  it('is behind when there has never been a sync but there is activity', () => {
    expect(syncStateOf({ paused: false, lastSync: null, lastActivity: '2026-07-29T08:00:00Z' }))
      .toEqual({ state: 'behind', lastSyncedAt: null })
  })
  it('is up to date when the last sync is at or after the last activity', () => {
    expect(syncStateOf({ paused: false, lastSync: '2026-07-29T09:00:00Z', lastActivity: '2026-07-29T08:00:00Z' }))
      .toEqual({ state: 'up-to-date' })
  })
  it('is up to date for a project with no activity at all', () => {
    expect(syncStateOf({ paused: false, lastSync: null, lastActivity: null })).toEqual({ state: 'up-to-date' })
  })
})

// Task 7 Finding 3: Today's solo stat must read the real ledger, not a
// session-count proxy. getSkeletonStats() hits /api/savings directly and
// folds the response through mappers.skeletonStatsFrom (tested on its own
// in mappers.test.ts) -- this just proves the endpoint and the fold are
// actually wired together.
describe('LocalDaemonClient.getSkeletonStats', () => {
  function stubSavings(body: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads /api/savings and folds totals into repeatOpens/answeredFirst', async () => {
    stubSavings({
      totals: {
        reads: { first: 900, sameSession: 700, crossSession: 504 },
        avoided: { tokens: 50000, serves: 818, tierA: 400, tierB: 418, partialWins: 0, netNegatives: 0 },
      },
    })
    const stats = await new LocalDaemonClient().getSkeletonStats()
    expect(stats).toEqual({ available: true, repeatOpens: 1204, answeredFirst: 818 })
  })

  it('is unavailable when the ledger has no reads/avoided yet', async () => {
    stubSavings({ totals: {} })
    const stats = await new LocalDaemonClient().getSkeletonStats()
    expect(stats).toEqual({ available: false })
  })
})

// Finding: getInsights used to reject with the "Task 12" stub message even
// after GET /api/team/insights shipped (lib/api-insights.js, wired in
// lib/server.js since 98546a1) -- no test caught it because every other
// InsightsPage test drives FakeDataClient, which always answers. This test
// drives a REAL LocalDaemonClient against a realistic daemon response (every
// field lib/api-insights.js's insightsPayload actually returns) and checks
// the result end to end: the right URL is requested, and every field lands
// in the typed Insights result unmapped-but-verified, not just "didn't
// throw".
describe('LocalDaemonClient.getInsights', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const rawInsights = {
    window: 30,
    sessions: { count: 412, deltaPct: 18 },
    membersSyncing: { ok: 2, total: 3 },
    entriesShared: { count: 187, delta: 31 },
    skeleton: { available: true, repeatOpens: 1204, answeredFirst: 818 },
    assists: { available: true, total: 876, byKind: { recallServed: 818, teammateNotes: 46, mcpQueries: 12 } },
    perPerson: [{ id: 'me', name: 'Marco', sessions: 214, shared: 205 }],
    topProjects: [{ name: 'membridge', sessions: 184, people: 3 }],
    problems: [
      { id: 'silent:sarah', severity: 'broken', headline: 'Nothing has arrived from Sarah', scale: '1 of 2 teammates · joined 3d ago · 0 entries shared', action: null },
    ],
    concentration: [{ projectName: 'billing-poc', onlyPerson: 'Andrew', detail: 'only Andrew has worked on this project in the last 30d' }],
    byTool: [{ tool: 'Claude Code', sessions: 268 }],
  }

  function stubInsights(body: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('requests the window-scoped endpoint and returns every field verbatim', async () => {
    const fetchMock = stubInsights(rawInsights)
    const insights = await new LocalDaemonClient().getInsights(30)

    expect(fetchMock).toHaveBeenCalledWith('/api/team/insights?window=30', expect.anything())
    expect(insights).toEqual(rawInsights)
  })

  it('passes a different window straight through to the query string', async () => {
    const fetchMock = stubInsights({ ...rawInsights, window: 7 })
    await new LocalDaemonClient().getInsights(7)

    expect(fetchMock).toHaveBeenCalledWith('/api/team/insights?window=7', expect.anything())
  })
})
