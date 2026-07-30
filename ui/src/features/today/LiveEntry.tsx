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
 *  the captured string verbatim, or nothing at all when it is null.
 *
 *  Deliberately NOT React.memo'd (unlike ProjectRow.tsx): elapsedSince()
 *  reads Date.now() at render time, with no timer of its own -- its "2m ago"
 *  staying accurate depends on the poll-driven re-render actually happening
 *  every 10s. react-query's structural sharing keeps an unchanged session
 *  object's identity stable across a poll with no real change, so memoizing
 *  here would freeze the elapsed label at whatever it read on the last
 *  ACTUAL change, not the last poll -- a real regression, not a safe skip. */
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
