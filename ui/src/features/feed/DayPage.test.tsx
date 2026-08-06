import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { App } from '../../app/App'
import { FEED_PAGE_SIZE } from '../../data/queries'
import type { FeedEntry, FeedFilters, FeedPage as FeedPageData } from '../../data/types'
import { ROUTES, dayHref, daySessionHref, sessionHref } from '../../app/routes'
import { DAY_FILE_LIMIT, buildDayCards, dayCardKey, daySlug } from './dayCards'
import { DayPage } from './DayPage'
import { MAX_AUTO_PAGES } from './FeedPage'
import { sessionTimeRange } from './DaySessionRow'

const entry = (overrides: Partial<FeedEntry> = {}): FeedEntry => ({
  id: 'e1', author: 'Andrew', authorId: 'andrew', tool: 'Codex', at: '2026-07-29T20:00:00Z',
  live: false, outcome: 'done', intent: null, files: [], session: 's-1',
  project: 'membridge', projectPath: '/Users/x/membridge', projectId: null,
  summaryFull: null, decisions: null, gotchas: null, changes: [],
  ...overrides,
})

/** A slug for a day nobody in the fixture worked. Minted through the same
 *  functions the feed uses, so it is a well-formed slug that simply names no
 *  loaded card -- which is the state under test, rather than a malformed URL. */
const ABSENT_SLUG = daySlug(dayCardKey(entry({ at: '2026-01-01T20:00:00Z', authorId: 'nobody' })))

/** Render the day view for a set of entries, at the slug the feed would
 *  actually mint for them. Going through buildDayCards rather than
 *  hand-writing a slug is the point: it is what proves the feed's href and
 *  this page's lookup agree, which is the one thing a hand-written slug in a
 *  test could never catch. */
function renderDay(entries: FeedEntry[], opts: { slug?: string; search?: string } = {}) {
  const cards = buildDayCards(entries)
  const slug = opts.slug ?? cards[0].slug
  window.history.replaceState({}, '', dayHref(slug) + (opts.search ?? ''))
  const client = new FakeDataClient()
  vi.spyOn(client, 'getFeed').mockResolvedValue({ entries, nextBefore: null, dayDigests: [] })
  return { ...renderWith(client, <DayPage slug={slug} />), slug, cards }
}

// The suite is pinned to America/Los_Angeles (vite.config.ts, test.env.TZ), so
// "20:00Z" is 13:00 the same day.
describe('sessionTimeRange', () => {
  it('names a range when the session ran across several prompts', () => {
    expect(sessionTimeRange({ startedAt: '2026-07-29T20:00:00Z', endedAt: '2026-07-29T21:30:00Z' }))
      .toBe('1:00 PM to 2:30 PM')
  })
  it('names one time when the session landed one prompt, not "X to X"', () => {
    expect(sessionTimeRange({ startedAt: '2026-07-29T20:00:00Z', endedAt: '2026-07-29T20:00:00Z' }))
      .toBe('1:00 PM')
  })
})

