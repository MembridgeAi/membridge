// Fix 12: six near-identical private relative-time helpers (EntryRow,
// ProjectsPage, MemberRow, SidePanels, LiveEntry, InviteRow) collapsed into
// this one module. These tests PIN each call site's existing output format
// -- the consolidation must not change a single rendered string -- and add
// the NaN guard none of the six copies had (an invalid date rendered
// "NaNd ago" / "expires in NaN days").
import { describe, it, expect } from 'vitest'
import { elapsedShort, expiresIn, relativeAgo } from './relativeTime'

const NOW = new Date('2026-07-29T21:00:00Z').getTime()

describe('relativeAgo (the "5m ago" family)', () => {
  it('renders just now under a minute (ProjectsPage/MemberRow format)', () => {
    expect(relativeAgo('2026-07-29T20:59:30Z', {}, NOW)).toBe('just now')
  })
  it('renders now under a minute for the EntryRow/SidePanels format', () => {
    expect(relativeAgo('2026-07-29T20:59:30Z', { justNow: 'now' }, NOW)).toBe('now')
  })
  it('renders whole minutes', () => {
    expect(relativeAgo('2026-07-29T20:55:00Z', {}, NOW)).toBe('5m ago')
  })
  it('renders whole hours', () => {
    expect(relativeAgo('2026-07-29T18:00:00Z', {}, NOW)).toBe('3h ago')
  })
  it('renders whole days', () => {
    expect(relativeAgo('2026-07-27T21:00:00Z', {}, NOW)).toBe('2d ago')
  })
  it('guards an invalid date with the just-now label, never NaN', () => {
    expect(relativeAgo('not-a-date', {}, NOW)).toBe('just now')
    expect(relativeAgo('not-a-date', { justNow: 'now' }, NOW)).toBe('now')
  })
})

describe('elapsedShort (LiveEntry\'s "2m"/"3h" elapsed clock)', () => {
  it('renders now under a minute', () => {
    expect(elapsedShort('2026-07-29T20:59:30Z', NOW)).toBe('now')
  })
  it('renders bare minutes/hours/days with no "ago"', () => {
    expect(elapsedShort('2026-07-29T20:55:00Z', NOW)).toBe('5m')
    expect(elapsedShort('2026-07-29T18:00:00Z', NOW)).toBe('3h')
    expect(elapsedShort('2026-07-27T21:00:00Z', NOW)).toBe('2d')
  })
  it('guards an invalid date, never NaN', () => {
    expect(elapsedShort('not-a-date', NOW)).toBe('now')
  })
})

describe('expiresIn (InviteRow\'s expiry label)', () => {
  it('renders expired at or past the boundary', () => {
    expect(expiresIn('2026-07-29T21:00:00Z', NOW)).toBe('expired')
    expect(expiresIn('2026-07-28T00:00:00Z', NOW)).toBe('expired')
  })
  it('renders singular for one day', () => {
    expect(expiresIn('2026-07-30T12:00:00Z', NOW)).toBe('expires in 1 day')
  })
  it('renders plural days, rounded up', () => {
    expect(expiresIn('2026-08-04T00:00:00Z', NOW)).toBe('expires in 6 days')
  })
  it('guards an invalid date, never NaN', () => {
    expect(expiresIn('not-a-date', NOW)).toBe('unknown')
  })
})
