import { Avatar } from '../../components/Avatar'
import { elapsedShort } from '../../data/relativeTime'
import type { LiveSessionGroup } from '../../data/types'

interface LiveEntryProps {
  group: LiveSessionGroup
}

/** One "Happening now" row: a 3-column grid (dot+avatar / who+tool+project /
 *  elapsed time), with the captured intent on a second row that shares the
 *  name's left edge (grid-column 2). Never infer or narrate intent -- render
 *  the captured string verbatim, or nothing at all when it is null.
 *
 *  One row per person+project GOAL, not per session (mappers.ts
 *  groupLiveSessions): `group.sessionCount` shows "N sessions" only when
 *  more than one live session shares this goal, and the elapsed clock reads
 *  from the OLDEST session in the group -- when the work actually started,
 *  not whichever session most recently touched it.
 *
 *  Deliberately NOT React.memo'd (unlike ProjectRow.tsx): elapsedSince()
 *  reads Date.now() at render time, with no timer of its own -- its "2m ago"
 *  staying accurate depends on the poll-driven re-render actually happening
 *  every 10s. react-query's structural sharing keeps an unchanged session
 *  object's identity stable across a poll with no real change, so memoizing
 *  here would freeze the elapsed label at whatever it read on the last
 *  ACTUAL change, not the last poll -- a real regression, not a safe skip. */
export function LiveEntry({ group }: LiveEntryProps) {
  return (
    <div className="live-entry" data-testid="live-entry">
      <span className="live-entry-avatar">
        <span className="live-dot" role="img" aria-label="Live" />
        <Avatar name={group.author} id={group.authorId} size={19} />
      </span>
      <span className="live-entry-name-cell">
        <span className="live-entry-who">{group.author} · {group.tool}</span>
        <span className="mono live-entry-project">{group.projectName}</span>
        {group.sessionCount > 1 && (
          <span className="mono live-entry-session-count">{group.sessionCount} sessions</span>
        )}
      </span>
      <span className="mono live-entry-elapsed">{elapsedShort(group.startedAt)}</span>
      {group.intent && (
        <div className="live-entry-intent">
          <span className="live-entry-intent-label">Intent</span>
          {group.intent}
        </div>
      )}
    </div>
  )
}
