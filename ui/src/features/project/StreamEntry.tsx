import { Avatar } from '../../components/Avatar'
import type { StreamEntry as StreamEntryData } from '../../data/types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Mirrors LiveEntry.tsx's elapsedSince -- each feature file keeps its own
// small copy of this rather than sharing a date-math module (see today.css
// header comment / TodayPage.tsx precedent).
function relativeTime(at: string, now: number = Date.now()): string {
  const ms = now - new Date(at).getTime()
  if (ms < MINUTE) return 'now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`
  return `${Math.floor(ms / DAY)}d ago`
}

// Pinned to UTC so the same instant renders the same clock time everywhere
// (same reasoning as SyncStateView's shortDate) -- the daemon's timestamps
// are UTC ISO strings.
function clockTime(at: string): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
}

interface StreamEntryProps {
  entry: StreamEntryData
}

/** One merged-stream row: author + tool + relative time, a live indicator or
 *  absolute clock time on the right, the outcome in full, a muted INTENT
 *  line (the captured ask verbatim, never inferred), and files in mono. */
export function StreamEntry({ entry }: StreamEntryProps) {
  return (
    <div className="stream-entry">
      <Avatar id={entry.authorId} name={entry.author} size={19} />
      <span className="stream-entry-who-cell">
        <span className="stream-entry-who">{entry.author}</span>
        <span className="stream-entry-tool">{entry.tool} · {relativeTime(entry.at)}</span>
      </span>
      <span className="mono stream-entry-meta">
        {entry.live ? (
          <>live <span className="live-dot" role="img" aria-label="Live" /></>
        ) : clockTime(entry.at)}
      </span>
      <div className="stream-entry-outcome">{entry.outcome}</div>
      {entry.intent && (
        <div className="stream-entry-intent">
          <span className="stream-entry-intent-label">Intent</span>
          {entry.intent}
        </div>
      )}
      {entry.files.length > 0 && (
        <div className="mono stream-entry-files">{entry.files.join(' · ')}</div>
      )}
    </div>
  )
}
