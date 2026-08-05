import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'wouter'
import { Avatar } from '../../components/Avatar'
import { shortPath } from '../../components/EntryRow'
import {
  FEED_SESSION_PARAM, ROUTES, backLink, dayHref, daySessionHref, parseDayFilters, sessionHref, useRawSearch,
} from '../../app/routes'
import { localDayRangeMs } from '../../data/localTime'
import { relativeAgo } from '../../data/relativeTime'
import { useFeed, useStatus } from '../../data/queries'
import { DAY_FILE_LIMIT, buildDayCards, daySlugDay } from './dayCards'
import type { DayCard, DaySession } from './dayCards'
import { MAX_AUTO_PAGES, dayLabel, dedupeById } from './FeedPage'
import './feed.css'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

/** The viewer's own wall clock (no timeZone option, so the browser's resolved
 *  zone wins) -- same reasoning as EntryRow's own clockTime, which is private
 *  to that module. Pinned to UTC, a 7pm session read "2:00 AM" to the person
 *  who had just run it. */
function clockTime(at: string): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/** A session's time range, or a single time when it landed one prompt. */
export function sessionTimeRange(session: Pick<DaySession, 'startedAt' | 'endedAt'>): string {
  const from = clockTime(session.startedAt)
  const to = clockTime(session.endedAt)
  return from === to ? from : `${from} to ${to}`
}

/** One section of the day. Absent content means an absent section, never an
 *  empty heading: the session page made the same call, and a heading over
 *  nothing reads as a load failure rather than as a quiet day. */
function DaySection({ title, count, children }: { title: string; count?: string; children: ReactNode }) {
  return (
    <section className="day-section">
      <h2 className="day-section-title">
        {title}
        {count && <span className="day-section-count">{count}</span>}
      </h2>
      {children}
    </section>
  )
}

/** Every file the day touched, most-touched first, with the rest behind a
 *  count. Paths are shortened from the LEFT (shortPath), because a path
 *  clipped from the right eats the filename, the one part that identifies it. */
