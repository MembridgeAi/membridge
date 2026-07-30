import type { SyncState } from '../data/types'
import { StateChip } from './StateChip'

// Pin to UTC so the rendered stamp is identical no matter the machine's local
// timezone. The daemon's timestamps are UTC ISO strings; formatting them in
// the viewer's local zone would let "Jul 23" become "Jul 22" or "Jul 24"
// depending on where the app runs, including in CI.
//
// Same-day lag renders as a time, not a date. A bare date cannot distinguish
// "synced two minutes ago" from "synced at 00:01 and dead ever since" -- both
// print today's date, and the warning colour made the harmless one look like
// an outage. Anything older than today keeps the date, which is the useful
// unit at that distance.
const shortStamp = (iso: string | null, now: Date = new Date()) => {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'never'
  const sameUtcDay = d.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)
  return sameUtcDay
    ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export function SyncStateView({ state, onSync }: { state: SyncState; onSync?: () => void }) {
  if (state.state === 'up-to-date') return <StateChip tone="ok" glyph="✓">up to date</StateChip>
  if (state.state === 'paused') return <StateChip tone="muted" glyph="">paused</StateChip>
  return (
    <>
      <StateChip tone="warn" glyph="⚠">behind · {shortStamp(state.lastSyncedAt)}</StateChip>
      {onSync && (
        <button type="button" className="btn-warn" onClick={onSync}>
          Sync now
        </button>
      )}
    </>
  )
}