describe('DayPage: a real day', () => {
  const aDay = () => [
    entry({
      id: 'a', session: 's-1', at: '2026-07-29T18:00:00Z', tool: 'Claude Code',
      outcome: 'Hook ownership now decided by durability',
      intent: 'make the summary hook fire on session boundaries',
      files: ['lib/hooks.js', 'test/run-tests.js'],
      changes: [{ file: 'lib/hooks.js', status: 'edited', add: 12, del: 3, note: 'gate extracted', dep: false }],
    }),
    entry({
      id: 'b', session: 's-1', at: '2026-07-29T19:00:00Z', tool: 'Claude Code',
      outcome: 'Hook ownership now decided by durability',
      intent: 'now make recall use the same gate',
      files: ['lib/hooks.js'],
    }),
    entry({
      id: 'c', session: 's-2', at: '2026-07-29T21:00:00Z', tool: 'Codex', distilled: true,
      outcome: 'Ports fixed and pushed',
      intent: 'fix the port collision in the test suite',
      files: ['test/run-tests.js'],
    }),
  ]

  it('leads with who, the projects, and the day\'s own sentence', async () => {
    const { container } = renderDay(aDay())
    expect(await screen.findByText('Ports fixed and pushed')).toBeInTheDocument()
    expect(container.querySelector('.day-head-name')!.textContent).toBe('Andrew')
    expect(container.querySelector('.day-head-sub')!.textContent).toContain('membridge')
  })

  it('names every file the day touched, most-touched first, with its note', async () => {
    const { container } = renderDay(aDay())
    await screen.findByText('Ports fixed and pushed')
    const files = [...container.querySelectorAll('.day-file-name')].map(el => el.textContent)
    expect(files).toEqual(['lib/hooks.js', 'test/run-tests.js'])
    expect(container.querySelector('.day-file-note')!.textContent).toBe('gate extracted')
    // Two entries named it. The change row annotates the file, it does not
    // count as a third touch: a note is a description, not a visit.
    expect(container.querySelector('.day-file-touches')!.textContent).toBe('2x')
  })

  it('lists what was done as bullets, deduped and never repeating the day\'s sentence', async () => {
    const { container } = renderDay(aDay())
    await screen.findByText('Ports fixed and pushed')
    const bullets = [...container.querySelectorAll('.day-bullet')].map(el => el.textContent)
    expect(bullets).toEqual(['Hook ownership now decided by durability'])
  })

  it('rolls the prompts up under their session, newest session first, prompts oldest first', async () => {
    const { container } = renderDay(aDay())
    await screen.findByText('Ports fixed and pushed')
    const groups = [...container.querySelectorAll('.day-session')]
    expect(groups).toHaveLength(2)
    expect(within(groups[0] as HTMLElement).getByText('Codex')).toBeInTheDocument()
    const secondGroupPrompts = [...groups[1].querySelectorAll('.day-prompt-text')].map(el => el.textContent)
    expect(secondGroupPrompts).toEqual([
      'make the summary hook fire on session boundaries',
      'now make recall use the same gate',
    ])
  })

  it('keeps every session one click from its own page', async () => {
    const entries = aDay()
    const { container, slug } = renderDay(entries)
    await screen.findByText('Ports fixed and pushed')
    const hrefs = [...container.querySelectorAll('.day-sessions .day-session-row')].map(a => a.getAttribute('href'))
    expect(hrefs).toEqual(['s-2', 's-1'].map(id => sessionHref(id, dayHref(slug))))
  })

  it('puts the sections in the owner\'s order: files, then summaries, then sessions', async () => {
    const { container } = renderDay(aDay())
    await screen.findByText('Ports fixed and pushed')
    const titles = [...container.querySelectorAll('.day-section-title')].map(el => el.textContent)
    expect(titles).toEqual(['Files touched2', 'Summaries1', 'Sessions2'])
  })

  it('offers a real way back to the Feed', async () => {
    const { container } = renderDay(aDay())
    await screen.findByText('Ports fixed and pushed')
    const back = container.querySelector('.day-back') as HTMLElement
    expect(back.getAttribute('href')).toBe(ROUTES.feed)
    expect(back.textContent).toContain('Back to the Feed')
  })

  it('omits a section entirely rather than rendering an empty heading', async () => {
    const { container } = renderDay([entry({ id: 'a', session: 's-1', outcome: '', intent: 'start', files: [] })])
    await screen.findByText(/No summary yet/)
    const titles = [...container.querySelectorAll('.day-section-title')].map(el => el.textContent)
    expect(titles).toEqual(['Sessions1'])
  })

  it('names which project a session ran in only on a day that spans several', async () => {
    const oneProject = renderDay(aDay())
    await screen.findByText('Ports fixed and pushed')
    expect(oneProject.container.querySelectorAll('.day-session-row-project')).toHaveLength(0)
    oneProject.unmount()

    const mixed = renderDay([
      entry({ id: 'a', session: 's-1', at: '2026-07-29T20:00:00Z', outcome: 'membridge work', project: 'membridge', projectPath: '/Users/x/membridge' }),
      entry({ id: 'b', session: 's-2', at: '2026-07-29T19:00:00Z', outcome: 'sublease work', project: 'sublease', projectPath: '/Users/x/sublease' }),
    ])
    await screen.findByText('membridge work')
    expect([...mixed.container.querySelectorAll('.day-sessions .day-session-row-project')].map(el => el.textContent))
      .toEqual(['membridge', 'sublease'])
  })

  it('marks and links the session a ?session= deep link named', async () => {
    const entries = aDay()
    const cards = buildDayCards(entries)
    const { container } = renderDay(entries, { search: '?session=s-1' })
    await screen.findByText('Ports fixed and pushed')
    const targeted = container.querySelectorAll('.day-session-targeted')
    expect(targeted).toHaveLength(1)
    // And a session opened from here comes back to the day, still marked.
    const href = targeted[0].querySelector('.day-session-row')!.getAttribute('href')
    expect(href).toBe(sessionHref('s-1', daySessionHref(cards[0].slug, 's-1')))
  })
})

