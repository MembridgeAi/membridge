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
