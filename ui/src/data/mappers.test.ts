import { describe, it, expect } from 'vitest'
import {
  collapseSessionCheckpoints, dedupeLiveSessions, feedQueryString, groupLiveSessions, hasSummary, intentOf,
  lastSharedAtByAuthor, latestSummaryFor, mapFeedEntry, mapLiveSession, mapMember, mapProjectRow, mapStreamEntry,
  memberIdsFor, outcomeOf, projectCountsByAuthor, streamEntryId,
  type RawFeedEntry, type RawProjectRow, type RawTeamFeedEntry,
} from './mappers'
import type { LiveSession, StreamEntry } from './types'

const entry = (overrides: Partial<RawFeedEntry> = {}): RawFeedEntry => ({
  ts: '2026-07-29T20:00:00Z',
  author: 'Andrew',
  authorId: 'andrew',
  source: 'Codex',
  session: 's1',
  project: 'membridge',
  projectPath: '/Users/x/membridge',
  projectId: null,
  ask: '',
  summary: null,
  distilled: false,
  files: [],
  goal: null,
  headline: null,
  ...overrides,
})

describe('hasSummary', () => {
  it('is true when a headline is present', () => {
    expect(hasSummary(entry({ headline: 'Shipped the thing' }))).toBe(true)
  })
  it('is true for a distilled summary even with no headline', () => {
    expect(hasSummary(entry({ distilled: true, summary: 'Long form result' }))).toBe(true)
  })
  it('is false for a harvested (non-distilled) summary with no headline', () => {
    expect(hasSummary(entry({ distilled: false, summary: 'raw last message' }))).toBe(false)
  })
  it('is false with neither headline nor summary -- this is the WIP/live signal', () => {
    expect(hasSummary(entry())).toBe(false)
  })
})

describe('intentOf', () => {
  it('prefers goal over ask', () => {
    expect(intentOf(entry({ goal: 'fix the hook', ask: 'please fix it' }))).toBe('fix the hook')
  })
  it('falls back to ask when goal is absent', () => {
    expect(intentOf(entry({ goal: null, ask: 'please fix it' }))).toBe('please fix it')
  })
  it('is null when goal and ask are both absent, never a placeholder string', () => {
    expect(intentOf(entry({ goal: null, ask: '' }))).toBeNull()
  })
  // FIX 1a/1b: lib/memorydb.js:155 mints the literal string "(not captured)"
  // for a summary with no matching prompt event. It is not a real intent --
  // the UI must treat it exactly like an absent one, never render it verbatim.
  it('treats the daemon\'s literal "(not captured)" placeholder as absent', () => {
    expect(intentOf(entry({ goal: null, ask: '(not captured)' }))).toBeNull()
  })
  it('treats "(not captured)" as absent even when it lands in goal, falling back to a real ask', () => {
    expect(intentOf(entry({ goal: '(not captured)', ask: 'please fix it' }))).toBe('please fix it')
  })
  it('treats a whitespace-only ask as absent, not a blank captured intent', () => {
    expect(intentOf(entry({ goal: null, ask: '   ' }))).toBeNull()
  })
})

describe('outcomeOf', () => {
  it('prefers headline over summary', () => {
    expect(outcomeOf(entry({ headline: 'h', summary: 's' }))).toBe('h')
  })
  it('falls back to an empty string, never null, when both are absent', () => {
    expect(outcomeOf(entry())).toBe('')
  })
})

describe('streamEntryId and mapStreamEntry', () => {
  it('is a session+ts composite because session alone is not unique per entry', () => {
    expect(streamEntryId(entry({ session: 's1', ts: 't1' }))).toBe('s1|t1')
    expect(streamEntryId(entry({ session: null, ts: 't1' }))).toBe('none|t1')
  })
  it('marks live true exactly when there is no summary yet', () => {
    expect(mapStreamEntry(entry()).live).toBe(true)
    expect(mapStreamEntry(entry({ headline: 'done' })).live).toBe(false)
  })
  it('carries the raw session id through untouched, for checkpoint collapsing', () => {
    expect(mapStreamEntry(entry({ session: 's1' })).session).toBe('s1')
    expect(mapStreamEntry(entry({ session: null })).session).toBeNull()
  })
})