// ---------------------------------------------------------------------------
// The three sections, as the owner asked for them.
//
// A note on how the folds are asserted: jsdom implements <details> as a plain
// element with a reflected `open` attribute and NO activation behavior on
// <summary> (node_modules/jsdom/.../HTMLDetailsElement-impl.js), so clicking a
// summary does not toggle anything and a closed fold's children are still in
// the DOM. Presence therefore proves nothing about open or closed. These tests
// assert the `open` property, which is the real state, and assert that the
// list lives INSIDE .day-fold-body, which is the real "it is behind the fold".
// ---------------------------------------------------------------------------
describe('DayPage: files touched, as a disclosure above the summaries', () => {
  /** 47 distinct paths: three the day kept coming back to, and 44 it touched
   *  once. Built as one entry's `files`, which dayFiles counts per occurrence. */
  const wideFiles = [
    ...Array.from({ length: 9 }, () => 'ui/src/features/feed/dayCards.ts'),
    ...Array.from({ length: 7 }, () => 'ui/src/features/feed/feed.css'),
    ...Array.from({ length: 5 }, () => 'ui/src/features/feed/DayPage.tsx'),
    ...Array.from({ length: 44 }, (_, i) => `lib/mod${String(i).padStart(2, '0')}.js`),
  ]

  const bigDay = () => [
    entry({
      id: 'a', session: 's-1', at: '2026-07-29T18:00:00Z', tool: 'Claude Code',
      outcome: 'Hook ownership now decided by durability',
      intent: 'make the summary hook fire on session boundaries',
      files: wideFiles,
      decisions: '- Durability beats recency\n- Merged before writing settings.json',
    }),
    entry({
      id: 'c', session: 's-2', at: '2026-07-29T21:00:00Z', tool: 'Codex', distilled: true,
      outcome: 'Ports fixed and pushed',
      intent: 'fix the port collision in the test suite',
      files: [],
    }),
  ]

  const filesFold = (container: HTMLElement) =>
    container.querySelector('.day-fold-body .day-files')!.closest('details') as HTMLDetailsElement

  it('heads the page with all three sections, in order, each carrying its count', async () => {
    const { container } = renderDay(bigDay())
    await screen.findByText('Ports fixed and pushed')
    const titles = [...container.querySelectorAll('.day-section-title')].map(el => el.textContent)
    expect(titles).toEqual(['Files touched47', 'Summaries3', 'Sessions2'])
  })

  it('starts the files fold closed, so the summaries stay above the fold', async () => {
    const { container } = renderDay(bigDay())
    await screen.findByText('Ports fixed and pushed')
    expect(filesFold(container).open).toBe(false)
  })

  it('names the three most-touched files, with their counts, while closed', async () => {
    const { container } = renderDay(bigDay())
    await screen.findByText('Ports fixed and pushed')
    // Counts on all three including a 1x, because here the number is the
    // ranking evidence rather than a badge.
    expect(container.querySelector('.day-fold-peek')!.textContent)
      .toBe('…/feed/dayCards.ts 9x · …/feed/feed.css 7x · …/feed/DayPage.tsx 5x')
  })

  it('puts the full ranked list behind the fold, most-touched first', async () => {
    const { container } = renderDay(bigDay())
    await screen.findByText('Ports fixed and pushed')
    const body = filesFold(container).querySelector('.day-fold-body')!
    const files = [...body.querySelectorAll('.day-file-name')].map(el => el.textContent)
    expect(files).toHaveLength(DAY_FILE_LIMIT)
    expect(files.slice(0, 3)).toEqual([
      'ui/src/features/feed/dayCards.ts',
      'ui/src/features/feed/feed.css',
      'ui/src/features/feed/DayPage.tsx',
    ])
  })

  it('keeps "+N more" inside the fold and still expanding the list', async () => {
    const { container } = renderDay(bigDay())
    await screen.findByText('Ports fixed and pushed')
    const more = await screen.findByRole('button', { name: '+35 more' })
    expect(more.closest('.day-fold-body')).not.toBeNull()

    await userEvent.click(more)
    expect(container.querySelectorAll('.day-file-name')).toHaveLength(47)
    // The heading count is the TOTAL throughout, never the shown-so-far number.
    expect(container.querySelector('.day-section-count')!.textContent).toBe('47')

    await userEvent.click(screen.getByRole('button', { name: 'Show fewer' }))
    expect(container.querySelectorAll('.day-file-name')).toHaveLength(DAY_FILE_LIMIT)
  })

  it('does not fold three files or fewer, because a chevron over nothing is a lie', async () => {
    const { container } = renderDay([entry({
      id: 'a', session: 's-1', outcome: 'a narrow day',
      files: ['lib/hooks.js', 'lib/feed.js', 'lib/scan.js'],
    })])
    await screen.findByText('a narrow day')
    expect(container.querySelector('.day-files')!.closest('details')).toBeNull()
    expect(container.querySelector('.day-fold-peek')).toBeNull()
    expect(container.querySelectorAll('.day-file-name')).toHaveLength(3)
  })

  it('drops the files section entirely on a day that touched none', async () => {
    const { container } = renderDay([entry({ id: 'a', session: 's-1', outcome: 'no files', files: [] })])
    await screen.findByText('no files')
    expect(container.querySelector('.day-files')).toBeNull()
    expect([...container.querySelectorAll('.day-section-title')].map(el => el.textContent))
      .not.toContain('Files touched')
  })
})

