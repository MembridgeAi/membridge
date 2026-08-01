import { isSameLocalDay } from '../data/localTime'
import type { SyncState } from '../data/types'
import { StateChip } from './StateChip'

// Rendered in the VIEWER's zone (no timeZone option -- the browser's own
// resolved zone). The daemon's timestamps are UTC ISO strings, and pinning
// the render to UTC meant a Pacific user saw "Jul 24" on a sync that, by
// their clock, happened on the evening of Jul 23. Tests get determinism by
// pinning the suite's zone (vite.config.ts, test.env.TZ), not by making
// every user read UTC.
//
// Same-day lag renders as a time, not a date. A bare date cannot distinguish
// "synced two minutes ago" from "synced at 00:01 and dead ever since" -- both
// print today's date, and the warning colour made the harmless one look like
// an outage. Anything older than today keeps the date, which is the useful
// unit at that distance. "Today" is the viewer's local day, so an evening
// sync stops reading as yesterday once UTC rolls over.
const shortStamp = (iso: string | null, now: Date = new Date()) => {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'never'
  // hourCycle:'h23', not hour12:false (Fix 13): the current spec maps
  // hour12:false to h23 for en-US, but older engines (pre-2021 V8, old
  // WebViews the daemon-served page can land in) mapped it to h24 and
  // rendered the midnight half-hour as "24:30". h23 says 00-23 explicitly,
  // so the rendering never depends on which mapping the engine shipped.
  return isSameLocalDay(d, now)
    ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// `syncPending` (Fix 9): while the caller's sync mutation is in flight the
// button disables and reads "Syncing…" -- otherwise a click looked like it
// did nothing (and invited a second, redundant sync).
export function SyncStateView({ state, onSync, syncPending }: { state: SyncState; onSync?: () => void; syncPending?: boolean }) {
  if (state.state === 'up-to-date') return <StateChip tone="ok" glyph="✓">up to date</StateChip>
  if (state.state === 'paused') return <StateChip tone="muted" glyph="">paused</StateChip>
  return (
    <>
      <StateChip tone="warn" glyph="⚠">behind · {shortStamp(state.lastSyncedAt)}</StateChip>
      {onSync && (
        <button type="button" className="btn-warn" onClick={onSync} disabled={syncPending}>
          {syncPending ? 'Syncing…' : 'Sync now'}
        </button>
      )}
    </>
  )
}