// BUG 2: the daemon's Stop hook re-summarizes a WORKING session every few
// edits, so a feed/stream page can carry several checkpoint rows for one
// session -- only the newest should render. These tests cover the pure
// grouping logic; FeedPage.test.tsx and ProjectPage.test.tsx cover the same
// fix wired into the real screens.
describe('collapseSessionCheckpoints', () => {
  const stream = (overrides: Partial<StreamEntry> = {}): StreamEntry => ({
    id: 'e1', author: 'Andrew', authorId: 'andrew', tool: 'Codex', at: '2026-07-29T19:00:00Z',
    live: false, outcome: 'a checkpoint', intent: null, files: [], session: 's1', ...overrides,
  })

  it('collapses several checkpoints of the same session into just the newest one', () => {
    const older = stream({ id: 'e1', at: '2026-07-29T18:00:00Z', outcome: 'first checkpoint' })
    const newer = stream({ id: 'e2', at: '2026-07-29T19:00:00Z', outcome: 'second checkpoint' })
    const newest = stream({ id: 'e3', at: '2026-07-29T20:00:00Z', outcome: 'latest checkpoint' })

    const out = collapseSessionCheckpoints([newest, newer, older])

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'e3', outcome: 'latest checkpoint' })
  })

  it('never merges two distinct sessions, even when their outcome text is byte-identical', () => {
    const a = stream({ id: 'a1', session: 's1', outcome: 'same text', at: '2026-07-29T19:00:00Z' })
    const b = stream({ id: 'b1', session: 's2', outcome: 'same text', at: '2026-07-29T19:05:00Z' })

    const out = collapseSessionCheckpoints([b, a])

    expect(out).toHaveLength(2)
    expect(out.map(e => e.session).sort()).toEqual(['s1', 's2'])
  })

  it('never merges two session-less rows into each other', () => {
    const a = stream({ id: 'a1', session: null, at: '2026-07-29T19:00:00Z' })
    const b = stream({ id: 'b1', session: null, at: '2026-07-29T19:05:00Z' })

    expect(collapseSessionCheckpoints([b, a])).toHaveLength(2)
  })

  it('orders the collapsed result newest-first regardless of input order', () => {
    const older = stream({ id: 'e1', session: 's1', at: '2026-07-29T18:00:00Z' })
    const newer = stream({ id: 'e2', session: 's2', at: '2026-07-29T20:00:00Z' })

    expect(collapseSessionCheckpoints([older, newer]).map(e => e.id)).toEqual(['e2', 'e1'])
  })
})

describe('mapFeedEntry', () => {
  it('carries the project name and path alongside every StreamEntry field', () => {
    const e = mapFeedEntry(entry({ project: 'sublease', projectPath: '/Users/x/sublease', headline: 'done' }))
    expect(e).toMatchObject({ project: 'sublease', projectPath: '/Users/x/sublease', outcome: 'done', live: false })
  })
})

describe('feedQueryString', () => {
  it('always sets limit and omits any filter that is null', () => {
    expect(feedQueryString({ author: null, project: null, source: null }, { limit: 30, before: null }))
      .toBe('limit=30')
  })
  it('includes only the filters that are set, plus before when paging', () => {
    const qs = feedQueryString({ author: 'andrew', project: '/Users/x/membridge', source: null }, { limit: 30, before: '2026-07-28T00:00:00Z' })
    const params = new URLSearchParams(qs)
    expect(params.get('author')).toBe('andrew')
    expect(params.get('project')).toBe('/Users/x/membridge')
    expect(params.get('source')).toBeNull()
    expect(params.get('before')).toBe('2026-07-28T00:00:00Z')
  })
})

