import { describe, it, expect } from 'vitest'
import {
  collapseSessionCheckpoints, dedupeLiveSessions, feedQueryString, groupLiveSessions, hasSummary, intentOf,
  latestSummaryFor, mapFeedEntry, mapLiveSession, mapMember, mapProjectRow, mapStreamEntry,
  memberActivity, recentAuthorIdsFor, outcomeOf, streamEntryId, clipWords, OUTCOME_MAX,
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
  live: false,
  ...overrides,
})

describe('mapStreamEntry brief fields (session detail page, Task 2)', () => {
  it('carries summaryFull, decisions, gotchas and changes through', () => {
    const mapped = mapStreamEntry(entry({
      summaryFull: 'The whole unclipped brief, both sentences intact.',
      decisions: 'Chose the hosted checkout',
      gotchas: 'Sandbox rate limits bite fast',
      changes: [{ file: 'src/pay.js', status: 'edited', add: 12, del: 3, note: 'gateway wiring', dep: false }],
    }))
    expect(mapped.summaryFull).toBe('The whole unclipped brief, both sentences intact.')
    expect(mapped.decisions).toBe('Chose the hosted checkout')
    expect(mapped.gotchas).toBe('Sandbox rate limits bite fast')
    expect(mapped.changes).toEqual([{ file: 'src/pay.js', status: 'edited', add: 12, del: 3, note: 'gateway wiring', dep: false }])
  })
  it('absent brief fields become null / [] and never undefined', () => {
    const mapped = mapStreamEntry(entry())
    expect(mapped.summaryFull).toBeNull()
    expect(mapped.decisions).toBeNull()
    expect(mapped.gotchas).toBeNull()
    expect(mapped.changes).toEqual([])
    expect(Object.values(mapped)).not.toContain(undefined)
  })
  it('a sparse daemon change row is normalized, never undefined per field', () => {
    const mapped = mapStreamEntry(entry({ changes: [{ file: 'package-lock.json' }] }))
    expect(mapped.changes).toEqual([{ file: 'package-lock.json', status: 'edited', add: null, del: null, note: null, dep: false }])
  })
  it('intentOf and outcomeOf behave exactly as before (additive change only)', () => {
    expect(intentOf(entry({ goal: 'wire payments', ask: 'the verbatim prompt' }))).toBe('wire payments')
    expect(intentOf(entry({ goal: null, ask: 'the verbatim prompt' }))).toBe('the verbatim prompt')
    expect(intentOf(entry({ goal: null, ask: '(not captured)' }))).toBeNull()
    expect(outcomeOf(entry({ headline: 'Payments wired', summary: 'longer text' }))).toBe('Payments wired')
    expect(outcomeOf(entry({ headline: null, summary: 'longer text' }))).toBe('longer text')
  })
})

// A list row is scannable or it is nothing. Measured on live data: only 4 of
// 21 rows pulled from one teammate carry a headline, so the summary fallback
// IS the common path -- and those summaries run 750-1000 characters.
describe('outcomeOf: the one-line budget', () => {
  const paragraph =
    'The gh CLI v2.97.0 is installed at ~/.local/bin/gh from the official release zip, ' +
    'with no Homebrew and no sudo, but GitHub login is still not done: the device code ' +
    'expired before the browser flow was completed.'

  it('prefers the first sentence over the whole paragraph', () => {
    const out = outcomeOf(entry({ headline: null, summary: paragraph }))
    expect(out.length).toBeLessThanOrEqual(OUTCOME_MAX + 1) // +1 for the ellipsis
    expect(out).not.toContain('device code')
  })

  it('never truncates mid-word', () => {
    const out = outcomeOf(entry({ headline: null, summary: paragraph }))
    expect(out.endsWith('…')).toBe(true)
    expect(out.slice(0, -1).trim()).toBe(out.slice(0, -1).trimEnd())
    expect(paragraph).toContain(out.slice(0, -1).trimEnd())
  })

  it('leaves a headline untouched -- it is already the one-line form', () => {
    const headline = 'gh CLI installed without Homebrew; GitHub login still not completed'
    expect(outcomeOf(entry({ headline, summary: paragraph }))).toBe(headline)
  })

  it('does not treat a dot inside a path or version as a sentence end', () => {
    const out = outcomeOf(entry({ headline: null, summary: 'Fixed lib/feed.js so v0.2.3 stops dropping rows.' }))
    expect(out).toBe('Fixed lib/feed.js so v0.2.3 stops dropping rows.')
  })

  it('keeps a short summary exactly as written', () => {
    expect(outcomeOf(entry({ headline: null, summary: 'Master repaired and green.' }))).toBe('Master repaired and green.')
  })

  it('is empty when there is nothing to say', () => {
    expect(outcomeOf(entry({ headline: null, summary: null }))).toBe('')
  })
})

