import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { focusManager } from '@tanstack/react-query'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { FEED_PAGE_SIZE } from '../../data/queries'
import type { FeedEntry } from '../../data/types'
import { dayCardStats } from './DayCard'
import { NO_SUMMARY_OVERVIEW, OPAQUE_OVERVIEW } from './dayCards'
import { ROUTES, sessionHref } from '../../app/routes'
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

/** Expand the day card whose overview matches, and hand back the card element.
 *  Every "what does a row look like" assertion below goes through this: the
 *  sessions are the card's SECOND level now, and asserting on them without
 *  opening the card would silently pass against a card that renders nothing. */
async function expandCard(overview: RegExp | string): Promise<HTMLElement> {
  const head = (await screen.findByText(overview)).closest('.day-card-head') as HTMLElement
  await userEvent.click(head)
  return head.closest('.day-card') as HTMLElement
}

/** The session row inside an expanded card whose text matches. The card's own
 *  overview matches the same text (it is a PICK of one row's outcome), so
 *  every row assertion has to say "the one inside an .entry-row" explicitly. */
function rowWithin(card: HTMLElement, text: RegExp | string): HTMLElement {
  const hit = within(card).getAllByText(text).find(el => el.closest('.entry-row'))
  return hit!.closest('.entry-row') as HTMLElement
}

// The stat line is a LIST of parts, not a sentence, because the owner asked
// for a prompt count here and no daemon field carries one yet. When it lands
// it is one more part; these cases are what says the shape already allows it.
describe('dayCardStats', () => {
  it('says how many sessions the day holds', () => {
    expect(dayCardStats({ sessionCount: 3 })).toEqual(['3 sessions'])
  })
  it('does not say "1 sessions"', () => {
    expect(dayCardStats({ sessionCount: 1 })).toEqual(['1 session'])
  })
})

