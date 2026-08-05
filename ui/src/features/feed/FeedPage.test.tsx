import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { focusManager } from '@tanstack/react-query'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { FEED_PAGE_SIZE } from '../../data/queries'
import type { FeedEntry } from '../../data/types'
import { dayCardStats } from './DayCard'
import { NO_SUMMARY_OVERVIEW, OPAQUE_OVERVIEW, buildDayCards } from './dayCards'
import { dayHref, daySessionHref } from '../../app/routes'
import { FeedPage, dayLabel, groupByDay } from './FeedPage'

// session defaults to null (not a shared string) so two default-built entries
// never accidentally fold into each other -- a null session is only ever
// itself, the rule dedupeSyncedTwins and daySessions both follow.
const entry = (overrides: Partial<FeedEntry> = {}): FeedEntry => ({
  id: 'e1', author: 'Andrew', authorId: 'andrew', tool: 'Codex', at: '2026-07-29T20:00:00Z',
  live: false, outcome: 'done', intent: null, files: [], session: null,
  project: 'membridge', projectPath: '/Users/x/membridge', projectId: null,
  summaryFull: null, decisions: null, gotchas: null, changes: [],
  ...overrides,
})

/** The href a day card for these entries should point at. Built through
 *  buildDayCards rather than by hand, so a test can never assert a slug the
 *  feed does not actually mint. */
const hrefFor = (entries: FeedEntry[], index = 0) => dayHref(buildDayCards(entries)[index].slug)

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

// The stat line is a LIST of parts, not a sentence, because the owner asked
// for a prompt count here and no daemon field carries one yet. When it lands
// it is one more part; these cases are what says the shape already allows it.
describe('dayCardStats', () => {
  it('says how many sessions the day holds', () => {
    expect(dayCardStats({ sessionCount: 3, files: [], projects: [] })).toEqual(['3 sessions'])
  })
  it('does not say "1 sessions"', () => {
    expect(dayCardStats({ sessionCount: 1, files: [], projects: [] })).toEqual(['1 session'])
  })
  it('adds the file count when the day touched anything', () => {
    const files = [{ file: 'a.ts', touches: 1, note: null }, { file: 'b.ts', touches: 2, note: null }]
    expect(dayCardStats({ sessionCount: 1, files, projects: [] })).toEqual(['1 session', '2 files'])
  })
  it('omits the file count for a day that touched nothing', () => {
    expect(dayCardStats({ sessionCount: 2, files: [], projects: [] })).toEqual(['2 sessions'])
  })
})

