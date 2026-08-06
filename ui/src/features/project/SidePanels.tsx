import { LoadingBlock } from '../../components/LoadingBlock'
import { StateChip } from '../../components/StateChip'
import { SyncStateView } from '../../components/SyncState'
import { readEncryption, type EncryptionState } from '../../components/encryptionState'
import { relativeAgo } from '../../data/relativeTime'
import type { Project, StreamEntry as StreamEntryData, SyncState } from '../../data/types'

interface MemoryPanelProps {
  project: Project
  latestEntry: StreamEntryData | null
  /** True while the project stream that `latestEntry` comes from is still in
   *  flight. Required, not optional: the Status row below is a HEALTH claim
   *  derived entirely from `latestEntry`, and a null entry means two completely
   *  different things before and after that request answers. Making this
   *  optional would let the next caller reintroduce the bug by omission. */
  streamPending: boolean
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
export function MemoryPanel({ project, latestEntry, streamPending, onOpenMemory, openPending }: MemoryPanelProps) {
  return (
    <div className="panel">
      <div className="section-label">Memory · this project</div>
      <div className="kv">
        <span className="kv-key">Status</span>
        {/* `paused` first: it is read off the project row, which has already
            loaded, and it is true regardless of what the stream says.
            streamPending next, BEFORE the latestEntry test -- "waiting for the
            first session" is derived from latestEntry being null, and a
            not-yet-answered request produces exactly the same null as a project
            that has genuinely never captured anything. That is how a project
            with 28 captured sessions displayed a muted "waiting for the first
            session" chip for 846ms on every open: a status indicator asserting
            a system state the code had not observed. */}
        {project.paused ? (
          <StateChip tone="muted" glyph="">paused</StateChip>
        ) : streamPending ? (
          <LoadingBlock variant="short" />
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
  /** T-78: solo/signed-out installs hide the Encryption row (there is no team
   *  to encrypt for) and drop "Team" from the "Team sync" label -- the daemon
   *  ticker still processes the project locally, so the row IS a fact worth
   *  showing, but the "Team" adjective claimed a team the user is not on.
   *  Required so the next caller cannot reintroduce the bug by omission. */
  soloView: boolean
}

// Short by necessity: this chip lives in a fixed 300px column with ~174px left
// after the key and padding, and `.chip` is `white-space: nowrap`, so an
// over-long label forces the whole side column wider and squeezes the activity
// stream beside it. Settings' Privacy row states the same three states at
// length, with an explanatory note under each warning -- see
// components/encryptionState.ts for why the wording is per-context and only the
// state and tone are shared.
const ENCRYPTION_LABEL: Record<EncryptionState, string> = {
  // Same words as Settings for this state: it is the one a reader is most
  // likely to see in both places and go looking for an explanation of.
  off: 'plaintext shared',
  'dual-write': 'readable copy stored',
  'ciphertext-only': 'end-to-end',
}

/** "Sync" — team sync reuses the same SyncStateView contract as the header
 *  (never re-implemented); encryption reads status.encryption directly.
 *
 *  The encryption chip used to tone the ENCRYPTION-OFF state `muted` and label
 *  it "off". Muted is this system's neutral/absence tone, so the worst state
 *  available -- nothing encrypted, everything readable on the server -- was the
 *  only one rendered as unremarkable, and "off" described a switch rather than
 *  the consequence. It now warns, in the same words Settings uses. The
 *  encrypted-but-dual-write state was already distinguished here, but borrowed
 *  the encryption-off vocabulary ("plaintext shared") for itself, which left the
 *  two unsafe states labelled as each other. */
export function SyncPanel({ sync, onSync, encryptionEnabled, plaintextOff, sessionsThisWeek, soloView }: SyncPanelProps) {
  const encryption = readEncryption(encryptionEnabled, plaintextOff)
  return (
    <div className="panel panel-last">
      <div className="section-label">Sync</div>
      <div className="kv">
        <span className="kv-key">{soloView ? 'Sync' : 'Team sync'}</span>
        <span className="kv-value"><SyncStateView state={sync} onSync={onSync} /></span>
      </div>
      {!soloView && (
        <div className="kv">
          <span className="kv-key">Encryption</span>
          <StateChip tone={encryption.tone} glyph={encryption.glyph}>
            {ENCRYPTION_LABEL[encryption.state]}
          </StateChip>
        </div>
      )}
      {/* Sessions only. This read "N sessions · M people", where M was the
          length of Project.recentAuthorIds -- the author set of this project's
          slice of one capped, cross-project feed page. Two things were wrong
          with it at once, and they compounded: the set is empty for a project
          quiet enough to miss that page, so a genuinely busy week rendered as
          "31 sessions · 0 people", a line that contradicts itself; and the set
          has no time window, so even when non-empty it was not a "this week"
          figure and could not honestly sit under this key.
          No number replaces it, because none of this page's payloads counts
          distinct people over a window. Two candidates were rejected: the
          project-scoped stream this page already loads is capped at 100 entries,
          so a count off it is a FLOOR that under-reports exactly for the busy
          projects where the figure would matter -- the same capped-page trap
          this codebase has now fixed four times; and an inline "people unknown"
          does not fit, per the width budget documented above. The faces in the
          page header carry who has been active, where being approximate is
          honest. */}
      <div className="kv">
        <span className="kv-key">This week</span>
        <span className="mono kv-value">{sessionsThisWeek} sessions</span>
      </div>
    </div>
  )
}