describe('DayPage: summaries, grouped under the session that produced them', () => {
  const aDay = () => [
    entry({
      id: 'a', session: 's-1', at: '2026-07-29T18:00:00Z', tool: 'Claude Code',
      outcome: 'Hook ownership now decided by durability',
      intent: 'make the summary hook fire on session boundaries',
    }),
    entry({
      id: 'c', session: 's-2', at: '2026-07-29T21:00:00Z', tool: 'Codex', distilled: true,
      outcome: 'Ports fixed and pushed', intent: 'fix the port collision',
    }),
  ]

  it('opens by default, because it is the answer the page exists to give', async () => {
    const { container } = renderDay(aDay())
    await screen.findByText('Ports fixed and pushed')
    const fold = container.querySelector('.day-summaries')!.closest('details') as HTMLDetailsElement
    expect(fold.open).toBe(true)
  })

  it('puts each session\'s bullets under a row that names that session', async () => {
    const { container, slug } = renderDay(aDay())
    await screen.findByText('Ports fixed and pushed')
    const groups = [...container.querySelectorAll('.day-summary-group')]
    expect(groups).toHaveLength(1)
    const row = groups[0].querySelector('.day-session-row')!
    expect(row.textContent).toContain('Claude Code')
    expect([...groups[0].querySelectorAll('.day-bullet')].map(el => el.textContent))
      .toEqual(['Hook ownership now decided by durability'])
    // The point of the row: read a bullet, click into the run that produced it.
    expect(row.tagName).toBe('A')
    expect(row.getAttribute('href')).toBe(sessionHref('s-1', dayHref(slug)))
  })

  it('carries no prompt count, because the bullets are already underneath', async () => {
    const { container } = renderDay(aDay())
    await screen.findByText('Ports fixed and pushed')
    expect(container.querySelector('.day-summary-group .day-session-row-meta')).toBeNull()
  })

  it('names the project on a summary row only when the day spans several', async () => {
    const oneProject = renderDay(aDay())
    await screen.findByText('Ports fixed and pushed')
    expect(oneProject.container.querySelectorAll('.day-summary-group .day-session-row-project')).toHaveLength(0)
    oneProject.unmount()

    const mixed = renderDay([
      entry({ id: 'a', session: 's-1', at: '2026-07-29T20:00:00Z', outcome: 'membridge work', project: 'membridge', projectPath: '/Users/x/membridge' }),
      entry({ id: 'b', session: 's-2', at: '2026-07-29T19:00:00Z', outcome: 'sublease work', project: 'sublease', projectPath: '/Users/x/sublease' }),
    ])
    await screen.findByText('membridge work')
    expect([...mixed.container.querySelectorAll('.day-summary-group .day-session-row-project')].map(el => el.textContent))
      .toEqual(['sublease'])
  })

  it('drops the summaries section entirely when no session produced a point', async () => {
    const { container } = renderDay([entry({ id: 'a', session: 's-1', outcome: '', intent: 'just an ask' })])
    await screen.findByText(/No summary yet/)
    expect(container.querySelector('.day-summaries')).toBeNull()
    expect([...container.querySelectorAll('.day-section-title')].map(el => el.textContent))
      .not.toContain('Summaries')
  })
})

describe('DayPage: sessions you click into', () => {
  const chatty = () => [
    entry({ id: 'a', session: 's-1', at: '2026-07-29T18:00:00Z', outcome: 'the day\'s work', intent: 'first ask' }),
    entry({ id: 'b', session: 's-1', at: '2026-07-29T19:00:00Z', outcome: 'the day\'s work', intent: 'second ask' }),
  ]

  it('makes the whole session header one link, not a timestamp with a chevron', async () => {
    const { container, slug } = renderDay(chatty())
    await screen.findByText('first ask')
    const row = container.querySelector('.day-sessions .day-session-row')!
    expect(row.tagName).toBe('A')
    expect(row.getAttribute('href')).toBe(sessionHref('s-1', dayHref(slug)))
    // Everything a reader targets is inside the one anchor.
    expect(row.querySelector('.day-session-row-time')!.textContent).toBe('11:00 AM to 12:00 PM')
    expect(row.querySelector('.day-session-row-chevron')).not.toBeNull()
  })

  it('says how many prompts a session captured, in words', async () => {
    const many = renderDay(chatty())
    await screen.findByText('first ask')
    expect(many.container.querySelector('.day-sessions .day-session-row-meta')!.textContent).toBe('2 prompts')
    many.unmount()

    const one = renderDay([entry({ id: 'a', session: 's-9', outcome: 'one ask only', intent: 'the only ask' })])
    await screen.findByText('the only ask')
    expect(one.container.querySelector('.day-sessions .day-session-row-meta')!.textContent).toBe('1 prompt')
    one.unmount()

    // A session that captured no prompt says nothing, rather than "0 prompts".
    const none = renderDay([entry({ id: 'a', session: 's-8', outcome: 'no ask captured', intent: null })])
    await screen.findByText('no ask captured')
    expect(none.container.querySelector('.day-sessions .day-session-row-meta')).toBeNull()
  })

  // <a> inside <a> is unnestable by the parser: the live DOM would silently
  // stop matching this JSX and every structural assertion here would go
  // strange. The prompts are a SIBLING of the row, never a child.
  it('keeps the prompt list a sibling of the row, never inside the anchor', async () => {
    const { container } = renderDay(chatty())
    await screen.findByText('first ask')
    const row = container.querySelector('.day-sessions .day-session-row')!
    expect(row.querySelector('.day-prompt')).toBeNull()
    expect(row.querySelector('a')).toBeNull()
    expect(row.nextElementSibling!.tagName).toBe('OL')
  })

  // The complaint this section answers is that sessions drop down instead of
  // opening. A per-session fold here would reintroduce exactly that.
  it('leaves the prompts unfolded, not behind a second disclosure', async () => {
    const { container } = renderDay(chatty())
    await screen.findByText('first ask')
    expect(container.querySelector('.day-session details')).toBeNull()
    expect([...container.querySelectorAll('.day-prompt-text')].map(el => el.textContent))
      .toEqual(['first ask', 'second ask'])
  })

  it('renders a session with no id as a row that is plainly not a link', async () => {
    const { container } = renderDay([entry({ id: 'bare', session: null, outcome: 'a bare-plumbing row' })])
    await screen.findByText('a bare-plumbing row')
    const rows = [...container.querySelectorAll('.day-session-row')]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.tagName).not.toBe('A')
      expect(row.classList.contains('day-session-row-static')).toBe(true)
      expect(row.querySelector('.day-session-row-chevron')).toBeNull()
    }
  })
})

