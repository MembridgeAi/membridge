import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'wouter'
import { FEED_SESSION_PARAM, daySessionHref, useRawSearch } from '../../app/routes'
import { isSameLocalDay, localDayKey, weekdayMonthDay } from '../../data/localTime'
import { useFeed, useMembers, useProjects, useStatus } from '../../data/queries'
import type { FeedEntry } from '../../data/types'
import { DayCard } from './DayCard'
import { UNDATED_DAY, buildDayCards } from './dayCards'
import './feed.css'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

/** What a day divider says for a row whose timestamp is not a time.
 *
 *  Both normalizers in lib/feed.js emit `ts: e.ts || ''`, and nothing guarded
 *  before `new Date(e.at)`, so such a row rendered a heading reading
 *  "UNDEFINED UNDEFINED NAN" -- three separate NaN reads presented to the
 *  reader as a date. Naming the state is the honest version, and it keeps
 *  matching the dayCards.UNDATED_DAY bucket those rows group into. */
export const UNDATED_LABEL = 'UNDATED'

// Local calendar fields, never UTC -- the daemon's timestamps are UTC, but
// the reader is not, and grouping by the UTC day filed every evening session
// west of Greenwich under TOMORROW's date (same fix as ProjectPage's dayLabel
// and TodayPage's todayDateLabel). Uppercase per spec's exact example:
// "TODAY · TUE JUL 29".
export function dayLabel(iso: string, now: Date = new Date()): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return UNDATED_LABEL
  const d = new Date(ms)
  const weekday = weekdayMonthDay(d).toUpperCase()
  return isSameLocalDay(d, now) ? `TODAY · ${weekday}` : weekday
}

interface DayGroup<T> {
  /** The viewer's LOCAL calendar day, YYYY-MM-DD, or UNDATED_DAY for a row
   *  whose timestamp is not a time. What the group is bucketed and React-keyed
   *  on, and it carries the YEAR, which is the whole reason it is not `day`.
   *
   *  `day` below is a human label with no year in it ("WED JUL 29"), so two
   *  Jul 29ths that both fall on a Wednesday -- 2020 and 2026, to name the pair
   *  a reader can actually reach -- produce the same string. Bucketed on it,
   *  two days six years apart merged into one section whenever nothing loaded
   *  in between put a different label between them; keyed on it, React saw two
   *  siblings claiming one identity and was free to reconcile the wrong card
   *  into the wrong heading. Neither needed a year of scrolling to hit once the
   *  feed started paging a week at a time. */
  key: string
  day: string
  entries: T[]
}

// Newest first, then bucketed into consecutive same-day runs -- items
// arrive newest-first across pages already, but this sorts before grouping
// rather than trusting order (same defensive stance as ProjectPage's
// groupByDay).
//
// Generic over anything carrying an `at`: the day dividers are the outer
// chrome ABOVE day cards rather than above bare entries, and both shapes have
// to bucket by exactly the same local-day rule. One function, so the two can
// never disagree about which day something happened on.
//
// Bucketed on the local day KEY and labelled separately: the identity of a day
// and the words describing it are two different things, and the label is lossy
// (see DayGroup.key). localDayKey is the same conversion dayCards.entryDayKey
// runs, so a divider and the cards under it can never disagree about which day
// they are, and UNDATED_DAY is the same bucket name those rows group into.
export function groupByDay<T extends { at: string }>(items: T[], now: Date = new Date()): DayGroup<T>[] {
  const sorted = [...items].sort((a, b) => b.at.localeCompare(a.at))
  const groups: DayGroup<T>[] = []
  for (const item of sorted) {
    const ms = Date.parse(item.at)
    const key = Number.isNaN(ms) ? UNDATED_DAY : localDayKey(new Date(ms))
    const current = groups[groups.length - 1]
    if (current && current.key === key) current.entries.push(item)
    else groups.push({ key, day: dayLabel(item.at, now), entries: [item] })
  }
  return groups
}

