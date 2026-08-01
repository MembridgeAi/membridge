import { StateChip } from '../../components/StateChip'
import { SyncStateView } from '../../components/SyncState'
import { relativeAgo } from '../../data/relativeTime'
import type { Project, StreamEntry as StreamEntryData, SyncState } from '../../data/types'

interface MemoryPanelProps {
  project: Project
  latestEntry: StreamEntryData | null
  onOpenMemory: () => void
  openPending: boolean
}

/**
 * "Memory · this project" — status derived from whether the project is
 * paused / has ever captured a session (there is no separate "delivery
 * status" field on Project); last update from the most recent merged-stream
 * entry (author + tool, the closest honest proxy for "producing agent");
 * entry count from `sessionsTotal` (the local ledger's count). memory.md is
 * a real control now (Task 18): POST /api/open {kind:'memory'} reveals the
 * file in the OS file manager -- see DataClient.openMemoryFile.
 */
export function MemoryPanel({ project, latestEntry, onOpenMemory, openPending }: MemoryPanelProps) {
  return (
    <div className="panel">
      <div className="section-label">Memory · this project</div>
      <div className="kv">
        <span className="kv-key">Status</span>
        {project.paused ? (
          <StateChip tone="muted" glyph="">paused</StateChip>
        ) : latestEntry ? (
          <StateChip tone="ok" glyph="✓">delivering</StateChip>
        ) : (
          <StateChip tone="muted" glyph="">waiting for the first session</StateChip>
        )}
      </div>
      {latestEntry && (
        <div className="kv">
          <span className="kv-key">Last update</span>
          <span className="mono kv-value">
            {relativeAgo(latestEntry.at, { justNow: 'now' })} · by {latestEntry.author}'s {latestEntry.tool}
          </span>
        </div>
      )}
      <div className="kv">
        <span className="kv-key">Entries</span>
        <span className="mono kv-value">
          {project.sessionsTotal} ·{' '}
          <button type="button" className="link-btn mono" onClick={onOpenMemory} disabled={openPending}>
            memory.md
          </button>
        </span>
      </div>
    </div>
  )
}

interface SyncPanelProps {
  sync: SyncState
  onSync?: () => void
  encryptionEnabled: boolean
  plaintextOff: boolean
  sessionsThisWeek: number
  peopleCount: number
}

/** "Sync" — team sync reuses the same SyncStateView contract as the header
 *  (never re-implemented); encryption reads status.encryption directly. */
export function SyncPanel({ sync, onSync, encryptionEnabled, plaintextOff, sessionsThisWeek, peopleCount }: SyncPanelProps) {
  return (
    <div className="panel panel-last">
      <div className="section-label">Sync</div>
      <div className="kv">
        <span className="kv-key">Team sync</span>
        <span className="kv-value"><SyncStateView state={sync} onSync={onSync} /></span>
      </div>
      <div className="kv">
        <span className="kv-key">Encryption</span>
        {encryptionEnabled && plaintextOff ? (
          <StateChip tone="ok" glyph="✓">end-to-end</StateChip>
        ) : encryptionEnabled ? (
          <StateChip tone="warn" glyph="⚠">plaintext shared</StateChip>
        ) : (
          <StateChip tone="muted" glyph="">off</StateChip>
        )}
      </div>
      <div className="kv">
        <span className="kv-key">This week</span>
        <span className="mono kv-value">{sessionsThisWeek} sessions · {peopleCount} people</span>
      </div>
    </div>
  )
}
