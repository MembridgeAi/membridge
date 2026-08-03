import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import type { LiveSession, Project } from '../../data/types'
import { TodayPage, lastTeamSyncLabel, projectsThisWeek, skeletonPercentLabel, todayDateLabel } from './TodayPage'

// Fixture factory for a Project row, used by the "Projects · this week"
// tests below -- only the fields each test actually varies are overridden.
function project(overrides: Partial<Project> = {}): Project {
  return {
    path: '/x/p', name: 'p', exists: true, archived: false, missing: false, paused: false,
    lastSync: '2026-07-29T19:00:00Z', lastActivity: '2026-07-29T19:00:00Z',
    sessionsTotal: 10, tools: ['Claude Code'], shared: false, memberIds: ['me'],
    sessionsThisWeek: 1, dailyCounts: [0, 0, 0, 0, 0, 0, 1],
    latestSummary: null, sync: { state: 'up-to-date' },
    ...overrides,
  }
}

// A teammate who does not share prompts has no captured ask at all, so this
// row rendered as a bare name and a clock -- the single most-looked-at screen
// saying nothing about what they are doing.
describe('Happening now: a session with no captured intent', () => {
  it('falls back to what the session has landed', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getLiveSessions').mockResolvedValue([
      liveSession({ author: 'Andrew Brown', authorId: 'andrew', intent: null, outcome: 'Windows builds broken since 29 Jul' }),
    ])
    renderWith(client, <TodayPage />)
    expect(await screen.findByText('Windows builds broken since 29 Jul')).toBeInTheDocument()
    // Not dressed up as an intent -- that label would be an inference.
    expect(screen.queryByText('Intent')).toBeNull()
  })

  it('renders nothing extra when there is neither intent nor outcome', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getLiveSessions').mockResolvedValue([
      liveSession({ author: 'Andrew Brown', authorId: 'andrew', intent: null, outcome: null }),
    ])
    renderWith(client, <TodayPage />)
    const row = await screen.findByTestId('live-entry')
    expect(row.querySelector('.live-entry-intent')).toBeNull()
    expect(row.querySelector('.live-entry-outcome')).toBeNull()
  })

  it('prefers a real captured intent over the outcome fallback', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getLiveSessions').mockResolvedValue([
      liveSession({ intent: 'wire the search endpoint', outcome: 'Search endpoint wired' }),
    ])
    renderWith(client, <TodayPage />)
    expect(await screen.findByText('wire the search endpoint')).toBeInTheDocument()
    expect(screen.queryByText('Search endpoint wired')).toBeNull()
  })
})

// Fixture factory for a LiveSession, used by the "Happening now" grouping
// tests below (FIX 1c).
function liveSession(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    id: 's1', author: 'You', authorId: 'me', tool: 'Claude Code', projectName: 'membridge',
    startedAt: '2026-07-29T20:00:00Z', intent: null, outcome: null, ...overrides,
  }
}

// Both fixture clients below override only the one method each block of
// tests needs, so they can hand TodayPage a project/live-session list the
// shared FakeDataClient fixture can't express (empty this-week activity,
// nine live sessions, etc.) without touching that shared fixture at all.
class ProjectsFixtureClient extends FakeDataClient {
  constructor(private fixture: Project[]) { super({}) }
  getProjects() { return Promise.resolve(this.fixture) }
}
class LiveSessionsFixtureClient extends FakeDataClient {
  constructor(private fixture: LiveSession[]) { super({}) }
  getLiveSessions() { return Promise.resolve(this.fixture) }
}

// Scopes a StatStrip assertion to the cell for one label, so "1" or "68%"
// is checked against the right stat, not just anywhere on the page.
async function statCell(label: string): Promise<HTMLElement> {
  const labelEl = await screen.findByText(label)
  const cell = labelEl.closest('.stat-cell')
  if (!cell) throw new Error(`no .stat-cell ancestor for label "${label}"`)
  return cell as HTMLElement
}

// The label can render before its value has finished loading (the stat
// strip's solo/team branch decides on statusQuery, the values on their own
// separate queries) -- findByText, not getByText, so this waits out that gap
// instead of racing it.
async function expectStatValue(label: string, value: string): Promise<void> {
  const cell = await statCell(label)
  expect(await within(cell).findByText(value)).toBeInTheDocument()
}

