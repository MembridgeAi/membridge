import { describe, it, expect } from 'vitest'
import { isSameLocalDay, localDayKey, localDayRangeMs, localDayRangeUtc, monthDay, weekdayMonthDay } from './localTime'

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

  // A local calendar day put in a URL and then compared against UTC instants.
  // /api/feed's since/before are UTC ISO strings and localDayKey is a LOCAL
  // date, and treating one as the other is off by the viewer's whole offset.
  describe('localDayRangeUtc', () => {
    it('converts local midnight to local midnight, not UTC midnight', () => {
      // Jul 29 in Los Angeles is 07:00Z Jul 29 to 07:00Z Jul 30 (PDT, -07:00).
      // Passing the bare date "2026-07-29" as a UTC bound would have started
      // the day at 17:00 on the 28th locally and ended it at 17:00 on the
      // 29th -- losing that day's whole afternoon and picking up the previous
      // one's.
      expect(localDayRangeUtc('2026-07-29')).toEqual({
        since: '2026-07-29T07:00:00.000Z',
        before: '2026-07-30T07:00:00.000Z',
      })
    })

    it('uses the standard-time offset in winter, not one hardcoded number', () => {
      // Jan 15 is PST (-08:00). A fixed offset would be an hour out.
      expect(localDayRangeUtc('2026-01-15')).toEqual({
        since: '2026-01-15T08:00:00.000Z',
        before: '2026-01-16T08:00:00.000Z',
      })
    })

    it('makes a spring-forward day 23 hours, which +86400000 would not', () => {
      // US DST begins Sun Mar 8 2026. Adding a fixed day of milliseconds ends
      // the day an hour late and double-counts an hour of the next one.
      const range = localDayRangeMs('2026-03-08')!
      expect(range.end - range.start).toBe(23 * 3600_000)
    })

    it('makes a fall-back day 25 hours', () => {
      const range = localDayRangeMs('2026-11-01')!
      expect(range.end - range.start).toBe(25 * 3600_000)
    })

    it('round-trips whatever localDayKey minted, which is the only input it gets', () => {
      const day = localDayKey(new Date('2026-07-30T02:00:00Z'))
      const range = localDayRangeMs(day)!
      expect(localDayKey(new Date(range.start))).toBe(day)
      // Half-open: the last instant of the day is inside, the end is not.
      expect(localDayKey(new Date(range.end - 1))).toBe(day)
      expect(localDayKey(new Date(range.end))).not.toBe(day)
    })

    it('refuses a hand-edited day rather than returning a range around NaN', () => {
      // The day half comes off a route slug, so it is editable text.
      expect(localDayRangeUtc('not-a-day')).toBeNull()
      expect(localDayRangeUtc('')).toBeNull()
      expect(localDayRangeUtc('2026-7-9')).toBeNull()
      // A date that parses but does not exist: JS would normalize Feb 31 to
      // Mar 3 and answer confidently about the wrong day.
      expect(localDayRangeUtc('2026-02-31')).toBeNull()
    })
  })
})
