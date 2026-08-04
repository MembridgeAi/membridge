import { describe, it, expect } from 'vitest'
import type { FeedEntry } from '../../data/types'
import { NO_SUMMARY_OVERVIEW, OPAQUE_OVERVIEW, buildDayCards, dayCardKey, pickDayOverview } from './dayCards'

// The suite is pinned to America/Los_Angeles (vite.config.ts, test.env.TZ), so
// "20:00Z" is 13:00 the same day and "02:00Z" is 19:00 the PREVIOUS day
// locally. Every "straddles UTC midnight" case below is the regression this
// codebase has already been bitten by twice.
const entry = (overrides: Partial<FeedEntry> = {}): FeedEntry => ({
  id: 'e1', author: 'Marco', authorId: 'marco', tool: 'Claude Code', at: '2026-07-29T20:00:00Z',
  live: false, outcome: 'done', intent: null, files: [], session: 's1',
  project: 'membridge', projectPath: '/Users/x/membridge',
  summaryFull: null, decisions: null, gotchas: null, changes: [],
  ...overrides,
})

describe('dayCardKey', () => {
  it('keys on author + project + LOCAL calendar day', () => {
    const a = dayCardKey(entry({ at: '2026-07-29T20:00:00Z' }))
    const b = dayCardKey(entry({ at: '2026-07-29T23:30:00Z' }))
    expect(a).toBe(b)
  })

  it('keeps one local evening on one card even when it straddles UTC midnight', () => {
    // 16:00 and 19:00 Jul 29 in Los Angeles. Keyed on the UTC day these split
    // into two cards, one of them filed under TOMORROW.
    const afternoon = dayCardKey(entry({ at: '2026-07-29T23:00:00Z' }))
    const evening = dayCardKey(entry({ at: '2026-07-30T02:00:00Z' }))
    expect(evening).toBe(afternoon)
  })

  it('splits the same person on the same day across two projects', () => {
    const one = dayCardKey(entry({ project: 'membridge', projectPath: '/Users/x/membridge' }))
    const two = dayCardKey(entry({ project: 'sublease', projectPath: '/Users/x/sublease' }))
    expect(one).not.toBe(two)
  })

  it('splits two people on the same day in the same project', () => {
    const marco = dayCardKey(entry({ author: 'Marco', authorId: 'marco' }))
    const andrew = dayCardKey(entry({ author: 'Andrew', authorId: 'andrew' }))
    expect(marco).not.toBe(andrew)
  })

  it('prefers the ids over the display names, so a renamed person stays one card', () => {
    const before = dayCardKey(entry({ author: 'Marco', authorId: 'marco' }))
    const after = dayCardKey(entry({ author: 'Marco P.', authorId: 'marco' }))
    expect(after).toBe(before)
  })

  it('falls back to the display name when a row carries no author id', () => {
    // Team rows pushed before author_id existed come back with a null id
    // (lib/feed.js normalizeTeam). Falling back to '' would fold every such
    // teammate into ONE card for the day.
    const marco = dayCardKey(entry({ authorId: '', author: 'Marco' }))
    const sarah = dayCardKey(entry({ authorId: '', author: 'Sarah' }))
    expect(marco).not.toBe(sarah)
  })

  it('falls back to the project display name when a row carries no path', () => {
    // Team rows never carry projectPath (lib/feed.js normalizeTeam sets it
    // null), so path-only keying folds every teammate project into one card.
    const one = dayCardKey(entry({ projectPath: null, project: 'membridge' }))
    const two = dayCardKey(entry({ projectPath: null, project: 'sublease' }))
    expect(one).not.toBe(two)
  })
})

