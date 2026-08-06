import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { focusManager } from '@tanstack/react-query'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { FEED_PAGE_SIZE } from '../../data/queries'
import type { FeedEntry, FeedPage as FeedPageResult } from '../../data/types'
import { dayCardStats, projectLabel } from './DayCard'
import { NO_SUMMARY_OVERVIEW, OPAQUE_OVERVIEW, buildDayCards } from './dayCards'
import { dayHref, daySessionHref } from '../../app/routes'
import { FEED_WEEK_DAYS, FeedPage, MAX_AUTO_PAGES, UNDATED_LABEL, dayLabel, groupByDay } from './FeedPage'

// session defaults to null (not a shared string) so two default-built entries
// never accidentally fold into each other -- a null session is only ever
// itself once its instant differs, the rule dedupeSyncedTwins follows.
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

/** `count` pages, each carrying ONE entry on its own local day, walking back a
 *  day at a time from Jul 29.
 *
 *  One new day per page is deliberately the shape the pager is worst at: it is
 *  what forces the walk, where a realistic 30-row page usually straddles
 *  several days and reaches a week in three or four requests. Every page hands
 *  back a cursor, including the last, so a test asserting the pager stopped is
 *  asserting it hit its own target rather than that the feed ran out of rows. */
const oneDayPerPage = (count: number): FeedPageResult[] =>
  Array.from({ length: count }, (_, i) => {
    const date = 29 - i
    return {
      entries: [entry({ id: `p${i}`, session: `p${i}`, at: `2026-07-${date}T20:00:00Z`, outcome: `day ${i}` })],
      nextBefore: `2026-07-${date - 1}T00:00:00Z`,
      dayDigests: [],
    }
  })

/** How many requests the pager made once it stopped making them.
 *
 *  Samples until two consecutive reads 100ms apart are equal. A runaway loop
 *  never settles, so a caller putting a bound on the result is asserting
 *  TERMINATION rather than a rate -- and unlike a fixed sleep, it does not turn
 *  into a phantom failure when the machine is busy compiling something else. */
