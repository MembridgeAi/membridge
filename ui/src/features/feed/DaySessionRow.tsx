import { Link } from 'wouter'
import { sessionHref } from '../../app/routes'
import type { DaySession } from './dayCards'

/** The viewer's own wall clock (no timeZone option, so the browser's resolved
 *  zone wins) -- same reasoning as EntryRow's own clockTime, which is private
 *  to that module. Pinned to UTC, a 7pm session read "2:00 AM" to the person
 *  who had just run it.
 *
 *  It lives here rather than on DayPage because the row is what renders a
 *  time, and DayPage importing it back is one arrow instead of a cycle. */
export function clockTime(at: string): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/** A session's time range, or a single time when it landed one prompt. */
export function sessionTimeRange(session: Pick<DaySession, 'startedAt' | 'endedAt'>): string {
  const from = clockTime(session.startedAt)
  const to = clockTime(session.endedAt)
  return from === to ? from : `${from} to ${to}`
}

interface DaySessionRowProps {
  session: DaySession
  /** Where the session page's back link returns to. */
  from: string
  showProject: boolean
  /** Trailing right-aligned metadata. Sessions passes the prompt count;
   *  Summaries passes nothing, because the bullets are already below. */
  meta?: string
}

/** One session, as a row you click into.
 *
 *  The WHOLE row is the target. It used to be an 8-character timestamp with a
 *  chevron 3px to its right: roughly 60x15px of hit area inside a row 670px
 *  wide, which is not a click-in, it is a hyperlink you have to aim at.
 *
 *  The row is a real <a>, so middle-click and cmd-click open the session in a
 *  new window. Two consequences, both the same ones DayCard.tsx already
 *  accepted for the same reason: Space no longer activates it (an a[href]
 *  takes Enter only, where a <button> took both), and NOTHING INSIDE THIS ROW
 *  MAY EVER BE A LINK, because the parser unnests a nested anchor and the live
 *  DOM would stop matching this JSX. That is also why the prompt list is a
 *  SIBLING of this row in DayPage rather than a child of it. */
export function DaySessionRow({ session, from, showProject, meta }: DaySessionRowProps) {
  const fields = (
    <>
      <span className="mono day-session-row-time">{sessionTimeRange(session)}</span>
      <span className="day-session-row-tool">{session.tool}</span>
      {/* Only when the day spans more than one project. On a single-project
          day it is the same word under every row, which is noise. */}
      {showProject && <span className="mono day-session-row-project">{session.project}</span>}
      {/* "live" only, for the reason spelled out on the day card. */}
      {session.live && <span className="mono day-session-row-live">live <span className="live-dot" role="img" aria-label="Live" /></span>}
      {meta && <span className="mono day-session-row-meta">{meta}</span>}
    </>
  )

  // A bare-plumbing row has no session id, so there is no page to open.
  // Rendered as a row that is plainly not one -- no anchor, and no chevron,
  // since the chevron is the mark that says "this opens" -- rather than as a
  // dead anchor that looks identical to a live one until it is clicked.
  if (!session.session) {
    return <div className="day-session-row day-session-row-static">{fields}</div>
  }

  return (
    <Link href={sessionHref(session.session, from)} className="day-session-row">
      {fields}
      <span className="day-session-row-chevron" aria-hidden="true">›</span>
    </Link>
  )
}