function DayFiles({ files }: { files: DayCard['files'] }) {
  const [showAll, setShowAll] = useState(false)
  const hidden = Math.max(0, files.length - DAY_FILE_LIMIT)
  const shown = showAll ? files : files.slice(0, DAY_FILE_LIMIT)
  return (
    <DaySection title="Files touched" count={String(files.length)}>
      <ul className="day-files">
        {shown.map(f => (
          <li key={f.file} className="day-file">
            <span className="mono day-file-name" title={f.file}>{shortPath(f.file)}</span>
            {f.touches > 1 && <span className="day-file-touches">{f.touches}x</span>}
            {f.note && <span className="day-file-note">{f.note}</span>}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" className="day-more" onClick={() => setShowAll(v => !v)}>
          {showAll ? 'Show fewer' : `+${hidden} more`}
        </button>
      )}
    </DaySection>
  )
}

/** One session's prompts under a header that names when it ran, which tool ran
 *  it, and links at its own page. The link is the whole reason the header
 *  exists: consolidating a day must not cost the reader the ability to open
 *  the single session they came for. */
function DaySessionGroup({ session, targeted, from, showProject }: { session: DaySession; targeted: boolean; from: string; showProject: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null)

  // Bring the targeted group into view once it exists. Guarded: jsdom and
  // older engines have no scrollIntoView, and a missing one must not throw
  // into the render path (the same guard EntryRow carries).
  useEffect(() => {
    if (!targeted || !ref.current) return
    if (typeof ref.current.scrollIntoView !== 'function') return
    ref.current.scrollIntoView({ block: 'center' })
  }, [targeted])

  const range = sessionTimeRange(session)
  return (
    <div ref={ref} className={`day-session${targeted ? ' day-session-targeted' : ''}`}>
      <div className="day-session-head">
        {session.session
          ? (
            <Link href={sessionHref(session.session, from)} className="mono day-session-link">
              {range}
              <span className="day-session-affordance" aria-hidden="true">›</span>
            </Link>
          )
          // A bare-plumbing row has no session, so there is no page to link
          // at. Rendered as plain text rather than as a dead anchor.
          : <span className="mono day-session-range">{range}</span>}
        {/* Only when the day spans more than one project. On a single-project
            day it is the same word under every group, which is noise. */}
        {showProject && <span className="mono day-session-project">{session.project}</span>}
        <span className="mono day-session-tool">{session.tool}</span>
        {/* "live" only, for the reason spelled out on the day card. */}
        {session.live && <span className="mono day-session-live">live <span className="live-dot" role="img" aria-label="Live" /></span>}
      </div>
      {session.prompts.length > 0 && (
        <ol className="day-prompts">
          {session.prompts.map(p => (
            <li key={p.key} className="day-prompt">
              <span className="mono day-prompt-time">{clockTime(p.at)}</span>
              <span className="day-prompt-text">{p.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** Where a day view's own back link goes. Resolved through backLink rather
 *  than hardcoded, so the words and the target come from the one place that
 *  owns both. A day view genuinely is only ever reached from the Feed, which
 *  is what makes a fixed origin honest here and what made the session page's
 *  hardcoded "Back to the Feed" dishonest: that page is reached from four
 *  screens and an MCP tool. */
const DAY_BACK = backLink(ROUTES.feed)

interface DayPageProps {
  /** The URL's slug, matched against each card's own slug. Not decoded, and
   *  no longer needing to be: dayCards.daySlug carries no percent escape at
   *  all, so what the router hands over is byte-for-byte what the card minted.
   *  The two only ever have to agree, never round-trip. */
  slug: string
}

/** One person's whole local calendar day, across every project, in full.
 *
 *  The order is the owner's, and it is an order of questions: what did this
 *  touch, what did it do, and what was it asked to do. The prompts come last
 *  and are grouped by session, because they are the raw material the first two
 *  sections are made of, and because a session is the unit anyone wants to
 *  open when they want more than this page has. */
export function DayPage({ slug }: DayPageProps) {
  const statusQuery = useStatus()
  const solo = statusQuery.data?.solo ?? true

  // Read the session target defensively: a malformed query string must
  // degrade to "no target" rather than throw into this render path.
  const search = useRawSearch()
  const targetSession = useMemo(() => {
    try {
      return new URLSearchParams(search).get(FEED_SESSION_PARAM) || null
    } catch {
      return null
    }
  }, [search])

  // The same query the Feed ran, filters and all. There is no per-day endpoint
  // to ask instead: /api/feed is the only thing that carries these rows, and
  // useFeed keys its cache on the filters (data/queries.ts), so asking
  // UNFILTERED here would be a different query key from the card that was just
  // clicked: a cold start, one page, no paging, and a card the reader had just
  // seen that is frequently not in it. The filters ride on the URL
  // (routes.dayHref) so the two agree and arriving from the feed is a cache
  // hit.
  const filters = useMemo(() => parseDayFilters(search), [search])
  const feedQuery = useFeed(filters)
  const entries = useMemo(
    () => dedupeById(feedQuery.data?.pages.flatMap(p => p.entries) ?? []),
    [feedQuery.data],
  )
  const dayDigests = useMemo(
    () => feedQuery.data?.pages.flatMap(p => p.dayDigests ?? []) ?? [],
    [feedQuery.data],
  )
  const cards = useMemo(() => buildDayCards(entries, dayDigests), [entries, dayDigests])
  const card = cards.find(c => c.slug === slug) ?? null

  // Page backwards until this ONE day is covered, and not one request further.
  //
  // A cache hit off the Feed needs none of this. A day URL opened cold does: a
  // pasted link, a reload, a cmd-clicked card. The feed loads recent activity
  // first, so the day being asked for can simply be older than page one.
  //
  // The condition is the narrow one, deliberately not FeedPage's "load a few
  // whole days": stop as soon as the OLDEST loaded entry is older than the
  // START of the day in the slug, because everything this day could contain is
  // then already loaded. That also keeps paging when the card is already on
  // screen but incomplete -- the day's earlier sessions can sit one page down,
  // and a day view missing half its prompts is a quieter wrong than a missing
  // one.
  //
  // The bound is compared as an INSTANT, through localTime.localDayRangeMs.
  // The slug's day is a LOCAL calendar date and every `at` is a UTC instant,
  // and treating the one as the other is off by the viewer's whole offset --
  // for a Los Angeles reader, 09:00 to 17:00 of the previous day lands on the
  // wrong side of the comparison. That conversion is defined once, in
  // localTime, and never inline here. (It is not sent to /api/feed as a
  // `since`: the daemon supports one, but adding it to this query would change
  // useFeed's cache key and cost the cache hit the paragraph above depends on.)
  //
  // Termination, the same shape as FeedPage's own pager and for the same
  // measured reason: isFetchingNextPage is both guard and dependency, so an
  // effect keyed on it re-arms every time a fetch settles. Progress is tracked
  // on the PAGE COUNT, so a page that errors, repeats its cursor or adds
  // nothing stops the loop instead of spinning it. MAX_AUTO_PAGES is the
  // backstop for a day so far back it is not worth walking to; the reader still
  // has "Look further back", which is a deliberate act.
  const dayStart = useMemo(() => {
    const day = daySlugDay(slug)
    return day ? localDayRangeMs(day)?.start ?? null : null
  }, [slug])
  const oldestLoadedMs = useMemo(() => entries.reduce<number | null>((oldest, e) => {
    const ms = Date.parse(e.at)
    if (Number.isNaN(ms)) return oldest
    return oldest === null || ms < oldest ? ms : oldest
  }, null), [entries])
  const dayCovered = dayStart === null || (oldestLoadedMs !== null && oldestLoadedMs < dayStart)
  const autoPagedFrom = useRef(-1)
  const pageCount = feedQuery.data?.pages.length ?? 0
  useEffect(() => {
    if (dayCovered) return
    if (pageCount >= MAX_AUTO_PAGES) return
    if (feedQuery.isError) return
    if (!feedQuery.hasNextPage || feedQuery.isFetchingNextPage) return
    if (autoPagedFrom.current === pageCount) return
    autoPagedFrom.current = pageCount
    feedQuery.fetchNextPage()
  }, [dayCovered, pageCount, feedQuery.isError, feedQuery.hasNextPage, feedQuery.isFetchingNextPage, feedQuery.fetchNextPage])

  const back = <Link href={DAY_BACK.href} className="day-back">‹ {DAY_BACK.label}</Link>

  if (feedQuery.isError && cards.length === 0) {
    return (
      <div className="day-page">
        {back}
        <p className="feed-error" role="alert">Couldn't reach MemBridge.</p>
        <p className="feed-empty-note">{errorMessage(feedQuery.error)}</p>
      </div>
    )
  }

  if (!card) {
    // Two different reasons to be here and only one of them is a mistake, so
    // the copy names both: the feed is PAGED, and a day older than the pages
    // loaded is a miss rather than a bad link. Never a blank page, and never
    // without a way back.
    return (
      <div className="day-page">
        {back}
        <div className="day-missing">
          <p className="day-missing-title">{feedQuery.isLoading ? 'Loading…' : 'That day is not in view'}</p>
          {!feedQuery.isLoading && (
            <p className="day-missing-note">
              The feed loads recent activity first, so this day may simply be further back than what is loaded.
            </p>
          )}
          {!feedQuery.isLoading && feedQuery.hasNextPage && (
            <button
              type="button"
              className="feed-show-more"
              onClick={() => feedQuery.fetchNextPage()}
              disabled={feedQuery.isFetchingNextPage}
            >
              {feedQuery.isFetchingNextPage ? 'Loading…' : 'Look further back'}
            </button>
          )}
        </div>
      </div>
    )
  }

  const overviewClass = card.overview.kind === 'undecryptable'
    ? 'day-head-overview day-head-overview-opaque'
    : card.overview.kind === 'none'
      ? 'day-head-overview day-head-overview-empty'
      : 'day-head-overview'

  // Where a session opened from here should call "back". The day's own URL,
  // carrying the session AND the filters through, so returning re-marks the
  // group the reader was looking at and lands on a day view that can still
  // find its card, instead of dropping them at the top of the day or on a
  // "not in view" page one query key over.
  const from = targetSession
    ? daySessionHref(card.slug, targetSession, filters)
    : dayHref(card.slug, null, filters)

  return (
    <div className="day-page">
      {back}

      <div className="day-head">
        <div className="day-head-who">
          {!solo && <Avatar id={card.authorId} name={card.author} size={22} />}
          <div>
            <div className="day-head-name wrap-anywhere">{card.author}</div>
            <div className="mono day-head-sub wrap-anywhere">
              {/* Every project of the day, not just the busiest: this page has
                  the room the feed row did not, and eliding here would hide
                  the very thing a cross-project day is being opened for. */}
              {card.projects.map(p => p.name).join(', ')} · {dayLabel(card.at)} · {relativeAgo(card.at, { justNow: 'now' })}
              {/* "live" only, never presence -- see the day card. */}
              {card.live && <> · live <span className="live-dot" role="img" aria-label="Live" /></>}
            </div>
          </div>
        </div>
        <p className={overviewClass}>{card.overview.text}</p>
        {card.intent && <p className="day-head-intent">{card.intent}</p>}
        {/* See the day card: a sentence written from part of the day says so,
            here, next to the sentence rather than buried anywhere else. */}
        {card.overview.coverageNote && (
          <p className="day-head-coverage" role="note">{card.overview.coverageNote}</p>
        )}
      </div>

      {card.files.length > 0 && <DayFiles files={card.files} />}

      {card.bullets.length > 0 && (
        <DaySection title="What was done">
          <ul className="day-bullets">
            {card.bullets.map(b => <li key={b.key} className="day-bullet">{b.text}</li>)}
          </ul>
        </DaySection>
      )}

      {/* No count on the Prompts heading: every group below carries its own
          header, and a bare number there reads as a prompt count, which is a
          number /api/feed does not carry. */}
      {card.sessions.length > 0 && (
        <DaySection title="Prompts">
          <div className="day-sessions">
            {card.sessions.map(s => (
              <DaySessionGroup
                key={s.key}
                session={s}
                targeted={!!targetSession && s.session === targetSession}
                from={from}
                showProject={card.projects.length > 1}
              />
            ))}
          </div>
        </DaySection>
      )}
    </div>
  )
}
