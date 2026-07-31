import { describe, it, expect } from 'vitest'
import { isSameLocalDay, localDayKey, monthDay, weekdayMonthDay } from './localTime'

// The suite is pinned to America/Los_Angeles (vite.config.ts, test.env.TZ),
// so every instant below has a KNOWN local rendering that differs from its
// UTC one. Each case is chosen so a UTC implementation would give a
// different answer -- that difference is the whole point of these tests.
describe('localTime', () => {
  it('pins the suite timezone so these expectations mean something', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Los_Angeles')
  })

  describe('localDayKey', () => {
    it('keys on the local calendar day, not the UTC one', () => {
      // 02:00 UTC on Jul 30 is 19:00 on Jul 29 in Los Angeles. A UTC key
      // would say 2026-07-30 and put an evening session on tomorrow.
      expect(localDayKey(new Date('2026-07-30T02:00:00Z'))).toBe('2026-07-29')
    })
    it('zero-pads month and day', () => {
      expect(localDayKey(new Date('2026-01-05T20:00:00Z'))).toBe('2026-01-05')
    })
  })

  describe('isSameLocalDay', () => {
    it('is true for two instants sharing a local day but not a UTC day', () => {
      // 16:00 and 19:00 local on Jul 29 -- the second is Jul 30 in UTC.
      expect(isSameLocalDay(new Date('2026-07-29T23:00:00Z'), new Date('2026-07-30T02:00:00Z'))).toBe(true)
    })
    it('is false for two instants sharing a UTC day but not a local day', () => {
      // Both are Jul 29 UTC; locally they are Jul 28 21:00 and Jul 29 09:00.
      expect(isSameLocalDay(new Date('2026-07-29T04:00:00Z'), new Date('2026-07-29T16:00:00Z'))).toBe(false)
    })
  })

  describe('weekdayMonthDay', () => {
    it('formats local weekday/month/day with no comma', () => {
      expect(weekdayMonthDay(new Date('2026-07-29T20:00:00Z'))).toBe('Wed Jul 29')
    })
    it('uses the local weekday and date when UTC has already rolled over', () => {
      expect(weekdayMonthDay(new Date('2026-07-30T02:00:00Z'))).toBe('Wed Jul 29')
    })
  })

  describe('monthDay', () => {
    it('formats the local month and day', () => {
      expect(monthDay(new Date('2026-07-30T02:00:00Z'))).toBe('Jul 29')
    })
  })
})