describe('TodayPage', () => {
  it('labels a live session with its captured intent', async () => {
    renderApp({}, <TodayPage />)
    expect(await screen.findByText(/make the summary hook fire on session boundaries/)).toBeInTheDocument()
    expect(screen.getAllByText('Intent').length).toBeGreaterThan(0)
  })

  it('spells out the session window', async () => {
    renderApp({}, <TodayPage />)
    expect(await screen.findByText('31 sessions · last 7 days')).toBeInTheDocument()
    expect(screen.queryByText(/· 7d$/)).toBeNull()
  })

  it('gives a Sync now button only to a behind project', async () => {
    renderApp({}, <TodayPage />)
    const rows = await screen.findAllByTestId('project-row')
    const upToDate = rows.find(r => within(r).queryByText('✓ up to date'))!
    const behind = rows.find(r => within(r).queryByText(/behind/))!
    expect(within(upToDate).queryByRole('button', { name: 'Sync now' })).toBeNull()
    expect(within(behind).getByRole('button', { name: 'Sync now' })).toBeInTheDocument()
  })

  it('renders an empty state without crashing', async () => {
    renderApp({ empty: true }, <TodayPage />)
    expect(await screen.findByText(/no projects yet/i)).toBeInTheDocument()
  })

  it('surfaces a load failure instead of rendering a blank page', async () => {
    renderApp({ failWith: 'daemon unreachable' }, <TodayPage />)
    expect(await screen.findByText(/couldn't reach/i)).toBeInTheDocument()
  })

  it('omits team-only stats in solo mode', async () => {
    renderApp({ solo: true }, <TodayPage />)
    await screen.findByText(/sessions · last 24h/i)
    expect(screen.queryByText(/updates shared/i)).toBeNull()
    expect(screen.queryByText(/last team sync/i)).toBeNull()
  })

  // Fix 5: dailyCounts[6] is a ROLLING 24h bucket (lib/server.js
  // dailySessionBuckets: "Rolling 24h buckets (not calendar days)"), so
  // calling it "sessions today" overstated what it measures.
  it('labels the sessions stat as a rolling 24h window, never "today"', async () => {
    renderApp({}, <TodayPage />)
    await statCell('sessions · last 24h')
    expect(screen.queryByText(/sessions today/i)).toBeNull()
  })

  // Fix 4: the "N live now" stat and the "Happening now" rows must be one
  // set (mappers.ts: "the count and the dots one set") -- the rows render
  // GROUPED person+project goals, so the count reads the same groups, not
  // the raw session list.
  it('counts live now as the grouped rows on screen, not raw sessions', async () => {
    // Two live sessions, same person, same project -> ONE row on screen.
    const sessions = [liveSession({ id: 's1' }), liveSession({ id: 's2' })]
    renderWith(new LiveSessionsFixtureClient(sessions), <TodayPage />)
    expect(await screen.findAllByTestId('live-entry')).toHaveLength(1)
    await expectStatValue('live now', '1')
  })

  // Fix 9: the header Sync now button reflects its mutation's state instead
  // of looking dead while a sync runs or silently swallowing a failure.
  it('disables the header sync button and says Syncing… while the sync runs', async () => {
    class HangingSyncClient extends FakeDataClient {
      syncAll() { return new Promise<void>(() => {}) } // never settles
    }
    renderWith(new HangingSyncClient(), <TodayPage />)
    const header = (await screen.findByText('Today')).closest('.today-header') as HTMLElement
    await userEvent.click(within(header).getByRole('button', { name: 'Sync now' }))
    const pending = within(header).getByRole('button', { name: 'Syncing…' })
    expect(pending).toBeDisabled()
  })

  it('surfaces a failed sync-all instead of looking like nothing happened', async () => {
    class FailingSyncClient extends FakeDataClient {
      syncAll() { return Promise.reject(new Error('sync exploded')) }
    }
    renderWith(new FailingSyncClient(), <TodayPage />)
    const header = (await screen.findByText('Today')).closest('.today-header') as HTMLElement
    await userEvent.click(within(header).getByRole('button', { name: 'Sync now' }))
    const alert = await screen.findByText(/couldn't sync/i)
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert.textContent).toContain('sync exploded')
  })

  it('surfaces a failed per-project sync from a behind row', async () => {
    class FailingProjectSyncClient extends FakeDataClient {
      syncProject() { return Promise.reject(new Error('project sync exploded')) }
    }
    renderWith(new FailingProjectSyncClient(), <TodayPage />)
    const rows = await screen.findAllByTestId('project-row')
    const behind = rows.find(r => within(r).queryByText(/behind/))!
    await userEvent.click(within(behind).getByRole('button', { name: 'Sync now' }))
    const alert = await screen.findByText(/couldn't sync/i)
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert.textContent).toContain('project sync exploded')
  })

  // FINDING 1: a naive count of every project with a latestSummary would be
  // 2 -- FakeDataClient's fixture gives BOTH membridge (shared) and sublease
  // (private) a latestSummary. Only membridge may count toward a
  // team-labelled stat, so the correct total is 1, not 2.
  it('counts updates shared only from shared projects, excluding a private project with its own summary', async () => {
    renderApp({}, <TodayPage />)
    await expectStatValue('updates shared', '1')
  })

  // FINDING 2: the old per-member synced count is gone (no per-member sync
  // state exists on the wire); "last team sync" reads status.teamLastSync directly.
  describe('lastTeamSyncLabel', () => {
    const NOW = new Date('2026-07-29T23:00:00Z').getTime()
    it('is "never" when the team has not synced', () => {
      expect(lastTeamSyncLabel(null, NOW)).toBe('never')
    })
    it('renders whole hours elapsed', () => {
      expect(lastTeamSyncLabel('2026-07-29T21:00:00Z', NOW)).toBe('2h ago')
    })
    it('renders whole days elapsed', () => {
      expect(lastTeamSyncLabel('2026-07-27T23:00:00Z', NOW)).toBe('2d ago')
    })
    it('renders "just now" under a minute', () => {
      expect(lastTeamSyncLabel('2026-07-29T22:59:30Z', NOW)).toBe('just now')
    })
  })

  it('shows last team sync as a relative label built from status.teamLastSync', async () => {
    renderApp({}, <TodayPage />)
    // Computed with the real clock, same as the component -- this proves the
    // wiring (status.teamLastSync -> the rendered stat), while the exact
    // arithmetic is covered by the lastTeamSyncLabel unit tests above.
    const expected = lastTeamSyncLabel('2026-07-29T21:00:00Z')
    await expectStatValue('last team sync', expected)
  })

  it('shows never for last team sync when the team has not synced yet', async () => {
    renderApp({ teamLastSync: null }, <TodayPage />)
    await expectStatValue('last team sync', 'never')
  })

  // FINDING 3: the solo effectiveness stat comes from the real /api/savings
  // ledger (getSkeletonStats), not a session-count proxy, and must never
  // substitute a computed number when the ledger has nothing yet.
  describe('skeletonPercentLabel', () => {
    it('renders the exact rounded percentage when the ledger has data', () => {
      expect(skeletonPercentLabel({ available: true, repeatOpens: 1204, answeredFirst: 818 })).toBe('68%')
    })
    it('renders the literal word pending, never a computed stand-in, when unavailable', () => {
      expect(skeletonPercentLabel({ available: false })).toBe('pending')
    })
  })

  it('renders the skeleton stat as a percentage when the ledger has data', async () => {
    renderApp({ solo: true }, <TodayPage />)
    await expectStatValue('repeat opens answered by memory', '68%')
  })

  it('renders pending -- never a computed stand-in -- when the ledger has no data yet', async () => {
    renderApp({ solo: true, skeletonAvailable: false }, <TodayPage />)
    await expectStatValue('repeat opens answered by memory', 'pending')
  })

  // FINDING 4: no whole-account digest endpoint exists (only per-project
  // POST /api/projects/copy), so the digest-copy button must not render here.
  it('has no whole-account digest-copy control on Today', async () => {
    renderApp({}, <TodayPage />)
    await screen.findByText('Today')
    expect(screen.queryByRole('button', { name: /copy for ai/i })).toBeNull()
    expect(screen.queryByText(/copy for ai/i)).toBeNull()
  })

  // FINDING 5: the header date is the viewer's local calendar day, no comma.
  // The suite is pinned to America/Los_Angeles (vite.config.ts, test.env.TZ).
  describe('todayDateLabel', () => {
    it('formats weekday/month/day from local fields with no comma', () => {
      expect(todayDateLabel(new Date('2026-07-29T23:30:00Z'))).toBe('Wed Jul 29')
    })
    it('still reads today in the evening, when UTC has already rolled over', () => {
      // 02:00Z Jul 30 is 19:00 Jul 29 in Los Angeles. Reading UTC fields put
      // TOMORROW's date in the header every evening west of Greenwich --
      // the first thing anyone opening the app after 17:00 noticed.
      expect(todayDateLabel(new Date('2026-07-30T02:00:00Z'))).toBe('Wed Jul 29')
    })
  })

  it('renders the header date with no comma', async () => {
    renderApp({}, <TodayPage />)
    const dateEl = await screen.findByText(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}$/)
    expect(dateEl).toBeInTheDocument()
    expect(dateEl.textContent).not.toContain(',')
  })

  // FIX 1c: "Happening now" groups by person + project so a goal doesn't
  // repeat once per live session.
  describe('Happening now grouping', () => {
    it('collapses nine sessions with no intent into one row, with no intent line and no "(not captured)" anywhere', async () => {
      const sessions = Array.from({ length: 9 }, (_, i) => liveSession({ id: `s${i}` }))
      renderWith(new LiveSessionsFixtureClient(sessions), <TodayPage />)
      const rows = await screen.findAllByTestId('live-entry')
      expect(rows).toHaveLength(1)
      expect(screen.queryByText('Intent')).toBeNull()
      expect(screen.queryByText(/not captured/i)).toBeNull()
    })

    it('shows the one real intent in a group where only one of several sessions captured it', async () => {
      const sessions = [liveSession({ id: 's1', intent: 'ship the invite flow' }), liveSession({ id: 's2', intent: null })]
      renderWith(new LiveSessionsFixtureClient(sessions), <TodayPage />)
      expect(await screen.findByText('ship the invite flow')).toBeInTheDocument()
      expect(await screen.findAllByTestId('live-entry')).toHaveLength(1)
    })

    it('keeps two different projects as two separate rows', async () => {
      const sessions = [liveSession({ id: 's1', projectName: 'membridge' }), liveSession({ id: 's2', projectName: 'sublease' })]
      renderWith(new LiveSessionsFixtureClient(sessions), <TodayPage />)
      expect(await screen.findAllByTestId('live-entry')).toHaveLength(2)
    })

    it('shows the session count only when more than one session shares the goal', async () => {
      const sessions = [liveSession({ id: 's1' }), liveSession({ id: 's2' })]
      renderWith(new LiveSessionsFixtureClient(sessions), <TodayPage />)
      expect(await screen.findByText('2 sessions')).toBeInTheDocument()
    })

    it('omits the session count for a single live session', async () => {
      renderWith(new LiveSessionsFixtureClient([liveSession({ id: 's1' })]), <TodayPage />)
      await screen.findAllByTestId('live-entry')
      expect(screen.queryByText(/\d+ sessions$/)).toBeNull()
    })
  })

  // FIX 2: "Projects · this week" must mean this week.
  describe('projectsThisWeek', () => {
    it('drops a project with no sessions this week', () => {
      const active = project({ path: '/a', name: 'active', sessionsThisWeek: 3 })
      const idle = project({ path: '/b', name: 'idle', sessionsThisWeek: 0 })
      expect(projectsThisWeek([active, idle])).toEqual([active])
    })

    it('orders by most recent activity first', () => {
      const older = project({ path: '/a', name: 'older', sessionsThisWeek: 2, lastActivity: '2026-07-27T00:00:00Z' })
      const newer = project({ path: '/b', name: 'newer', sessionsThisWeek: 2, lastActivity: '2026-07-29T00:00:00Z' })
      expect(projectsThisWeek([older, newer]).map(p => p.name)).toEqual(['newer', 'older'])
    })

    it('keeps a project that is behind on sync as long as it has activity this week', () => {
      const behind = project({ path: '/a', name: 'behind', sessionsThisWeek: 2, sync: { state: 'behind', lastSyncedAt: '2026-07-20T00:00:00Z' } })
      expect(projectsThisWeek([behind])).toEqual([behind])
    })
  })

  it('shows only projects with activity this week in the Projects section', async () => {
    const client = new ProjectsFixtureClient([
      project({ path: '/a', name: 'active-proj', sessionsThisWeek: 5, lastActivity: '2026-07-29T10:00:00Z' }),
      project({ path: '/b', name: 'idle-proj', sessionsThisWeek: 0, lastActivity: '2026-07-01T10:00:00Z' }),
    ])
    renderWith(client, <TodayPage />)
    expect(await screen.findByText('active-proj')).toBeInTheDocument()
    expect(screen.queryByText('idle-proj')).toBeNull()
  })

  it('renders an honest empty line, not an empty section, when no project has activity this week', async () => {
    const client = new ProjectsFixtureClient([project({ path: '/a', name: 'idle', sessionsThisWeek: 0 })])
    renderWith(client, <TodayPage />)
    expect(await screen.findByText('No project activity in the last 7 days.')).toBeInTheDocument()
    expect(screen.queryByTestId('project-row')).toBeNull()
  })
})

// The card is the most-looked-at thing on the most-looked-at screen, and it
// was a dead end: it named a person and their work and went nowhere.
describe('Happening now: the card links to that session in the feed', () => {
  it('links to the feed targeting the newest session in the group', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getLiveSessions').mockResolvedValue([
      liveSession({ id: 'sess-older', author: 'Marco', authorId: 'marco', startedAt: '2026-07-29T19:00:00Z' }),
      liveSession({ id: 'sess-newest', author: 'Marco', authorId: 'marco', startedAt: '2026-07-29T21:00:00Z' }),
    ])
    renderWith(client, <TodayPage />)
    const row = await screen.findByTestId('live-entry')
    const link = row.closest('a') || row.querySelector('a')
    expect(link).not.toBeNull()
    expect(link!.getAttribute('href')).toBe('/feed?session=sess-newest')
  })
})
