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
