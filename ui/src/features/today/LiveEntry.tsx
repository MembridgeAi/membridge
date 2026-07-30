import { Avatar } from '../../components/Avatar'
import type { LiveSession } from '../../data/types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "now" for < 1m, then minutes, hours, days -- coarsest unit that still
 *  reads as "just happened" for a live session's elapsed time. */
function elapsedSince(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime()
  if (ms < MINUTE) return 'now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`
  return `${Math.floor(ms / DAY)}d`
}

interface LiveEntryProps {
  session: LiveSession
}

/** One "Happening now" row: a 3-column grid (dot+avatar / who+tool+project /
 *  elapsed time), with the captured intent on a second row that shares the
 *  name's left edge (grid-column 2). Never infer or narrate intent -- render
 *  the captured string verbatim, or nothing at all when it is null. */
export function LiveEntry({ session }: LiveEntryProps) {
  return (
    <div className="live-entry">
      <span className="live-entry-avatar">
        <span className="live-dot" role="img" aria-label="Live" />
        <Avatar name={session.author} id={session.authorId} size={19} />
      </span>
      <span className="live-entry-name-cell">
        <span className="live-entry-who">{session.author} · {session.tool}</span>
        <span className="mono live-entry-project">{session.projectName}</span>
      </span>
      <span className="mono live-entry-elapsed">{elapsedSince(session.startedAt)}</span>
      {session.intent && (
        <div className="live-entry-intent">
          <span className="live-entry-intent-label">Intent</span>
          {session.intent}
        </div>
      )}
    </div>
  )
}
