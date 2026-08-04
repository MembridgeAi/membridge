import { useMemo, useState } from 'react'
import { useSearch } from 'wouter'
import { FEED_SESSION_PARAM } from '../../app/routes'
import { isSameLocalDay, weekdayMonthDay } from '../../data/localTime'
import { collapseSessionCheckpoints } from '../../data/mappers'
import { useFeed, useMembers, useProjects, useStatus } from '../../data/queries'
import type { FeedEntry } from '../../data/types'
import { DayCard } from './DayCard'
import { buildDayCards } from './dayCards'
import './feed.css'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

// Local calendar fields, never UTC -- the daemon's timestamps are UTC, but
// the reader is not, and grouping by the UTC day filed every evening session
// west of Greenwich under TOMORROW's date (same fix as ProjectPage's dayLabel
// and TodayPage's todayDateLabel). Uppercase per spec's exact example:
// "TODAY · TUE JUL 29".
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const weekday = weekdayMonthDay(d).toUpperCase()
  return isSameLocalDay(d, now) ? `TODAY · ${weekday}` : weekday
}

interface DayGroup<T> {
  day: string
  entries: T[]
}

// Newest first, then bucketed into consecutive same-day runs -- items
// arrive newest-first across pages already, but this sorts before grouping
// rather than trusting order (same defensive stance as ProjectPage's
// groupByDay).
//
// Generic over anything carrying an `at`: the day dividers are now the outer
// chrome ABOVE day cards rather than above bare entries, and both shapes have
// to bucket by exactly the same local-day rule. One function, so the two can
// never disagree about which day something happened on.
export function groupByDay<T extends { at: string }>(items: T[], now: Date = new Date()): DayGroup<T>[] {
  const sorted = [...items].sort((a, b) => b.at.localeCompare(a.at))
  const groups: DayGroup<T>[] = []
  for (const item of sorted) {
    const day = dayLabel(item.at, now)
    const current = groups[groups.length - 1]
    if (current && current.day === day) current.entries.push(item)
    else groups.push({ day, entries: [item] })
  }
  return groups
}

// The `before` boundary on /api/feed is INCLUSIVE (server.js:692), so the
// last entry of one page is always the first entry of the next -- dedupe by
// id when flattening pages rather than rendering (and double-keying) that
// one-entry overlap.
function dedupeById(entries: FeedEntry[]): FeedEntry[] {
  const seen = new Set<string>()
  const out: FeedEntry[] = []
  for (const e of entries) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  return out
}

/** The Feed screen: every session across every project the viewer can see,
 *  newest first, yours and teammates' interleaved -- the old dashboard's
 *  Activity view. Filters (person/project/tool) all route through the
 *  query, and "Show more" pages backwards by the daemon's own cursor, so
 *  filtering and paging always agree with each other. */
export function FeedPage() {
  const statusQuery = useStatus()
  const solo = statusQuery.data?.solo ?? true

  // Arriving from a Today card: `?session=<id>` names the row you were sent
  // to. Read defensively -- a malformed query string must degrade to "no
  // target" rather than throw into this render path.
  const search = useSearch()
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

  const projectsQuery = useProjects()
  const membersQuery = useMembers(!solo)
  const feedQuery = useFeed({ author: author || null, project: project || null, source: source || null })

  // dedupeById first (the /api/feed page-boundary overlap noted above), then
  // collapseSessionCheckpoints -- the daemon's Stop hook re-summarizes a
  // session every few edits, so several of these deduped rows can still be
  // the SAME session's successive checkpoints; only the newest one should
  // read as "this session's current state".
  const entries = useMemo(
    () => collapseSessionCheckpoints(dedupeById(feedQuery.data?.pages.flatMap(p => p.entries) ?? [])),
    [feedQuery.data],
  )
  // Entries -> day cards -> day dividers. The cards are the top level of the
  // feed now: one per person per project per local day, so a teammate's
  // afternoon is one line with a count instead of eight near-identical rows.
  // The dividers stay the outer chrome, and both layers key on the SAME local
  // day (dayCardKey and dayLabel both go through localTime), so a card can
  // never land under a heading for a different day.
  const dayCards = useMemo(() => buildDayCards(entries), [entries])
  const dayGroups = groupByDay(dayCards)
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
        <p className="feed-error" role="alert">Couldn't reach the daemon. {errorMessage(feedQuery.error)}</p>
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
        <div key={group.day}>
          <div className="feed-day">{group.day}</div>
          {group.entries.map(card => (
            <DayCard
              key={card.key}
              card={card}
              showAvatar={!solo}
              targetSession={targetSession}
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
          onClick={() => feedQuery.fetchNextPage()}
          disabled={feedQuery.isFetchingNextPage}
        >
          {feedQuery.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </button>
      )}
    </div>
  )
}