const settledCalls = async (spy: { mock: { calls: unknown[] } }): Promise<number> => {
  let last = -1
  for (let i = 0; i < 25; i++) {
    const now = spy.mock.calls.length
    if (now === last) return now
    last = now
    await new Promise(r => setTimeout(r, 100))
  }
  return spy.mock.calls.length
}

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
  it('names an undated row instead of rendering "UNDEFINED UNDEFINED NAN"', () => {
    // lib/feed.js emits `ts: e.ts || ''` and nothing guarded before new Date().
    expect(dayLabel('', NOW)).toBe(UNDATED_LABEL)
    expect(dayLabel('not a date', NOW)).toBe(UNDATED_LABEL)
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

  // Board ticket #10. The label carries no year, so it is not an identity.
  // Jul 29 falls on a Wednesday in both 2020 and 2026, which makes those two
  // days render the SAME heading text -- and the group was bucketed and
  // React-keyed on that text. Two consequences, both real: six years of
  // activity collapsed under one divider whenever nothing between them broke
  // the run, and two siblings sharing a React key, which frees React to
  // reconcile one day's cards into the other day's section. Paging a week at a
  // time makes reaching a second July 29th cheaper, so this stopped being
  // theoretical.
  it('gives two same-labelled days years apart their own key, not one shared', () => {
    const NOW = new Date('2026-07-29T23:00:00Z')
    const groups = groupByDay([
      entry({ id: 'now', at: '2026-07-29T20:00:00Z' }),
      entry({ id: 'then', at: '2020-07-29T20:00:00Z' }),
    ], NOW)
    // The rendered text is unchanged, and is genuinely identical apart from
    // the TODAY prefix -- which is exactly why it cannot be the key.
    expect(groups.map(g => g.day)).toEqual(['TODAY · WED JUL 29', 'WED JUL 29'])
    expect(groups).toHaveLength(2)
    expect(groups.map(g => g.key)).toEqual(['2026-07-29', '2020-07-29'])
    expect(new Set(groups.map(g => g.key)).size).toBe(groups.length)
  })

  it('buckets undated rows together under one named key rather than on NaN', () => {
    const groups = groupByDay([
      entry({ id: 'a', at: '' }),
      entry({ id: 'b', at: 'not a date' }),
    ], new Date('2026-07-29T23:00:00Z'))
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('undated')
    expect(groups[0].day).toBe(UNDATED_LABEL)
  })

  // The case the test above CANNOT see: it puts the two undated rows next to
  // each other, so they land in one run whether or not the grouping handles
  // them deliberately. Real dates in between is what separates them.
  it('keeps differently-malformed rows in ONE undated group even when real days sort between them', () => {
    const groups = groupByDay([
      // 'not a date' sorts above every ISO string ('n' > '2') and '' sorts
      // below all of them, so a run-based grouping puts a real day between
      // these two and mints the key 'undated' twice.
      entry({ id: 'a', at: 'not a date' }),
      entry({ id: 'b', at: '2026-07-29T20:00:00Z' }),
      entry({ id: 'c', at: '' }),
    ], new Date('2026-07-29T23:00:00Z'))

    const undatedGroups = groups.filter(g => g.key === 'undated')
    expect(undatedGroups).toHaveLength(1)
    expect(undatedGroups[0].entries.map(e => e.id).sort()).toEqual(['a', 'c'])
    expect(new Set(groups.map(g => g.key)).size).toBe(groups.length)
  })

  it('sorts the undated group to the bottom, never above today', () => {
    const groups = groupByDay([
      entry({ id: 'a', at: 'not a date' }),
      entry({ id: 'b', at: '2026-07-29T20:00:00Z' }),
    ], new Date('2026-07-29T23:00:00Z'))
    // Raw string order would have put 'not a date' first, heading the feed
    // with the rows whose timestamps are the least trustworthy.
    expect(groups[groups.length - 1].key).toBe('undated')
    expect(groups[0].key).not.toBe('undated')
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

describe('projectLabel', () => {
  const project = (name: string) => ({ key: name, name, count: 1 })
  it('names the projects a card spans, busiest first', () => {
    expect(projectLabel([project('membridge'), project('sublease')])).toBe('membridge, sublease')
  })
  it('elides the tail rather than crowding out the person\'s name', () => {
    expect(projectLabel(['a', 'b', 'c', 'd', 'e'].map(project))).toBe('a, b, c +2')
  })
  it('renders nothing, not a stray separator, for no projects', () => {
    expect(projectLabel([])).toBe('')
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
  it('counts the projects only once the list on the line above is elided', () => {
    const projects = ['a', 'b', 'c', 'd'].map(name => ({ key: name, name, count: 1 }))
    expect(dayCardStats({ sessionCount: 1, files: [], projects })).toEqual(['1 session', '4 projects'])
  })
})

describe('FeedPage', () => {
  it('carries exactly two pieces of text: the day\'s sentence and its brief intent', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [entry({
        id: 'a', session: 's-1', outcome: 'Hook ownership now decided by durability',
        goal: 'Make the summary hook fire on session boundaries instead of on edits',
      })],
      nextBefore: null, dayDigests: [],
    })
    const { container } = renderWith(c, <FeedPage />)

    const card = (await screen.findByText('Hook ownership now decided by durability')).closest('.day-card') as HTMLElement
    expect(within(card).getByText('membridge').className).toContain('mono')
    // What was DONE on top, what was ASKED FOR underneath. Two facts from two
    // sources: built from the outcomes, both lines said the same thing twice.
    expect(card.querySelector('.day-card-intent')!.textContent)
      .toBe('Make the summary hook fire on session boundaries instead of on edits.')
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
    vi.spyOn(c, 'getFeed').mockResolvedValue({ entries, nextBefore: null, dayDigests: [] })
    renderWith(c, <FeedPage />)

    const card = (await screen.findByText('the day\'s outcome')).closest('.day-card') as HTMLElement
    expect(card.tagName).toBe('A')
    expect(card.getAttribute('href')).toBe(hrefFor(entries))
  })

  it('nests no second link inside the card, which the parser would unnest', async () => {
    const { container } = renderApp({}, <FeedPage />)
    await screen.findByText(/Hook ownership/)
    const card = container.querySelector('.day-card') as HTMLElement
    expect(card.querySelectorAll('a')).toHaveLength(0)
  })

  it('does not expand in place: no session rows, and no disclosure left to describe', async () => {
    const { container } = renderApp({}, <FeedPage />)
    await screen.findByText(/Hook ownership/)
    expect(container.querySelectorAll('.entry-row')).toHaveLength(0)
    const card = container.querySelector('.day-card')!
    expect(card.getAttribute('aria-expanded')).toBeNull()
    expect(card.getAttribute('aria-controls')).toBeNull()
    expect(container.querySelector('.day-card-head')).toBeNull()
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

  it('carries the active filters onto every card\'s link', async () => {
    // The day view runs useFeed itself and useFeed keys its cache on the
    // filters. A link built without them opens a different query key: a cold
    // start that frequently cannot reach the card just clicked.
    const client = new FakeDataClient({ solo: false })
    vi.spyOn(client, 'getFeed').mockResolvedValue({
      entries: [entry({ id: 'a', session: 's-1', outcome: 'filtered work' })],
      nextBefore: null, dayDigests: [],
    })
    const { container } = renderWith(client, <FeedPage />)
    const select = await screen.findByLabelText('Filter by person')
    await within(select).findByRole('option', { name: 'Andrew' })
    await userEvent.selectOptions(select, 'andrew')

    await screen.findByText('filtered work')
    const href = container.querySelector('.day-card')!.getAttribute('href')!
    expect(new URLSearchParams(href.slice(href.indexOf('?'))).get('author')).toBe('andrew')
  })

  it('auto-pages until the feed covers a WEEK, without a click, then stops', async () => {
    // The starvation the owner hit: /api/feed pages by ROW and grouping
    // happens after, so one busy teammate's 30 rows fill page one and a
    // quieter person's card for the same day lands behind "Show more". Andrew's
    // ask is that the feed be a week long before that button appears, so the
    // pager walks to FEED_WEEK_DAYS distinct local days.
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed')
    // One more page than the week needs, all of them offering a cursor: the
    // pager has to stop on its own target rather than on running out.
    for (const page of oneDayPerPage(FEED_WEEK_DAYS + 1)) spy.mockResolvedValueOnce(page)
    renderWith(client, <FeedPage />)

    // No click anywhere in this test.
    expect(await screen.findByText(`day ${FEED_WEEK_DAYS - 1}`)).toBeInTheDocument()
    expect(screen.getByText('day 0')).toBeInTheDocument()
    expect(await settledCalls(spy)).toBe(FEED_WEEK_DAYS)
    // A week is loaded, so the control is now the reader's to press, not a
    // spinner they are waiting on.
    expect(await screen.findByRole('button', { name: 'Show more' })).toBeEnabled()
  })

  it('says "Loading…" for the WHOLE walk to a week, not just one request', async () => {
    // isFetchingNextPage drops to false between pages. A button keyed on it
    // alone flickers back to "Show more" mid-week and invites a press that
    // queues a second week on top of the one still arriving.
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed')
    spy.mockResolvedValueOnce(oneDayPerPage(1)[0])
    // Page two never arrives. A hanging page is the only way to hold the screen
    // in the mid-walk state deterministically -- with resolving mocks the whole
    // week can land before the first assertion runs, and the test would be
    // measuring the scheduler rather than the button.
    spy.mockImplementation(() => new Promise<FeedPageResult>(() => {}))

    renderWith(client, <FeedPage />)
    await screen.findByText('day 0')
    // One day of the seven is in hand, so the control is not the reader's yet.
    expect(await screen.findByRole('button', { name: 'Loading…' })).toBeDisabled()
  })

  it('"Show more" adds another week rather than a single page', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed')
    for (const page of oneDayPerPage(FEED_WEEK_DAYS * 2)) spy.mockResolvedValueOnce(page)
    renderWith(client, <FeedPage />)

    await screen.findByText(`day ${FEED_WEEK_DAYS - 1}`)
    expect(await settledCalls(spy)).toBe(FEED_WEEK_DAYS)

    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }))

    // A second week, off ONE press: the button moves the day target and the
    // pager walks to it, rather than handing back a single page.
    expect(await screen.findByText(`day ${FEED_WEEK_DAYS * 2 - 1}`)).toBeInTheDocument()
    expect(await settledCalls(spy)).toBe(FEED_WEEK_DAYS * 2)
    expect(screen.getByText('day 0')).toBeInTheDocument()
  })

  it('walks again after a filter change instead of freezing on a dead "Loading…"', async () => {
    // The pager latches "already asked at this page count" in a ref, and
    // useFeed keys its cache on the filters -- so picking a filter swaps in a
    // different cache entry whose page count starts over at zero. A latch left
    // at the PREVIOUS filter's count matched the new one on the first pass and
    // the pager refused to walk a feed it had never walked.
    //
    // Survivable while the button was keyed on isFetchingNextPage: the reader
    // saw a live "Show more" and drove it by hand. Keyed on the DAY TARGET, the
    // same state renders a disabled "Loading…" that no request will ever
    // finish, with no way out but another filter change or a reload.
    const client = new FakeDataClient()
    // The unfiltered feed RUNS OUT after two pages. That is what leaves the
    // latch set: the pager's last attempt did not grow the page count.
    const unfiltered = oneDayPerPage(2)
    unfiltered[1] = { ...unfiltered[1], nextBefore: null }
    const filtered = oneDayPerPage(FEED_WEEK_DAYS)
    const spy = vi.spyOn(client, 'getFeed').mockImplementation((filters, opts) => {
      const pages = filters.project ? filtered : unfiltered
      const next = opts.before === null
        ? 0
        : pages.findIndex(p => p.nextBefore === opts.before) + 1
      return Promise.resolve(pages[Math.min(next, pages.length - 1)])
    })
    renderWith(client, <FeedPage />)

    await screen.findByText('day 1')
    const beforeFilter = await settledCalls(spy)

    const select = await screen.findByLabelText('Filter by project')
    await within(select).findByRole('option', { name: 'sublease' })
    await userEvent.selectOptions(select, '/Users/x/sublease')

    // The pager has to walk the NEW query key. With the stale latch it made
    // exactly one request (the query's own first page) and then stopped, so a
    // bound of "more than one past the old count" is what separates walking
    // from frozen.
    expect(await settledCalls(spy)).toBeGreaterThan(beforeFilter + 1)
    // And the control is the reader's again, not a spinner nothing will finish.
    expect(await screen.findByRole('button', { name: 'Show more' })).toBeEnabled()
  })

  it('stops auto-paging when a page errors, instead of hammering the daemon', async () => {
    // REAL latency on purpose. With synchronously-resolved mocks React batches
    // the fetching-true render away, the effect's dependencies never change,
    // and a runaway pager looks perfectly healthy. Measured before the guard:
    // 66 calls in 1.5s against an erroring second page.
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed').mockImplementation(async (_f, opts) => {
      await new Promise(r => setTimeout(r, 5))
      if (!opts?.before) return { entries: [entry({ id: 'p1', session: 'p1', outcome: 'only day' })], nextBefore: '2026-07-20T00:00:00Z', dayDigests: [] }
      throw new Error('daemon went away')
    })
    renderWith(client, <FeedPage />)
    await screen.findByText('only day')
    expect(await settledCalls(spy)).toBeLessThanOrEqual(3)
  })

  it('stops auto-paging when further pages add no new day', async () => {
    // The other non-progress case: the daemon keeps answering, and keeps
    // answering with the same day. Progress is tracked on the PAGE COUNT, not
    // on the fetching flag, so each state is asked about once and the ceiling
    // ends it. A week target does not change that -- it only raises where the
    // ceiling sits.
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed').mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 5))
      return { entries: [entry({ id: 'same', session: 'same', outcome: 'one day only' })], nextBefore: '2026-07-20T00:00:00Z', dayDigests: [] }
    })
    renderWith(client, <FeedPage />)
    await screen.findByText('one day only')
    expect(await settledCalls(spy)).toBeLessThanOrEqual(MAX_AUTO_PAGES)
  })

  it('"Show more" pages backwards using the previous page\'s cursor, keeping the earlier page visible', async () => {
    // Page one already carries a whole week, so auto-paging is satisfied and
    // this exercises the MANUAL control rather than racing the effect.
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed')
      .mockResolvedValueOnce({
        entries: Array.from({ length: FEED_WEEK_DAYS }, (_, i) => entry({
          id: `d${i}`, session: `d${i}`, at: `2026-07-${29 - i}T20:00:00Z`,
          outcome: i === 0 ? 'first page entry' : `day ${i}`,
        })),
        nextBefore: '2026-07-20T00:00:00Z', dayDigests: [],
      })
      .mockResolvedValueOnce({ entries: [entry({ id: 'page2', session: 'p2', at: '2026-07-19T20:00:00Z', outcome: 'second page entry' })], nextBefore: null, dayDigests: [] })
    renderWith(client, <FeedPage />)

    expect(await screen.findByText('first page entry')).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }))

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
const marcosDayClient = () => {
  const c = new FakeDataClient()
  vi.spyOn(c, 'getFeed').mockResolvedValue({
    entries: [
      entry({ id: 'm1', session: 's-m1', authorId: 'marco', author: 'Marco', at: '2026-07-29T20:00:00Z', outcome: 'a raw harvested line' }),
      entry({ id: 'm2', session: 's-m2', authorId: 'marco', author: 'Marco', at: '2026-07-29T19:00:00Z', distilled: true, outcome: 'the day\'s distilled outcome' }),
      entry({ id: 'm3', session: 's-m3', authorId: 'marco', author: 'Marco', at: '2026-07-29T18:00:00Z', outcome: 'another harvested line' }),
    ],
    nextBefore: null, dayDigests: [],
  })
  return c
}