// The consequence of the feed no longer running collapseSessionCheckpoints.
// memorydb.buildEntries emits one entry per PROMPT, so a session with ten
// prompts is ten rows sharing a session id; the collapse kept only the newest
// and threw the other nine away. The day view is what those prompts are for,
// and it must show the session ONCE while keeping all of them -- otherwise the
// card's "1 session" and the body underneath it disagree.
describe('DayPage: many prompts of one session', () => {
  const chatty = () => Array.from({ length: 12 }, (_, i) => entry({
    id: `p${i}`, session: 's-long', at: `2026-07-29T${String(10 + i).padStart(2, '0')}:00:00Z`,
    outcome: 'the session\'s settled outcome',
    intent: `prompt number ${i}`,
  }))

  it('renders one session group, not one per prompt', async () => {
    const { container } = renderDay(chatty())
    await screen.findByText('prompt number 0')
    expect(container.querySelectorAll('.day-session')).toHaveLength(1)
  })

  it('keeps every distinct prompt, in the order they were asked', async () => {
    const { container } = renderDay(chatty())
    await screen.findByText('prompt number 0')
    const prompts = [...container.querySelectorAll('.day-prompt-text')].map(el => el.textContent)
    expect(prompts).toHaveLength(12)
    expect(prompts[0]).toBe('prompt number 0')
    expect(prompts[11]).toBe('prompt number 11')
  })

  it('states the session\'s outcome once, not once per row', async () => {
    const { container } = renderDay(chatty())
    await screen.findByText('prompt number 0')
    // The overview picks it, so the bullet list drops it as a repeat: the
    // sentence appears exactly once on the page.
    expect(screen.getAllByText('the session\'s settled outcome')).toHaveLength(1)
    expect(container.querySelectorAll('.day-bullet')).toHaveLength(0)
  })

  it('keeps two distinct sessions with byte-identical text as two groups', async () => {
    const { container } = renderDay([
      entry({ id: 'x1', session: 's1', at: '2026-07-29T20:10:00Z', outcome: 'identical summary text', intent: 'identical ask' }),
      entry({ id: 'x2', session: 's2', at: '2026-07-29T20:05:00Z', outcome: 'identical summary text', intent: 'identical ask' }),
    ])
    await screen.findByText('identical summary text')
    expect(container.querySelectorAll('.day-session')).toHaveLength(2)
  })
})

// The twin, with the REAL asymmetry Postgres produces. test/mock-supabase.js
// returns pushed rows verbatim, so a fixture built from one shape would prove
// nothing at all.
describe('DayPage: work that synced back as its own twin', () => {
  const twinned = () => [
    entry({
      id: 's-1|2026-07-29T20:00:00.550Z', session: 's-1', at: '2026-07-29T20:00:00.550Z',
      outcome: 'the real outcome', intent: 'the verbatim prompt someone actually typed',
      files: ['lib/hooks.js'], project: 'membridge', projectPath: '/Users/x/membridge', projectId: 'proj-1',
    }),
    entry({
      id: 's-1|2026-07-29T20:00:00.55+00:00', session: 's-1', at: '2026-07-29T20:00:00.55+00:00',
      outcome: 'the real outcome', intent: '(prompt not shared)',
      files: ['lib/hooks.js'], project: 'Membridge', projectPath: null, projectId: 'proj-1',
    }),
  ]

  it('lists the session once, with the verbatim prompt and not the placeholder', async () => {
    const { container } = renderDay(twinned())
    await screen.findByText('the real outcome')
    expect(container.querySelectorAll('.day-session')).toHaveLength(1)
    const prompts = [...container.querySelectorAll('.day-prompt-text')].map(el => el.textContent)
    expect(prompts).toEqual(['the verbatim prompt someone actually typed'])
  })

  it('does not count the same file twice, nor the project under both spellings', async () => {
    const { container } = renderDay(twinned())
    await screen.findByText('the real outcome')
    expect(container.querySelector('.day-section-count')!.textContent).toBe('1')
    // One touch, so no "2x" badge at all.
    expect(container.querySelector('.day-file-touches')).toBeNull()
    expect(container.querySelector('.day-head-sub')!.textContent).not.toContain('Membridge')
  })
})

