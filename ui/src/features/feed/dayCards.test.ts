import { describe, it, expect } from 'vitest'
import type { FeedEntry } from '../../data/types'
import {
  NO_SUMMARY_OVERVIEW, OPAQUE_OVERVIEW, buildDayCards, dayBullets, dayCardKey, dayFiles,
  dayIntent, dayIntentSentences, dayProjects, daySessions, daySlug, daySlugDay, dedupeSyncedTwins,
  pickDayOverview, projectPart,
} from './dayCards'

// The suite is pinned to America/Los_Angeles (vite.config.ts, test.env.TZ), so
// "20:00Z" is 13:00 the same day and "02:00Z" is 19:00 the PREVIOUS day
// locally. Every "straddles UTC midnight" case below is the regression this
// codebase has already been bitten by twice.
const entry = (overrides: Partial<FeedEntry> = {}): FeedEntry => ({
  id: 'e1', author: 'Marco', authorId: 'marco', tool: 'Claude Code', at: '2026-07-29T20:00:00Z',
  live: false, outcome: 'done', intent: null, files: [], session: 's1',
  project: 'membridge', projectPath: '/Users/x/membridge', projectId: null,
  summaryFull: null, decisions: null, gotchas: null, changes: [],
  ...overrides,
})

// The two shapes the SAME work arrives in. A local row carries the path and
// the folder's own name; its synced-back twin carries neither -- lib/feed.js
// normalizeTeam nulls projectPath and the backend hands back a capitalised
// display name -- and only projectId is common to both.
const local = (overrides: Partial<FeedEntry> = {}) =>
  entry({ project: 'membridge', projectPath: '/Users/x/membridge', projectId: 'proj-1', ...overrides })
const syncedTwin = (overrides: Partial<FeedEntry> = {}) =>
  entry({ project: 'Membridge', projectPath: null, projectId: 'proj-1', ...overrides })

