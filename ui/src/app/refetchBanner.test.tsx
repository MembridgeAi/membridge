// P0 Fix 1: a refetch failure on a page that already has data must NOT blank
// the screen. react-query v5 sets isError=true on a failed background
// refetch even when cached data is still present, and every one of these
// pages polls (status/live every 10s) -- so a single daemon hiccup
// (including the user pressing Settings -> Restart daemon) replaced a fully
// populated screen with a full-page error. The rule, taken from FeedPage
// (which already did this right): the full error page renders only when a
// failed query has NO data at all; a failure with cached data renders the
// data plus a non-destructive inline "can't reach the daemon" banner.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { DataClient } from '../data/DataClient'
import { DataClientProvider } from '../data/DataClientProvider'
import { FakeDataClient } from '../data/FakeDataClient'
import { TodayPage } from '../features/today/TodayPage'
import { ProjectsPage } from '../features/projects/ProjectsPage'
import { ProjectPage } from '../features/project/ProjectPage'
import { TeamPage } from '../features/team/TeamPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { InsightsPage } from '../features/insights/InsightsPage'

// Both now name the product, not the implementation ("daemon"): BANNER is the
// shared inline DaemonError banner (renamed with the Team work); FULL_PAGE_ERROR
// is the per-page blocking headline (renamed with the full-page-error work).
const BANNER = /can't reach membridge, retrying/i
const FULL_PAGE_ERROR = /couldn't reach membridge/i

/** Wraps a FakeDataClient so every read starts failing on demand -- the
 *  "daemon just went away mid-session" switch. Only get* methods fail;
 *  nothing here needs mutations to. */
function flakyClient(): { client: DataClient; fail: () => void } {
  const base = new FakeDataClient()
  let failing = false
  const client = new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (failing && String(prop).startsWith('get')) {
          return Promise.reject(new Error('daemon unreachable'))
        }
        return value.apply(target, args)
      }
    },
  }) as DataClient
  return { client, fail: () => { failing = true } }
}

function renderPage(ui: ReactNode) {
  const { client, fail } = flakyClient()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <DataClientProvider client={client}>{ui}</DataClientProvider>
    </QueryClientProvider>,
  )
  // refetchQueries({ type: 'active' }) stands in for the 10s poll tick /
  // window refocus that refires every mounted query at once.
  const refetchAll = async () => {
    fail()
    await qc.refetchQueries({ type: 'active' })
  }
  return { refetchAll }
}

afterEach(cleanup)

describe('a refetch failure with cached data keeps the page, adds a banner (P0 Fix 1)', () => {
  it('Today keeps its populated screen', async () => {
    const { refetchAll } = renderPage(<TodayPage />)
    await screen.findAllByTestId('project-row')
    await refetchAll()
    expect(await screen.findByText(BANNER)).toBeInTheDocument()
    expect(screen.getAllByTestId('project-row').length).toBeGreaterThan(0)
    expect(screen.queryByText(FULL_PAGE_ERROR)).toBeNull()
  })

  it('Projects keeps its populated grid', async () => {
    const { refetchAll } = renderPage(<ProjectsPage />)
    await screen.findByTestId('project-row-membridge')
    await refetchAll()
    expect(await screen.findByText(BANNER)).toBeInTheDocument()
    expect(screen.getByTestId('project-row-membridge')).toBeInTheDocument()
    expect(screen.queryByText(FULL_PAGE_ERROR)).toBeNull()
  })

  it('the project page keeps its stream', async () => {
    const { refetchAll } = renderPage(<ProjectPage slug={encodeURIComponent('/Users/x/membridge')} />)
    await screen.findByRole('heading', { name: 'membridge' })
    await refetchAll()
    expect(await screen.findByText(BANNER)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'membridge' })).toBeInTheDocument()
    expect(screen.queryByText(FULL_PAGE_ERROR)).toBeNull()
  })

  it('the Team page People section keeps its member list', async () => {
    const { refetchAll } = renderPage(<TeamPage />)
    await screen.findByTestId('member-row-andrew')
    await refetchAll()
    expect(await screen.findByText(BANNER)).toBeInTheDocument()
    expect(screen.getByTestId('member-row-andrew')).toBeInTheDocument()
    expect(screen.queryByText(FULL_PAGE_ERROR)).toBeNull()
  })

  it('Settings keeps its controls', async () => {
    const { refetchAll } = renderPage(<SettingsPage />)
    await screen.findByText('Memory delivery')
    await refetchAll()
    expect(await screen.findByText(BANNER)).toBeInTheDocument()
    expect(screen.getByText('Memory delivery')).toBeInTheDocument()
    expect(screen.queryByText(FULL_PAGE_ERROR)).toBeNull()
  })

  it('Insights keeps its stats', async () => {
    const { refetchAll } = renderPage(<InsightsPage />)
    await screen.findByText('times memory helped')
    await refetchAll()
    expect((await screen.findAllByText(BANNER)).length).toBeGreaterThan(0)
    expect(screen.getByText('times memory helped')).toBeInTheDocument()
    expect(screen.queryByText(FULL_PAGE_ERROR)).toBeNull()
  })

  it('still shows the full error page when a query fails with no data at all', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <DataClientProvider client={new FakeDataClient({ failWith: 'daemon unreachable' })}>
          <TodayPage />
        </DataClientProvider>
      </QueryClientProvider>,
    )
    expect(await screen.findByText(FULL_PAGE_ERROR)).toBeInTheDocument()
    expect(screen.queryByText(BANNER)).toBeNull()
  })
})