describe('FeedPage', () => {
  it('renders each entry with its outcome, intent, and the project name in mono', async () => {
    renderApp({}, <FeedPage />)
    const card = await expandCard(/Hook ownership now decided by durability/)
    const row = rowWithin(card, /Hook ownership now decided by durability/)
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
  // a div. The card that reveals it is a <button>, not a second anchor.
  it('a row with a session renders as a link to /sessions/:id built from ROUTES', async () => {
    renderApp({}, <FeedPage />)
    const card = await expandCard(/Hook ownership now decided by durability/)
    const row = rowWithin(card, /Hook ownership now decided by durability/)
    expect(row.tagName).toBe('A')
    // Carries ?from= so the session page's back link can say "the Feed" and
     // mean it (Task 2), rather than saying it because it had no alternative.
    expect(row.getAttribute('href')).toBe(sessionHref('s-f2', ROUTES.feed))
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
      vi.spyOn(client, 'getFeed').mockResolvedValue({ entries: [], nextBefore: null })
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

  it('"Show more" pages backwards using the previous page\'s cursor, keeping the earlier page visible', async () => {
    // Distinct days, so the two pages are two cards -- one card per person per
    // project per day would otherwise fold both pages' single entries together
    // and this would be asserting on the overview pick instead of on paging.
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed')
      .mockResolvedValueOnce({ entries: [entry({ id: 'page1', session: 'p1', outcome: 'first page entry' })], nextBefore: '2026-07-20T00:00:00Z' })
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

    // One card (one person, one project, one day), and inside it two rows --
    // the card's own overview is the third match, which is the PICK, not a
    // third session.
    const card = await expandCard('identical summary text')
    expect(within(card).getAllByText('identical summary text')).toHaveLength(3)
    expect(card.querySelectorAll('.entry-row')).toHaveLength(2)
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

    const card = await expandCard('newer session outcome')
    const rows = within(card).getAllByText(/session outcome/).filter(el => el.closest('.entry-row'))
    expect(rows.map(r => r.textContent)).toEqual(['newer session outcome', 'older session outcome'])
  })
})

// The owner's ask: "there shouldnt be a bunch of sessions from marco just
// today. it should be one singular one with the proper overview sentance."
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

  it('leads with ONE picked overview sentence, not every session\'s summary', async () => {
    renderWith(marcosDay(), <FeedPage />)
    expect(await screen.findByText('the day\'s distilled outcome')).toBeInTheDocument()
    expect(screen.queryByText('a raw harvested line')).toBeNull()
    expect(screen.queryByText('another harvested line')).toBeNull()
  })

  it('states the session count', async () => {
    renderWith(marcosDay(), <FeedPage />)
    await screen.findByText('the day\'s distilled outcome')
    expect(screen.getByText('3 sessions')).toBeInTheDocument()
  })

  it('is collapsed by default', async () => {
    const { container } = renderWith(marcosDay(), <FeedPage />)
    await screen.findByText('the day\'s distilled outcome')
    expect(container.querySelector('.day-card-head')!.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('.entry-row')).toHaveLength(0)
  })

  it('reveals the day\'s sessions on expand, each still linking to its session page', async () => {
    const { container } = renderWith(marcosDay(), <FeedPage />)
    const card = await expandCard('the day\'s distilled outcome')
    expect(card.querySelectorAll('.entry-row')).toHaveLength(3)
    const hrefs = [...container.querySelectorAll('.entry-row')].map(r => r.getAttribute('href'))
    expect(hrefs).toEqual(['s-m1', 's-m2', 's-m3'].map(id => sessionHref(id, ROUTES.feed)))
  })

  it('splits one person\'s day across the two projects they worked in', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [
        entry({ id: 'a', session: 'a', at: '2026-07-29T20:00:00Z', outcome: 'membridge work', project: 'membridge', projectPath: '/Users/x/membridge' }),
        entry({ id: 'b', session: 'b', at: '2026-07-29T19:00:00Z', outcome: 'sublease work', project: 'sublease', projectPath: '/Users/x/sublease' }),
      ],
      nextBefore: null,
    })
    const { container } = renderWith(c, <FeedPage />)
    await screen.findByText('membridge work')
    expect(screen.getByText('sublease work')).toBeInTheDocument()
    expect(container.querySelectorAll('.day-card')).toHaveLength(2)
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
  it('says an un-summarized day is un-summarized', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [entry({ id: 'a', session: 'a', outcome: '', intent: 'wire the recall hook' })],
      nextBefore: null,
    })
    renderWith(c, <FeedPage />)
    expect(await screen.findByText(NO_SUMMARY_OVERVIEW)).toBeInTheDocument()
  })

  it('says an ENCRYPTED day is encrypted, never passing it off as un-summarized', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [entry({ id: 'a', session: 'a', outcome: '', undecryptable: true })],
      nextBefore: null,
    })
    renderWith(c, <FeedPage />)
    expect(await screen.findByText(OPAQUE_OVERVIEW)).toBeInTheDocument()
    expect(screen.queryByText(NO_SUMMARY_OVERVIEW)).toBeNull()
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

  // Day cards are collapsed by default, so the card HOLDING the target has to
  // open itself -- otherwise the row every Today card links at is unreachable
  // and the link may as well not exist.
  it('opens the card holding the target, and marks the matching row only', async () => {
    window.history.replaceState({}, '', '/feed?session=sess-a')
    const { container } = renderWith(client(), <FeedPage />)
    await screen.findAllByText('the targeted work')
    expect(container.querySelector('.day-card-head')!.getAttribute('aria-expanded')).toBe('true')
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
    expect(container.querySelector('.day-card-head')!.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('.entry-row-targeted')).toHaveLength(0)
  })

  it('marks nothing when there is no session param at all', async () => {
    window.history.replaceState({}, '', '/feed')
    const { container } = renderWith(client(), <FeedPage />)
    await screen.findByText('the targeted work')
    expect(container.querySelectorAll('.entry-row-targeted')).toHaveLength(0)
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
    vi.spyOn(client, 'getFeed').mockResolvedValue({ entries: [], nextBefore: null })
    renderWith(client, <FeedPage />)

    expect(await screen.findByText('Nothing yet.')).toBeInTheDocument()
    expect(screen.queryByTestId('feed-loading')).toBeNull()
  })
})
