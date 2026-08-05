// P0 Fix 3: project routes key on the project PATH (encodeURIComponent'd),
// not the basename. Routing on `name` collided the moment two watched
// projects shared a basename (two checkouts of "api"), and interpolating
// raw names into hrefs broke outright on '#' or '?' in a name. Old
// name-based deep links still resolve via a name-match fallback.
import { describe, it, expect, afterEach } from 'vitest'
import { screen, cleanup } from '@testing-library/react'
import { renderWith } from '../test/renderApp'
import { FakeDataClient } from '../data/FakeDataClient'
import type { Project } from '../data/types'
import { App } from './App'
import { ProjectsPage } from '../features/projects/ProjectsPage'

function project(overrides: Partial<Project>): Project {
  return {
    path: '/x/p', name: 'p', exists: true, archived: false, missing: false, paused: false,
    lastSync: '2026-07-29T19:00:00Z', lastActivity: '2026-07-29T19:00:00Z',
    sessionsTotal: 10, tools: ['Claude Code'], shared: false, recentAuthorIds: ['me'],
    sessionsThisWeek: 1, dailyCounts: [0, 0, 0, 0, 0, 0, 1],
    latestSummary: null, sync: { state: 'up-to-date' },
    ...overrides,
  }
}

// Two projects BOTH named "api" (different checkouts), plus one whose name
// carries a '#': the two shapes basename routing could not represent.
const FIXTURE: Project[] = [
  project({ path: '/x/client/api', name: 'api', sessionsThisWeek: 3 }),
  project({ path: '/x/server/api', name: 'api', sessionsThisWeek: 7 }),
  project({ path: '/x/hashes', name: 'api#2', sessionsThisWeek: 5 }),
]

class TwoApisClient extends FakeDataClient {
  getProjects() { return Promise.resolve(FIXTURE) }
}

function visit(path: string) {
  window.history.pushState({}, '', path)
}

afterEach(() => {
  cleanup()
  window.history.pushState({}, '', '/')
})

describe('project routing by path (P0 Fix 3)', () => {
  it('resolves the first of two same-named projects to its own page', async () => {
    visit(`/projects/${encodeURIComponent('/x/client/api')}`)
    renderWith(new TwoApisClient(), <App />)
    // The two "api" pages are only tellable apart by their own data --
    // SyncPanel's "This week" line carries each one's sessionsThisWeek. Matched
    // exactly, not with a trailing separator: that separator existed only to
    // introduce a "N people" figure, which was removed in T15 because it was
    // derived from a capped cross-project page and could contradict the session
    // count beside it.
    expect(await screen.findByText(/^3 sessions$/)).toBeInTheDocument()
    expect(screen.queryByText(/^7 sessions$/)).toBeNull()
  })

  it('resolves the second of two same-named projects to its own page', async () => {
    visit(`/projects/${encodeURIComponent('/x/server/api')}`)
    renderWith(new TwoApisClient(), <App />)
    expect(await screen.findByText(/^7 sessions$/)).toBeInTheDocument()
    expect(screen.queryByText(/^3 sessions$/)).toBeNull()
  })

  it('round-trips a name containing "#" via the name-match fallback', async () => {
    visit(`/projects/${encodeURIComponent('api#2')}`)
    renderWith(new TwoApisClient(), <App />)
    expect(await screen.findByRole('heading', { name: 'api#2' })).toBeInTheDocument()
    expect(await screen.findByText(/^5 sessions$/)).toBeInTheDocument()
  })

  it('still resolves an old name-based deep link (back-compat)', async () => {
    visit('/projects/membridge')
    renderWith(new FakeDataClient(), <App />)
    expect(await screen.findByRole('heading', { name: 'membridge' })).toBeInTheDocument()
  })

  it('builds Open links from the encoded project path, never the raw name', async () => {
    renderWith(new FakeDataClient(), <ProjectsPage />)
    const links = await screen.findAllByRole('link', { name: 'Open' })
    const hrefs = links.map(l => l.getAttribute('href'))
    expect(hrefs).toContain(`/projects/${encodeURIComponent('/Users/x/membridge')}`)
    expect(hrefs).not.toContain('/projects/membridge')
  })
})