// The `before` boundary on /api/feed is INCLUSIVE (server.js), so the last
// entry of one page is always the first entry of the next -- dedupe by id when
// flattening pages rather than rendering (and double-keying) that one-entry
// overlap.
//
// Exported for DayPage, which reads the SAME query and has to fold it into the
// same cards; two copies of this rule is how the feed's card and the day it
// links to end up disagreeing about which day a session belongs to.
export function dedupeById(entries: FeedEntry[]): FeedEntry[] {
  const seen = new Set<string>()
  const out: FeedEntry[] = []
  for (const e of entries) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  return out
}

/** The unit the feed loads in, and the unit "Show more" adds: a week of
 *  distinct local days. Andrew's ask, verbatim -- "the feed should be a week
 *  long before the show more button, and when pressed should add a week at a
 *  time". Three days was the old target, and it stopped the feed a day or two
 *  into the reader's own week, which is the wrong place to put a control: a
 *  week is the span a person actually reasons about ("what did we do this
 *  week"), and stopping short of it makes them press a button to reach the
 *  answer they opened the screen for. */
export const FEED_WEEK_DAYS = 7

/** Pages the auto-pager will spend PER WEEK of target. Not an absolute cap any
 *  more, because "Show more" raises the target by a week and a fixed ceiling
 *  would make the second press a no-op.
 *
 *  14, and the number is measured rather than round. /api/feed serves 30 rows a
 *  page (queries.FEED_PAGE_SIZE), so 14 pages is 420 rows per week of target.
 *  The busiest single day on Andrew's real feed measures ~60 rows across a
 *  two-person team (dayCards.ts records the breakdown: 15 + 9 + 18 + 18), so
 *  420 rows reaches seven days of that. Below ~12 the ceiling would bind before
 *  the week was covered on exactly the busy accounts the week target exists
 *  for; far above 14 the sequential round trips on a cold open become something
 *  the reader waits through. In practice the loop exits long before the ceiling
 *  -- a 30-row page usually straddles more than one day, so a normal feed
 *  reaches seven days in three or four pages -- and the ceiling only bites on
 *  an account whose whole history is a handful of very busy days.
 *
 *  DayPage imports this as its own absolute backstop for walking back to one
 *  day. Raising it is right there too, and for the same reason: a feed that now
 *  spans a week wants a day view that can reach a day a week back rather than
 *  showing "That day is not in view" for one it just linked to. */
export const MAX_AUTO_PAGES = 14

/** The Feed screen: DAY CARDS, and nothing else. One card per person per local
 *  calendar day, across every project they touched, newest activity first,
 *  yours and teammates' interleaved.
 *
 *  A card carries the day's sentence and 1 to 3 sentences of what was done,
 *  and clicking it opens that day's own page. It used to expand in place into
 *  a stack of session rows, which was the same volume problem the card exists
 *  to solve, one level down; the detail lives on its own page now.
 *
 *  Filters (person/project/tool) all route through the query, and paging runs
 *  backwards by the daemon's own cursor, so filtering and paging always agree
 *  with each other.
 *
 *  The screen loads a WEEK of distinct local days before it offers "Show more",
 *  and each press adds another week. Both are day counts rather than page
 *  counts, because /api/feed pages by row: a page-counting version hands the
 *  reader a "week" that is one busy teammate's Tuesday. */