describe('dedupeLiveSessions and mapLiveSession', () => {
  it('drops entries that already have a summary', () => {
    expect(dedupeLiveSessions([entry({ headline: 'done' })])).toHaveLength(0)
  })
  it('keeps only the newest entry per session (input assumed newest-first)', () => {
    const newer = entry({ session: 's1', ts: '2026-07-29T21:00:00Z' })
    const older = entry({ session: 's1', ts: '2026-07-29T19:00:00Z' })
    const out = dedupeLiveSessions([newer, older])
    expect(out).toEqual([newer])
  })
  it('maps a live entry to a LiveSession using the entry ts as startedAt', () => {
    const live = mapLiveSession(entry({ goal: 'rebuild the UI' }))
    expect(live).toMatchObject({ id: 's1', author: 'Andrew', authorId: 'andrew', tool: 'Codex', projectName: 'membridge', startedAt: '2026-07-29T20:00:00Z', intent: 'rebuild the UI' })
  })
})

describe('groupLiveSessions', () => {
  const live = (overrides: Partial<LiveSession> = {}): LiveSession => ({
    id: 's1', author: 'You', authorId: 'me', tool: 'Claude Code', projectName: 'membridge',
    startedAt: '2026-07-29T20:00:00Z', intent: null, ...overrides,
  })

  it('collapses nine same-person, same-project sessions with no intent into one group with no intent', () => {
    const sessions = Array.from({ length: 9 }, (_, i) => live({ id: `s${i}`, startedAt: `2026-07-29T20:0${i}:00Z` }))
    const groups = groupLiveSessions(sessions)
    expect(groups).toHaveLength(1)
    expect(groups[0].intent).toBeNull()
    expect(groups[0].sessionCount).toBe(9)
  })

  it('surfaces the most recent non-empty intent in the group, even when a newer session in it has none', () => {
    const sessions = [
      live({ id: 's1', startedAt: '2026-07-29T19:00:00Z', intent: 'first pass at the hook' }),
      live({ id: 's2', startedAt: '2026-07-29T20:00:00Z', intent: null }),
    ]
    expect(groupLiveSessions(sessions)[0].intent).toBe('first pass at the hook')
  })

  it('keeps two different projects for the same person as two separate rows', () => {
    const sessions = [live({ id: 's1', projectName: 'membridge' }), live({ id: 's2', projectName: 'sublease' })]
    expect(groupLiveSessions(sessions)).toHaveLength(2)
  })

  it('keeps two different people in the same project as two separate rows', () => {
    const sessions = [live({ id: 's1', authorId: 'me', author: 'You' }), live({ id: 's2', authorId: 'andrew', author: 'Andrew' })]
    const groups = groupLiveSessions(sessions)
    expect(groups).toHaveLength(2)
    expect(groups.every(g => g.sessionCount === 1)).toBe(true)
  })

  it('uses the OLDEST session in the group as startedAt -- when the work actually began', () => {
    const sessions = [
      live({ id: 's1', startedAt: '2026-07-29T18:00:00Z' }),
      live({ id: 's2', startedAt: '2026-07-29T21:00:00Z' }),
    ]
    expect(groupLiveSessions(sessions)[0].startedAt).toBe('2026-07-29T18:00:00Z')
  })
})

describe('latestSummaryFor and memberIdsFor', () => {
  it('picks the first entry (newest-first) that carries a headline or summary', () => {
    const stale = entry({ headline: 'old work', ts: '2026-07-28T00:00:00Z', author: 'You', authorId: 'me' })
    const fresh = entry({ headline: 'fresh work', ts: '2026-07-29T00:00:00Z', author: 'Andrew', authorId: 'andrew' })
    expect(latestSummaryFor([fresh, stale])).toEqual({ text: 'fresh work', author: 'Andrew', at: '2026-07-29T00:00:00Z' })
  })
  it('returns null when no entry has a headline or summary', () => {
    expect(latestSummaryFor([entry()])).toBeNull()
  })
  it('collects distinct non-null authorIds', () => {
    const ids = memberIdsFor([entry({ authorId: 'andrew' }), entry({ authorId: 'andrew' }), entry({ authorId: 'sarah' }), entry({ authorId: null })])
    expect(ids.sort()).toEqual(['andrew', 'sarah'])
  })
})

