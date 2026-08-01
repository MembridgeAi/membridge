// One relative-time module (Fix 12) replacing six private near-copies
// (EntryRow, ProjectsPage, MemberRow, SidePanels, LiveEntry, InviteRow) --
// six copies is how a formatting bug lands in six places at once (see
// localTime.ts, where the same consolidation already happened for calendar
// labels). Each call site's output format is preserved EXACTLY; the one
// behavior change is the NaN guard none of the copies had: an invalid
// timestamp used to render "NaNd ago" / "expires in NaN days". The guard
// follows SyncState's shortStamp precedent (which answers 'never' for
// unparseable input): degrade to a harmless fixed word, never NaN.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now" (or the caller's own under-a-minute label, e.g. "now"), then
 *  "5m ago" / "3h ago" / "2d ago" -- the elapsed-since-past-instant family.
 *  An invalid date degrades to the just-now label. */
export function relativeAgo(iso: string, opts: { justNow?: string } = {}, now: number = Date.now()): string {
  const justNow = opts.justNow ?? 'just now'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return justNow
  const ms = now - t
  if (ms < MINUTE) return justNow
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`
  return `${Math.floor(ms / DAY)}d ago`
}

/** LiveEntry's bare elapsed clock: "now", "5m", "3h", "2d" -- the coarsest
 *  unit that still reads as "just happened" for a live session. An invalid
 *  date degrades to "now" (harmless for a row that only renders while the
 *  daemon says the session is live). */
export function elapsedShort(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 'now'
  const ms = now - t
  if (ms < MINUTE) return 'now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`
  return `${Math.floor(ms / DAY)}d`
}

/** InviteRow's forward-looking expiry: "expired", "expires in 1 day",
 *  "expires in N days" (rounded up). An invalid date degrades to "unknown"
 *  -- neither claiming the invite is dead nor putting a NaN on screen. */
export function expiresIn(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 'unknown'
  const ms = t - now
  if (ms <= 0) return 'expired'
  const days = Math.ceil(ms / DAY)
  return days === 1 ? 'expires in 1 day' : `expires in ${days} days`
}
