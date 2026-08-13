import { describe, it, expect } from 'vitest'
import type { DayDigest, FeedEntry } from '../../data/types'
import {
  NO_SUMMARY_OVERVIEW, OPAQUE_OVERVIEW, UNDATED_DAY,
  buildDayCards, dayBullets, dayCardKey, dayFiles, dayIntent, dayIntentSentences,
  dayAsks, dayProjects, daySessions, daySlug, daySlugDay, dedupeSyncedTwins, digestKey, pickDayOverview, projectPart,
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

describe('dayCardKey', () => {
  it('keys on author + LOCAL calendar day', () => {
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

  // THE CHANGE. A person's day is one thing to them, not one thing per repo.
  it('keeps one person\'s day on ONE card across two projects', () => {
    const one = dayCardKey(entry({ project: 'membridge', projectPath: '/Users/x/membridge' }))
    const two = dayCardKey(entry({ project: 'sublease', projectPath: '/Users/x/sublease' }))
    expect(one).toBe(two)
  })

  it('splits two people on the same day', () => {
    const marco = dayCardKey(entry({ author: 'Marco', authorId: 'marco' }))
    const andrew = dayCardKey(entry({ author: 'Andrew', authorId: 'andrew' }))
    expect(marco).not.toBe(andrew)
  })

  it('prefers the id over the display name, so a renamed person stays one card', () => {
    const before = dayCardKey(entry({ author: 'Marco', authorId: 'marco' }))
    const after = dayCardKey(entry({ author: 'Marco P.', authorId: 'marco' }))
    expect(after).toBe(before)
  })

  it('falls back to the display name rather than to an empty key', () => {
    // Defensive only: author_id is NOT NULL in the original schema and the RLS
    // insert policy requires it, so no real row arrives without one. The point
    // of the case is that IF one did, two people would not merge.
    const marco = dayCardKey(entry({ authorId: '', author: 'Marco' }))
    const sarah = dayCardKey(entry({ authorId: '', author: 'Sarah' }))
    expect(marco).not.toBe(sarah)
  })

  it('buckets a row whose timestamp is not a time, instead of keying it NaN', () => {
    // lib/feed.js emits `ts: e.ts || ''`. Unguarded this keyed "NaN-NaN-NaN",
    // which sorts above every real date and parks the row at the top forever.
    expect(dayCardKey(entry({ at: '' })).startsWith(UNDATED_DAY)).toBe(true)
  })
})

describe('projectPart', () => {
  // lib/feed.js's own dedupeKey precedence, and canonical for this problem.
  it('prefers projectId, the one component that survives team sync', () => {
    const local = projectPart(entry({ projectId: 'p1', projectPath: '/Users/x/membridge', project: 'membridge' }))
    const synced = projectPart(entry({ projectId: 'p1', projectPath: null, project: 'Membridge' }))
    expect(synced).toBe(local)
  })

  it('falls back to the path, so two unlinked projects sharing a folder name stay apart', () => {
    const a = projectPart(entry({ projectId: null, projectPath: '/Users/x/site', project: 'site' }))
    const b = projectPart(entry({ projectId: null, projectPath: '/Users/y/site', project: 'site' }))
    expect(a).not.toBe(b)
  })

  it('falls back to the display name for a team row with neither', () => {
    const a = projectPart(entry({ projectId: null, projectPath: null, project: 'membridge' }))
    const b = projectPart(entry({ projectId: null, projectPath: null, project: 'sublease' }))
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// The synced-back twin.
//
// CONFIRMED against real Postgres 17: '...:00.550Z'::timestamptz serializes as
// "...:00.55+00:00". Every fixture here carries that REAL asymmetry -- a
// different ts string, a nulled projectPath, a capitalised project name and a
// clipped ask -- because test/mock-supabase.js returns pushed rows verbatim,
// so a fixture built from one shape proves nothing at all.
// ---------------------------------------------------------------------------
const localRow = (overrides: Partial<FeedEntry> = {}): FeedEntry => entry({
  id: 's-1|2026-07-29T20:00:00.550Z', at: '2026-07-29T20:00:00.550Z', session: 's-1',
  project: 'membridge', projectPath: '/Users/x/membridge', projectId: 'proj-1',
  intent: 'wire the recall hook into the Stop path',
  ...overrides,
})
const syncedTwin = (overrides: Partial<FeedEntry> = {}): FeedEntry => entry({
  id: 's-1|2026-07-29T20:00:00.55+00:00', at: '2026-07-29T20:00:00.55+00:00', session: 's-1',
  project: 'Membridge', projectPath: null, projectId: 'proj-1',
  intent: '(prompt not shared)',
  ...overrides,
})

describe('dedupeSyncedTwins', () => {
  it('folds a row against its synced-back twin, which differs in the ts STRING', () => {
    expect(dedupeSyncedTwins([localRow(), syncedTwin()])).toHaveLength(1)
  })

  it('keeps the LOCAL row, the one carrying the verbatim prompt', () => {
    const folded = dedupeSyncedTwins([syncedTwin(), localRow()])
    expect(folded).toHaveLength(1)
    expect(folded[0].projectPath).toBe('/Users/x/membridge')
    expect(folded[0].intent).toBe('wire the recall hook into the Stop path')
  })

  it('folds a SESSION-LESS row against its twin too', () => {
    // daySessions keys such a row off `entry:${id}`, and the id embeds the ts,
    // so an unfolded pair renders as two sessions a millisecond apart.
    const folded = dedupeSyncedTwins([
      localRow({ session: null, id: 'none|2026-07-29T20:00:00.550Z' }),
      syncedTwin({ session: null, id: 'none|2026-07-29T20:00:00.55+00:00' }),
    ])
    expect(folded).toHaveLength(1)
  })

  it('never folds two DIFFERENT sessions that happen to share an instant', () => {
    const folded = dedupeSyncedTwins([
      localRow({ session: 's-1', id: 'a' }),
      localRow({ session: 's-2', id: 'b' }),
    ])
    expect(folded).toHaveLength(2)
  })

  it('never folds two people, however alike their rows look', () => {
    const folded = dedupeSyncedTwins([
      localRow({ id: 'a', authorId: 'marco', author: 'Marco' }),
      localRow({ id: 'b', authorId: 'sarah', author: 'Sarah' }),
    ])
    expect(folded).toHaveLength(2)
  })

  it('never folds the same session in two different projects', () => {
    const folded = dedupeSyncedTwins([
      localRow({ id: 'a', projectId: 'proj-1' }),
      localRow({ id: 'b', projectId: 'proj-2' }),
    ])
    expect(folded).toHaveLength(2)
  })

  it('leaves a genuinely distinct second prompt of the same session alone', () => {
    const folded = dedupeSyncedTwins([
      localRow({ id: 'a', at: '2026-07-29T20:00:00.550Z' }),
      localRow({ id: 'b', at: '2026-07-29T20:05:00.000Z' }),
    ])
    expect(folded).toHaveLength(2)
  })

  it('is idempotent, so a caller folding twice cannot lose a row', () => {
    const once = dedupeSyncedTwins([localRow(), syncedTwin()])
    expect(dedupeSyncedTwins(once)).toEqual(once)
  })
})

// ---------------------------------------------------------------------------
// The slug. wouter runs decodeURI over location.pathname BEFORE it matches, so
// a percent-escaped slug arrives decoded and matches nothing.
// ---------------------------------------------------------------------------
describe('daySlug', () => {
  it('survives decodeURI unchanged, which encodeURIComponent does not', () => {
    const slug = daySlug(dayCardKey(entry({ authorId: '', author: 'Renée o~brien Melika' })))
    expect(decodeURI(slug)).toBe(slug)
    // And it holds nothing for a router to decode in the first place.
    expect(slug).toMatch(/^[A-Za-z0-9\-_~]+$/)
  })

  it('gives two different keys two different slugs, even across the separator', () => {
    // The tilde is the separator, and a name containing one is exactly what
    // defeated the escaping this replaced.
    const a = daySlug(dayCardKey(entry({ authorId: '', author: 'a~b' })))
    const b = daySlug(dayCardKey(entry({ authorId: '', author: 'a' })))
    expect(a).not.toBe(b)
  })

  it('reads the day half back for the pager, and only the day half', () => {
    const slug = daySlug(dayCardKey(entry({ at: '2026-07-29T20:00:00Z' })))
    expect(daySlugDay(slug)).toBe('2026-07-29')
  })

  it('returns no day for a hand-edited slug rather than throwing', () => {
    expect(daySlugDay('not-a-slug')).toBeNull()
    expect(daySlugDay('')).toBeNull()
    expect(daySlugDay(daySlug(`${UNDATED_DAY}\x00id:marco`))).toBeNull()
  })
})

describe('dayProjects', () => {
  it('lists every project of the day, busiest first', () => {
    const projects = dayProjects([
      entry({ id: 'a', projectPath: '/Users/x/sublease', project: 'sublease' }),
      entry({ id: 'b', projectPath: '/Users/x/membridge', project: 'membridge' }),
      entry({ id: 'c', projectPath: '/Users/x/membridge', project: 'membridge' }),
    ])
    expect(projects.map(p => p.name)).toEqual(['membridge', 'sublease'])
    expect(projects[0].count).toBe(2)
  })

  it('does not list a linked project twice under its two capitalisations', () => {
    const projects = dayProjects([localRow(), syncedTwin({ id: 'other' })])
    expect(projects).toHaveLength(1)
    // And it renders the name off the LOCAL row, the one the reader's own
    // folder is called, not the backend's copy of it.
    expect(projects[0].name).toBe('membridge')
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

describe('dayFiles', () => {
  it('ranks by how often the day came back to a file', () => {
    const files = dayFiles([
      entry({ id: 'a', files: ['lib/hooks.js', 'README.md'] }),
      entry({ id: 'b', files: ['lib/hooks.js'] }),
    ])
    expect(files.map(f => f.file)).toEqual(['lib/hooks.js', 'README.md'])
    expect(files[0].touches).toBe(2)
  })

  it('annotates a file from `changes` without counting the note as a visit', () => {
    const files = dayFiles([
      entry({ id: 'a', files: ['lib/hooks.js'], changes: [{ file: 'lib/hooks.js', status: 'edited', add: 1, del: 0, note: 'gate extracted', dep: false }] }),
    ])
    expect(files[0].touches).toBe(1)
    expect(files[0].note).toBe('gate extracted')
  })

  it('sinks supporting churn below real code touched the same number of times', () => {
    const files = dayFiles([entry({ id: 'a', files: ['docs/plan.md', 'lib/hooks.js'] })])
    expect(files.map(f => f.file)).toEqual(['lib/hooks.js', 'docs/plan.md'])
  })
})

describe('daySessions', () => {
  // The consequence of dropping collapseSessionCheckpoints from the feed:
  // buildEntries emits one entry per PROMPT, so a session with several prompts
  // is several rows sharing a session id. Collapsing on the id alone kept only
  // the newest, discarding every prompt but the last -- which is exactly what
  // "prompts underneath" is made of.
  it('renders one session\'s many prompts as ONE group holding all of them', () => {
    const sessions = daySessions([
      entry({ id: 'p1', session: 's1', at: '2026-07-29T20:00:00Z', intent: 'first ask' }),
      entry({ id: 'p2', session: 's1', at: '2026-07-29T20:05:00Z', intent: 'second ask' }),
      entry({ id: 'p3', session: 's1', at: '2026-07-29T20:10:00Z', intent: 'third ask' }),
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0].prompts.map(p => p.text)).toEqual(['first ask', 'second ask', 'third ask'])
  })

  it('keeps two distinct sessions apart even when their text is byte-identical', () => {
    const sessions = daySessions([
      entry({ id: 'x1', session: 's1', at: '2026-07-29T20:10:00Z', outcome: 'identical summary text', intent: 'identical ask' }),
      entry({ id: 'x2', session: 's2', at: '2026-07-29T20:05:00Z', outcome: 'identical summary text', intent: 'identical ask' }),
    ])
    expect(sessions).toHaveLength(2)
  })

  it('orders sessions newest first and each session\'s prompts oldest first', () => {
    const sessions = daySessions([
      entry({ id: 'o1', session: 'old', at: '2026-07-29T18:00:00Z', intent: 'older ask' }),
      entry({ id: 'n1', session: 'new', at: '2026-07-29T21:00:00Z', intent: 'newer ask' }),
      entry({ id: 'o2', session: 'old', at: '2026-07-29T17:00:00Z', intent: 'oldest ask' }),
    ])
    expect(sessions.map(s => s.key)).toEqual(['new', 'old'])
    expect(sessions[1].prompts.map(p => p.text)).toEqual(['oldest ask', 'older ask'])
  })

  it('drops a repeated ask rather than listing it once per checkpoint row', () => {
    const sessions = daySessions([
      entry({ id: 'a', session: 's1', at: '2026-07-29T20:00:00Z', intent: 'the same ask' }),
      entry({ id: 'b', session: 's1', at: '2026-07-29T20:05:00Z', intent: 'The same ask.' }),
    ])
    expect(sessions[0].prompts).toHaveLength(1)
  })

  it('gives a session-less row its own group rather than folding them together', () => {
    const sessions = daySessions([
      entry({ id: 'p1', session: null, at: '2026-07-29T20:00:00Z' }),
      entry({ id: 'p2', session: null, at: '2026-07-29T19:00:00Z' }),
    ])
    expect(sessions).toHaveLength(2)
    expect(sessions.every(s => s.session === null)).toBe(true)
  })

  it('contributes nothing for an entry that carried no prompt, not a blank bullet', () => {
    const sessions = daySessions([entry({ id: 'a', session: 's1', intent: null })])
    expect(sessions[0].prompts).toHaveLength(0)
  })
})

describe('dayBullets', () => {
  const overview = { kind: 'distilled' as const, text: 'the day\'s sentence', fromEntryId: 'x', coverageNote: null, source: 'pick' as const }

  it('reads oldest work first, one outcome per session', () => {
    const sessions = daySessions([
      entry({ id: 'a', session: 's1', at: '2026-07-29T18:00:00Z', outcome: 'the morning\'s outcome' }),
      entry({ id: 'b', session: 's2', at: '2026-07-29T21:00:00Z', outcome: 'the afternoon\'s outcome' }),
    ])
    expect(dayBullets(sessions, overview).map(b => b.text))
      .toEqual(['the morning\'s outcome', 'the afternoon\'s outcome'])
  })

  it('never repeats the sentence already on the card above it', () => {
    const sessions = daySessions([entry({ id: 'a', session: 's1', outcome: 'The day\'s sentence.' })])
    expect(dayBullets(sessions, overview)).toEqual([])
  })

  it('splits decisions the writer actually wrote as a list', () => {
    const sessions = daySessions([entry({
      id: 'a', session: 's1', outcome: '',
      decisions: '- Durability beats recency\n- Merged before writing settings.json',
    })])
    expect(dayBullets(sessions, overview).map(b => b.text))
      .toEqual(['Durability beats recency', 'Merged before writing settings.json'])
  })

  it('never shreds a flattened paragraph back into half-sentences', () => {
    // Pre-v0.2.8 text was flattened to one line on the way out of storage and
    // the structure is not recoverable. Sentence-splitting it produces the
    // garbage this list was rejected for once already.
    const long = `${'a decision that runs on and on. '.repeat(12)}`
    const sessions = daySessions([entry({ id: 'a', session: 's1', outcome: '', decisions: long })])
    expect(dayBullets(sessions, overview)).toEqual([])
  })

  it('invents nothing for a day it could not read', () => {
    const sessions = daySessions([entry({ id: 'a', session: 's1', outcome: '', undecryptable: true, intent: null })])
    const opaque = { kind: 'undecryptable' as const, text: OPAQUE_OVERVIEW, fromEntryId: null, coverageNote: null, source: 'pick' as const }
    expect(dayBullets(sessions, opaque)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The card's SECOND line: what the day was asked to do.
//
// It used to be built from the day's bullets, which are the same session
// outcomes the daemon digest joins with "; " to make the FIRST line. Two lines,
// one source: every populated card in Andrew's real feed printed its own
// headline twice, differing only in punctuation.
// ---------------------------------------------------------------------------
describe('dayAsks', () => {
  const withAsks = (rows: Partial<FeedEntry>[]) => daySessions(rows.map((r, i) => entry({ id: `e${i}`, ...r })))

  it('prefers the session GOAL, which is written for a reader', () => {
    const asks = dayAsks(withAsks([{
      session: 's1', goal: 'Redesign the hero terminal panel so it demonstrates the product',
      intent: 'Redesign the hero terminal panel so it demonstrates the product',
    }]))
    expect(asks.map(a => a.text)).toEqual(['Redesign the hero terminal panel so it demonstrates the product'])
    expect(asks[0].fromGoal).toBe(true)
  })

  it('falls back to the captured ask when a session wrote no goal', () => {
    const asks = dayAsks(withAsks([{ session: 's1', goal: null, intent: 'reconcile the UI changes with marcos most recent merges' }]))
    expect(asks.map(a => a.text)).toEqual(['reconcile the UI changes with marcos most recent merges'])
    expect(asks[0].fromGoal).toBe(false)
  })

  // The real short asks in Andrew's feed. Rendered as a statement of intent
  // these tell a reader nothing at all.
  it('drops a continuation prompt rather than printing it as the day\'s intent', () => {
    for (const noise of ['yes', 'continue', 'fill it in', 'ok']) {
      expect(dayAsks(withAsks([{ session: 's1', goal: null, intent: noise }]))).toEqual([])
    }
  })

  it('keeps the shortest ask that is still a real request', () => {
    // "letes build the bm25 fts5" is 25 characters, live, and is genuinely
    // what that session was asked to do.
    expect(dayAsks(withAsks([{ session: 's1', goal: null, intent: 'letes build the bm25 fts5' }])).map(a => a.text))
      .toEqual(['letes build the bm25 fts5'])
  })

  it('takes one line per session, its FIRST, oldest session first', () => {
    const asks = dayAsks(withAsks([
      { session: 's1', at: '2026-07-29T18:00:00Z', goal: null, intent: 'push all this over to the site reworks' },
      { session: 's1', at: '2026-07-29T18:30:00Z', goal: null, intent: 'now do the same for the other branch' },
      { session: 's2', at: '2026-07-29T21:00:00Z', goal: null, intent: 'reconcile the UI changes with marcos merges' },
    ]))
    expect(asks.map(a => a.text)).toEqual(['push all this over to the site reworks', 'reconcile the UI changes with marcos merges'])
  })

  it('never lists the same ask twice across sessions', () => {
    const asks = dayAsks(withAsks([
      { session: 's1', at: '2026-07-29T18:00:00Z', goal: null, intent: 'ok im ready to fully review, what needs doing' },
      { session: 's2', at: '2026-07-29T19:00:00Z', goal: null, intent: 'Ok im ready to fully review, what needs doing.' },
    ]))
    expect(asks).toHaveLength(1)
  })

  it('says nothing for a day whose rows carried no readable ask', () => {
    expect(dayAsks(withAsks([{ session: 's1', goal: null, intent: null }]))).toEqual([])
  })

  // The prompt reaches this client with its newlines already stripped
  // (digest.clip flattens on the way out of storage), so a request followed by
  // a pasted terminal transcript is one long line with no boundary to cut on.
  // Clipped to fit, it rendered a shell session as the day's stated intent.
  it('skips a pasted transcript rather than clipping it into the line', () => {
    const paste = 'fix this efficiently and effectively as recommended. andrewbrown@Andrews-MacBook-Pro Downloads % defaults read /Applications/MemBridge.app/Contents/Info.plist CFBundleShortVersionString 0.2.8 andrewbrown@Andrews-MacBook-Pro Downloads % cd ~/membridge'
    const asks = dayAsks(withAsks([
      { session: 's1', at: '2026-07-29T18:00:00Z', goal: null, intent: paste },
      { session: 's1', at: '2026-07-29T18:30:00Z', goal: null, intent: 'now push it to the site branch' },
    ]))
    // It kept looking through the session rather than settling for a fragment.
    expect(asks.map(a => a.text)).toEqual(['now push it to the site branch'])
    expect(asks[0].text).not.toContain('…')
  })

  it('leaves a session out entirely when everything it asked is unreadable', () => {
    const paste = `paste ${'x'.repeat(300)}`
    expect(dayAsks(withAsks([{ session: 's1', goal: null, intent: paste }]))).toEqual([])
  })

  it('never applies that ceiling to a written goal', () => {
    // A goal is authored prose by construction, and lib/hooks GOAL_MAX already
    // bounds it. The ceiling exists for pasted prompts, not for authored text.
    const longGoal = `Decide whether directed agent-to-agent teammate messages are worth building ${'and '.repeat(30)}shipping`
    const asks = dayAsks(withAsks([{ session: 's1', goal: longGoal, intent: longGoal }]))
    expect(asks).toHaveLength(1)
    expect(asks[0].fromGoal).toBe(true)
  })
})

describe('dayIntent', () => {
  const ask = (text: string, key = text.slice(0, 4)) => ({ key, text, fromGoal: false })

  it('scales 1 to 3 sentences by how much was done that day', () => {
    expect(dayIntentSentences(1)).toBe(1)
    expect(dayIntentSentences(3)).toBe(2)
    expect(dayIntentSentences(9)).toBe(3)
  })

  it('joins the day\'s own asks whole, never re-worded', () => {
    expect(dayIntent([ask('first thing'), ask('second thing')], 2)).toBe('first thing. second thing.')
  })

  it('adds no second full stop to a line that already ends in one', () => {
    expect(dayIntent([ask('already punctuated.')], 1)).toBe('already punctuated.')
    expect(dayIntent([ask('clipped mid sen…')], 1)).toBe('clipped mid sen…')
  })

  it('never repeats the sentence already on the line above it', () => {
    expect(dayIntent([ask('Ship the second wave of tickets')], 1, 'Ship the second wave of tickets.')).toBe('')
  })

  it('shows fewer whole asks rather than half of one when the line runs long', () => {
    const long = 'x'.repeat(200)
    const out = dayIntent([ask(long, 'a'), ask(long, 'b'), ask(long, 'c')], 9)
    // One whole ask, not three clipped ones: the budget decides HOW MANY are
    // shown and never trims one into a fragment.
    expect(out).toBe(`${long}.`)
  })

  it('always shows the first ask, however long, rather than an empty line', () => {
    const huge = 'y'.repeat(500)
    expect(dayIntent([ask(huge)], 1)).toBe(`${huge}.`)
  })

  it('says nothing at all for a day that captured no ask', () => {
    expect(dayIntent([], 1)).toBe('')
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
  })

  // The owner's ask, exactly: a team of two working is two cards.
  it('renders two people working today as exactly two cards', () => {
    const cards = buildDayCards([
      entry({ id: 'a', session: 'a', authorId: 'marco', author: 'Marco', project: 'membridge', projectPath: '/Users/x/membridge' }),
      entry({ id: 'b', session: 'b', authorId: 'marco', author: 'Marco', project: 'sublease', projectPath: '/Users/x/sublease' }),
      entry({ id: 'c', session: 'c', authorId: 'andrew', author: 'Andrew', project: 'membridge', projectPath: '/Users/x/membridge' }),
    ])
    expect(cards).toHaveLength(2)
  })

  it('names every project a card spans, and never a single one as the scope', () => {
    // Seven membridge sessions and one sublease session. Copying `project` off
    // the newest entry would have labelled the whole day "sublease".
    const cards = buildDayCards([
      entry({ id: 'x', session: 'x', at: '2026-07-29T21:00:00Z', project: 'sublease', projectPath: '/Users/x/sublease' }),
      ...Array.from({ length: 7 }, (_, i) => entry({
        id: `m${i}`, session: `m${i}`, at: `2026-07-29T1${i}:00:00Z`,
        project: 'membridge', projectPath: '/Users/x/membridge',
      })),
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0].projects.map(p => p.name)).toEqual(['membridge', 'sublease'])
    expect(cards[0].projects[0].count).toBe(7)
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

  it('counts SESSIONS, not rows -- several prompts of one session are one session', () => {
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

  // THE DUPLICATION the owner reported, with the real asymmetry.
  it('does not double a day\'s counts when its work synced back as its own twin', () => {
    const cards = buildDayCards([
      localRow({ id: 's-1|2026-07-29T20:00:00.550Z', files: ['lib/hooks.js'] }),
      syncedTwin({ id: 's-1|2026-07-29T20:00:00.55+00:00', files: ['lib/hooks.js'] }),
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0].sessionCount).toBe(1)
    expect(cards[0].files).toHaveLength(1)
    expect(cards[0].files[0].touches).toBe(1)
    expect(cards[0].sessions[0].prompts).toHaveLength(1)
    // And it kept the real prompt, not the placeholder the wire copy carries.
    expect(cards[0].sessions[0].prompts[0].text).toBe('wire the recall hook into the Stop path')
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

  it('splits one person\'s work across two LOCAL days even inside one UTC day', () => {
    // 21:00 Jul 28 and 09:00 Jul 29 locally, both Jul 29 in UTC.
    const cards = buildDayCards([
      entry({ id: 'morning', session: 'a', at: '2026-07-29T16:00:00Z' }),
      entry({ id: 'lastnight', session: 'b', at: '2026-07-29T04:00:00Z' }),
    ])
    expect(cards).toHaveLength(2)
    expect(cards[0].sessions[0].entries.map(e => e.id)).toEqual(['morning'])
    expect(cards[1].sessions[0].entries.map(e => e.id)).toEqual(['lastnight'])
  })

  it('carries the overview pick onto the card', () => {
    const cards = buildDayCards([
      entry({ id: 'a', session: 'a', at: '2026-07-29T20:00:00Z', outcome: '' }),
      entry({ id: 'b', session: 'b', at: '2026-07-29T19:00:00Z', distilled: true, outcome: 'the day\'s real outcome' }),
    ])
    expect(cards[0].overview.text).toBe('the day\'s real outcome')
    expect(cards[0].overview.kind).toBe('distilled')
  })

  it('carries a slug the day view can be addressed by', () => {
    const cards = buildDayCards([entry()])
    expect(cards[0].slug).toBe(daySlug(cards[0].key))
    expect(daySlugDay(cards[0].slug)).toBe('2026-07-29')
  })

  it('returns nothing for no entries rather than one empty card', () => {
    expect(buildDayCards([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The daemon's day digest (GET /api/feed `dayDigests`). This is the general
// one-sentence day header the owner asked for -- "Worked on UI fixes, app
// install and dmg" -- which no pick of one session's outcome can be, and which
// this module must never compose for itself.
// ---------------------------------------------------------------------------
const digest = (overrides: Partial<DayDigest> = {}): DayDigest => ({
  // The daemon joins the two key halves with a SPACE; dayCardKey uses NUL.
  key: '2026-07-29 id:marco',
  kind: 'distilled',
  text: 'Worked on UI fixes, app install and dmg',
  sources: [{ entryId: 's1|2026-07-29T20:00:00Z', session: 's1', ts: '2026-07-29T20:00:00Z', project: 'membridge', projectId: null, distilled: true, text: 'x' }],
  sessions: 1,
  summarized: 1,
  omittedSessions: 0,
  entries: 1,
  complete: true,
  coverageNote: null,
  ...overrides,
})

describe('digestKey', () => {
  it('reconciles the daemon\'s space separator with the card\'s NUL', () => {
    expect(digestKey('2026-07-29 id:marco')).toBe(dayCardKey(entry()))
  })

  it('splits on the FIRST space only, so a display-name fallback survives', () => {
    // "name:marco melika" contains spaces of its own; splitting on all of them
    // would shred exactly the keys the name fallback exists for.
    expect(digestKey('2026-07-29 name:marco melika'))
      .toBe(dayCardKey(entry({ authorId: '', author: 'Marco Melika' })))
  })

  it('leaves a key with no separator alone rather than mangling it', () => {
    expect(digestKey('nonsense')).toBe('nonsense')
    expect(digestKey('')).toBe('')
  })
})

describe('pickDayOverview with a digest', () => {
  it('renders the daemon\'s sentence verbatim, over any session outcome', () => {
    const pick = pickDayOverview([entry({ distilled: true, outcome: 'one session\'s outcome' })], digest())
    expect(pick.text).toBe('Worked on UI fixes, app install and dmg')
    expect(pick.source).toBe('digest')
    expect(pick.kind).toBe('distilled')
  })

  it('links the sentence at the session it was drawn from', () => {
    expect(pickDayOverview([entry()], digest()).fromEntryId).toBe('s1|2026-07-29T20:00:00Z')
  })

  it('keeps un-summarized and undecryptable as DISTINCT states', () => {
    expect(pickDayOverview([], digest({ kind: 'none', text: NO_SUMMARY_OVERVIEW })).kind).toBe('none')
    expect(pickDayOverview([], digest({ kind: 'undecryptable', text: OPAQUE_OVERVIEW })).kind).toBe('undecryptable')
  })

  it('degrades a kind this build has never heard of to the weakest honest one', () => {
    // There is text and nothing claims it was distilled. Never rendered raw:
    // the value reaches a CSS class name.
    expect(pickDayOverview([], digest({ kind: 'something-new' })).kind).toBe('summary')
  })

  it('falls back to its own pick when no digest arrived for the day', () => {
    const pick = pickDayOverview([entry({ distilled: true, outcome: 'one session\'s outcome' })])
    expect(pick.text).toBe('one session\'s outcome')
    expect(pick.source).toBe('pick')
    expect(pick.coverageNote).toBeNull()
  })

  // The coverage note used to render whenever the daemon set one, which put an
  // amber warning on 3 of the 6 cards in Andrew's real feed -- the rate at
  // which a warning stops being read. The rule below is what narrowed it.
  it('warns about statements the daemon dropped to its own cap, which no paging recovers', () => {
    const note = '2 more sessions not shown'
    expect(pickDayOverview([entry()], digest({ omittedSessions: 2, coverageNote: note })).coverageNote).toBe(note)
  })

  it('warns about a truncated day while this client is still mid-day', () => {
    const note = 'showing only the part of this day that has loaded'
    expect(pickDayOverview([entry()], digest({ complete: false, coverageNote: note }), { dayFullyLoaded: false }).coverageNote)
      .toBe(note)
  })

  it('drops that warning once the client has loaded past the start of the day', () => {
    // `complete` is a fact about ONE PAGE (lib/digest.js), not about the day.
    // A client holding several pages can have loaded the rest itself, and
    // repeating the page's warning then describes a gap that is not there.
    const note = 'showing only the part of this day that has loaded'
    expect(pickDayOverview([entry()], digest({ complete: false, coverageNote: note }), { dayFullyLoaded: true }).coverageNote)
      .toBeNull()
  })

  it('never warns under a header that already says nothing is known', () => {
    // "This summary is partial" under "No summary yet for this day." warns
    // about the coverage of a summary that does not exist.
    const note = 'showing only the part of this day that has loaded'
    for (const kind of ['none', 'undecryptable']) {
      expect(pickDayOverview([entry()], digest({ kind, complete: false, coverageNote: note }), { dayFullyLoaded: false }).coverageNote)
        .toBeNull()
    }
  })

  it('claims no shortfall for a whole day the daemon saw whole', () => {
    expect(pickDayOverview([entry()], digest()).coverageNote).toBeNull()
  })
})

describe('buildDayCards with digests', () => {
  it('joins a digest to its card across the separator difference', () => {
    const cards = buildDayCards([entry()], [digest()])
    expect(cards[0].overview.text).toBe('Worked on UI fixes, app install and dmg')
  })

  it('leaves a card whose day has no digest on its own pick', () => {
    const cards = buildDayCards(
      [entry({ authorId: 'sarah', author: 'Sarah', outcome: 'sarah\'s only outcome' })],
      [digest()],
    )
    expect(cards[0].overview.source).toBe('pick')
    expect(cards[0].overview.text).toBe('sarah\'s only outcome')
  })

  it('picks the digest that accounts for the most of the day, never merging two', () => {
    // A reader three pages deep holds one digest per page for the same day.
    const cards = buildDayCards([entry()], [
      digest({ text: 'the page-two slice', summarized: 1, entries: 1 }),
      digest({ text: 'the fuller statement', summarized: 4, entries: 9 }),
    ])
    expect(cards[0].overview.text).toBe('the fuller statement')
  })

  // THE DEFECT, with marco's real 2026-08-04 numbers. Page one held 18 of the
  // day's rows and not one summarized session; page two held 13 rows and three.
  // Ranked on rows the card picked page one, so a day with three perfectly good
  // statements in hand rendered "No summary yet for this day." -- and, because
  // that page was also the truncated one, an amber coverage warning under it.
  it('prefers the page that can say something over the page with more rows', () => {
    const cards = buildDayCards([entry()], [
      digest({
        text: NO_SUMMARY_OVERVIEW, kind: 'none', sources: [],
        sessions: 2, summarized: 0, entries: 18,
        complete: false, coverageNote: 'showing only the part of this day that has loaded',
      }),
      digest({
        text: 'Done and the memory that worried me turned out to be stale', kind: 'summary',
        sessions: 4, summarized: 3, entries: 13, complete: true, coverageNote: null,
      }),
    ])
    expect(cards[0].overview.text).toBe('Done and the memory that worried me turned out to be stale')
    expect(cards[0].overview.kind).toBe('summary')
    expect(cards[0].overview.coverageNote).toBeNull()
  })

  it('breaks a tie on statements toward the page that reached the day\'s start', () => {
    const cards = buildDayCards([entry()], [
      digest({ text: 'the truncated page', summarized: 2, entries: 40, complete: false }),
      digest({ text: 'the page that reached the start', summarized: 2, entries: 5, complete: true }),
    ])
    expect(cards[0].overview.text).toBe('the page that reached the start')
  })

  it('is unchanged by an empty digest list, which is what an older daemon sends', () => {
    expect(buildDayCards([entry()], [])).toEqual(buildDayCards([entry()]))
  })

  it('still drops a bullet that merely restates the digest sentence', () => {
    const cards = buildDayCards(
      [entry({ session: 's1', outcome: 'Worked on UI fixes, app install and dmg.' })],
      [digest()],
    )
    expect(cards[0].bullets).toEqual([])
  })
})

describe('buildDayCards tags', () => {
  it('tags a card from the files its day touched', () => {
    // Distinct `session` on each entry: dedupeSyncedTwins (buildDayCards'
    // first step) keys on [session, author, project, instant], and with a
    // shared session both entries collapse to the same key -- the same
    // author, project and `at` the entry() default gives both -- so the
    // second entry's file is discarded as a "synced twin" of the first
    // before grouping ever sees it, and the card holds only one area.
    const cards = buildDayCards([
      entry({ id: 'a', session: 's1', files: ['ui/src/App.tsx', 'ui/src/Shell.tsx', 'ui/src/x.css'] }),
      entry({ id: 'b', session: 's2', files: ['supabase/migrations/057_x.sql'] }),
    ])
    expect(cards[0].tags.map(t => t.area)).toEqual(['UI/UX', 'Data/Schema'])
  })

  it('gives a card with no recognised files an empty list, never undefined', () => {
    const cards = buildDayCards([entry({ id: 'a', files: [] })])
    expect(cards[0].tags).toEqual([])
  })

  // The spec calls worktree-path normalisation the single most important guard
  // of this feature -- almost all work in this repo happens inside
  // `.claude/worktrees/<name>/`, and a raw path like this one begins `.claude/`
  // and tags every such day `Config`. areaOf pins it as a unit; this pins it
  // END TO END, because the card is built from dayFiles' output and a
  // normalisation that only held inside areaOf would still ship the bug.
  it('normalises a worktree-prefixed path on the way onto the card', () => {
    const cards = buildDayCards([
      entry({ id: 'a', files: ['.claude/worktrees/agent-x/ui/src/App.tsx'] }),
    ])
    expect(cards[0].files.map(fl => fl.file)).toEqual(['.claude/worktrees/agent-x/ui/src/App.tsx'])
    expect(cards[0].tags.map(t => t.area)).toEqual(['UI/UX'])
  })

  it('counts a file named by changes as well as by files', () => {
    const cards = buildDayCards([
      entry({ id: 'a', files: [], changes: [{ file: 'lib/feed.js', status: 'edited', add: 1, del: 0, note: 'x', dep: false }] }),
    ])
    expect(cards[0].tags.map(t => t.area)).toEqual(['Backend'])
  })
})
