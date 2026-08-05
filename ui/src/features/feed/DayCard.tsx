import { useId, useState } from 'react'
import { Avatar } from '../../components/Avatar'
import { EntryRow } from '../../components/EntryRow'
import { relativeAgo } from '../../data/relativeTime'
import type { DayCard as DayCardModel } from './dayCards'

/** The card's bottom-right stat line, as a list of already-worded parts joined
 *  by the system's usual middot.
 *
 *  A LIST rather than a string because the owner asked for a prompt count here
 *  and /api/feed does not carry one yet (nothing in lib/feed.js or the feed
 *  types has a prompt count -- adding the daemon field is its own task). When
 *  it lands, this becomes one more push and one more test case; no caller and
 *  no markup changes. Shipping session counts now is the deliberate interim,
 *  not an oversight. */
export function dayCardStats(card: Pick<DayCardModel, 'sessionCount'>): string[] {
  return [card.sessionCount === 1 ? '1 session' : `${card.sessionCount} sessions`]
}

interface DayCardProps {
  card: DayCardModel
  /** Solo mode has one person, so an avatar distinguishes nothing -- absent,
   *  not greyed. Same rule as EntryRow's own prop, and passed straight down to
   *  the rows inside. */
  showAvatar: boolean
  /** The session `?session=` sent the reader to, or null. A card holding it
   *  starts EXPANDED: collapsed, the row the link exists to point at would be
   *  unreachable, which silently breaks every Today card's link into the feed. */
  targetSession: string | null
  /** Where a row inside this card is being opened FROM, handed to EntryRow so
   *  the session page's back link says "the Feed" because it means it, rather
   *  than because that was the only thing it could ever say. */
  from: string
}

/** One person's work in one project on one local calendar day, consolidated.
 *
 *  Collapsed it is a single line of overview plus a session count; expanded it
 *  reveals that day's sessions through the SHARED EntryRow -- the same
 *  component the project stream renders -- so a row here and a row there can
 *  never drift, and each still links to its own session page.
 *
 *  The header is a real <button>: it toggles state in place and navigates
 *  nowhere, so it must not be an anchor. The rows inside are the anchors. */
export function DayCard({ card, showAvatar, targetSession, from }: DayCardProps) {
  const holdsTarget = !!targetSession && card.entries.some(e => e.session === targetSession)
  const [expanded, setExpanded] = useState(holdsTarget)
  const panelId = useId()
  const stats = dayCardStats(card)

  const overviewClass = card.overview.kind === 'undecryptable'
    ? 'day-card-overview day-card-overview-opaque'
    : card.overview.kind === 'none'
      ? 'day-card-overview day-card-overview-empty'
      : 'day-card-overview'

  return (
    <div className={`day-card${expanded ? ' day-card-expanded' : ''}`}>
      <button
        type="button"
        className="day-card-head"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded(v => !v)}
      >
        <span className="day-card-avatar-cell">
          {showAvatar && <Avatar id={card.authorId} name={card.author} size={19} />}
        </span>
        {/* Both of these carry arbitrary-length user data (a display name and a
            project name), so both are bounded by .wrap-anywhere -- see
            styles/base.css. The author's own `white-space: nowrap` was removed
            with it, because nowrap makes even a spaced name unbreakable.

            NO LINE CLAMP, which is the one deviation from T1's companion
            treatment, and it is a measured decision rather than an omission. A
            clamp needs `display: -webkit-box`, which would blockify these spans
            -- and unlike .proj-path (a text-only element), .day-card-who has a
            SIBLING on its line, so blockifying would push .day-card-sub onto its
            own row permanently, for every card in the feed. The vertical cost it
            would be buying off is small: the cell is 556px wide at the 900px
            floor, so a name only reaches a second line past ~65 characters, and
            a 140-character name measures 3 lines / +34px of card height. Paying
            a layout regression on 100% of rows to save 34px on an absurd name is
            the wrong trade. Nothing is truncated, so nothing needs `title` to
            stay recoverable -- the full value is on screen. */}
        <span className="day-card-who-cell">
          <span className="day-card-who wrap-anywhere">{card.author}</span>
          <span className="day-card-sub wrap-anywhere">
            <span className="mono">{card.project}</span>
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
        <span className="mono day-card-stats">{stats.join(' · ')}</span>
        <span className="day-card-chevron" aria-hidden="true">{expanded ? '⌄' : '›'}</span>
      </button>

      {/* Unmounted, not hidden, while collapsed: EntryRow schedules hover
          timers and a document keydown listener per row, and a day of a
          teammate's sessions kept alive behind display:none pays all of it for
          rows nobody can see. */}
      {expanded && (
        <div className="day-card-sessions" id={panelId}>
          {card.entries.map(entry => (
            <EntryRow
              key={entry.id}
              entry={entry}
              project={entry.project}
              showAvatar={showAvatar}
              targeted={!!targetSession && entry.session === targetSession}
              from={from}
            />
          ))}
        </div>
      )}
    </div>
  )
}
