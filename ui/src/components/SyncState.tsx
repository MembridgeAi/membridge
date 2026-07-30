import type { SyncState } from '../data/types'
import { StateChip } from './StateChip'

// Pin to UTC so the rendered date is identical no matter the machine's local
// timezone. The daemon's timestamps are UTC ISO strings; formatting them in
// the viewer's local zone would let "Jul 23" become "Jul 22" or "Jul 24"
// depending on where the app runs, including in CI.
const shortDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : 'never'

export function SyncStateView({ state, onSync }: { state: SyncState; onSync?: () => void }) {
  if (state.state === 'up-to-date') return <StateChip tone="ok" glyph="✓">up to date</StateChip>
  if (state.state === 'paused') return <StateChip tone="muted" glyph="">paused</StateChip>
  return (
    <>
      <StateChip tone="warn" glyph="⚠">behind · {shortDate(state.lastSyncedAt)}</StateChip>
      {onSync && (
        <button type="button" className="btn-warn" onClick={onSync}>
          Sync now
        </button>
      )}
    </>
  )
}