describe('projectPart', () => {
  it('prefers projectId, the one component that survives team sync', () => {
    expect(projectPart(local())).toBe(projectPart(syncedTwin()))
  })

  it('falls back to the path for an UNLINKED project, which has no id at all', () => {
    // membridge-site, live: a local-only project never linked to a team. With
    // the name as the fallback, two unlinked projects sharing a folder name
    // under different parents would merge.
    const one = projectPart(entry({ projectId: null, projectPath: '/Users/x/a/site', project: 'site' }))
    const two = projectPart(entry({ projectId: null, projectPath: '/Users/x/b/site', project: 'site' }))
    expect(one).not.toBe(two)
  })

  it('falls back to the display name when a row carries neither id nor path', () => {
    const one = projectPart(entry({ projectId: null, projectPath: null, project: 'membridge' }))
    const two = projectPart(entry({ projectId: null, projectPath: null, project: 'sublease' }))
    expect(one).not.toBe(two)
  })
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

  // THE DUPLICATION, and the whole reason the project left the key. Measured
  // live, one day of /api/feed produced four keys for two people: marco /
  // Membridge, You / membridge-site, You / membridge, You / Membridge. The
  // last two are one project reached from its two sides and the middle two
  // are one person's day. A person's day is one thing to them.
  it('keeps one person\'s day on ONE key across every project they touched', () => {
    const membridge = dayCardKey(entry({ project: 'membridge', projectPath: '/Users/x/membridge' }))
    const site = dayCardKey(entry({ project: 'membridge-site', projectPath: '/Users/x/membridge-site' }))
    const syncedBack = dayCardKey(syncedTwin())
    expect(site).toBe(membridge)
    expect(syncedBack).toBe(membridge)
  })

  it('splits two people on the same day, so a team of two is two cards', () => {
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

  it('never lets the project decide the key at all, however the row names it', () => {
    const withEverything = dayCardKey(entry({ projectId: 'p1', projectPath: '/Users/x/a', project: 'A' }))
    const withNothing = dayCardKey(entry({ projectId: null, projectPath: null, project: '' }))
    expect(withNothing).toBe(withEverything)
  })
})

// A card spans projects now, so it has to say which. The fold is projectPart,
// NOT the raw name: a linked project's local rows and its own synced-back
// twins would otherwise list as "membridge" and "Membridge" side by side,
// which is the split that used to be in the card key, moved one level in.
describe('dayProjects', () => {
  it('lists the distinct projects of the day, busiest first', () => {
    const projects = dayProjects([
      entry({ id: 'a', project: 'membridge-site', projectPath: '/Users/x/membridge-site' }),
      entry({ id: 'b', project: 'membridge', projectPath: '/Users/x/membridge' }),
      entry({ id: 'c', project: 'membridge', projectPath: '/Users/x/membridge' }),
    ])
    expect(projects.map(p => p.name)).toEqual(['membridge', 'membridge-site'])
    expect(projects[0].count).toBe(2)
  })

  it('counts a project and its synced-back twin as ONE project', () => {
    const projects = dayProjects([local({ id: 'a' }), syncedTwin({ id: 'b' })])
    expect(projects).toHaveLength(1)
    expect(projects[0].count).toBe(2)
  })

  it('prefers the local row\'s name, which is the folder the reader knows', () => {
    // The backend hands back a capitalised display name; this machine's own
    // folder is what the reader recognises, whichever order they arrive in.
    expect(dayProjects([syncedTwin({ id: 'a' }), local({ id: 'b' })])[0].name).toBe('membridge')
    expect(dayProjects([local({ id: 'a' }), syncedTwin({ id: 'b' })])[0].name).toBe('membridge')
  })

  it('keeps two unlinked projects that share a folder name apart', () => {
    const projects = dayProjects([
      entry({ id: 'a', projectId: null, projectPath: '/Users/x/a/site', project: 'site' }),
      entry({ id: 'b', projectId: null, projectPath: '/Users/x/b/site', project: 'site' }),
    ])
    expect(projects).toHaveLength(2)
  })

  it('breaks a count tie by name, so the order never depends on page arrival', () => {
    const projects = dayProjects([
      entry({ id: 'a', project: 'zebra', projectPath: '/Users/x/zebra' }),
      entry({ id: 'b', project: 'alpha', projectPath: '/Users/x/alpha' }),
    ])
    expect(projects.map(p => p.name)).toEqual(['alpha', 'zebra'])
  })
})

// The regression: the same work reaching this machine twice, once as a local
// row and once as its own synced-back twin. FeedPage's dedupeById misses them
// because the ids are built from the ts and the backend re-renders that.
describe('dedupeSyncedTwins', () => {
  it('folds a row that carries a projectPath with the one that does not', () => {
    const out = dedupeSyncedTwins([
      local({ id: 'a', session: 's-1', at: '2026-07-29T20:00:00Z' }),
      syncedTwin({ id: 'b', session: 's-1', at: '2026-07-29T20:00:00Z' }),
    ])
    expect(out).toHaveLength(1)
  })

  it('keeps the LOCAL row, whichever order the two arrive in', () => {
    const twinFirst = dedupeSyncedTwins([
      syncedTwin({ id: 'b', session: 's-1', at: '2026-07-29T20:00:00Z' }),
      local({ id: 'a', session: 's-1', at: '2026-07-29T20:00:00Z' }),
    ])
    expect(twinFirst[0].projectPath).toBe('/Users/x/membridge')
    const localFirst = dedupeSyncedTwins([
      local({ id: 'a', session: 's-1', at: '2026-07-29T20:00:00Z' }),
      syncedTwin({ id: 'b', session: 's-1', at: '2026-07-29T20:00:00Z' }),
    ])
    expect(localFirst[0].projectPath).toBe('/Users/x/membridge')
  })

  it('folds twins whose timestamps are the same instant written differently', () => {
    // The backend round-trips the ts through timestamptz, so ".550Z" can come
    // back as ".55+00:00" -- the same moment, a different string, a different
    // streamEntryId, which is exactly why dedupeById upstream never saw them.
    const out = dedupeSyncedTwins([
      local({ id: 'a', session: 's-1', at: '2026-07-29T20:00:00.550Z' }),
      syncedTwin({ id: 'b', session: 's-1', at: '2026-07-29T20:00:00.55+00:00' }),
    ])
    expect(out).toHaveLength(1)
  })

  it('never folds two different sessions', () => {
    const out = dedupeSyncedTwins([
      local({ id: 'a', session: 's-1', at: '2026-07-29T20:00:00Z' }),
      syncedTwin({ id: 'b', session: 's-2', at: '2026-07-29T20:00:00Z' }),
    ])
    expect(out).toHaveLength(2)
  })

  it('never folds two prompts of one session at different instants', () => {
    const out = dedupeSyncedTwins([
      local({ id: 'a', session: 's-1', at: '2026-07-29T20:00:00Z' }),
      local({ id: 'b', session: 's-1', at: '2026-07-29T20:05:00Z' }),
    ])
    expect(out).toHaveLength(2)
  })

  it('never folds session-less rows, even at the same instant in the same project', () => {
    // A bare-plumbing row is only ever itself; keying it off '' would fold
    // every unrelated one in the day together (collapseSessionCheckpoints
    // documents the same trap).
    const out = dedupeSyncedTwins([
      local({ id: 'p1', session: null, at: '2026-07-29T20:00:00Z' }),
      local({ id: 'p2', session: null, at: '2026-07-29T20:00:00Z' }),
    ])
    expect(out).toHaveLength(2)
  })

  it('is idempotent, so folding twice can never change the answer', () => {
    const input = [
      local({ id: 'a', session: 's-1', at: '2026-07-29T20:00:00Z' }),
      syncedTwin({ id: 'b', session: 's-1', at: '2026-07-29T20:00:00Z' }),
    ]
    expect(dedupeSyncedTwins(dedupeSyncedTwins(input))).toEqual(dedupeSyncedTwins(input))
  })

  it('preserves input order for everything it does not fold', () => {
    const out = dedupeSyncedTwins([
      local({ id: 'a', session: 's-1', at: '2026-07-29T20:00:00Z' }),
      local({ id: 'b', session: 's-2', at: '2026-07-29T19:00:00Z' }),
      local({ id: 'c', session: 's-3', at: '2026-07-29T21:00:00Z' }),
    ])
    expect(out.map(e => e.id)).toEqual(['a', 'b', 'c'])
  })
})

// The day card key is what the day view is addressed by, so the slug has to
// survive a URL and stay one-to-one with the key it came from.
describe('daySlug', () => {
  it('carries no character a URL path segment cannot hold', () => {
    const slug = daySlug(dayCardKey(entry({ author: 'Marco Melika/?#', authorId: undefined })))
    expect(slug).not.toContain('\x00')
    expect(slug).not.toContain('/')
    expect(slug).not.toContain('?')
    // base64url plus the separator, and nothing else: no percent escape at
    // all, which is the property the next test rests on.
    expect(/^[A-Za-z0-9\-_~]+$/.test(slug)).toBe(true)
  })

  // THE REGRESSION. wouter runs decodeURI over location.pathname before it
  // matches a route (wouter/src/paths.js), so anything the slug hands the
  // router comes back decoded. A percent-encoded slug therefore never equalled
  // the one the card minted, and every one of these names produced a visible
  // card that answered "That day is not in view".
  it('survives decodeURI, which is what the router does to it', () => {
    for (const author of ['Marco Melika', 'Renée', 'o~brien', 'a b~c%d', '田中']) {
      const slug = daySlug(dayCardKey(entry({ authorId: undefined, author })))
      expect(decodeURI(slug)).toBe(slug)
    }
  })

  it('gives two different days two different slugs', () => {
    const a = daySlug(dayCardKey(entry({ at: '2026-07-29T20:00:00Z' })))
    const b = daySlug(dayCardKey(entry({ at: '2026-07-28T20:00:00Z' })))
    expect(a).not.toBe(b)
  })

  it('cannot be forged by an author whose name contains the separator', () => {
    // A tilde is not in the base64url alphabet, so an author literally called
    // "a~b" cannot split into two parts. Project is no longer part of the key,
    // so the author is the only caller-supplied component left that could
    // collide.
    const withTilde = daySlug(dayCardKey(entry({ authorId: undefined, author: 'a~b' })))
    expect(withTilde.split('~')).toHaveLength(2)
    // And the tilde really is inside the part, not a third component of it.
    expect(daySlugDay(withTilde)).toBe('2026-07-29')
  })

  it('gives two different people two different slugs on the same day', () => {
    const a = daySlug(dayCardKey(entry({ authorId: undefined, author: 'Renée' })))
    const b = daySlug(dayCardKey(entry({ authorId: undefined, author: 'Renee' })))
    expect(a).not.toBe(b)
  })
})

describe('daySlugDay', () => {
  it('reads back the local calendar day the slug names', () => {
    // 2026-07-29T04:00Z is 21:00 on the 28th in America/Los_Angeles, and the
    // day half of the key is the LOCAL day, never the UTC one.
    expect(daySlugDay(daySlug(dayCardKey(entry({ at: '2026-07-29T04:00:00Z' }))))).toBe('2026-07-28')
    expect(daySlugDay(daySlug(dayCardKey(entry({ at: '2026-07-29T20:00:00Z' }))))).toBe('2026-07-29')
  })

  it('answers null for anything it did not mint, rather than throwing', () => {
    // A slug arrives from the address bar, so it is hand-editable text and
    // this runs inside a render path.
    for (const bad of ['', 'not-a-slug', '~~~', '%%%', 'MjAyNi0wNy0yOQ']) {
      expect(() => daySlugDay(bad)).not.toThrow()
    }
    expect(daySlugDay('not-a-slug')).toBeNull()
    // Decodable, but not a date: still not a day.
    expect(daySlugDay(daySlug('hello'))).toBeNull()
  })
})

describe('dayIntentSentences', () => {
  // The proxy for "how much has been done" is the SESSION COUNT: /api/feed
  // carries no prompt count, and adding one was deliberately deferred.
  it('gives a one-session day one sentence', () => {
    expect(dayIntentSentences(1)).toBe(1)
  })
  it('gives a two or three session day two', () => {
    expect(dayIntentSentences(2)).toBe(2)
    expect(dayIntentSentences(3)).toBe(2)
  })
  it('caps at three however long the day ran', () => {
    expect(dayIntentSentences(4)).toBe(3)
    expect(dayIntentSentences(40)).toBe(3)
  })
})

describe('dayIntent', () => {
  const bullets = (...texts: string[]) => texts.map((text, i) => ({ key: `k${i}`, text }))

  it('joins the day\'s bullets into sentences, as many as the rule allows', () => {
    expect(dayIntent(bullets('Fixed the ports', 'Added the back button', 'Rewrote the card'), 4))
      .toBe('Fixed the ports. Added the back button. Rewrote the card.')
  })

  it('stops at one sentence for a one-session day', () => {
    expect(dayIntent(bullets('Fixed the ports', 'Added the back button'), 1)).toBe('Fixed the ports.')
  })

  it('does not add a second full stop to a line that already ends in one', () => {
    expect(dayIntent(bullets('Fixed the ports.'), 1)).toBe('Fixed the ports.')
  })

  it('does not put a full stop after the ellipsis of a clipped line', () => {
    expect(dayIntent(bullets('Fixed the ports and then…'), 1)).toBe('Fixed the ports and then…')
  })

  it('says nothing at all for a day that landed nothing', () => {
    expect(dayIntent([], 3)).toBe('')
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
  })

  it('falls back to the newest entry carrying any outcome when nothing is distilled', () => {
    const pick = pickDayOverview([
      entry({ id: 'a', at: '2026-07-29T21:00:00Z', distilled: false, outcome: 'the newest harvested line' }),
      entry({ id: 'b', at: '2026-07-29T20:00:00Z', distilled: false, outcome: 'an older harvested line' }),
    ])
    expect(pick.kind).toBe('summary')
    expect(pick.text).toBe('the newest harvested line')
  })

  it('never picks an empty row over a real one, however much newer the empty row is', () => {
    const pick = pickDayOverview([
      entry({ id: 'empty', at: '2026-07-29T23:00:00Z', outcome: '' }),
      entry({ id: 'real', at: '2026-07-29T08:00:00Z', outcome: 'the only real outcome of the day' }),
    ])
    expect(pick.text).toBe('the only real outcome of the day')
  })

  it('never picks an undecryptable row over a real one', () => {
    const pick = pickDayOverview([
      entry({ id: 'opaque', at: '2026-07-29T23:00:00Z', outcome: '', undecryptable: true }),
      entry({ id: 'real', at: '2026-07-29T08:00:00Z', distilled: true, outcome: 'the readable outcome' }),
    ])
    expect(pick.kind).toBe('distilled')
    expect(pick.text).toBe('the readable outcome')
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
  })

  it('reports a genuinely un-distilled day plainly, and never invents text for it', () => {
    const pick = pickDayOverview([
      entry({ id: 'x', at: '2026-07-29T21:00:00Z', outcome: '', intent: 'wire the recall hook' }),
    ])
    expect(pick.kind).toBe('none')
    expect(pick.text).toBe(NO_SUMMARY_OVERVIEW)
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

describe('dayFiles', () => {
  it('unions every entry\'s files, most-touched first', () => {
    const files = dayFiles([
      entry({ id: 'a', files: ['lib/feed.js', 'ui/one.ts'] }),
      entry({ id: 'b', files: ['lib/feed.js'] }),
      entry({ id: 'c', files: ['lib/feed.js', 'ui/two.ts'] }),
    ])
    expect(files.map(f => f.file)).toEqual(['lib/feed.js', 'ui/one.ts', 'ui/two.ts'])
    expect(files[0].touches).toBe(3)
  })

  it('ranks supporting churn below source when the touch counts tie', () => {
    const files = dayFiles([entry({ files: ['docs/guide.md', 'lib/feed.js'] })])
    expect(files.map(f => f.file)).toEqual(['lib/feed.js', 'docs/guide.md'])
  })

  it('carries the agent\'s own per-file note through', () => {
    const files = dayFiles([
      entry({ files: ['lib/feed.js'], changes: [{ file: 'lib/feed.js', status: 'edited', add: 4, del: 1, note: 'nulls projectPath on team rows', dep: false }] }),
    ])
    expect(files[0].note).toBe('nulls projectPath on team rows')
  })

  it('names a file that only the change list mentions', () => {
    const files = dayFiles([
      entry({ files: [], changes: [{ file: 'package.json', status: 'edited', add: null, del: null, note: null, dep: true }] }),
    ])
    expect(files.map(f => f.file)).toEqual(['package.json'])
  })

  it('is empty for a day that touched nothing, so the section can be omitted', () => {
    expect(dayFiles([entry({ files: [] })])).toEqual([])
  })
})

describe('daySessions', () => {
  it('groups a session\'s prompts under it, oldest prompt first', () => {
    const sessions = daySessions([
      entry({ id: 'p2', session: 's-1', at: '2026-07-29T20:10:00Z', intent: 'now make recall use the same gate' }),
      entry({ id: 'p1', session: 's-1', at: '2026-07-29T20:00:00Z', intent: 'make the summary hook fire on session boundaries' }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0].prompts.map(p => p.text)).toEqual([
      'make the summary hook fire on session boundaries',
      'now make recall use the same gate',
    ])
  })

  it('orders the sessions themselves newest first', () => {
    const sessions = daySessions([
      entry({ id: 'a', session: 's-old', at: '2026-07-29T18:00:00Z' }),
      entry({ id: 'b', session: 's-new', at: '2026-07-29T21:00:00Z' }),
    ])
    expect(sessions.map(s => s.session)).toEqual(['s-new', 's-old'])
  })

  it('carries the session\'s time range', () => {
    const sessions = daySessions([
      entry({ id: 'a', session: 's-1', at: '2026-07-29T18:00:00Z' }),
      entry({ id: 'b', session: 's-1', at: '2026-07-29T21:00:00Z' }),
    ])
    expect(sessions[0].startedAt).toBe('2026-07-29T18:00:00Z')
    expect(sessions[0].endedAt).toBe('2026-07-29T21:00:00Z')
  })

  it('drops an entry that captured no prompt rather than listing a blank one', () => {
    const sessions = daySessions([
      entry({ id: 'a', session: 's-1', at: '2026-07-29T20:00:00Z', intent: null }),
      entry({ id: 'b', session: 's-1', at: '2026-07-29T20:05:00Z', intent: 'the only real prompt' }),
    ])
    expect(sessions[0].prompts.map(p => p.text)).toEqual(['the only real prompt'])
  })

  it('lists one prompt once when a re-summarized session repeats the same ask', () => {
    const sessions = daySessions([
      entry({ id: 'a', session: 's-1', at: '2026-07-29T20:00:00Z', intent: 'ship the thing' }),
      entry({ id: 'b', session: 's-1', at: '2026-07-29T20:05:00Z', intent: 'Ship the thing.' }),
    ])
    expect(sessions[0].prompts).toHaveLength(1)
  })

  it('clips a pasted essay of a prompt and says it clipped it', () => {
    const sessions = daySessions([
      entry({ session: 's-1', intent: `${'please do the thing '.repeat(40)}now` }),
    ])
    const prompt = sessions[0].prompts[0]
    expect(prompt.clipped).toBe(true)
    expect(prompt.text.length).toBeLessThan(220)
    expect(prompt.text.endsWith('…')).toBe(true)
  })

  it('flattens a multi-line prompt to one line rather than growing the row', () => {
    const sessions = daySessions([entry({ session: 's-1', intent: 'fix the\n\n  hook' })])
    expect(sessions[0].prompts[0].text).toBe('fix the hook')
  })

  it('keeps each session-less row as its own group rather than folding them', () => {
    const sessions = daySessions([
      entry({ id: 'p1', session: null, at: '2026-07-29T20:00:00Z' }),
      entry({ id: 'p2', session: null, at: '2026-07-29T19:00:00Z' }),
    ])
    expect(sessions).toHaveLength(2)
    expect(sessions.every(s => s.session === null)).toBe(true)
  })
})

describe('dayBullets', () => {
  // Most cases here are about the SOURCING rule, so they run against a day
  // with no overview sentence to be deduped against. The two cases that are
  // about that interaction build the real overview themselves, below.
  const NO_OVERVIEW = { kind: 'none' as const, text: NO_SUMMARY_OVERVIEW }
  const bulletsFor = (entries: FeedEntry[]) => dayBullets(daySessions(entries), NO_OVERVIEW).map(b => b.text)

  it('aggregates what each session did across the day, oldest work first', () => {
    expect(bulletsFor([
      entry({ id: 'a', session: 's-1', at: '2026-07-29T18:00:00Z', outcome: 'Added a back button to the day cards in Feed' }),
      entry({ id: 'b', session: 's-2', at: '2026-07-29T21:00:00Z', outcome: 'Fixed summary generation' }),
    ])).toEqual(['Added a back button to the day cards in Feed', 'Fixed summary generation'])
  })

  it('never repeats the card\'s own overview sentence as a bullet', () => {
    // The overview is a PICK of one session's outcome, so without this the
    // day's headline renders twice, once as the sentence and once as a point.
    const entries = [
      entry({ id: 'a', session: 's-1', at: '2026-07-29T18:00:00Z', outcome: 'the older thing' }),
      entry({ id: 'b', session: 's-2', at: '2026-07-29T21:00:00Z', distilled: true, outcome: 'the settled outcome' }),
    ]
    const bullets = dayBullets(daySessions(entries), pickDayOverview(entries)).map(b => b.text)
    expect(bullets).toEqual(['the older thing'])
  })

  it('splits decisions that arrived as a real list, one bullet per line', () => {
    // v0.2.8 onward: the distiller writes one point per line.
    expect(bulletsFor([
      entry({ session: 's-1', outcome: '', decisions: '- Keyed the card on projectId\n- Dropped the second deduper' }),
    ])).toEqual(['Keyed the card on projectId', 'Dropped the second deduper'])
  })

  it('never shreds a flattened legacy paragraph back into half-sentences', () => {
    // Before daf624a, digest.clip and digest.plainText both ran
    // replace(/\s+/g,' ') on every path out of storage, so every archived
    // multi-line note is one paragraph and its structure is unrecoverable.
    // Sentence-splitting it produces exactly the shredded output this list was
    // rejected for once already: the session's own outcome line stands in.
    const paragraph = `${'Durability beats recency because a crashed run must not steal the hook. '.repeat(6)}`
    expect(bulletsFor([
      entry({ session: 's-1', outcome: 'Hook ownership now decided by durability', decisions: paragraph }),
    ])).toEqual(['Hook ownership now decided by durability'])
  })

  it('keeps a short flattened note whole rather than dropping it', () => {
    expect(bulletsFor([
      entry({ session: 's-1', outcome: '', decisions: 'Rotated fixture ports per run instead of pinning one block.' }),
    ])).toEqual(['Rotated fixture ports per run instead of pinning one block.'])
  })

  it('includes gotchas in the same list as what was done', () => {
    expect(bulletsFor([
      entry({ session: 's-1', outcome: '', gotchas: 'settings.json rewrites drop unknown keys, so merge before writing.' }),
    ])).toEqual(['settings.json rewrites drop unknown keys, so merge before writing.'])
  })

  it('says a thing once when two sessions of the day landed the same line', () => {
    expect(bulletsFor([
      entry({ id: 'a', session: 's-1', at: '2026-07-29T18:00:00Z', outcome: 'Fixed the port collision' }),
      entry({ id: 'b', session: 's-2', at: '2026-07-29T21:00:00Z', outcome: 'Fixed the port collision.' }),
    ])).toEqual(['Fixed the port collision'])
  })

  it('is empty for a day that landed nothing, so the section can be omitted', () => {
    expect(bulletsFor([entry({ session: 's-1', outcome: '', intent: 'start' })])).toEqual([])
  })

  it('contributes nothing from a row this machine could not decrypt', () => {
    expect(bulletsFor([entry({ session: 's-1', outcome: '', undecryptable: true })])).toEqual([])
  })
})

describe('buildDayCards', () => {
  it('folds a person\'s many sessions on one day into ONE card', () => {
    const cards = buildDayCards([
      entry({ id: '1', session: 's1', at: '2026-07-29T20:00:00Z' }),
      entry({ id: '2', session: 's2', at: '2026-07-29T18:00:00Z' }),
      entry({ id: '3', session: 's3', at: '2026-07-29T16:00:00Z' }),
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0].sessionCount).toBe(3)
    expect(cards[0].author).toBe('Marco')
    expect(cards[0].projects.map(p => p.name)).toEqual(['membridge'])
  })

  // The owner's ask, in his own arithmetic: "a team of two working should have
  // 2 day cards, one per person". This is the live shape of today's feed --
  // Marco in one project, You across three views of two -- and it must render
  // as two cards, not four.
  it('renders a team of two working across several projects as TWO cards', () => {
    const cards = buildDayCards([
      entry({ id: 'm1', authorId: 'marco', author: 'Marco', session: 's-m1', at: '2026-07-29T20:00:00Z', project: 'Membridge', projectPath: null, projectId: 'proj-1' }),
      entry({ id: 'y1', authorId: 'you', author: 'You', session: 's-y1', at: '2026-07-29T19:00:00Z', project: 'membridge-site', projectPath: '/Users/x/membridge-site', projectId: null }),
      entry({ id: 'y2', authorId: 'you', author: 'You', session: 's-y2', at: '2026-07-29T18:00:00Z', project: 'membridge', projectPath: '/Users/x/membridge', projectId: 'proj-1' }),
      entry({ id: 'y3', authorId: 'you', author: 'You', session: 's-y3', at: '2026-07-29T17:00:00Z', project: 'Membridge', projectPath: null, projectId: 'proj-1' }),
    ])
    expect(cards).toHaveLength(2)
    expect(cards.map(c => c.author)).toEqual(['Marco', 'You'])
    // And "You" spans TWO projects, not three: the local row and the synced
    // twin of the linked project are one project, listed under the folder
    // name this machine actually has.
    expect(cards[1].projects.map(p => p.name)).toEqual(['membridge', 'membridge-site'])
  })

  // THE REGRESSION, at the level that renders it: one card, and a count that
  // has not doubled. Fixture is deliberately the live shape -- one row with a
  // projectPath, one without, same session, same instant.
  it('folds a day\'s synced-back twins instead of billing them as a second card', () => {
    const cards = buildDayCards([
      local({ id: 'a', session: 's-1', at: '2026-07-29T20:00:00Z' }),
      syncedTwin({ id: 'b', session: 's-1', at: '2026-07-29T20:00:00Z' }),
      local({ id: 'c', session: 's-2', at: '2026-07-29T19:00:00Z' }),
      syncedTwin({ id: 'd', session: 's-2', at: '2026-07-29T19:00:00Z' }),
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0].sessionCount).toBe(2)
    expect(cards[0].sessions.flatMap(s => s.entries)).toHaveLength(2)
  })

  it('does not list a twin\'s prompt twice under its session', () => {
    // The team row's `ask` is clipped at push time, so the two copies are not
    // byte-identical and prompt-level dedupe alone would not catch them.
    const cards = buildDayCards([
      local({ id: 'a', session: 's-1', at: '2026-07-29T20:00:00Z', intent: 'rebuild the day cards so one card is one person per day' }),
      syncedTwin({ id: 'b', session: 's-1', at: '2026-07-29T20:00:00Z', intent: 'rebuild the day cards so one card is one…' }),
    ])
    expect(cards[0].sessions[0].prompts.map(p => p.text))
      .toEqual(['rebuild the day cards so one card is one person per day'])
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

  it('keeps each card\'s own sessions newest-first', () => {
    const cards = buildDayCards([
      entry({ id: 'b', session: 'b', at: '2026-07-29T18:00:00Z' }),
      entry({ id: 'a', session: 'a', at: '2026-07-29T20:00:00Z' }),
    ])
    expect(cards[0].sessions.map(s => s.key)).toEqual(['a', 'b'])
  })

  it('counts SESSIONS, not rows -- several prompts of one session are one session', () => {
    // FeedPage no longer collapses a session to its newest row (the prompts
    // are the point), so this is now the ONLY thing standing between a
    // twelve-prompt session and a card claiming "12 sessions".
    const cards = buildDayCards([
      entry({ id: 'c2', session: 's1', at: '2026-07-29T20:10:00Z' }),
      entry({ id: 'c1', session: 's1', at: '2026-07-29T20:00:00Z' }),
    ])
    expect(cards[0].sessionCount).toBe(1)
    expect(cards[0].sessions).toHaveLength(1)
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

  it('keeps one person\'s day in ONE card, naming every project in it', () => {
    const cards = buildDayCards([
      entry({ id: 'a', session: 'a', at: '2026-07-29T20:00:00Z', project: 'membridge', projectPath: '/Users/x/membridge' }),
      entry({ id: 'b', session: 'b', at: '2026-07-29T19:00:00Z', project: 'sublease', projectPath: '/Users/x/sublease' }),
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0].projects.map(p => p.name).sort()).toEqual(['membridge', 'sublease'])
  })

  it('splits one person\'s work across two LOCAL days even inside one UTC day', () => {
    // 21:00 Jul 28 and 09:00 Jul 29 locally, both Jul 29 in UTC.
    const cards = buildDayCards([
      entry({ id: 'morning', session: 'a', at: '2026-07-29T16:00:00Z' }),
      entry({ id: 'lastnight', session: 'b', at: '2026-07-29T04:00:00Z' }),
    ])
    expect(cards).toHaveLength(2)
    expect(cards[0].sessions.flatMap(s => s.entries).map(e => e.id)).toEqual(['morning'])
    expect(cards[1].sessions.flatMap(s => s.entries).map(e => e.id)).toEqual(['lastnight'])
  })

  it('carries the overview pick onto the card', () => {
    const cards = buildDayCards([
      entry({ id: 'a', session: 'a', at: '2026-07-29T20:00:00Z', outcome: '' }),
      entry({ id: 'b', session: 'b', at: '2026-07-29T19:00:00Z', distilled: true, outcome: 'the day\'s real outcome' }),
    ])
    expect(cards[0].overview.text).toBe('the day\'s real outcome')
    expect(cards[0].overview.kind).toBe('distilled')
  })

  it('carries the day\'s files, bullets, intent and sessions onto the card', () => {
    const cards = buildDayCards([
      entry({ id: 'a', session: 's-1', at: '2026-07-29T18:00:00Z', outcome: 'Wired the recall gate', files: ['lib/hooks.js'], intent: 'wire the recall hook' }),
      entry({ id: 'b', session: 's-2', at: '2026-07-29T20:00:00Z', outcome: 'Fixed the port collision', files: ['test/run.js'], intent: 'fix the ports' }),
    ])
    expect(cards[0].files.map(f => f.file)).toEqual(['lib/hooks.js', 'test/run.js'])
    // The newest session's outcome became the day's sentence, so the bullet
    // list and the intent are what is LEFT, never a repeat of it.
    expect(cards[0].bullets.map(b => b.text)).toEqual(['Wired the recall gate'])
    expect(cards[0].intent).toBe('Wired the recall gate.')
    expect(cards[0].sessions.map(s => s.session)).toEqual(['s-2', 's-1'])
  })

  it('gives every card a slug the day view can be addressed by', () => {
    const cards = buildDayCards([entry({ session: 's-1' })])
    expect(cards[0].slug).toBe(daySlug(cards[0].key))
  })

  it('says nothing as intent for a day that landed nothing', () => {
    expect(buildDayCards([entry({ session: 's-1', outcome: '', intent: 'start' })])[0].intent).toBe('')
  })

  it('returns nothing for no entries rather than one empty card', () => {
    expect(buildDayCards([])).toEqual([])
  })
})