describe('clipWords', () => {
  it('returns short text untouched, with no ellipsis', () => {
    expect(clipWords('short enough', 40)).toBe('short enough')
  })
  it('cuts on a word boundary and marks the cut', () => {
    expect(clipWords('alpha beta gamma delta', 14)).toBe('alpha beta…')
  })
  it('falls back to a hard cut when one word exceeds the budget', () => {
    expect(clipWords('supercalifragilistic', 10)).toBe('supercalif…')
  })
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
  // Replaces "marks live true exactly when there is no summary yet", which
  // asserted the defect itself: it required a summary-less entry to be live
  // no matter how old it was, which is why week-old rows kept a green dot.
  // Same two directions as before, plus the two cases that pin the old rule
  // out -- summary presence must not move `live` either way.
  it('takes live from the daemon flag, independent of whether a summary landed', () => {
    expect(mapStreamEntry(entry({ live: true })).live).toBe(true)
    expect(mapStreamEntry(entry({ live: false })).live).toBe(false)
    expect(mapStreamEntry(entry({ live: false, headline: null, summary: null })).live).toBe(false)
    expect(mapStreamEntry(entry({ live: true, headline: 'done' })).live).toBe(true)
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
    live: false, outcome: 'a checkpoint', intent: null, files: [], session: 's1',
    summaryFull: null, decisions: null, gotchas: null, changes: [], ...overrides,
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

// ---------------------------------------------------------------------------
// Liveness is the daemon's call, not the UI's. It used to be derived here as
// "no summary yet", which never consulted the clock: a session that ended
// without landing a summary stayed green forever and every one of them was
// counted under LIVE NOW. The daemon now stamps `live` per entry from the
// session's newest event of any kind, and both the indicator and the count
// read that one field -- which is what keeps them in agreement.
// ---------------------------------------------------------------------------
describe('liveness comes from the daemon, not from summary presence', () => {
  it('is live when the daemon says so, even though a summary has landed', () => {
    // A working session is re-summarized every few edits (see
    // collapseSessionCheckpoints), so having a summary does NOT mean it ended.
    expect(mapStreamEntry(entry({ live: true, headline: 'Rebuilt the mapper' })).live).toBe(true)
  })

  it('is not live when the daemon says so, even with no summary at all', () => {
    expect(mapStreamEntry(entry({ live: false, headline: null, summary: null })).live).toBe(false)
  })

  it('keeps a live entry that already carries an outcome', () => {
    const e = entry({ live: true, headline: 'Rebuilt the mapper' })
    expect(dedupeLiveSessions([e])).toEqual([e])
  })

  it('drops a stale entry that never landed a summary', () => {
    expect(dedupeLiveSessions([entry({ live: false, headline: null, summary: null })])).toHaveLength(0)
  })

  it('counts exactly the rows that render the indicator', () => {
    // The invariant behind "29 LIVE NOW next to rows that are not live": the
    // Today count and the Feed's green dots must be the same set. Both sides
    // collapse a session's checkpoints to one row, so compare post-collapse.
    const raw = [
      entry({ session: 's1', ts: '2026-07-29T21:00:00Z', live: true }),
      entry({ session: 's1', ts: '2026-07-29T20:59:00Z', live: true }),
      entry({ session: 's2', ts: '2026-07-29T20:00:00Z', live: false, headline: 'done' }),
      entry({ session: 's3', ts: '2026-07-29T19:00:00Z', live: true, headline: 'still going' }),
      entry({ session: 's4', ts: '2026-07-20T19:00:00Z', live: false }),
    ]
    const countedByToday = dedupeLiveSessions(raw).length
    const rowsShowingIndicator = collapseSessionCheckpoints(raw.map(mapStreamEntry)).filter(r => r.live).length
    expect(countedByToday).toBe(2)
    expect(rowsShowingIndicator).toBe(countedByToday)
  })
})

describe('dedupeLiveSessions and mapLiveSession', () => {
  it('drops an entry the daemon did not mark live', () => {
    expect(dedupeLiveSessions([entry({ headline: 'done' })])).toHaveLength(0)
  })
  it('keeps only the newest entry per session (input assumed newest-first)', () => {
    const newer = entry({ session: 's1', ts: '2026-07-29T21:00:00Z', live: true })
    const older = entry({ session: 's1', ts: '2026-07-29T19:00:00Z', live: true })
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
    startedAt: '2026-07-29T20:00:00Z', intent: null, outcome: null, ...overrides,
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

describe('latestSummaryFor and recentAuthorIdsFor', () => {
  it('picks the first entry (newest-first) that carries a headline or summary', () => {
    const stale = entry({ headline: 'old work', ts: '2026-07-28T00:00:00Z', author: 'You', authorId: 'me' })
    const fresh = entry({ headline: 'fresh work', ts: '2026-07-29T00:00:00Z', author: 'Andrew', authorId: 'andrew' })
    expect(latestSummaryFor([fresh, stale])).toEqual({ text: 'fresh work', author: 'Andrew', at: '2026-07-29T00:00:00Z' })
  })
  it('returns null when no entry has a headline or summary', () => {
    expect(latestSummaryFor([entry()])).toBeNull()
  })
  it('collects distinct non-null authorIds', () => {
    const ids = recentAuthorIdsFor([entry({ authorId: 'andrew' }), entry({ authorId: 'andrew' }), entry({ authorId: 'sarah' }), entry({ authorId: null })])
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
    expect(p.recentAuthorIds.sort()).toEqual(['me', 'sarah'])
  })
  it('carries the daemon archived and missing flags, defaulting absence to false', () => {
    const p = mapProjectRow({ ...row, archived: true, missing: true }, [])
    expect(p.archived).toBe(true)
    expect(p.missing).toBe(true)
    const legacy = mapProjectRow(row, []) // an older daemon's row has neither flag
    expect(legacy.archived).toBe(false)
    expect(legacy.missing).toBe(false)
  })
})

describe('memberActivity', () => {
  const row = (overrides: Partial<RawTeamFeedEntry> = {}): RawTeamFeedEntry => ({
    author_id: 'andrew', project_id: 'proj-a', ts: '2026-07-29T19:00:00Z', ...overrides,
  })

  it('counts distinct projects and picks the newest ts, from one author\'s own rows', () => {
    const out = memberActivity([
      row({ project_id: 'proj-a', ts: '2026-07-28T00:00:00Z' }),
      row({ project_id: 'proj-b', ts: '2026-07-29T19:00:00Z' }),
      row({ project_id: 'proj-a', ts: '2026-07-27T00:00:00Z' }), // dup project, not double-counted
    ])
    expect(out).toEqual({ projectCount: 2, lastSharedAt: '2026-07-29T19:00:00Z' })
  })
  it('ignores rows with no project_id for the count, but still tracks their ts', () => {
    const out = memberActivity([row({ project_id: null, ts: '2026-07-29T19:00:00Z' })])
    expect(out).toEqual({ projectCount: 0, lastSharedAt: '2026-07-29T19:00:00Z' })
  })
  it('is projectCount 0 and lastSharedAt null for an empty page, never a made-up value', () => {
    expect(memberActivity([])).toEqual({ projectCount: 0, lastSharedAt: null })
  })

  // THE REGRESSION THIS GUARDS: mapMember/getMembers used to derive a
  // member's projectCount and lastSharedAt from ONE page shared by every
  // author on the team (see mappers.ts's members block comment -- "third
  // time this exact paging assumption has failed"). Whichever teammate is
  // most active fills that shared page entirely, so a quiet teammate's own
  // rows never appear in it and they read as a ghost: 0 projects, nothing
  // shared, even though they demonstrably have both. memberActivity is the
  // fix -- it only ever sees ONE author's own rows (LocalDaemonClient.ts
  // fetches with an explicit `author=` query per member), so there is no
  // shared array left for a noisy teammate to crowd anyone out of. This test
  // proves the invariant directly: build the quiet author's OWN page (what
  // an author-scoped /api/team/feed request returns) and show it is correct
  // no matter how large the OTHER author's volume is -- a noisy teammate's
  // entries are never even passed in, by construction.
  it('a quiet teammate\'s facts are correct regardless of a teammate with 20x their volume -- their entries never even reach this function', () => {
    const NOISY_COUNT = 220 // 20x QUIET_COUNT
    const QUIET_COUNT = 11
    // What a single-shared-page implementation would have scanned: one big
    // combined, newest-first array where the noisy author's 220 recent rows
    // occupy every slot up to any realistic page cap (100 or 200), and the
    // quiet author's 11 older rows never surface. Kept here only to make the
    // "20x volume, one crowds out the other" scenario concrete -- the fixed
    // code path never builds or reads this combined array at all.
    const noisyRows = Array.from({ length: NOISY_COUNT }, (_, i) => row({
      author_id: 'noisy', project_id: i % 2 === 0 ? 'proj-a' : 'proj-b',
      ts: new Date(2026, 6, 29, 12, 0, i).toISOString(), // all newer than every quiet row below
    }))
    const quietRows = [
      // Newest row deliberately last in this literal array but NOT last in
      // time, to prove memberActivity finds it by comparing ts, not by
      // assuming array order.
      row({ author_id: 'quiet', project_id: 'proj-c', ts: '2026-07-18T09:00:00Z' }),
      row({ author_id: 'quiet', project_id: 'proj-c', ts: '2026-07-15T09:00:00Z' }),
      ...Array.from({ length: QUIET_COUNT - 2 }, (_, i) => row({
        author_id: 'quiet', project_id: 'proj-d', ts: new Date(2026, 6, 10, 9, 0, i).toISOString(),
      })),
    ]
    expect(noisyRows.length).toBe(NOISY_COUNT)
    expect(quietRows.length).toBe(QUIET_COUNT)

    // The fix: each author's activity is computed from THEIR OWN rows only
    // (what LocalDaemonClient's author-scoped request returns) -- the noisy
    // author's 220 rows are simply never in scope for the quiet author's
    // result, so volume disparity cannot affect correctness at all.
    const quiet = memberActivity(quietRows)
    expect(quiet).toEqual({ projectCount: 2, lastSharedAt: '2026-07-18T09:00:00Z' })

    // The noisy author's own numbers stay correct too, independent of the
    // quiet author's presence or absence.
    const noisy = memberActivity(noisyRows)
    expect(noisy.projectCount).toBe(2)
    expect(noisy.lastSharedAt).toBe(noisyRows[noisyRows.length - 1].ts)
  })
})

describe('mapMember', () => {
  it('maps a member row to only what this machine can observe, never a fabricated diagnosis', () => {
    const m = mapMember(
      { user_id: 'andrew', display_name: 'Andrew', role: 'admin', joined_at: '2026-07-22T18:58:00Z' },
      { projectCount: 3, lastSharedAt: '2026-07-29T19:00:00Z' },
    )
    expect(m).toEqual({
      // No `email` key at all. It used to be here as '' -- a field the members
      // RPC never returns -- and that empty string is what MemberRow painted
      // as a blank address line under every name.
      id: 'andrew', name: 'Andrew', role: 'admin', joinedAt: '2026-07-22T18:58:00Z',
      projectCount: 3, lastSharedAt: '2026-07-29T19:00:00Z', keyAlert: false,
      // #59. A daemon too old to report the field degrades to an explicit
      // zero, not undefined: zero means "no gap", which keeps the UI quiet.
      // Failing the other way would put a repull hint under every empty
      // search run against an older daemon.
      preFixLocal: { entries: 0, projects: 0 },
    })
  })

  // #59, and the reason this test exists at all: mapMember builds an explicit
  // object literal, so a wire field it does not name is dropped here -- with
  // no error, no type complaint at the boundary, and nothing visible until a
  // component reads undefined. That is precisely how this field would have
  // gone missing, so the carry-through is pinned rather than assumed.
  it('carries preFixLocal through instead of dropping it at the object literal', () => {
    const m = mapMember(
      {
        user_id: 'andrew', display_name: 'Andrew', role: 'admin', joined_at: '2026-07-22T18:58:00Z',
        preFixLocal: { entries: 7, projects: 2 },
      },
      { projectCount: 3, lastSharedAt: '2026-07-29T19:00:00Z' },
    )
    expect(m.preFixLocal).toEqual({ entries: 7, projects: 2 })
  })
  it('falls back joinedAt to an empty string when the row carries no timestamp, rather than asserting one', () => {
    const m = mapMember(
      { user_id: 'andrew', display_name: 'Andrew', role: 'admin', joined_at: null },
      { projectCount: 0, lastSharedAt: null },
    )
    expect(m.joinedAt).toBe('')
  })
  it('is null for lastSharedAt when the member has no team-feed rows of their own, never a made-up time', () => {
    const m = mapMember(
      { user_id: 'sarah', display_name: 'Sarah', role: 'member', joined_at: '2026-07-27T16:31:00Z' },
      { projectCount: 0, lastSharedAt: null },
    )
    expect(m.lastSharedAt).toBeNull()
  })
})

// A Today card has to be able to take you somewhere. The group keeps the
// NEWEST session's id, matching how author/tool/projectName are already taken
// from `newest` -- the row describes the most recent session in the group, so
// its link must land on that same one.
describe('groupLiveSessions session target', () => {
  const live = (overrides: Partial<LiveSession> = {}): LiveSession => ({
    id: 's1', author: 'You', authorId: 'me', tool: 'Claude Code', projectName: 'membridge',
    startedAt: '2026-07-29T20:00:00Z', intent: null, outcome: null, ...overrides,
  })

  it('carries the newest session id in the group, not the oldest and not the group key', () => {
    const groups = groupLiveSessions([
      live({ id: 'older', startedAt: '2026-07-29T19:00:00Z' }),
      live({ id: 'newest', startedAt: '2026-07-29T21:00:00Z' }),
      live({ id: 'middle', startedAt: '2026-07-29T20:00:00Z' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].sessionId).toBe('newest')
    expect(groups[0].id).not.toBe('newest')
  })

  it('gives a single-session group that session id', () => {
    expect(groupLiveSessions([live({ id: 'only-one' })])[0].sessionId).toBe('only-one')
  })
})