describe('pickDayOverview', () => {
  it('picks the NEWEST distilled outcome, not merely the newest outcome', () => {
    const pick = pickDayOverview([
      entry({ id: 'a', at: '2026-07-29T21:00:00Z', distilled: false, outcome: 'a raw harvested line' }),
      entry({ id: 'b', at: '2026-07-29T20:00:00Z', distilled: true, outcome: 'the distilled outcome' }),
      entry({ id: 'c', at: '2026-07-29T19:00:00Z', distilled: true, outcome: 'an older distilled outcome' }),
    ])
    expect(pick.kind).toBe('distilled')
    expect(pick.text).toBe('the distilled outcome')
    expect(pick.fromEntryId).toBe('b')
  })

  it('falls back to the newest entry carrying any outcome when nothing is distilled', () => {
    const pick = pickDayOverview([
      entry({ id: 'a', at: '2026-07-29T21:00:00Z', distilled: false, outcome: 'the newest harvested line' }),
      entry({ id: 'b', at: '2026-07-29T20:00:00Z', distilled: false, outcome: 'an older harvested line' }),
    ])
    expect(pick.kind).toBe('summary')
    expect(pick.text).toBe('the newest harvested line')
    expect(pick.fromEntryId).toBe('a')
  })

  it('never picks an empty row over a real one, however much newer the empty row is', () => {
    const pick = pickDayOverview([
      entry({ id: 'empty', at: '2026-07-29T23:00:00Z', outcome: '' }),
      entry({ id: 'real', at: '2026-07-29T08:00:00Z', outcome: 'the only real outcome of the day' }),
    ])
    expect(pick.text).toBe('the only real outcome of the day')
    expect(pick.fromEntryId).toBe('real')
  })

  it('never picks an undecryptable row over a real one', () => {
    const pick = pickDayOverview([
      entry({ id: 'opaque', at: '2026-07-29T23:00:00Z', outcome: '', undecryptable: true }),
      entry({ id: 'real', at: '2026-07-29T08:00:00Z', distilled: true, outcome: 'the readable outcome' }),
    ])
    expect(pick.kind).toBe('distilled')
    expect(pick.fromEntryId).toBe('real')
  })

  it('says a day is ENCRYPTED, not un-distilled, when its rows could not be decrypted', () => {
    // The trap: an empty outcome and a failed decrypt both render "No summary
    // yet" on an EntryRow, so a reader cannot tell "nobody summarized this"
    // from "this machine could not read it". A day card must not repeat that.
    const pick = pickDayOverview([
      entry({ id: 'x', at: '2026-07-29T21:00:00Z', outcome: '', undecryptable: true }),
      entry({ id: 'y', at: '2026-07-29T20:00:00Z', outcome: '', undecryptable: true }),
    ])
    expect(pick.kind).toBe('undecryptable')
    expect(pick.text).toBe(OPAQUE_OVERVIEW)
    expect(pick.fromEntryId).toBeNull()
  })

  it('reports a genuinely un-distilled day plainly, and never invents text for it', () => {
    const pick = pickDayOverview([
      entry({ id: 'x', at: '2026-07-29T21:00:00Z', outcome: '', intent: 'wire the recall hook' }),
    ])
    expect(pick.kind).toBe('none')
    expect(pick.text).toBe(NO_SUMMARY_OVERVIEW)
    expect(pick.fromEntryId).toBeNull()
  })

  it('calls a day encrypted when even one of its unreadable rows failed to decrypt', () => {
    // Mixed opaque + un-distilled with nothing readable: naming the decrypt
    // failure is the more actionable of the two, and it is the one a reader
    // cannot otherwise discover.
    const pick = pickDayOverview([
      entry({ id: 'x', at: '2026-07-29T21:00:00Z', outcome: '' }),
      entry({ id: 'y', at: '2026-07-29T20:00:00Z', outcome: '', undecryptable: true }),
    ])
    expect(pick.kind).toBe('undecryptable')
  })

  it('is a PICK, never a concatenation of the day\'s summaries', () => {
    const pick = pickDayOverview([
      entry({ id: 'a', at: '2026-07-29T21:00:00Z', outcome: 'first outcome' }),
      entry({ id: 'b', at: '2026-07-29T20:00:00Z', outcome: 'second outcome' }),
    ])
    expect(pick.text).toBe('first outcome')
    expect(pick.text).not.toContain('second outcome')
  })

  it('degrades to the un-distilled sentence on an empty day rather than throwing', () => {
    expect(pickDayOverview([]).kind).toBe('none')
  })
})

