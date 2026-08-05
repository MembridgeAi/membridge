import { Link } from 'wouter'
import { Avatar } from '../../components/Avatar'
import { dayHref, daySessionHref } from '../../app/routes'
import { relativeAgo } from '../../data/relativeTime'
import type { FeedFilters } from '../../data/types'
import type { DayCard as DayCardModel, DayProject } from './dayCards'

/** How many project names a card spells out before the rest become a count.
 *  Three fits the sub-line at every width the app is used at; past that the
 *  names crowd out the person's name, which is the thing being scanned for. */
export const PROJECT_LIMIT = 3

/** The projects a card spans, busiest first, as a comma list with the tail
 *  elided. Exported and pure so the eliding rule is testable without the DOM.
 *  Never empty in practice; an entry always names a project, but a defensive
 *  empty list renders nothing rather than a stray separator. */
export function projectLabel(projects: DayProject[]): string {
  const shown = projects.slice(0, PROJECT_LIMIT).map(p => p.name)
  const hidden = projects.length - shown.length
  return hidden > 0 ? `${shown.join(', ')} +${hidden}` : shown.join(', ')
}

/** The card's bottom-right stat line, as a list of already-worded parts joined
 *  by the system's usual middot.
 *
 *  A LIST rather than a string because the owner asked for a prompt count here
 *  and /api/feed does not carry one yet (nothing in lib/feed.js or the feed
 *  types has a prompt count -- adding the daemon field is its own task). When
 *  it lands, this becomes one more push and one more test case; no caller and
 *  no markup changes. Shipping sessions and files now is the deliberate
 *  interim, not an oversight. */
export function dayCardStats(card: Pick<DayCardModel, 'sessionCount' | 'files' | 'projects'>): string[] {
  const parts = [card.sessionCount === 1 ? '1 session' : `${card.sessionCount} sessions`]
  if (card.files.length > 0) parts.push(card.files.length === 1 ? '1 file' : `${card.files.length} files`)
  // The projects are already named in full on the line above, so counting
  // them again says nothing. Only worth a part once the list is elided.
  if (card.projects.length > PROJECT_LIMIT) parts.push(`${card.projects.length} projects`)
  return parts
}

interface DayCardProps {
  card: DayCardModel
  /** Solo mode has one person, so an avatar distinguishes nothing -- absent,
   *  not greyed. Same rule as EntryRow's own prop. */
  showAvatar: boolean
  /** This card holds the session `?session=` sent the reader to. Marks it, and
   *  its link carries the target through, so following it lands on the session
   *  the reader was actually sent to rather than the top of the day. */
  targeted?: boolean
  /** The session target to carry into the day view, or null. */
  targetSession?: string | null
  /** The feed's filters at the moment this card was built. Carried onto the
   *  link so the day view runs the SAME query, which is what makes a filtered
   *  feed's cards reachable at all -- see dayHref. */
  filters?: FeedFilters | null
}

/** One person's whole local calendar day, across every project they touched,
 *  as one row of the Feed. Two people working today is two cards, which is the
 *  entire point: keyed on the project as well, one person's day became a card
 *  per checkout and the same afternoon appeared three times.
 *
 *  The Feed is day cards and nothing else now. A card carries exactly two
 *  pieces of text: the day's own sentence, and 1 to 3 sentences of what was
 *  actually done under it. Everything else the reader might want -- the files,
 *  the full bullet list, every prompt grouped by session -- is one click away
 *  on the day view, because it did not fit on a feed row and pretending it did
 *  is what the old expanding card got wrong.
 *
 *  The whole card is a real <a>, so middle-click and cmd-click open the day in
 *  a new window. It used to be a <button> that toggled in place; there is no
 *  in-place state left for it to hold. */
export function DayCard({ card, showAvatar, targeted = false, targetSession = null, filters = null }: DayCardProps) {
  const overviewClass = card.overview.kind === 'undecryptable'
    ? 'day-card-overview day-card-overview-opaque'
    : card.overview.kind === 'none'
      ? 'day-card-overview day-card-overview-empty'
      : 'day-card-overview'

  return (
    <Link
      href={targetSession ? daySessionHref(card.slug, targetSession, filters) : dayHref(card.slug, null, filters)}
      className={`day-card${targeted ? ' day-card-targeted' : ''}`}
    >
      <span className="day-card-avatar-cell">
        {showAvatar && <Avatar id={card.authorId} name={card.author} size={19} />}
      </span>
      <span className="day-card-who-cell">
        <span className="day-card-who">{card.author}</span>
        <span className="day-card-sub">
          <span className="mono">{projectLabel(card.projects)}</span>
          {' · '}{relativeAgo(card.at, { justNow: 'now' })}
        </span>
      </span>
      {/* "live" only. A teammate's flag means their row reached this machine
          recently (lib/feed.js liveBasis 'synced-row'), NOT that they are at
          the keyboard, so no copy here may claim presence. */}
      <span className="mono day-card-meta">
        {card.live && <>live <span className="live-dot" role="img" aria-label="Live" /></>}
      </span>
      <span className={overviewClass}>{card.overview.text}</span>
      {/* Absent, not blank: a day that landed nothing to say says so once, in
          the sentence above, and does not repeat itself in an empty line. */}
      {card.intent && <span className="day-card-intent">{card.intent}</span>}
      <span className="mono day-card-stats">{dayCardStats(card).join(' · ')}</span>
      <span className="day-card-chevron" aria-hidden="true">›</span>
    </Link>
  )
}
