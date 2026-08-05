const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// The daemon's timestamps are UTC ISO strings, but the person reading them
// is not in UTC. Rendering or grouping by the UTC calendar day showed anyone
// west of Greenwich TOMORROW's date all evening (a US Pacific user after
// 17:00 local), so every date the UI shows is derived from LOCAL calendar
// fields instead. getFullYear/getMonth/getDate (never getUTC*) resolve in
// the viewer's own zone, and no zone is ever hardcoded -- the browser's
// resolved zone is the only correct answer here.
//
// Shared rather than repeated: Feed, ProjectPage, TodayPage and SyncState
// each need day-keying or day-labelling, and four private copies is how the
// UTC bug ended up in four places at once.

/** The viewer-local calendar day as YYYY-MM-DD -- the correct grouping key
 *  for "which day did this happen on". `toISOString().slice(0, 10)` is the
 *  bug this replaces: it is always a UTC day. */
export function localDayKey(d: Date): string {
  const year = String(d.getFullYear()).padStart(4, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** The half-open instant range a viewer-local calendar day actually covers,
 *  as epoch milliseconds: local midnight of `day` up to (not including) local
 *  midnight of the next day.
 *
 *  This exists because the two halves of the system disagree about what a
 *  "day" is, and the disagreement is silent. Every date this UI shows or keys
 *  on is a LOCAL calendar date (localDayKey above). /api/feed's `since` and
 *  `before` are compared against UTC ISO strings (lib/server.js feedPayload).
 *  Handing the bare local date to either one is off by the viewer's offset:
 *  for a Los Angeles reader "2026-07-29" as a UTC bound starts at 17:00 on
 *  Jul 28 local, so a whole working day of the 28th silently joins the 29th
 *  and the last seven hours of the 29th silently fall off the end.
 *
 *  ONE conversion, here, rather than a `new Date(day + 'T00:00:00Z')` at each
 *  call site: the two ends have to be derived by the same rule or a day is
 *  either double-counted or has a hole in it, and DST makes the day 23 or 25
 *  hours long twice a year, which no fixed 24-hour arithmetic gets right.
 *  Constructing through the local Date fields (never Date.UTC) is what makes
 *  the browser's own zone, including its DST rules, decide.
 *
 *  Returns null for anything that is not a YYYY-MM-DD this module would mint:
 *  the day half of a route slug is hand-editable text, and a bad one must
 *  degrade to "no range" rather than to a range around NaN. */
export function localDayRangeMs(day: string): { start: number; end: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''))
  if (!m) return null
  const [year, month, date] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const start = new Date(year, month - 1, date, 0, 0, 0, 0)
  // Day + 1 via the DATE field, not `start + 86400000`: JS normalizes an
  // out-of-range date (Jan 32 -> Feb 1) and resolves the result in the local
  // zone, so a spring-forward day comes out 23 hours long rather than 24.
  const end = new Date(year, month - 1, date + 1, 0, 0, 0, 0)
  // A month/day that does not exist (2026-02-31) normalizes to a real date
  // rather than to NaN, so the regex above is not enough on its own: reject
  // anything that did not round-trip to the day it claimed to be.
  if (localDayKey(start) !== day) return null
  return { start: start.getTime(), end: end.getTime() }
}

/** The same range as the UTC ISO instants /api/feed compares against. The
 *  ONLY correct thing to put in a `since`/`before` for "this local day", and
 *  the reason it is derived rather than typed: `end` is EXCLUSIVE here, which
 *  a caller passing it to an inclusive `before` has to know. */
export function localDayRangeUtc(day: string): { since: string; before: string } | null {
  const range = localDayRangeMs(day)
  if (!range) return null
  return { since: new Date(range.start).toISOString(), before: new Date(range.end).toISOString() }
}

/** Whether two instants fall on the same viewer-local calendar day. */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return localDayKey(a) === localDayKey(b)
}

/** "Wed Jul 29" -- local fields, and no comma, matching the mockup
 *  (toLocaleDateString's weekday-included form always inserts one). */
export function weekdayMonthDay(d: Date): string {
  return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** "Jul 29" -- local fields. */
export function monthDay(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}