describe('feed: consolidated day cards', () => {
  const marcosDay = () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [
        entry({ id: 'm1', session: 's-m1', authorId: 'marco', author: 'Marco', at: '2026-07-29T20:00:00Z', outcome: 'a raw harvested line' }),
        entry({ id: 'm2', session: 's-m2', authorId: 'marco', author: 'Marco', at: '2026-07-29T19:00:00Z', distilled: true, outcome: 'the day\'s distilled outcome' }),
        entry({ id: 'm3', session: 's-m3', authorId: 'marco', author: 'Marco', at: '2026-07-29T18:00:00Z', outcome: 'another harvested line' }),
      ],
      nextBefore: null, dayDigests: [],
    })
    return c
  }

  it('folds one person\'s sessions on one day into a single card', async () => {
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

  it('carries what was ASKED under the sentence, never the sentence again', async () => {
    // THE DEFECT this replaced: the intent was built from the day's bullets,
    // which are the same session outcomes the digest joins to make the header,
    // so every populated card in Andrew's feed printed its headline twice.
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [
        entry({ id: 'm1', session: 's-m1', authorId: 'marco', author: 'Marco', at: '2026-07-29T20:00:00Z', outcome: 'a raw harvested line', goal: 'Ship the second wave of tickets' }),
        entry({ id: 'm2', session: 's-m2', authorId: 'marco', author: 'Marco', at: '2026-07-29T19:00:00Z', distilled: true, outcome: 'the day\'s distilled outcome', intent: 'walk the app as a solo user for team-language bugs' }),
        entry({ id: 'm3', session: 's-m3', authorId: 'marco', author: 'Marco', at: '2026-07-29T18:00:00Z', outcome: 'another harvested line', intent: 'hand off cleanly to Andrew before the pause' }),
      ],
      nextBefore: null, dayDigests: [],
    })
    const { container } = renderWith(c, <FeedPage />)
    await screen.findByText('the day\'s distilled outcome')
    // Three sessions, so two asks, oldest session first.
    const intent = container.querySelector('.day-card-intent')!.textContent!
    expect(intent).toBe('hand off cleanly to Andrew before the pause. walk the app as a solo user for team-language bugs.')
    // And not one word of the header, which is the whole defect.
    expect(intent).not.toContain('the day\'s distilled outcome')
    expect(intent).not.toContain('harvested line')
  })

  it('states the session count', async () => {
    renderWith(marcosDay(), <FeedPage />)
    await screen.findByText('the day\'s distilled outcome')
    expect(screen.getByText('3 sessions')).toBeInTheDocument()
  })

  // THE ASK, verbatim: "a team of two working should have 2 day cards, one per
  // person". Two people, four projects between them, four separate sessions.
  it('renders a team of two working today as exactly two cards', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [
        entry({ id: 'a', session: 'a', authorId: 'marco', author: 'Marco', at: '2026-07-29T20:00:00Z', outcome: 'marco on membridge', project: 'membridge', projectPath: '/Users/x/membridge' }),
        entry({ id: 'b', session: 'b', authorId: 'marco', author: 'Marco', at: '2026-07-29T19:00:00Z', outcome: 'marco on the site', project: 'membridge-site', projectPath: '/Users/x/site' }),
        entry({ id: 'c', session: 'c', authorId: 'andrew', author: 'Andrew', at: '2026-07-29T18:00:00Z', outcome: 'andrew on membridge', project: 'membridge', projectPath: '/Users/x/membridge' }),
        entry({ id: 'd', session: 'd', authorId: 'andrew', author: 'Andrew', at: '2026-07-29T17:00:00Z', outcome: 'andrew on sublease', project: 'sublease', projectPath: '/Users/x/sublease' }),
      ],
      nextBefore: null, dayDigests: [],
    })
    const { container } = renderWith(c, <FeedPage />)
    await screen.findByText('marco on membridge')
    expect(container.querySelectorAll('.day-card')).toHaveLength(2)
  })

  it('names every project one card spans instead of one of them as the scope', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [
        entry({ id: 'a', session: 'a', at: '2026-07-29T20:00:00Z', outcome: 'membridge work', project: 'membridge', projectPath: '/Users/x/membridge' }),
        entry({ id: 'b', session: 'b', at: '2026-07-29T19:00:00Z', outcome: 'sublease work', project: 'sublease', projectPath: '/Users/x/sublease' }),
      ],
      nextBefore: null, dayDigests: [],
    })
    const { container } = renderWith(c, <FeedPage />)
    await screen.findByText('membridge work')
    const card = container.querySelector('.day-card')!
    expect(card.textContent).toContain('membridge')
    expect(card.textContent).toContain('sublease')
    // And the link spans the whole day, not one of the two projects.
    expect(card.getAttribute('href')).not.toContain('sublease')
  })

  // The synced-back twin, built from the REAL asymmetry: the twin's ts
  // round-trips through Postgres timestamptz ('.550Z' comes back '.55+00:00'),
  // its projectPath is nulled and its name capitalised. A fixture built with
  // byte-identical timestamps proves nothing here.
  //
  // At THIS level the card is what it should be even before the fold, because
  // it is keyed on the person and the twin's projectId is unchanged; the
  // visible doubling is on the day view, where DayPage.test.tsx pins it. This
  // case is here as the guard on that: it fails the moment the card key or
  // dayProjects starts keying on anything the round trip alters.
  it('renders one card, not two, when a day\'s work synced back as its own twin', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [
        entry({ id: 's-1|2026-07-29T20:00:00.550Z', session: 's-1', at: '2026-07-29T20:00:00.550Z', outcome: 'the real outcome', intent: 'the real prompt', project: 'membridge', projectPath: '/Users/x/membridge', projectId: 'proj-1' }),
        entry({ id: 's-1|2026-07-29T20:00:00.55+00:00', session: 's-1', at: '2026-07-29T20:00:00.55+00:00', outcome: 'the real outcome', intent: '(prompt not shared)', project: 'Membridge', projectPath: null, projectId: 'proj-1' }),
        entry({ id: 's-2|2026-07-29T19:00:00.100Z', session: 's-2', at: '2026-07-29T19:00:00.100Z', outcome: 'the earlier outcome', intent: 'the earlier prompt', project: 'membridge', projectPath: '/Users/x/membridge', projectId: 'proj-1' }),
        entry({ id: 's-2|2026-07-29T19:00:00.1+00:00', session: 's-2', at: '2026-07-29T19:00:00.1+00:00', outcome: 'the earlier outcome', intent: '(prompt not shared)', project: 'Membridge', projectPath: null, projectId: 'proj-1' }),
      ],
      nextBefore: null, dayDigests: [],
    })
    const { container } = renderWith(c, <FeedPage />)
    await screen.findByText('the real outcome')
    expect(container.querySelectorAll('.day-card')).toHaveLength(1)
    // And the counts have not doubled either: two sessions, not four.
    expect(screen.getByText('2 sessions')).toBeInTheDocument()
    // Nor is the project listed twice under its two capitalisations.
    expect(container.querySelector('.day-card-sub')!.textContent).toContain('membridge ·')
  })

  it('orders cards by their newest entry, under one day divider', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [
        entry({ id: 'a', session: 'a', authorId: 'sarah', author: 'Sarah', at: '2026-07-29T17:00:00Z', outcome: 'the older card' }),
        entry({ id: 'b', session: 'b', authorId: 'marco', author: 'Marco', at: '2026-07-29T19:00:00Z', outcome: 'the newer card' }),
      ],
      nextBefore: null, dayDigests: [],
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
      nextBefore: null, dayDigests: [],
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
  // DEFECT 2, and the decision behind it. A card used to render "No summary
  // yet for this day." and a paragraph under it, which read as a contradiction
  // because BOTH lines came from the day's outcomes: the header said no outcome
  // was recorded while the line under it printed outcomes.
  //
  // Now they are independent facts, and both are kept. The header is about what
  // was DONE ("nobody has written up this work"); the intent is about what was
  // ASKED, which is a different thing to know and, on a day with no summary, the
  // only thing known at all. Withholding it would leave a card that says nothing
  // whatsoever about a day that really happened. The two lines no longer
  // contradict because they no longer describe the same thing.
  it('still says an un-summarized day is un-summarized, and keeps the ask under it', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [entry({ id: 'a', session: 'a', outcome: '', intent: 'wire the recall hook into the Stop path' })],
      nextBefore: null, dayDigests: [],
    })
    const { container } = renderWith(c, <FeedPage />)
    expect(await screen.findByText(NO_SUMMARY_OVERVIEW)).toBeInTheDocument()
    expect(container.querySelector('.day-card-intent')!.textContent)
      .toBe('wire the recall hook into the Stop path.')
  })

  it('adds no intent at all when the day captured no usable ask', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [entry({ id: 'a', session: 'a', outcome: '', intent: 'continue' })],
      nextBefore: null, dayDigests: [],
    })
    const { container } = renderWith(c, <FeedPage />)
    expect(await screen.findByText(NO_SUMMARY_OVERVIEW)).toBeInTheDocument()
    expect(container.querySelector('.day-card-intent')).toBeNull()
  })

  it('says an ENCRYPTED day is encrypted, never passing it off as un-summarized', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [entry({ id: 'a', session: 'a', outcome: '', undecryptable: true })],
      nextBefore: null, dayDigests: [],
    })
    const { container } = renderWith(c, <FeedPage />)
    expect(await screen.findByText(OPAQUE_OVERVIEW)).toBeInTheDocument()
    expect(screen.queryByText(NO_SUMMARY_OVERVIEW)).toBeNull()
    expect(container.querySelector('.day-card-intent')).toBeNull()
  })
})