describe('FeedPage', () => {
  it('renders each day as a card carrying its sentence, its intent and the project in mono', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [entry({
        id: 'a', session: 's-1', outcome: 'Hook ownership now decided by durability',
        decisions: '- Durability beats recency\n- Merged before writing settings.json',
      })],
      nextBefore: null,
    })
    const { container } = renderWith(c, <FeedPage />)

    const card = (await screen.findByText('Hook ownership now decided by durability')).closest('.day-card') as HTMLElement
    expect(within(card).getByText('membridge').className).toContain('mono')
    expect(card.querySelector('.day-card-intent')!.textContent).toBe('Durability beats recency.')
    expect(container.querySelectorAll('.day-card')).toHaveLength(1)
  })

  it('marks a live day', async () => {
    renderApp({}, <FeedPage />)
    expect(await screen.findByLabelText('Live')).toBeInTheDocument()
  })

  // The card NAVIGATES now; it does not expand. It is a real <a> so
  // middle-click and cmd-click open the day in a new window, which is exactly
  // why it cannot be a click handler on a div.
  it('renders a card as a link to its day view, built from ROUTES', async () => {
    const entries = [entry({ id: 'a', session: 's-1', outcome: 'the day\'s outcome' })]
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({ entries, nextBefore: null })
    renderWith(c, <FeedPage />)

    const card = (await screen.findByText('the day\'s outcome')).closest('.day-card') as HTMLElement
    expect(card.tagName).toBe('A')
    expect(card.getAttribute('href')).toBe(hrefFor(entries))
  })

  it('does not expand in place: no session rows and no toggle anywhere in the feed', async () => {
    const { container } = renderApp({}, <FeedPage />)
    await screen.findByText(/Hook ownership/)
    expect(container.querySelectorAll('.entry-row')).toHaveLength(0)
    expect(container.querySelector('.day-card')!.getAttribute('aria-expanded')).toBeNull()
    expect(screen.queryByRole('button', { expanded: false })).toBeNull()
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

  it('auto-pages until the feed covers a few whole days, without a click', async () => {
    // The starvation Andrew hit: /api/feed pages by ROW and grouping happens
    // after, so one busy teammate's 30 rows fill page one and a quieter
    // person's card for the same day lands behind "Show more". The feed now
    // keeps pulling until it has MIN_DAYS_LOADED days.
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed')
      .mockResolvedValueOnce({ entries: [entry({ id: 'p1', session: 'p1', outcome: 'busy teammate' })], nextBefore: '2026-07-20T00:00:00Z' })
      .mockResolvedValueOnce({ entries: [entry({ id: 'p2', session: 'p2', at: '2026-07-19T20:00:00Z', outcome: 'quiet teammate' })], nextBefore: '2026-07-18T00:00:00Z' })
      .mockResolvedValueOnce({ entries: [entry({ id: 'p3', session: 'p3', at: '2026-07-17T20:00:00Z', outcome: 'older still' })], nextBefore: null })
    renderWith(client, <FeedPage />)

    // No click anywhere in this test.
    expect(await screen.findByText('older still')).toBeInTheDocument()
    expect(screen.getByText('quiet teammate')).toBeInTheDocument()
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it('stops auto-paging when a page errors, instead of hammering the daemon', async () => {
    // REAL latency on purpose. With synchronously-resolved mocks React batches
    // the fetching-true render away, the effect's dependencies never change,
    // and a runaway pager looks perfectly healthy. Measured before the fix:
    // 66 calls in 1.5s against an erroring second page.
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed').mockImplementation(async (_f, opts) => {
      await new Promise(r => setTimeout(r, 5))
      if (!opts?.before) return { entries: [entry({ id: 'p1', session: 'p1', outcome: 'only day' })], nextBefore: '2026-07-20T00:00:00Z' }
      throw new Error('daemon went away')
    })
    renderWith(client, <FeedPage />)
    await screen.findByText('only day')
    await new Promise(r => setTimeout(r, 300))
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('stops auto-paging when further pages add no new day', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed').mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 5))
      return { entries: [entry({ id: 'same', session: 'same', outcome: 'one day only' })], nextBefore: '2026-07-20T00:00:00Z' }
    })
    renderWith(client, <FeedPage />)
    await screen.findByText('one day only')
    await new Promise(r => setTimeout(r, 300))
    expect(spy.mock.calls.length).toBeLessThanOrEqual(6)
  })

  it('"Show more" pages backwards using the previous page\'s cursor, keeping the earlier page visible', async () => {
    // Page one already carries enough days that auto-paging is satisfied, so
    // this exercises the MANUAL control rather than racing the effect.
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed')
      .mockResolvedValueOnce({
        entries: [
          entry({ id: 'd1', session: 'd1', at: '2026-07-29T20:00:00Z', outcome: 'first page entry' }),
          entry({ id: 'd2', session: 'd2', at: '2026-07-28T20:00:00Z', outcome: 'day two' }),
          entry({ id: 'd3', session: 'd3', at: '2026-07-27T20:00:00Z', outcome: 'day three' }),
        ],
        nextBefore: '2026-07-20T00:00:00Z',
      })
      .mockResolvedValueOnce({ entries: [entry({ id: 'page2', session: 'p2', at: '2026-07-19T20:00:00Z', outcome: 'second page entry' })], nextBefore: null })
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

// The owner's ask: "i want feed simply to contain the day cards with the one
// snetance header one what was done and the brief 1-3 sentance intent".
// These pin that at the real component; dayCards.test.ts pins the pure rules.
describe('feed: consolidated day cards', () => {
  const marcosDay = () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [
        entry({ id: 'm1', session: 's-m1', authorId: 'marco', author: 'Marco', at: '2026-07-29T20:00:00Z', outcome: 'a raw harvested line' }),
        entry({ id: 'm2', session: 's-m2', authorId: 'marco', author: 'Marco', at: '2026-07-29T19:00:00Z', distilled: true, outcome: 'the day\'s distilled outcome' }),
        entry({ id: 'm3', session: 's-m3', authorId: 'marco', author: 'Marco', at: '2026-07-29T18:00:00Z', outcome: 'another harvested line' }),
      ],
      nextBefore: null,
    })
    return c
  }

  it('folds one person\'s sessions in one project on one day into a single card', async () => {
    const { container } = renderWith(marcosDay(), <FeedPage />)
    await screen.findByText('the day\'s distilled outcome')
    expect(container.querySelectorAll('.day-card')).toHaveLength(1)
  })

  it('leads with ONE picked sentence, never every session\'s summary', async () => {
    const { container } = renderWith(marcosDay(), <FeedPage />)
    await screen.findByText('the day\'s distilled outcome')
    const overviews = [...container.querySelectorAll('.day-card-overview')].map(el => el.textContent)
    expect(overviews).toEqual(['the day\'s distilled outcome'])
  })

  it('carries a brief intent under the sentence, capped by how much was done', async () => {
    const { container } = renderWith(marcosDay(), <FeedPage />)
    await screen.findByText('the day\'s distilled outcome')
    // Three sessions, so two sentences of intent, and never a repeat of the
    // sentence directly above it.
    const intent = container.querySelector('.day-card-intent')!.textContent!
    expect(intent).toBe('another harvested line. a raw harvested line.')
    expect(intent).not.toContain('the day\'s distilled outcome')
  })

  it('states the session and file counts', async () => {
    renderWith(marcosDay(), <FeedPage />)
    await screen.findByText('the day\'s distilled outcome')
    expect(screen.getByText('3 sessions')).toBeInTheDocument()
  })

  it('keeps one person\'s day in ONE card even across two projects', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [
        entry({ id: 'a', session: 'a', at: '2026-07-29T20:00:00Z', outcome: 'membridge work', project: 'membridge', projectPath: '/Users/x/membridge' }),
        entry({ id: 'b', session: 'b', at: '2026-07-29T19:00:00Z', outcome: 'sublease work', project: 'sublease', projectPath: '/Users/x/sublease' }),
      ],
      nextBefore: null,
    })
    const { container } = renderWith(c, <FeedPage />)
    // One person, one day, one card. The card carries a single overview
    // sentence for the day, so only the picked outcome renders as text; both
    // projects are still named on the card.
    await screen.findByText('membridge work')
    expect(container.querySelectorAll('.day-card')).toHaveLength(1)
    const card = container.querySelector('.day-card')!
    expect(card.textContent).toContain('membridge')
    expect(card.textContent).toContain('sublease')
  })

  // THE DUPLICATION Andrew reported: the same work reaching this machine
  // twice, once local and once as its own synced-back twin, rendering as two
  // cards of the same afternoon. lib/feed.js nulls projectPath on the team
  // copy and the backend capitalises the name; only projectId is common.
  it('renders one card, not two, when a day\'s work synced back as its own twin', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [
        entry({ id: 'local-1', session: 's-1', at: '2026-07-29T20:00:00Z', outcome: 'the real outcome', project: 'membridge', projectPath: '/Users/x/membridge', projectId: 'proj-1' }),
        entry({ id: 'team-1', session: 's-1', at: '2026-07-29T20:00:00Z', outcome: 'the real outcome', project: 'Membridge', projectPath: null, projectId: 'proj-1' }),
        entry({ id: 'local-2', session: 's-2', at: '2026-07-29T19:00:00Z', outcome: 'the earlier outcome', project: 'membridge', projectPath: '/Users/x/membridge', projectId: 'proj-1' }),
        entry({ id: 'team-2', session: 's-2', at: '2026-07-29T19:00:00Z', outcome: 'the earlier outcome', project: 'Membridge', projectPath: null, projectId: 'proj-1' }),
      ],
      nextBefore: null,
    })
    const { container } = renderWith(c, <FeedPage />)
    await screen.findByText('the real outcome')
    expect(container.querySelectorAll('.day-card')).toHaveLength(1)
    // And the count has not doubled either: two sessions, not four.
    expect(screen.getByText('2 sessions')).toBeInTheDocument()
  })

  it('orders cards by their newest entry, under one day divider', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [
        entry({ id: 'a', session: 'a', authorId: 'sarah', author: 'Sarah', at: '2026-07-29T17:00:00Z', outcome: 'the older card' }),
        entry({ id: 'b', session: 'b', authorId: 'marco', author: 'Marco', at: '2026-07-29T19:00:00Z', outcome: 'the newer card' }),
      ],
      nextBefore: null,
    })
    const { container } = renderWith(c, <FeedPage />)
    await screen.findByText('the newer card')
    const overviews = [...container.querySelectorAll('.day-card-overview')].map(el => el.textContent)
    expect(overviews).toEqual(['the newer card', 'the older card'])
    expect(container.querySelectorAll('.feed-day')).toHaveLength(1)
  })

  it('is live when any of its sessions is, without claiming the person is present', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [
        entry({ id: 'a', session: 'a', at: '2026-07-29T20:00:00Z', live: false, outcome: 'the overview' }),
        entry({ id: 'b', session: 'b', at: '2026-07-29T19:00:00Z', live: true, outcome: 'older' }),
      ],
      nextBefore: null,
    })
    const { container } = renderWith(c, <FeedPage />)
    await screen.findByText('the overview')
    const meta = container.querySelector('.day-card-meta') as HTMLElement
    expect(within(meta).getByLabelText('Live')).toBeInTheDocument()
    expect(meta.textContent).toBe('live ')
  })

  // The trap: EntryRow renders an empty outcome and a failed decrypt
  // identically ("No summary yet"), so a reader cannot tell them apart. A day
  // card must not inherit that ambiguity.
  it('says an un-summarized day is un-summarized, and adds no intent to fill the gap', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [entry({ id: 'a', session: 'a', outcome: '', intent: 'wire the recall hook' })],
      nextBefore: null,
    })
    const { container } = renderWith(c, <FeedPage />)
    expect(await screen.findByText(NO_SUMMARY_OVERVIEW)).toBeInTheDocument()
    expect(container.querySelector('.day-card-intent')).toBeNull()
  })

  it('says an ENCRYPTED day is encrypted, never passing it off as un-summarized', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [entry({ id: 'a', session: 'a', outcome: '', undecryptable: true })],
      nextBefore: null,
    })
    const { container } = renderWith(c, <FeedPage />)
    expect(await screen.findByText(OPAQUE_OVERVIEW)).toBeInTheDocument()
    expect(screen.queryByText(NO_SUMMARY_OVERVIEW)).toBeNull()
    expect(container.querySelector('.day-card-intent')).toBeNull()
  })
})

