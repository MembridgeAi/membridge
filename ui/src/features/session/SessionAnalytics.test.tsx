import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import {
  SessionAnalytics, commitsProduced, durationLabel, filesTouched, lineTotals, topFilesByEditFrequency,
} from './SessionAnalytics'
import type { Session } from '../../data/types'

const session = (overrides: Partial<Session> = {}): Session => ({
  session: 's1', project: 'membridge', projectPath: '/x/membridge',
  author: 'Andrew', authorId: 'andrew', source: 'Claude Code',
  startedAt: '2026-07-29T19:00:00Z', endedAt: '2026-07-29T20:30:00Z', live: false,
  summary: 'done', summaryFull: 'done', goal: null, headline: null,
  decisions: null, gotchas: null,
  files: ['lib/hooks.js', 'test/run-tests.js'],
  changes: [
    { file: 'lib/hooks.js', status: 'edited', add: 41, del: 12, note: 'ownership gate', dep: false },
    { file: 'test/run-tests.js', status: 'edited', add: 88, del: 2, note: null, dep: false },
  ],
  checkpoints: [],
  prompts: [
    { ts: '2026-07-29T20:00:00Z', ask: 'now make recall use the same gate', files: ['lib/hooks.js'] },
    { ts: '2026-07-29T19:00:00Z', ask: 'make the hook fire on boundaries', files: ['lib/hooks.js', 'test/run-tests.js'] },
  ],
  ...overrides,
})

afterEach(cleanup)

describe('analytics helpers (pure)', () => {
  it('filesTouched counts the session files, falling back to changes', () => {
    expect(filesTouched(session())).toBe(2)
    expect(filesTouched(session({ files: [] }))).toBe(2)
    expect(filesTouched(session({ files: [], changes: [] }))).toBe(0)
  })

  it('topFilesByEditFrequency ranks by how many prompts touched each file, capped at 3', () => {
    const ranked = topFilesByEditFrequency(session())
    expect(ranked.map(f => f.file)).toEqual(['lib/hooks.js', 'test/run-tests.js'])
    expect(ranked[0].count).toBe(2)
    expect(ranked[1].count).toBe(1)
  })

  it('topFilesByEditFrequency caps at three even when many files were touched', () => {
    const files = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js']
    const ranked = topFilesByEditFrequency(session({
      files,
      prompts: [{ ts: '2026-07-29T19:00:00Z', ask: 'x', files }],
    }))
    expect(ranked).toHaveLength(3)
  })

  it('topFilesByEditFrequency falls back to the file list when no prompt carried files', () => {
    const ranked = topFilesByEditFrequency(session({
      prompts: [{ ts: '2026-07-29T19:00:00Z', ask: 'x', files: [] }],
    }))
    expect(ranked.map(f => f.file)).toEqual(['lib/hooks.js', 'test/run-tests.js'])
    // No frequency was observable, so it must not claim one.
    expect(ranked.every(f => f.count === 0)).toBe(true)
  })

  it('lineTotals sums add/del and reports whether anything was actually counted', () => {
    expect(lineTotals(session())).toEqual({ add: 129, del: 14, counted: true })
    // Every count null (binary, rename, no repo) is NOT a real zero.
    expect(lineTotals(session({
      changes: [{ file: 'a.png', status: 'edited', add: null, del: null, note: null, dep: false }],
    }))).toEqual({ add: 0, del: 0, counted: false })
    expect(lineTotals(session({ changes: [] }))).toEqual({ add: 0, del: 0, counted: false })
  })

  it('commitsProduced returns null when the daemon did not serve the field', () => {
    expect(commitsProduced(session())).toBeNull()
    expect(commitsProduced(session({ commits: 3 }))).toBe(3)
    // Junk never becomes a number.
    expect(commitsProduced(session({ commits: -1 }))).toBeNull()
  })

  it('durationLabel degrades rather than rendering NaN', () => {
    expect(durationLabel('2026-07-29T19:00:00Z', '2026-07-29T20:30:00Z')).toBe('1h 30m')
    expect(durationLabel('2026-07-29T19:00:00Z', '2026-07-29T19:42:00Z')).toBe('42m')
    expect(durationLabel('2026-07-29T19:00:00Z', '2026-07-29T19:00:10Z')).toBe('under a minute')
    expect(durationLabel(null, '2026-07-29T20:30:00Z')).toBeNull()
    expect(durationLabel('nonsense', '2026-07-29T20:30:00Z')).toBeNull()
    // Clock skew.
    expect(durationLabel('2026-07-29T20:30:00Z', '2026-07-29T19:00:00Z')).toBeNull()
  })
})

function tileLabels(): string[] {
  return [...document.querySelectorAll('.session-tile-label')].map(el => el.textContent || '')
}

describe('SessionAnalytics header (four tiles)', () => {
  it('renders the four approved tiles in a fixed order', () => {
    render(<SessionAnalytics session={session({ commits: 2 })} />)
    expect(tileLabels()).toEqual(['Files touched', 'Lines', 'Commits', 'Duration'])
  })

  it('the files tile carries the count and the top three files by edit frequency', () => {
    render(<SessionAnalytics session={session()} />)
    const tile = screen.getByText('Files touched').closest('.session-tile')!
    expect(tile.textContent).toContain('2')
    expect(tile.textContent).toContain('lib/hooks.js')
    expect(tile.textContent).toContain('test/run-tests.js')
  })

  it('the lines tile shows +add and -del', () => {
    render(<SessionAnalytics session={session()} />)
    const tile = screen.getByText('Lines').closest('.session-tile')!
    expect(tile.textContent).toContain('+129')
    expect(tile.textContent).toContain('-14')
  })

  it('survival rate is deliberately excluded and must never appear', () => {
    render(<SessionAnalytics session={session({ commits: 2 })} />)
    expect(screen.queryByText(/survival/i)).toBeNull()
  })

  it('a tile with no data degrades to a muted dash, never NaN and never a fake zero', () => {
    render(<SessionAnalytics session={session({
      changes: [], files: [], startedAt: null, endedAt: null, prompts: [],
    })} />)
    // Commits was never served; lines were never counted; duration is unknowable.
    const lines = screen.getByText('Lines').closest('.session-tile')!
    expect(lines.textContent).not.toMatch(/NaN/)
    expect(lines.querySelector('.session-tile-empty')).not.toBeNull()
    const commits = screen.getByText('Commits').closest('.session-tile')!
    expect(commits.querySelector('.session-tile-empty')).not.toBeNull()
    const duration = screen.getByText('Duration').closest('.session-tile')!
    expect(duration.querySelector('.session-tile-empty')).not.toBeNull()
  })

  it('a live session reports its duration as live rather than a stale number', () => {
    render(<SessionAnalytics session={session({ live: true, endedAt: null })} />)
    const duration = screen.getByText('Duration').closest('.session-tile')!
    expect(duration.textContent).toContain('live')
  })
})