describe('DayPage: a day that is not there', () => {
  it('says so, with a way back, rather than rendering a blank page', async () => {
    const entries = [entry({ id: 'a', session: 's-1', outcome: 'a real day' })]
    const { container } = renderDay(entries, { slug: ABSENT_SLUG })
    expect(await screen.findByText(/not in view/i)).toBeInTheDocument()
    expect(container.querySelector('.day-back')!.getAttribute('href')).toBe(ROUTES.feed)
    expect(container.querySelector('.day-head')).toBeNull()
  })

  it('says the feed is paged, because a missing day is usually just older', async () => {
    const entries = [entry({ id: 'a', session: 's-1', outcome: 'a real day' })]
    renderDay(entries, { slug: ABSENT_SLUG })
    expect(await screen.findByText(/further back than what is loaded/i)).toBeInTheDocument()
  })

  it('offers to page further back when the feed has more to give', async () => {
    window.history.replaceState({}, '', dayHref(ABSENT_SLUG))
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed')
      .mockResolvedValueOnce({ entries: [entry({ id: 'a', session: 's-1' })], nextBefore: '2026-07-20T00:00:00Z', dayDigests: [] })
      .mockResolvedValueOnce({ entries: [entry({ id: 'b', session: 's-2', at: '2026-07-19T20:00:00Z' })], nextBefore: null, dayDigests: [] })
    renderWith(client, <DayPage slug={ABSENT_SLUG} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Look further back' }))
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('surfaces a daemon failure instead of claiming the day does not exist', async () => {
    window.history.replaceState({}, '', dayHref(ABSENT_SLUG))
    const client = new FakeDataClient({ failWith: 'daemon unreachable' })
    renderWith(client, <DayPage slug={ABSENT_SLUG} />)
    expect(await screen.findByText(/couldn't reach/i)).toBeInTheDocument()
    expect(screen.queryByText(/not in view/i)).toBeNull()
  })
})

describe('DayPage: a day this machine could not decrypt', () => {
  // The trap this whole feature keeps having to avoid: an empty summary and a
  // failed decrypt render identically unless something says which, and only
  // one of them is a condition to act on.
  const opaque = () => [
    entry({ id: 'a', session: 's-1', outcome: '', undecryptable: true, intent: null }),
    entry({ id: 'b', session: 's-2', at: '2026-07-29T19:00:00Z', outcome: '', undecryptable: true, intent: null }),
  ]

  it('says the day is encrypted rather than passing it off as un-summarized', async () => {
    const { container } = renderDay(opaque())
    expect(await screen.findByText(/could not be read on this machine/i)).toBeInTheDocument()
    expect(screen.queryByText(/No summary yet/)).toBeNull()
    expect(container.querySelector('.day-head-overview-opaque')).not.toBeNull()
  })

  it('invents no bullets and no intent for a day it cannot read', async () => {
    const { container } = renderDay(opaque())
    await screen.findByText(/could not be read on this machine/i)
    expect(container.querySelectorAll('.day-bullet')).toHaveLength(0)
    expect(container.querySelector('.day-head-intent')).toBeNull()
  })

  it('still lists the sessions, so the reader can see how much they cannot read', async () => {
    const { container } = renderDay(opaque())
    await screen.findByText(/could not be read on this machine/i)
    expect(container.querySelectorAll('.day-session')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Through the ROUTER, and through the real feed query.
//
// Everything above hands DayPage its slug as a PROP and mocks getFeed to one
// fixed answer whatever it is asked. Both of those are the seams that break,
// so both are exercised for real here: the URL goes through <App />'s own
// <Route path={ROUTES.day}>, and getFeed filters and pages the way the daemon
// does instead of answering every question identically.
// ---------------------------------------------------------------------------

/** A getFeed with the daemon's behavior: server-side filters, newest first,
 *  paged backwards on an INCLUSIVE `before` (lib/server.js). */
function pagedFeed(all: FeedEntry[]) {
  return async (filters: FeedFilters, opts: { limit: number; before: string | null }): Promise<FeedPageData> => {
    const rows = all
      .filter(e => !filters.author || e.authorId === filters.author)
      .filter(e => !filters.project || e.projectPath === filters.project)
      .filter(e => !filters.source || e.tool === filters.source)
      .filter(e => !opts.before || e.at <= opts.before)
      .sort((a, b) => b.at.localeCompare(a.at))
    const page = rows.slice(0, opts.limit)
    return { entries: page, nextBefore: rows.length > opts.limit ? page[page.length - 1].at : null, dayDigests: [] }
  }
}

describe('DayPage: reached through the route, not the prop', () => {
  // THE REGRESSION a prop-passed slug cannot catch. wouter runs decodeURI over
  // location.pathname before it matches (wouter/src/paths.js), and App.tsx
  // passes params.daySlug through undecoded, so a percent-encoded slug arrived
  // decoded and matched nothing. Measured on exactly these three shapes: a
  // space became a literal space, an accent became a literal accent, and %7E
  // became the separator itself. Every one was a visible card that answered
  // "not in view". The name half is where they live, because authorPart falls
  // back to the display name when there is no id.
  it('finds the day for an author whose name has a space, an accent and a tilde', async () => {
    const entries = [entry({
      id: 'a', session: 's-1', authorId: '', author: 'Renée o~brien Melika',
      outcome: 'the day the router used to lose',
    })]
    const card = buildDayCards(entries)[0]
    window.history.replaceState({}, '', dayHref(card.slug))
    const client = new FakeDataClient()
    vi.spyOn(client, 'getFeed').mockImplementation(pagedFeed(entries))
    const { container } = renderWith(client, <App />)

    expect(await screen.findByText('the day the router used to lose')).toBeInTheDocument()
    expect(screen.queryByText(/not in view/i)).toBeNull()
    expect(container.querySelector('.day-head-name')!.textContent).toBe('Renée o~brien Melika')
    // And the reason it works: the URL is a fixed point of decodeURI, so what
    // the router hands back is byte-for-byte what the card minted.
    expect(decodeURI(window.location.pathname)).toBe(window.location.pathname)
  })

  it('opens the day a card links to, clicked out of the feed for real', async () => {
    const entries = [entry({ id: 'a', session: 's-1', outcome: 'the clicked day', intent: 'the ask' })]
    window.history.replaceState({}, '', ROUTES.feed)
    const client = new FakeDataClient()
    vi.spyOn(client, 'getFeed').mockImplementation(pagedFeed(entries))
    const { container } = renderWith(client, <App />)

    await userEvent.click(await screen.findByText('the clicked day'))
    expect(await screen.findByText(/Back to the Feed/)).toBeInTheDocument()
    expect(container.querySelector('.day-head-name')!.textContent).toBe('Andrew')
    expect(screen.getByText('the ask')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// A FILTERED feed's cards.
//
// useFeed keys its cache on the filters, so a day view asking for the
// UNFILTERED feed is a different query key from the one the card was built
// from: a cold start, one page, and no way to reach a day the filter had
// pulled up from far further back.
// ---------------------------------------------------------------------------
describe('DayPage: a card clicked out of a filtered feed', () => {
  // One person's rows, all on the same local day, bury everybody else: that is
  // more than the day view could ever walk back to on its own, so the ONLY way
  // to reach Sarah's day is to ask the question the feed asked.
  //
  // THE COUNT IS LOAD-BEARING and must stay ahead of MAX_AUTO_PAGES. /api/feed's
  // `before` is inclusive, so page one carries FEED_PAGE_SIZE rows and every
  // page after it adds only FEED_PAGE_SIZE - 1 new ones: the walk reaches
  // 30 + (MAX_AUTO_PAGES - 1) * 29 rows, which is 146 at a cap of 5 and 407 at
  // a cap of 14. At 160 rows this fixture was exhausted in 6 calls, so raising
  // the cap did not just break the count assertion below, it reached Sarah and
  // destroyed the premise of the test: "not in view" stopped being true. 420
  // keeps the day genuinely out of reach at both caps, with room to raise it
  // again before this needs revisiting.
  const noisy = Array.from({ length: 420 }, (_, i) => entry({
    id: `n${i}`, session: `n${i}`, authorId: 'marco', author: 'Marco',
    at: new Date(Date.parse('2026-07-29T20:00:00Z') - i * 60_000).toISOString(),
    outcome: 'busy teammate',
  }))
  const quiet = [entry({
    id: 'q1', session: 'q1', authorId: 'sarah', author: 'Sarah',
    at: '2026-07-28T20:00:00Z', outcome: 'the quiet person\'s day',
  })]
  const fixture = [...noisy, ...quiet]

  it('renders the day, all the way from picking the filter to clicking the card', async () => {
    window.history.replaceState({}, '', ROUTES.feed)
    const client = new FakeDataClient({ solo: false })
    vi.spyOn(client, 'getFeed').mockImplementation(pagedFeed(fixture))
    const { container } = renderWith(client, <App />)

    const select = await screen.findByLabelText('Filter by person')
    await within(select).findByRole('option', { name: 'Sarah' })
    await userEvent.selectOptions(select, 'sarah')

    await userEvent.click(await screen.findByText('the quiet person\'s day'))

    // On the day view, with the day actually rendered.
    expect(await screen.findByText(/Back to the Feed/)).toBeInTheDocument()
    expect(screen.queryByText(/not in view/i)).toBeNull()
    expect(container.querySelector('.day-head-name')!.textContent).toBe('Sarah')
  })

  // The other half of the pair: the same day, at a URL carrying no filters, is
  // genuinely out of reach. Without it the test above could pass on paging
  // alone and prove nothing about the filters.
  //
  // This is also the REQUEST-STORM guard's proof. An effect keyed on
  // isFetchingNextPage with no progress record re-arms every time a fetch
  // settles; measured at 66 requests in 1.5s. Both assertions below are the
  // guard: a hard cap, and every request asking for a DIFFERENT cursor, which
  // is what "progress, not a fetching flag" means.
  it('cannot reach that day from an unfiltered URL, and gives up bounded', async () => {
    const card = buildDayCards(quiet)[0]
    window.history.replaceState({}, '', dayHref(card.slug))
    const client = new FakeDataClient({ solo: false })
    const spy = vi.spyOn(client, 'getFeed').mockImplementation(pagedFeed(fixture))
    renderWith(client, <App />)

    expect(await screen.findByText(/not in view/i)).toBeInTheDocument()
    await new Promise(resolve => setTimeout(resolve, 400))
    // Against the CONSTANT, never a literal. This asserted `<= 5` while
    // DayPage's cap was 5; the moment the feed raised MAX_AUTO_PAGES the
    // assertion failed on a bound that had moved legitimately, which is a test
    // reporting its own staleness as a defect in the code.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(MAX_AUTO_PAGES)
    const cursors = spy.mock.calls.map(([, opts]) => opts.before)
    expect(new Set(cursors).size).toBe(cursors.length)
  })

  it('stops paging when a page errors rather than retrying in a tight loop', async () => {
    const card = buildDayCards(quiet)[0]
    window.history.replaceState({}, '', dayHref(card.slug))
    const client = new FakeDataClient({ solo: false })
    const spy = vi.spyOn(client, 'getFeed').mockImplementation(async (_f, opts) => {
      await new Promise(r => setTimeout(r, 5))
      if (!opts?.before) return { entries: noisy.slice(0, 30), nextBefore: noisy[29].at, dayDigests: [] }
      throw new Error('daemon went away')
    })
    renderWith(client, <App />)

    await screen.findByText(/not in view/i)
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3)
  })

  // The day in the slug is a LOCAL calendar date; every `at` is a UTC instant.
  // Comparing one against the other is off by the viewer's whole offset, and
  // this fixture is built to land in that gap: the loaded page already reaches
  // back to 21:00 the PREVIOUS local day, which is 04:00Z on the day itself.
  // Converted properly (localTime.localDayRangeMs) the day is covered and the
  // pager stops at one request; treating the bare date as a UTC bound leaves
  // 04:00Z looking like it is still inside the day, and the view walks all the
  // way to its cap fetching pages it already has.
  it('knows the day is covered using local-midnight instants, not the bare date', async () => {
    const onTheDay = Array.from({ length: 25 }, (_, i) => entry({
      id: `d${i}`, session: `d${i}`,
      at: new Date(Date.parse('2026-07-28T20:00:00Z') - i * 60_000).toISOString(),
      outcome: 'the day itself',
    }))
    // 21:00 and earlier on Jul 27 LOCAL, which is 04:00Z on Jul 28.
    const previousEvening = Array.from({ length: 6 }, (_, i) => entry({
      id: `p${i}`, session: `p${i}`,
      at: new Date(Date.parse('2026-07-28T04:00:00Z') - i * 60_000).toISOString(),
      outcome: 'the previous evening',
    }))
    const all = [...onTheDay, ...previousEvening]
    const card = buildDayCards(all).find(c => c.slug === daySlug(dayCardKey(onTheDay[0])))!
    window.history.replaceState({}, '', dayHref(card.slug))
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getFeed').mockImplementation(pagedFeed(all))
    renderWith(client, <App />)

    expect(await screen.findByText('the day itself')).toBeInTheDocument()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(spy.mock.calls.length).toBe(1)
  })

  it('pages back to the day when it is within reach, without a click', async () => {
    // The cold-open case a cache hit does not cover: a pasted day URL, or a
    // reload on one. Two pages back is within reach, so the day view walks to
    // it by itself and stops there.
    const reachable = [
      ...noisy.slice(0, 40),
      entry({ id: 'r1', session: 'r1', authorId: 'sarah', author: 'Sarah', at: '2026-07-28T20:00:00Z', outcome: 'one page further back' }),
    ]
    const card = buildDayCards(reachable).find(c => c.author === 'Sarah')!
    window.history.replaceState({}, '', dayHref(card.slug))
    const client = new FakeDataClient({ solo: false })
    const spy = vi.spyOn(client, 'getFeed').mockImplementation(pagedFeed(reachable))
    renderWith(client, <App />)

    expect(await screen.findByText('one page further back')).toBeInTheDocument()
    // 40 noisy rows plus one of Sarah's: two pages of 30 covers the day, and
    // the third is never asked for.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2)
    expect(spy.mock.calls[0][1]).toEqual({ limit: FEED_PAGE_SIZE, before: null })
  })
})

// The day view renders the same day sentence the card does, from the same
// field, and the same coverage note. Two surfaces, one source.
describe('DayPage: the daemon\'s day sentence', () => {
  const entries = [entry({ id: 'a', session: 's-1', outcome: 'one session\'s own outcome', intent: 'get the install flow working end to end' })]
  const render = (over: Record<string, unknown> = {}) => {
    const slug = buildDayCards(entries)[0].slug
    window.history.replaceState({}, '', dayHref(slug))
    const client = new FakeDataClient()
    vi.spyOn(client, 'getFeed').mockResolvedValue({
      entries,
      nextBefore: null,
      dayDigests: [{
        key: '2026-07-29 id:andrew',
        kind: 'distilled',
        text: 'Worked on UI fixes, app install and dmg',
        sources: [{ entryId: 'a', session: 's-1', ts: '2026-07-29T20:00:00Z', project: 'membridge', projectId: null, distilled: true, text: 'x' }],
        sessions: 1, summarized: 1, omittedSessions: 0, entries: 1, complete: true, coverageNote: null,
        ...over,
      }],
    })
    return renderWith(client, <DayPage slug={slug} />)
  }

  it('heads the day with the daemon\'s sentence', async () => {
    const { container } = render()
    expect(await screen.findByText('Worked on UI fixes, app install and dmg')).toBeInTheDocument()
    expect(container.querySelector('.day-head-overview')!.textContent)
      .toBe('Worked on UI fixes, app install and dmg')
  })

  it('renders a coverage note next to the sentence it qualifies', async () => {
    // Only for a shortfall no paging can fix: the daemon HAD these statements
    // and dropped them to its own clause cap. A page-truncation note is
    // handled separately, and suppressed once the client has the whole day.
    const note = '1 more session not shown'
    const { container } = render({ omittedSessions: 1, coverageNote: note })
    await screen.findByText(note)
    expect(container.querySelector('.day-head-coverage')!.textContent).toBe(note)
  })

  it('lists the session\'s own outcome as a bullet, since the sentence is not it', async () => {
    const { container } = render()
    await screen.findByText('Worked on UI fixes, app install and dmg')
    expect([...container.querySelectorAll('.day-bullet')].map(el => el.textContent))
      .toEqual(['one session\'s own outcome'])
  })
})
