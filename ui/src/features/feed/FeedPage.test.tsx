import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { focusManager } from '@tanstack/react-query'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { FEED_PAGE_SIZE } from '../../data/queries'
import type { FeedEntry } from '../../data/types'
import { dayCardStats, projectLabel } from './DayCard'
import { NO_SUMMARY_OVERVIEW, OPAQUE_OVERVIEW, buildDayCards } from './dayCards'
import { dayHref, daySessionHref } from '../../app/routes'
import { FeedPage, UNDATED_LABEL, dayLabel, groupByDay } from './FeedPage'

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

  // T-81. The dropdown used to list `status.tools` -- tools the daemon has
  // SPOTTED on disk. A first-run machine where Codex is installed but has
  // never fired listed Codex in the filter, and selecting it emptied the
  // feed. The fix is a monotonic set of tools that have ever produced a row
  // this session, union with the current filter.
  describe('the tool filter lists tools that have fired here, not tools spotted on disk', () => {
    it('shows a tool once entries carrying it have loaded', async () => {
      renderWith(new FakeDataClient(), <FeedPage />)
      const select = await screen.findByLabelText('Filter by tool')
      // The default fixture serves Codex and Claude Code rows.
      await within(select).findByRole('option', { name: 'Codex' })
      expect(within(select).getByRole('option', { name: 'Claude Code' })).toBeInTheDocument()
    })

    it('does NOT list a tool the daemon reports as spotted but which has never fired here', async () => {
      // status.tools carries a tool that has no matching entry -- the old
      // dropdown showed it and selecting it emptied the feed. The new
      // dropdown draws from entries only, so this "spotted but silent" tool
      // must not appear.
      const client = new FakeDataClient()
      const status = await client.getStatus()
      vi.spyOn(client, 'getStatus').mockResolvedValue({
        ...status,
        tools: ['Claude Code', 'Codex', 'Cursor'], // Cursor is spotted, but no fixture row uses it
      })
      renderWith(client, <FeedPage />)
      const select = await screen.findByLabelText('Filter by tool')
      await within(select).findByRole('option', { name: 'Codex' })
      expect(within(select).queryByRole('option', { name: 'Cursor' })).toBeNull()
    })

    it('lists nothing beyond "All tools" when nothing has fired yet', async () => {
      const client = new FakeDataClient()
      // status still claims a tool is watched, but the feed is empty --
      // exactly the ticket's first-run case (Codex spotted, nothing synced).
      vi.spyOn(client, 'getFeed').mockResolvedValue({ entries: [], nextBefore: null, dayDigests: [] })
      renderWith(client, <FeedPage />)
      const select = await screen.findByLabelText('Filter by tool')
      // "All tools" is the resting option and must stay.
      expect(within(select).getByRole('option', { name: 'All tools' })).toBeInTheDocument()
      // Two known daemon-reported tools from the default fixture ('Claude
      // Code', 'Codex'); neither may appear now that no row carries them.
      expect(within(select).queryByRole('option', { name: 'Codex' })).toBeNull()
      expect(within(select).queryByRole('option', { name: 'Claude Code' })).toBeNull()
    })
  })

  it('auto-pages until the feed covers a few whole days, without a click', async () => {
    // The starvation the owner hit: /api/feed pages by ROW and grouping
    // happens after, so one busy teammate's 30 rows fill page one and a
    // quieter person's card for the same day lands behind "Show more". The
    // feed keeps pulling until it has MIN_DAYS_LOADED days.
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed')
      .mockResolvedValueOnce({ entries: [entry({ id: 'p1', session: 'p1', outcome: 'busy teammate' })], nextBefore: '2026-07-20T00:00:00Z', dayDigests: [] })
      .mockResolvedValueOnce({ entries: [entry({ id: 'p2', session: 'p2', at: '2026-07-19T20:00:00Z', outcome: 'quiet teammate' })], nextBefore: '2026-07-18T00:00:00Z', dayDigests: [] })
      .mockResolvedValueOnce({ entries: [entry({ id: 'p3', session: 'p3', at: '2026-07-17T20:00:00Z', outcome: 'older still' })], nextBefore: null, dayDigests: [] })
    renderWith(client, <FeedPage />)

    // No click anywhere in this test.
    expect(await screen.findByText('older still')).toBeInTheDocument()
    expect(screen.getByText('quiet teammate')).toBeInTheDocument()
    expect(spy).toHaveBeenCalledTimes(3)
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
    await new Promise(r => setTimeout(r, 400))
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('stops auto-paging when further pages add no new day', async () => {
    // The other non-progress case: the daemon keeps answering, and keeps
    // answering with the same day. Progress is tracked on the page count, so
    // each state is asked about once and the cap ends it.
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed').mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 5))
      return { entries: [entry({ id: 'same', session: 'same', outcome: 'one day only' })], nextBefore: '2026-07-20T00:00:00Z', dayDigests: [] }
    })
    renderWith(client, <FeedPage />)
    await screen.findByText('one day only')
    await new Promise(r => setTimeout(r, 400))
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
        nextBefore: '2026-07-20T00:00:00Z', dayDigests: [],
      })
      .mockResolvedValueOnce({ entries: [entry({ id: 'page2', session: 'p2', at: '2026-07-19T20:00:00Z', outcome: 'second page entry' })], nextBefore: null, dayDigests: [] })
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

  it('shows the areas a day touched, as inert tags', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [entry({
        id: 'a', session: 's-1', outcome: 'Reworked the feed cards',
        files: ['ui/src/features/feed/DayCard.tsx', 'ui/src/features/feed/feed.css'],
      })],
      nextBefore: null, dayDigests: [],
    })
    renderWith(c, <FeedPage />)

    const card = (await screen.findByText('Reworked the feed cards')).closest('.day-card') as HTMLElement
    const tags = within(card).getByTestId('day-card-tags')
    expect(tags).toHaveTextContent('UI/UX')
    // The card is itself an <a>; a nested interactive element would be unnested
    // by the parser and the DOM would stop matching the JSX.
    expect(tags.querySelector('a, button')).toBeNull()
  })

  it('renders no tag strip at all for a day with no recognisable files', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [entry({ id: 'a', session: 's-1', outcome: 'Thinking, mostly', files: [] })],
      nextBefore: null, dayDigests: [],
    })
    renderWith(c, <FeedPage />)

    const card = (await screen.findByText('Thinking, mostly')).closest('.day-card') as HTMLElement
    expect(within(card).queryByTestId('day-card-tags')).toBeNull()
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

// T-72. The Feed's gate was already correct — "Nothing yet." never appeared over
// a loading feed. The other half was missing: measured per animation frame, the
// body was entirely empty from 87ms to 1402ms, so the screen read as a Feed that
// HAD loaded and found nothing. Same wrong conclusion, reached by omission
// rather than by copy.
describe('FeedPage while the first page is still in flight', () => {
  it('shows placeholder rows rather than an empty body', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getFeed').mockReturnValue(new Promise<never>(() => {}))
    renderWith(client, <FeedPage />)

    expect(await screen.findByTestId('feed-loading')).toBeInTheDocument()
    // And still not the empty-state claim.
    expect(screen.queryByText('Nothing yet.')).toBeNull()
  })

  it('says nothing yet only once the feed has actually come back empty', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getFeed').mockResolvedValue({ entries: [], nextBefore: null, dayDigests: [] })
    renderWith(client, <FeedPage />)

    expect(await screen.findByText('Nothing yet.')).toBeInTheDocument()
    expect(screen.queryByTestId('feed-loading')).toBeNull()
  })
})