// Arriving from a Today card: `?session=` names a session, and the feed is
// days now, with nothing on it left to expand. The param has to keep working
// or every Today row's link silently no-ops -- LiveEntry.tsx builds all of
// them this way, and so does every such URL already pasted into a chat.
describe('feed: a session targeted by ?session=', () => {
  const entries = [
    entry({ id: 'e1', session: 'sess-a', outcome: 'the targeted work' }),
    entry({ id: 'e2', session: 'sess-b', at: '2026-07-28T20:00:00Z', outcome: 'some other work' }),
  ]
  const client = () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({ entries, nextBefore: null, dayDigests: [] })
    return c
  }

  it('hands the reader on to the day holding that session, target intact', async () => {
    window.history.replaceState({}, '', '/feed?session=sess-a')
    renderWith(client(), <FeedPage />)
    await screen.findByText('the targeted work')
    const expected = daySessionHref(buildDayCards(entries)[0].slug, 'sess-a')
    await vi.waitFor(() => {
      expect(window.location.pathname + window.location.search).toBe(expected)
    })
  })

  it('marks the card holding the target and links straight at that session', async () => {
    window.history.replaceState({}, '', '/feed?session=sess-a')
    const { container } = renderWith(client(), <FeedPage />)
    await screen.findByText('the targeted work')
    const targeted = container.querySelectorAll('.day-card-targeted')
    expect(targeted).toHaveLength(1)
    expect(targeted[0].getAttribute('href')).toBe(daySessionHref(buildDayCards(entries)[0].slug, 'sess-a'))
  })

  it('renders the feed normally, and goes nowhere, when the target is not on the loaded pages', async () => {
    // The feed is paged; a live session can easily sit past the first page.
    // Degrading to a plain feed is the only honest option, and it must never
    // throw into the render path or redirect to a day that is not there.
    window.history.replaceState({}, '', '/feed?session=sess-not-loaded')
    const { container } = renderWith(client(), <FeedPage />)
    await screen.findByText('the targeted work')
    expect(container.querySelectorAll('.day-card-targeted')).toHaveLength(0)
    expect(container.querySelector('.day-card')!.getAttribute('href')).toBe(hrefFor(entries))
    expect(window.location.pathname).toBe('/feed')
  })

  it('marks nothing when there is no session param at all', async () => {
    window.history.replaceState({}, '', '/feed')
    const { container } = renderWith(client(), <FeedPage />)
    await screen.findByText('the targeted work')
    expect(container.querySelectorAll('.day-card-targeted')).toHaveLength(0)
    expect(window.location.pathname).toBe('/feed')
  })
})

