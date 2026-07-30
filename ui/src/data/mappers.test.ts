import { describe, it, expect } from 'vitest'
import {
  dedupeLiveSessions, hasSummary, intentOf, latestSummaryFor, mapLiveSession, mapMember, mapProjectRow,
  mapSettings, mapStreamEntry, memberIdsFor, outcomeOf, projectCountsByAuthor, streamEntryId,
  type RawFeedEntry, type RawProjectRow,
} from './mappers'
import type { Status } from './types'

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
  it('fills fields the backend does not expose with honest, non-alarming defaults', () => {
    const m = mapMember({ user_id: 'andrew', display_name: 'Andrew', role: 'admin', joined_at: null }, { andrew: 3 })
    expect(m).toEqual({
      id: 'andrew', name: 'Andrew', email: '', role: 'admin', projectCount: 3,
      sync: { state: 'up-to-date' }, keyVerified: true, syncDetail: null,
    })
  })
})

describe('mapSettings', () => {
  const status: Status = {
    running: true, version: '0.1.7', solo: false, setupDone: true, projectCount: 2,
    lastSync: null, teamLastSync: null, tools: [],
    encryption: { enabled: true, plaintextOff: true, paused: null, keyAlerts: 0 },
    auth: { paused: null, detail: null, since: null },
  }
  const raw = { intervalSec: 300, hookInstalled: true, distill: { enabled: true } }

  it('maps the summaries delivery channel from the real hook/distill config', () => {
    const s = mapSettings(raw, status, null)
    const summaries = s.delivery.find(d => d.id === 'summaries')
    expect(summaries).toMatchObject({ installed: true, enabled: true })
  })
  it('is solo-null for team even when a team row is passed, if status says solo', () => {
    const soloStatus: Status = { ...status, solo: true }
    const team = { team_id: 't1', team_name: 'Acme', role: 'owner' as const, memberCount: 3 }
    expect(mapSettings(raw, soloStatus, team).team).toBeNull()
  })
  it('surfaces the real team name, role and member count when not solo', () => {
    const team = { team_id: 't1', team_name: 'Acme', role: 'owner' as const, memberCount: 3 }
    expect(mapSettings(raw, status, team).team).toEqual({ name: 'Acme', role: 'owner', memberCount: 3 })
  })
})
