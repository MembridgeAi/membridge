import { Avatar } from './Avatar'
import type { StreamEntry } from '../data/types'

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

// The viewer's own wall clock (no timeZone option, so the browser's resolved
// zone wins) -- same reasoning as SyncStateView's shortStamp. Pinned to UTC,
// a 7pm session read "2:00 AM" to the person who had just run it.
function clockTime(at: string): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

interface EntryRowProps {
  entry: StreamEntry
  /** The entry's project, display name only -- passed by a cross-project
   *  context (Feed) so each row says which project it happened in. A
   *  single-project context (ProjectPage) omits it: the project is already
   *  the page you're on, so repeating its name on every row is noise. */
  project?: string
  /** Solo mode has exactly one person, so an avatar (a "who" signal) has
   *  nothing to distinguish -- absent, not disabled/greyed. Defaults true
   *  for every existing single-project caller. */
  showAvatar?: boolean
}

/** One merged-stream row, shared by the Feed (cross-project) and the
 *  project page (single-project) so the two never drift: author [+
 *  project] + tool + relative time, a live indicator or absolute clock
 *  time on the right, the outcome in full, a muted INTENT line (the
 *  captured ask verbatim, never inferred), and files in mono. */
export function EntryRow({ entry, project, showAvatar = true }: EntryRowProps) {
  return (
    <div className="entry-row">
      <span className="entry-row-avatar-cell">
        {showAvatar && <Avatar id={entry.authorId} name={entry.author} size={19} />}
      </span>
      <span className="entry-row-who-cell">
        <span className="entry-row-who">{entry.author}</span>
        <span className="entry-row-tool">
          {entry.tool}
          {project && <> · <span className="mono">{project}</span></>}
          {' · '}{relativeTime(entry.at)}
        </span>
      </span>
      <span className="mono entry-row-meta">
        {entry.live ? (
          <>live <span className="live-dot" role="img" aria-label="Live" /></>
        ) : clockTime(entry.at)}
      </span>
      <div className="entry-row-outcome">{entry.outcome}</div>
      {entry.intent && (
        <div className="entry-row-intent">
          <span className="entry-row-intent-label">Intent</span>
          {entry.intent}
        </div>
      )}
      {entry.files.length > 0 && (
        <div className="mono entry-row-files">{entry.files.join(' · ')}</div>
      )}
    </div>
  )
}