// The general day header the owner asked for. It is a DAEMON field, because a
// sentence about a whole day cannot be composed from the day's headline
// fragments without producing garbage -- dayCards.ts has the rule and the
// tests. These pin the wiring at the real component, and pin that a daemon
// which does not serve it yet still renders a usable card.
describe('feed: the daemon\'s day sentence', () => {
  const withDigest = (over: Record<string, unknown> = {}, extra: FeedEntry[] = []) => {
    const entries = [
      entry({ id: 'a', session: 's-1', authorId: 'marco', author: 'Marco', at: '2026-07-29T20:00:00Z', outcome: 'one session\'s own outcome', intent: 'then package the dmg properly' }),
      entry({ id: 'b', session: 's-2', authorId: 'marco', author: 'Marco', at: '2026-07-29T19:00:00Z', outcome: 'an earlier outcome', intent: 'get the install flow working end to end' }),
      ...extra,
    ]
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries,
      nextBefore: null,
      dayDigests: [{
        key: '2026-07-29 id:marco',
        kind: 'distilled',
        text: 'Worked on UI fixes, app install and dmg',
        sources: [{ entryId: 'a', session: 's-1', ts: '2026-07-29T20:00:00Z', project: 'membridge', projectId: null, distilled: true, text: 'x' }],
        sessions: 2,
        summarized: 2,
        omittedSessions: 0,
        entries: 2,
        complete: true,
        coverageNote: null,
        ...over,
      }],
    })
    return c
  }

  it('leads the card with the daemon\'s sentence, not with one session\'s outcome', async () => {
    const { container } = renderWith(withDigest(), <FeedPage />)
    expect(await screen.findByText('Worked on UI fixes, app install and dmg')).toBeInTheDocument()
    const overviews = [...container.querySelectorAll('.day-card-overview')].map(el => el.textContent)
    expect(overviews).toEqual(['Worked on UI fixes, app install and dmg'])
  })

  it('carries the ASK underneath it, which is a different sentence entirely', async () => {
    const { container } = renderWith(withDigest(), <FeedPage />)
    await screen.findByText('Worked on UI fixes, app install and dmg')
    const intent = container.querySelector('.day-card-intent')!.textContent!
    expect(intent).toBe('get the install flow working end to end. then package the dmg properly.')
    expect(intent).not.toContain('Worked on UI fixes')
  })

  // DEFECT 3. The note used to render whenever the daemon set one, and the
  // daemon sets one per PAGE, so it fired on 3 of the 6 cards in Andrew's real
  // feed including days that were fully loaded. At that rate it is decoration.
  it('warns when the daemon dropped statements to its own cap', async () => {
    const note = '2 more sessions not shown'
    renderWith(withDigest({ omittedSessions: 2, coverageNote: note }), <FeedPage />)
    expect(await screen.findByText(note)).toBeInTheDocument()
  })

  it('shows no coverage note for a digest that saw the whole day', async () => {
    const { container } = renderWith(withDigest(), <FeedPage />)
    await screen.findByText('Worked on UI fixes, app install and dmg')
    expect(container.querySelector('.day-card-coverage')).toBeNull()
  })

  it('drops a page-truncation warning once the feed has loaded past that day', async () => {
    // `complete: false` is a fact about the page the digest came from. The
    // fixture's entries are all on 2026-07-29 and the feed has also loaded
    // 2026-07-28, so the client is past the start of the day and the page's
    // warning no longer describes anything.
    const { container } = renderWith(withDigest(
      { complete: false, coverageNote: 'showing only the part of this day that has loaded' },
      [entry({ id: 'older', session: 's-old', at: '2026-07-28T20:00:00Z', outcome: 'the previous day' })],
    ), <FeedPage />)
    await screen.findByText('Worked on UI fixes, app install and dmg')
    expect(container.querySelectorAll('.day-card-coverage')).toHaveLength(0)
  })

  it('keeps that warning while the feed is still mid-day', async () => {
    // Nothing older than the day itself is loaded, so the client cannot say
    // the rest of the day is in hand and the daemon's warning stands.
    renderWith(withDigest({ complete: false, coverageNote: 'showing only the part of this day that has loaded' }), <FeedPage />)
    expect(await screen.findByText('showing only the part of this day that has loaded')).toBeInTheDocument()
  })

  it('falls back to its own picked sentence against a daemon that sends none', async () => {
    // Every FakeDataClient page ships dayDigests: [], which is exactly the
    // older-daemon state. A blank card here would be the regression.
    const { container } = renderWith(marcosDayClient(), <FeedPage />)
    await screen.findByText('the day\'s distilled outcome')
    expect(container.querySelector('.day-card-overview')!.textContent).toBe('the day\'s distilled outcome')
    expect(container.querySelector('.day-card-coverage')).toBeNull()
  })
})

