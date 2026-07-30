import { useMemo, useState } from 'react'
import { EntryRow } from '../../components/EntryRow'
import { useFeed, useMembers, useProjects, useStatus } from '../../data/queries'
import type { FeedEntry } from '../../data/types'
import './feed.css'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

// UTC fields, never local -- the daemon's timestamps are UTC, and a
// local-time render could sort an entry into the wrong calendar day
// depending on where the app runs (same reasoning as ProjectPage's
// dayLabel and TodayPage's todayDateLabel). Uppercase per spec's exact
// example: "TODAY · TUE JUL 29".
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const isToday = d.getUTCFullYear() === now.getUTCFullYear()
    && d.getUTCMonth() === now.getUTCMonth() && d.getUTCDate() === now.getUTCDate()
  const weekday = `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`.toUpperCase()
  return isToday ? `TODAY · ${weekday}` : weekday
}

interface DayGroup {
  day: string
  entries: FeedEntry[]
}

// Newest first, then bucketed into consecutive same-day runs -- entries
// arrive newest-first across pages already, but this sorts before grouping
// rather than trusting order (same defensive stance as ProjectPage's
// groupByDay).
export function groupByDay(entries: FeedEntry[], now: Date = new Date()): DayGroup[] {
  const sorted = [...entries].sort((a, b) => b.at.localeCompare(a.at))
  const groups: DayGroup[] = []
  for (const entry of sorted) {
    const day = dayLabel(entry.at, now)
    const current = groups[groups.length - 1]
    if (current && current.day === day) current.entries.push(entry)
    else groups.push({ day, entries: [entry] })
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

  const [author, setAuthor] = useState('')
  const [project, setProject] = useState('')
  const [source, setSource] = useState('')

  const projectsQuery = useProjects()
  const membersQuery = useMembers(!solo)
  const feedQuery = useFeed({ author: author || null, project: project || null, source: source || null })

  const entries = useMemo(
    () => dedupeById(feedQuery.data?.pages.flatMap(p => p.entries) ?? []),
    [feedQuery.data],
  )
  const dayGroups = groupByDay(entries)
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
          {group.entries.map(entry => (
            <EntryRow key={entry.id} entry={entry} project={entry.project} showAvatar={!solo} />
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
