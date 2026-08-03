import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { focusManager } from '@tanstack/react-query'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { FEED_PAGE_SIZE } from '../../data/queries'
import type { FeedEntry } from '../../data/types'
import { FeedPage, dayLabel, groupByDay } from './FeedPage'

// session defaults to null (not a shared string) so two default-built
// entries never accidentally collapse into each other via
// collapseSessionCheckpoints -- a null session falls back to its own entry
// id as the group key, matching mappers.ts's own fallback rule.
const entry = (overrides: Partial<FeedEntry> = {}): FeedEntry => ({
  id: 'e1', author: 'Andrew', authorId: 'andrew', tool: 'Codex', at: '2026-07-29T20:00:00Z',
  live: false, outcome: 'done', intent: null, files: [], session: null, project: 'membridge', projectPath: '/Users/x/membridge',
  summaryFull: null, decisions: null, gotchas: null, changes: [],
  ...overrides,
})

// The suite is pinned to America/Los_Angeles (vite.config.ts, test.env.TZ),
// so "20:00Z" is 13:00 the same day and "02:00Z" is 19:00 the PREVIOUS day
// locally. The evening-in-the-west cases below are the regression: they used
// to render tomorrow's date, because grouping keyed on the UTC calendar day.
describe('dayLabel', () => {
  const NOW = new Date('2026-07-29T23:00:00Z')
  it('prefixes TODAY, uppercase, for the current local calendar day', () => {
    expect(dayLabel('2026-07-29T10:00:00Z', NOW)).toBe('TODAY · WED JUL 29')
  })
  it('renders a plain uppercase weekday/month/day for any other day', () => {
    expect(dayLabel('2026-07-28T10:00:00Z', NOW)).toBe('TUE JUL 28')
  })
  it('still says TODAY in the evening, when UTC has already rolled to tomorrow', () => {
    // 02:00Z Jul 30 is 19:00 Jul 29 in Los Angeles. Keying on UTC labelled
    // this "TODAY · THU JUL 30" -- tomorrow's date, all evening.
    expect(dayLabel('2026-07-30T02:00:00Z', new Date('2026-07-30T02:30:00Z'))).toBe('TODAY · WED JUL 29')
  })
  it('does not say TODAY for last night, when the UTC day happens to match', () => {
    // Both instants are Jul 29 in UTC, but locally the entry is Jul 28 21:00
    // and "now" is Jul 29 09:00 -- a different day to the person reading it.
    expect(dayLabel('2026-07-29T04:00:00Z', new Date('2026-07-29T16:00:00Z'))).toBe('TUE JUL 28')
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

  it('keeps one local day together even when the entries straddle UTC midnight', () => {
    // 16:00 and 19:00 on Jul 29 locally -- one afternoon, one group. Keyed
    // on UTC these split across two headings, "JUL 29" and "JUL 30".
    const NOW = new Date('2026-07-30T03:00:00Z')
    const groups = groupByDay([
      entry({ id: 'evening', at: '2026-07-30T02:00:00Z' }),
      entry({ id: 'afternoon', at: '2026-07-29T23:00:00Z' }),
    ], NOW)
    expect(groups.map(g => g.day)).toEqual(['TODAY · WED JUL 29'])
    expect(groups[0].entries.map(e => e.id)).toEqual(['evening', 'afternoon'])
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

  // Task 6: a feed row with a session is a real <a> to the session route --
  // middle-click and cmd-click must work, so it cannot be a click handler on
  // a div.
  it('a row with a session renders as a link to /sessions/:id built from ROUTES', async () => {
    renderApp({}, <FeedPage />)
    const outcome = await screen.findByText(/Hook ownership now decided by durability/)
    const row = outcome.closest('.entry-row')
    expect(row).not.toBeNull()
    expect(row!.tagName).toBe('A')
    expect(row!.getAttribute('href')).toBe(`/sessions/${encodeURIComponent('s-f2')}`)
  })

  // Fix 16: an infinite query refetches EVERY loaded page on window
  // refocus by default -- for a reader three "Show more" clicks deep, one
  // alt-tab refired all their pages at once and fought their scroll
  // position, the exact behavior the no-poll decision here exists to avoid.
  it('does not refire the loaded pages on window refocus', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed')
    renderWith(client, <FeedPage />)
    await screen.findByText(/Hook ownership/)
    const callsAfterLoad = spy.mock.calls.length
    try {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(spy.mock.calls.length).toBe(callsAfterLoad)
    } finally {
      focusManager.setFocused(undefined)
    }
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

  // BUG 2: the Stop hook re-summarizes a WORKING session every few edits, so
  // /api/feed can carry several checkpoint rows for the same session --
  // uncollapsed, the Feed read as the same long summary repeated several
  // times in a row. These three tests pin the fix at the real component,
  // not just at the mapper unit level.
  it('collapses several checkpoint entries of the same session into one row showing the newest text', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getFeed').mockResolvedValueOnce({
      entries: [
        entry({ id: 'c3', session: 's1', at: '2026-07-29T20:10:00Z', outcome: 'third checkpoint of the session' }),
        entry({ id: 'c2', session: 's1', at: '2026-07-29T20:05:00Z', outcome: 'second checkpoint of the session' }),
        entry({ id: 'c1', session: 's1', at: '2026-07-29T20:00:00Z', outcome: 'first checkpoint of the session' }),
      ],
      nextBefore: null,
    })
    renderWith(client, <FeedPage />)

    expect(await screen.findByText('third checkpoint of the session')).toBeInTheDocument()
    expect(screen.queryByText('second checkpoint of the session')).toBeNull()
    expect(screen.queryByText('first checkpoint of the session')).toBeNull()
  })

  it('keeps two distinct sessions with byte-identical outcome text as two separate rows', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getFeed').mockResolvedValueOnce({
      entries: [
        entry({ id: 'x1', session: 's1', authorId: 'andrew', author: 'Andrew', at: '2026-07-29T20:10:00Z', outcome: 'identical summary text' }),
        entry({ id: 'x2', session: 's2', authorId: 'andrew', author: 'Andrew', at: '2026-07-29T20:05:00Z', outcome: 'identical summary text' }),
      ],
      nextBefore: null,
    })
    renderWith(client, <FeedPage />)

    expect(await screen.findAllByText('identical summary text')).toHaveLength(2)
  })

  it('keeps the collapsed rows newest-first', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getFeed').mockResolvedValueOnce({
      entries: [
        entry({ id: 'older', session: 's-old', at: '2026-07-29T18:00:00Z', outcome: 'older session outcome' }),
        entry({ id: 'newer', session: 's-new', at: '2026-07-29T21:00:00Z', outcome: 'newer session outcome' }),
      ],
      nextBefore: null,
    })
    renderWith(client, <FeedPage />)

    const rows = await screen.findAllByText(/session outcome/)
    expect(rows.map(r => r.textContent)).toEqual(['newer session outcome', 'older session outcome'])
  })
})