// Arriving from a Today card: `?session=` names a session, and the feed is
// days. The card holding it has to say so and has to carry the target
// through, or the link may as well not exist.
describe('feed: a session targeted by ?session=', () => {
  const entries = [
    entry({ id: 'e1', session: 'sess-a', outcome: 'the targeted work' }),
    entry({ id: 'e2', session: 'sess-b', at: '2026-07-28T20:00:00Z', outcome: 'some other work' }),
  ]
  const client = () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({ entries, nextBefore: null })
    return c
  }

  it('marks the card holding the target and links straight at that session', async () => {
    window.history.replaceState({}, '', '/feed?session=sess-a')
    const { container } = renderWith(client(), <FeedPage />)
    await screen.findByText('the targeted work')
    const targeted = container.querySelectorAll('.day-card-targeted')
    expect(targeted).toHaveLength(1)
    expect(targeted[0].getAttribute('href')).toBe(daySessionHref(buildDayCards(entries)[0].slug, 'sess-a'))
  })

  it('renders the feed normally when the target is not on the loaded pages', async () => {
    // The feed is paged; a live session can easily sit past the first page.
    // Degrading to a plain feed is the only honest option, and it must never
    // throw into the render path.
    window.history.replaceState({}, '', '/feed?session=sess-not-loaded')
    const { container } = renderWith(client(), <FeedPage />)
    await screen.findByText('the targeted work')
    expect(container.querySelectorAll('.day-card-targeted')).toHaveLength(0)
    expect(container.querySelector('.day-card')!.getAttribute('href')).toBe(hrefFor(entries))
  })

  it('marks nothing when there is no session param at all', async () => {
    window.history.replaceState({}, '', '/feed')
    const { container } = renderWith(client(), <FeedPage />)
    await screen.findByText('the targeted work')
    expect(container.querySelectorAll('.day-card-targeted')).toHaveLength(0)
  })
})