describe('buildDayCards', () => {
  it('folds a person\'s many sessions in one project on one day into ONE card', () => {
    const cards = buildDayCards([
      entry({ id: '1', session: 's1', at: '2026-07-29T20:00:00Z' }),
      entry({ id: '2', session: 's2', at: '2026-07-29T18:00:00Z' }),
      entry({ id: '3', session: 's3', at: '2026-07-29T16:00:00Z' }),
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0].sessionCount).toBe(3)
    expect(cards[0].author).toBe('Marco')
    expect(cards[0].project).toBe('membridge')
  })

  it('stamps the card with its NEWEST entry\'s timestamp and orders cards by it', () => {
    const cards = buildDayCards([
      entry({ id: 'old', authorId: 'sarah', author: 'Sarah', session: 'a', at: '2026-07-29T17:00:00Z' }),
      entry({ id: 'new', authorId: 'marco', author: 'Marco', session: 'b', at: '2026-07-29T19:00:00Z' }),
      entry({ id: 'mid', authorId: 'marco', author: 'Marco', session: 'c', at: '2026-07-29T18:00:00Z' }),
    ])
    expect(cards.map(c => c.author)).toEqual(['Marco', 'Sarah'])
    expect(cards[0].at).toBe('2026-07-29T19:00:00Z')
  })

  it('keeps each card\'s own entries newest-first', () => {
    const cards = buildDayCards([
      entry({ id: 'b', session: 'b', at: '2026-07-29T18:00:00Z' }),
      entry({ id: 'a', session: 'a', at: '2026-07-29T20:00:00Z' }),
    ])
    expect(cards[0].entries.map(e => e.id)).toEqual(['a', 'b'])
  })

  it('counts SESSIONS, not rows -- successive checkpoints of one session are one session', () => {
    // FeedPage collapses checkpoints before it gets here, but the count must
    // not depend on that having happened: an inflated "12 sessions" for one
    // session summarized twelve times is exactly the noise this screen removes.
    const cards = buildDayCards([
      entry({ id: 'c2', session: 's1', at: '2026-07-29T20:10:00Z' }),
      entry({ id: 'c1', session: 's1', at: '2026-07-29T20:00:00Z' }),
    ])
    expect(cards[0].sessionCount).toBe(1)
  })

  it('counts a session-less row as its own session rather than folding them together', () => {
    const cards = buildDayCards([
      entry({ id: 'p1', session: null, at: '2026-07-29T20:00:00Z' }),
      entry({ id: 'p2', session: null, at: '2026-07-29T19:00:00Z' }),
    ])
    expect(cards[0].sessionCount).toBe(2)
  })

  it('is live when ANY of its entries is live', () => {
    const cards = buildDayCards([
      entry({ id: 'a', session: 'a', at: '2026-07-29T20:00:00Z', live: false }),
      entry({ id: 'b', session: 'b', at: '2026-07-29T19:00:00Z', live: true }),
    ])
    expect(cards[0].live).toBe(true)
  })

  it('is not live when none of its entries is', () => {
    const cards = buildDayCards([entry({ live: false })])
    expect(cards[0].live).toBe(false)
  })

  it('splits one person\'s day across the two projects they worked in', () => {
    const cards = buildDayCards([
      entry({ id: 'a', session: 'a', at: '2026-07-29T20:00:00Z', project: 'membridge', projectPath: '/Users/x/membridge' }),
      entry({ id: 'b', session: 'b', at: '2026-07-29T19:00:00Z', project: 'sublease', projectPath: '/Users/x/sublease' }),
    ])
    expect(cards.map(c => c.project)).toEqual(['membridge', 'sublease'])
  })

  it('splits one person\'s work across two LOCAL days even inside one UTC day', () => {
    // 21:00 Jul 28 and 09:00 Jul 29 locally, both Jul 29 in UTC.
    const cards = buildDayCards([
      entry({ id: 'morning', session: 'a', at: '2026-07-29T16:00:00Z' }),
      entry({ id: 'lastnight', session: 'b', at: '2026-07-29T04:00:00Z' }),
    ])
    expect(cards).toHaveLength(2)
    expect(cards[0].entries.map(e => e.id)).toEqual(['morning'])
    expect(cards[1].entries.map(e => e.id)).toEqual(['lastnight'])
  })

  it('carries the overview pick onto the card', () => {
    const cards = buildDayCards([
      entry({ id: 'a', session: 'a', at: '2026-07-29T20:00:00Z', outcome: '' }),
      entry({ id: 'b', session: 'b', at: '2026-07-29T19:00:00Z', distilled: true, outcome: 'the day\'s real outcome' }),
    ])
    expect(cards[0].overview.text).toBe('the day\'s real outcome')
    expect(cards[0].overview.kind).toBe('distilled')
  })

  it('returns nothing for no entries rather than one empty card', () => {
    expect(buildDayCards([])).toEqual([])
  })
})