// Arriving from a Today card: the feed has to say WHICH row you were sent to,
// or the link may as well not exist. `?session=` is the target.
describe('feed: a session targeted by ?session=', () => {
  const client = () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [
        entry({ id: 'e1', session: 'sess-a', outcome: 'the targeted work' }),
        entry({ id: 'e2', session: 'sess-b', outcome: 'some other work' }),
      ],
      nextCursor: null,
    } as never)
    return c
  }

  it('marks the matching row, and only that row', async () => {
    window.history.replaceState({}, '', '/feed?session=sess-a')
    const { container } = renderWith(client(), <FeedPage />)
    await screen.findByText('the targeted work')
    const targeted = container.querySelectorAll('.entry-row-targeted')
    expect(targeted).toHaveLength(1)
    expect(targeted[0].textContent).toContain('the targeted work')
  })

  it('renders the feed normally when the target is not on the loaded pages', async () => {
    // The feed is paged; a live session can easily sit past the first page.
    // Degrading to a plain feed is the only honest option, and it must never
    // throw into the render path.
    window.history.replaceState({}, '', '/feed?session=sess-not-loaded')
    const { container } = renderWith(client(), <FeedPage />)
    await screen.findByText('the targeted work')
    expect(container.querySelectorAll('.entry-row-targeted')).toHaveLength(0)
  })

  it('marks nothing when there is no session param at all', async () => {
    window.history.replaceState({}, '', '/feed')
    const { container } = renderWith(client(), <FeedPage />)
    await screen.findByText('the targeted work')
    expect(container.querySelectorAll('.entry-row-targeted')).toHaveLength(0)
  })
})