export function FeedPage() {
  const statusQuery = useStatus()
  const solo = statusQuery.data?.solo ?? true

  // Arriving from a Today card: `?session=<id>` names the session you were
  // sent to. Read defensively -- a malformed query string must degrade to "no
  // target" rather than throw into this render path.
  const search = useRawSearch()
  const [, navigate] = useLocation()
  const targetSession = useMemo(() => {
    try {
      return new URLSearchParams(search).get(FEED_SESSION_PARAM) || null
    } catch {
      return null
    }
  }, [search])

  const [author, setAuthor] = useState('')
  const [project, setProject] = useState('')
  const [source, setSource] = useState('')

  // How many distinct local days the feed is currently trying to cover. Starts
  // at a week and grows a week per "Show more", which is what makes that button
  // load a WEEK rather than a page: it moves the target and the auto-pager
  // below does the walking, however many pages that turns out to take.
  //
  // A day target rather than a page count, for the reason the pager already
  // documents: /api/feed pages by ROW, so one busy teammate's 30 rows can be a
  // single day and a page-counting button would hand the reader a "week" that
  // is Tuesday.
  const [daysWanted, setDaysWanted] = useState(FEED_WEEK_DAYS)

  const projectsQuery = useProjects()
  const membersQuery = useMembers(!solo)
  // ONE filters value, read by the query and written onto every card's link.
  // The day view runs useFeed itself and useFeed keys its cache on the
  // filters, so a card built here under a filter is only reachable if the day
  // view asks the same question -- building the two apart is exactly how a
  // filtered feed's cards start answering "that day is not in view".
  const filters = useMemo(
    () => ({ author: author || null, project: project || null, source: source || null }),
    [author, project, source],
  )
  const feedQuery = useFeed(filters)

  // dedupeById only (the /api/feed page-boundary overlap noted above).
  //
  // collapseSessionCheckpoints used to run here as well, reducing a session to
  // its single newest row so the feed did not render the same long summary
  // several times running. It is deliberately gone: every entry off /api/feed
  // is one captured PROMPT (lib/memorydb.js mints one per prompt event and
  // attaches the summary to whichever one the Stop hook landed on), so
  // collapsing threw away every prompt of a session but the last -- which is
  // exactly the data the day view's prompt roll-up is made of. Nothing
  // regresses here, because the card no longer renders one row per entry, and
  // the two jobs the collapse was quietly also doing are now done on purpose:
  // dayCards.daySessions groups a session's rows for the day view, and
  // dayCards.dedupeSyncedTwins folds a row against its synced-back copy, which
  // dedupeById cannot (the twin's ts round-trips through timestamptz and comes
  // back a different STRING, so it is a different id).
  //
  // ProjectPage still collapses, and must: it renders one row per entry.
  const entries = useMemo(
    () => dedupeById(feedQuery.data?.pages.flatMap(p => p.entries) ?? []),
    [feedQuery.data],
  )
  // Entries -> day cards -> day dividers. The cards are the top level of the
  // feed: one per person per local day, so a teammate's afternoon is one card
  // with a count instead of eight near-identical rows. The dividers stay the
  // outer chrome, and both layers key on the SAME local day (dayCardKey and
  // dayLabel both go through localTime), so a card can never land under a
  // heading for a different day.
  // The daemon's day sentences off every loaded page. buildDayCards picks the
  // one that saw most of each day and falls back to its own pick where none
  // arrived, so a daemon that does not serve them is a supported state.
  const dayDigests = useMemo(
    () => feedQuery.data?.pages.flatMap(p => p.dayDigests ?? []) ?? [],
    [feedQuery.data],
  )
  const dayCards = useMemo(() => buildDayCards(entries, dayDigests), [entries, dayDigests])
  const dayGroups = groupByDay(dayCards)
  // What the pager counts as progress. The UNDATED bucket holds rows whose `at`
  // could not be parsed (lib/feed.js emits `ts: e.ts || ''`), and it is not a
  // day: counting it would let the feed stop one REAL day short of the week it
  // promised, on exactly the accounts whose data is already suspect. It still
  // renders; it just does not pay towards the target.
  const datedDayCount = dayGroups.filter(g => g.key !== UNDATED_DAY).length

  // Keep pulling pages until the feed covers `daysWanted` whole days, not just
  // a few rows. /api/feed pages by ROW and grouping happens after, so one busy
  // teammate starves everyone else: 30 rows of theirs is a full page and a
  // quieter person's card for the same day lands behind "Show more". Measured
  // on a two-person team, 59 rows from one of them filled page one entirely.
  //
  // Fetching to a DAY count rather than a card count is deliberate. A card
  // count would still be gameable by the same person (many projects, many
  // cards, same day), and days are what the reader actually scans.
  //
  // No `since` parameter is sent to reach the week, deliberately. useFeed keys
  // its cache on the filters alone, and adding a bound to the request would
  // change that key and cost the day view its cache hit off the feed -- the
  // long comment in DayPage.tsx is about exactly that hit. Paging to a day
  // count is what reaches a week without touching the key.
  //
  // TERMINATION IS TRACKED ON PROGRESS, never on the fetching flag alone.
  // isFetchingNextPage is both a guard and a dependency, so an effect keyed on
  // it re-arms every time a fetch settles: with nothing recording that an
  // attempt was already made for this state, a page that errors, repeats its
  // cursor, or simply adds no new day loops forever. Measured at 66 requests
  // in 1.5 seconds against an erroring second page, for as long as the screen
  // is open. The pageCount ref is what makes it terminate -- if the last
  // attempt did not grow data.pages, stop asking -- and pageCeiling caps even a
  // perfectly healthy walk. That mechanism is unchanged; only the target moved.
  const autoPagedFrom = useRef(-1)
  // The latch means "already asked at this page count", and page counts START
  // OVER when the query key changes: useFeed keys its cache on the filters, so
  // picking a person or a project swaps in a different cache entry whose
  // pageCount walks 0, 1, 2 again. A latch still holding the PREVIOUS filter's
  // count then matches the new filter's count on the very first pass, and the
  // pager refuses to walk a feed it has never walked.
  //
  // That staleness predates the week target, but it used to be survivable: the
  // button below was keyed on isFetchingNextPage, so the reader saw a live
  // "Show more" and could drive it by hand. Keyed on the TARGET, the same state
  // renders a disabled "Loading..." that no request will ever finish, with no
  // way out but another filter change or a reload. Reset with the query key.
  useEffect(() => { autoPagedFrom.current = -1 }, [filters])
  const pageCount = feedQuery.data?.pages.length ?? 0
  // The ceiling scales with the target, so the second "Show more" is not a
  // no-op the way a fixed cap would make it.
  const pageCeiling = MAX_AUTO_PAGES * Math.max(1, Math.ceil(daysWanted / FEED_WEEK_DAYS))
  useEffect(() => {
    if (datedDayCount >= daysWanted) return
    if (pageCount >= pageCeiling) return
    // A failed page is a reason to stop, not to retry in a tight loop. The
    // reader still has "Show more", which is a deliberate act.
    if (feedQuery.isError) return
    if (!feedQuery.hasNextPage || feedQuery.isFetchingNextPage) return
    // Already asked at this page count and got nowhere: the next page either
    // failed or carried no new day. Either way, asking again changes nothing.
    if (autoPagedFrom.current === pageCount) return
    autoPagedFrom.current = pageCount
    feedQuery.fetchNextPage()
  }, [datedDayCount, daysWanted, pageCeiling, pageCount, feedQuery.isError, feedQuery.hasNextPage, feedQuery.isFetchingNextPage, feedQuery.fetchNextPage])

  // The auto-pager is still walking towards the current target. The button has
  // to say so for the WHOLE walk, not just while one request is in flight:
  // isFetchingNextPage drops to false between pages, so a label keyed on it
  // alone flickers back to "Show more" mid-week and invites a press that queues
  // another week on top of the one still arriving. Once the ceiling is reached
  // this goes false on purpose -- the pager has given up, and the reader gets a
  // live button to push past it by hand.
  const fillingToTarget = datedDayCount < daysWanted
    && feedQuery.hasNextPage
    && !feedQuery.isError
    && pageCount < pageCeiling
  const loadingMore = feedQuery.isFetchingNextPage || fillingToTarget

  // One press, one more week. It moves the target AND fetches the next page
  // itself; the target alone would not be enough, because the effect refuses to
  // run once a page has errored and this button is the only way back from that
  // state. Latching the ref at the current page count keeps the effect from
  // racing this call with a second request for the same page; once the page
  // lands the count moves and the pager resumes towards the new target.
  const showMore = () => {
    setDaysWanted(days => days + FEED_WEEK_DAYS)
    autoPagedFrom.current = pageCount
    feedQuery.fetchNextPage()
  }

  // A `?session=` deep link names a SESSION, and the feed is days. Today's
  // rows (features/today/LiveEntry.tsx) are all built this way, and so is
  // every such URL already pasted into a chat, so the param has to keep
  // working -- but with no expansion left there is nothing on this screen for
  // it to open, and a card that merely highlights itself makes the reader
  // hunt for the row they were sent to.
  //
  // So the feed hands the link on: once the session's card is loaded, replace
  // this URL with that day's, target and filters intact, and the day view
  // scrolls the session's own group into view. REPLACE, not push, so Back
  // returns to Today rather than bouncing off this redirect.
  //
  // A target that is not on the loaded pages is a plain miss, not an error:
  // no redirect happens, the feed renders as normal, and auto-paging may still
  // turn the card up, at which point this fires.
  const targetCard = targetSession
    ? dayCards.find(c => c.sessions.some(s => s.session === targetSession)) ?? null
    : null
  const targetHref = targetCard && targetSession
    ? daySessionHref(targetCard.slug, targetSession, filters)
    : null
  useEffect(() => {
    if (targetHref) navigate(targetHref, { replace: true })
  }, [targetHref, navigate])

  const projects = projectsQuery.data ?? []
  const members = membersQuery.data ?? []
  const tools = statusQuery.data?.tools ?? []

  const hasEntries = entries.length > 0
  const firstLoadFailed = feedQuery.isError && !hasEntries

  if (firstLoadFailed) {
    return (
      <div className="feed-page">
        <div className="feed-header">
          <h1 className="feed-title">Feed</h1>
        </div>
        <p className="feed-error" role="alert">Couldn't reach MemBridge.</p>
        <p className="feed-empty-note">{errorMessage(feedQuery.error)}</p>
      </div>
    )
  }

  return (
    <div className="feed-page">
      <div className="feed-header">
        <h1 className="feed-title">Feed</h1>
      </div>

      <div className="feed-filters">
        {!solo && (
          <select aria-label="Filter by person" value={author} onChange={e => setAuthor(e.target.value)}>
            <option value="">Everyone</option>
            {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
        <select aria-label="Filter by project" value={project} onChange={e => setProject(e.target.value)}>
          <option value="">All projects</option>
          {projects.map(p => <option key={p.path} value={p.path}>{p.name}</option>)}
        </select>
        <select aria-label="Filter by tool" value={source} onChange={e => setSource(e.target.value)}>
          <option value="">All tools</option>
          {tools.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {!feedQuery.isLoading && dayGroups.length === 0 && (
        <p className="feed-empty-note">Nothing yet.</p>
      )}

      {dayGroups.map(group => (
        <div key={group.key}>
          <div className="feed-day">{group.day}</div>
          {group.entries.map(card => (
            <DayCard
              key={card.key}
              card={card}
              showAvatar={!solo}
              targeted={card === targetCard}
              targetSession={card === targetCard ? targetSession : null}
              filters={filters}
            />
          ))}
        </div>
      ))}

      {hasEntries && feedQuery.isError && (
        <p className="feed-error" role="alert">Couldn't load more. {errorMessage(feedQuery.error)}</p>
      )}

      {feedQuery.hasNextPage && (
        <button
          type="button"
          className="feed-show-more"
          onClick={showMore}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading…' : 'Show more'}
        </button>
      )}
    </div>
  )
}
