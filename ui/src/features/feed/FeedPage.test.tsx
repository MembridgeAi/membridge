import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { FEED_PAGE_SIZE } from '../../data/queries'
import type { FeedEntry } from '../../data/types'
import { FeedPage, dayLabel, groupByDay } from './FeedPage'

const entry = (overrides: Partial<FeedEntry> = {}): FeedEntry => ({
  id: 'e1', author: 'Andrew', authorId: 'andrew', tool: 'Codex', at: '2026-07-29T20:00:00Z',
  live: false, outcome: 'done', intent: null, files: [], project: 'membridge', projectPath: '/Users/x/membridge',
  ...overrides,
})

describe('dayLabel', () => {
  const NOW = new Date('2026-07-29T23:00:00Z')
  it('prefixes TODAY, uppercase, for the current UTC calendar day', () => {
    expect(dayLabel('2026-07-29T10:00:00Z', NOW)).toBe('TODAY · WED JUL 29')
  })
  it('renders a plain uppercase weekday/month/day for any other day', () => {
    expect(dayLabel('2026-07-28T10:00:00Z', NOW)).toBe('TUE JUL 28')
  })
})

describe('groupByDay', () => {
  it('buckets newest-first into consecutive same-day runs', () => {
    const NOW = new Date('2026-07-29T23:00:00Z')
    const groups = groupByDay([
      entry({ id: 'a', at: '2026-07-28T10:00:00Z' }),
      entry({ id: 'b', at: '2026-07-29T20:00:00Z' }),
      entry({ id: 'c', at: '2026-07-29T09:00:00Z' }),
    ], NOW)
    expect(groups.map(g => g.day)).toEqual(['TODAY · WED JUL 29', 'TUE JUL 28'])
    expect(groups[0].entries.map(e => e.id)).toEqual(['b', 'c'])
  })
})

describe('FeedPage', () => {
  it('renders each entry with its outcome, intent, and the project name in mono', async () => {
    renderApp({}, <FeedPage />)
    const outcome = await screen.findByText(/Hook ownership now decided by durability/)
    const row = outcome.closest('.entry-row') as HTMLElement
    const projectLabel = within(row).getByText('membridge')
    expect(projectLabel.className).toContain('mono')
    expect(within(row).getByText(/make the summary hook fire on session boundaries/)).toBeInTheDocument()
  })

  it('marks a live session', async () => {
    renderApp({}, <FeedPage />)
    expect(await screen.findByLabelText('Live')).toBeInTheDocument()
  })

  it('renders an empty state', async () => {
    renderApp({ empty: true }, <FeedPage />)
    expect(await screen.findByText(/nothing yet/i)).toBeInTheDocument()
  })

  it('surfaces a load failure instead of rendering a blank page', async () => {
    renderApp({ failWith: 'daemon unreachable' }, <FeedPage />)
    expect(await screen.findByText(/couldn't reach/i)).toBeInTheDocument()
  })

  it('omits the person filter and every avatar in solo mode -- absent, not disabled', async () => {
    renderApp({ solo: true }, <FeedPage />)
    await screen.findByText(/Hook ownership/)
    expect(screen.queryByLabelText('Filter by person')).toBeNull()
    expect(screen.queryByLabelText('Andrew')).toBeNull()
  })

  it('shows the person filter and avatars on a team', async () => {
    renderApp({ solo: false }, <FeedPage />)
    expect(await screen.findByLabelText('Filter by person')).toBeInTheDocument()
    expect((await screen.findAllByLabelText('Andrew')).length).toBeGreaterThan(0)
  })

  it('routes a person filter change through the query, not a client-side slice', async () => {
    const client = new FakeDataClient({ solo: false })
    const spy = vi.spyOn(client, 'getFeed')
    renderWith(client, <FeedPage />)
    const select = await screen.findByLabelText('Filter by person')
    // The select renders before its options (members) have loaded -- wait
    // for the real option, not just the empty control, before choosing it.
    await within(select).findByRole('option', { name: 'Andrew' })
    await userEvent.selectOptions(select, 'andrew')
    expect(spy).toHaveBeenLastCalledWith(
      { author: 'andrew', project: null, source: null },
      { limit: FEED_PAGE_SIZE, before: null },
    )
  })

  it('routes a project filter change through the query', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed')
    renderWith(client, <FeedPage />)
    const select = await screen.findByLabelText('Filter by project')
    await within(select).findByRole('option', { name: 'sublease' })
    await userEvent.selectOptions(select, '/Users/x/sublease')
    expect(spy).toHaveBeenLastCalledWith(
      { author: null, project: '/Users/x/sublease', source: null },
      { limit: FEED_PAGE_SIZE, before: null },
    )
  })

  it('routes a tool filter change through the query', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed')
    renderWith(client, <FeedPage />)
    const select = await screen.findByLabelText('Filter by tool')
    await within(select).findByRole('option', { name: 'Codex' })
    await userEvent.selectOptions(select, 'Codex')
    expect(spy).toHaveBeenLastCalledWith(
      { author: null, project: null, source: 'Codex' },
      { limit: FEED_PAGE_SIZE, before: null },
    )
  })

  it('"Show more" pages backwards using the previous page\'s cursor, keeping the earlier page visible', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed')
      .mockResolvedValueOnce({ entries: [entry({ id: 'page1', outcome: 'first page entry' })], nextBefore: '2026-07-20T00:00:00Z' })
      .mockResolvedValueOnce({ entries: [entry({ id: 'page2', outcome: 'second page entry' })], nextBefore: null })
    renderWith(client, <FeedPage />)

    expect(await screen.findByText('first page entry')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }))

    expect(await screen.findByText('second page entry')).toBeInTheDocument()
    expect(screen.getByText('first page entry')).toBeInTheDocument()
    expect(spy).toHaveBeenLastCalledWith(
      { author: null, project: null, source: null },
      { limit: FEED_PAGE_SIZE, before: '2026-07-20T00:00:00Z' },
    )
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })
})