describe('mapProjectRow', () => {
  const row: RawProjectRow = {
    path: '/Users/x/membridge', name: 'membridge', exists: true, paused: false,
    lastSync: '2026-07-29T19:00:00Z', lastActivity: '2026-07-29T19:00:00Z',
    sessionsTotal: 184, sessionsThisWeek: 31, dailyCounts: [5, 8, 4, 10, 7, 12, 13],
    tools: ['Claude Code'], team: { projectId: 'proj-1', teamId: 'team-1' },
  }

  it('passes the daemon-computed sessionsThisWeek and dailyCounts straight through', () => {
    const p = mapProjectRow(row, [])
    expect(p.sessionsThisWeek).toBe(31)
    expect(p.dailyCounts).toEqual([5, 8, 4, 10, 7, 12, 13])
  })
  it('is shared exactly when the row carries a team link', () => {
    expect(mapProjectRow(row, []).shared).toBe(true)
    expect(mapProjectRow({ ...row, team: null }, []).shared).toBe(false)
  })
  it('matches team entries by projectId and local entries by path', () => {
    const local = entry({ projectPath: '/Users/x/membridge', projectId: null, authorId: 'me' })
    const team = entry({ projectPath: null, projectId: 'proj-1', authorId: 'sarah' })
    const other = entry({ projectPath: '/Users/x/other', projectId: 'proj-9', authorId: 'ghost' })
    const p = mapProjectRow(row, [local, team, other])
    expect(p.memberIds.sort()).toEqual(['me', 'sarah'])
  })
})

describe('projectCountsByAuthor and mapMember', () => {
  it('counts distinct projects per author across the feed page', () => {
    const counts = projectCountsByAuthor([
      entry({ authorId: 'andrew', projectPath: '/a' }),
      entry({ authorId: 'andrew', projectPath: '/b' }),
      entry({ authorId: 'andrew', projectPath: '/a' }), // dup, not double-counted
      entry({ authorId: 'sarah', projectPath: '/a' }),
    ])
    expect(counts).toEqual({ andrew: 2, sarah: 1 })
  })
  it('maps a member row to only what this machine can observe, never a fabricated diagnosis', () => {
    const m = mapMember(
      { user_id: 'andrew', display_name: 'Andrew', role: 'admin', joined_at: '2026-07-22T18:58:00Z' },
      { andrew: 3 },
      { andrew: '2026-07-29T19:00:00Z' },
    )
    expect(m).toEqual({
      id: 'andrew', name: 'Andrew', email: '', role: 'admin', joinedAt: '2026-07-22T18:58:00Z',
      projectCount: 3, lastSharedAt: '2026-07-29T19:00:00Z', keyAlert: false,
    })
  })
  it('falls back joinedAt to an empty string when the row carries no timestamp, rather than asserting one', () => {
    const m = mapMember({ user_id: 'andrew', display_name: 'Andrew', role: 'admin', joined_at: null }, {}, {})
    expect(m.joinedAt).toBe('')
  })
  it('is null for lastSharedAt when the member has no entry in the team-feed page, never a made-up time', () => {
    const m = mapMember({ user_id: 'sarah', display_name: 'Sarah', role: 'member', joined_at: '2026-07-27T16:31:00Z' }, {}, {})
    expect(m.lastSharedAt).toBeNull()
  })
})

describe('lastSharedAtByAuthor', () => {
  const row = (overrides: Partial<RawTeamFeedEntry> = {}): RawTeamFeedEntry => ({
    author_id: 'andrew', ts: '2026-07-29T19:00:00Z', ...overrides,
  })

  it('picks the newest ts per author_id', () => {
    const out = lastSharedAtByAuthor([
      row({ author_id: 'andrew', ts: '2026-07-28T00:00:00Z' }),
      row({ author_id: 'andrew', ts: '2026-07-29T19:00:00Z' }),
      row({ author_id: 'sarah', ts: '2026-07-20T00:00:00Z' }),
    ])
    expect(out).toEqual({ andrew: '2026-07-29T19:00:00Z', sarah: '2026-07-20T00:00:00Z' })
  })
  it('ignores rows with no author_id', () => {
    expect(lastSharedAtByAuthor([row({ author_id: null })])).toEqual({})
  })
})