// Andrew's ask: "Id also like the top 3 files touched on the day cards, along
// with the tool(s) used". The card's last line, quietest thing on it, and the
// one place the feed says WHAT was touched rather than what it was about.
describe('feed: what the day touched', () => {
  const touchedLine = async (entries: FeedEntry[]) => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({ entries, nextBefore: null, dayDigests: [] })
    const { container } = renderWith(c, <FeedPage />)
    await screen.findByText('the day\'s outcome')
    const card = container.querySelector('.day-card') as HTMLElement
    return { card, touched: card.querySelector('.day-card-touched') }
  }

  const worked = (over: Partial<FeedEntry>) =>
    entry({ outcome: 'the day\'s outcome', ...over })

  it('names the tools used, then the three most-touched files', async () => {
    const { touched } = await touchedLine([
      worked({ id: 'a', session: 's1', tool: 'Claude Code', files: ['lib/feed.js', 'ui/src/features/feed/dayCards.ts'] }),
      worked({ id: 'b', session: 's2', tool: 'Claude Code', at: '2026-07-29T19:00:00Z', files: ['lib/feed.js'] }),
      worked({ id: 'c', session: 's3', tool: 'Codex', at: '2026-07-29T18:00:00Z', files: ['feed.css'] }),
    ])
    expect(touched!.querySelector('.day-card-tools')!.textContent).toBe('Claude Code, Codex')

    const files = [...touched!.querySelectorAll('.day-card-file')]
    // Shortened from the LEFT, and each one keeps its full path in `title`, so
    // nothing the 10px line clipped is unrecoverable.
    expect(files.map(f => f.textContent)).toEqual([
      'lib/feed.js2x', 'feed.css1x', '…/feed/dayCards.ts1x',
    ])
    expect(files.map(f => f.getAttribute('title'))).toEqual([
      'lib/feed.js', 'feed.css', 'ui/src/features/feed/dayCards.ts',
    ])
    // Tools FIRST: a short, near-constant label holds a stable left edge down a
    // column of cards, where the ranked paths belong on the elastic right.
    expect(touched!.firstElementChild!.className).toBe('day-card-tools')
  })

  it('shows exactly three files however many the day touched', async () => {
    // The total is already on the stat line ("5 files"), so a second count here
    // would be noise. Three, and the rest are on the day view.
    const { card, touched } = await touchedLine([
      worked({ id: 'a', session: 's1', files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] }),
    ])
    expect(touched!.querySelectorAll('.day-card-file')).toHaveLength(3)
    expect(card.querySelector('.day-card-stats')!.textContent).toContain('5 files')
  })

  it('renders however few files there are, never padded to three', async () => {
    const { touched } = await touchedLine([
      worked({ id: 'a', session: 's1', files: ['lib/feed.js'] }),
    ])
    expect(touched!.querySelectorAll('.day-card-file')).toHaveLength(1)
  })

  it('carries the tool alone when the day touched no files', async () => {
    const { touched } = await touchedLine([
      worked({ id: 'a', session: 's1', tool: 'Cursor', files: [] }),
    ])
    expect(touched!.querySelector('.day-card-tools')!.textContent).toBe('Cursor')
    expect(touched!.querySelectorAll('.day-card-file')).toHaveLength(0)
  })

  it('carries the files alone when no tool name was captured', async () => {
    const { touched } = await touchedLine([
      worked({ id: 'a', session: 's1', tool: '', files: ['lib/feed.js'] }),
    ])
    expect(touched!.querySelector('.day-card-tools')).toBeNull()
    expect(touched!.querySelectorAll('.day-card-file')).toHaveLength(1)
  })

  it('drops the whole line for a day with neither, rather than an empty row', async () => {
    const { touched } = await touchedLine([
      worked({ id: 'a', session: 's1', tool: '', files: [] }),
    ])
    expect(touched).toBeNull()
  })
})
