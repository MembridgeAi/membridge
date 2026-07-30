import { StateChip } from '../../components/StateChip'
import { SyncStateView } from '../../components/SyncState'
import type { Project, StreamEntry as StreamEntryData, SyncState } from '../../data/types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function relativeTime(at: string, now: number = Date.now()): string {
  const ms = now - new Date(at).getTime()
  if (ms < MINUTE) return 'now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`
  return `${Math.floor(ms / DAY)}d ago`
}

interface MemoryPanelProps {
  project: Project
  latestEntry: StreamEntryData | null
}

/**
 * "Memory · this project" — status derived from whether the project is
 * paused / has ever captured a session (there is no separate "delivery
 * status" field on Project); last update from the most recent merged-stream
 * entry (author + tool, the closest honest proxy for "producing agent");
 * entry count from `sessionsTotal` (the local ledger's count). The
 * memory.md reference is plain text, not a link — there is no DataClient
 * method to open a local file, so an anchor here would be a dead control.
 */
export function MemoryPanel({ project, latestEntry }: MemoryPanelProps) {
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
            {relativeTime(latestEntry.at)} · by {latestEntry.author}'s {latestEntry.tool}
          </span>
        </div>
      )}
      <div className="kv">
        <span className="kv-key">Entries</span>
        <span className="mono kv-value">{project.sessionsTotal} · memory.md</span>
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
