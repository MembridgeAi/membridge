import { useEffect, useMemo, useState } from 'react'
import { Link } from 'wouter'
import { Avatar } from '../../components/Avatar'
import { sessionHref } from '../../app/routes'
import { relativeAgo } from '../../data/relativeTime'
import { useMembers, useProjects, useSearch, useStatus } from '../../data/queries'
import type { SearchResult } from '../../data/types'
import { matchLabels, snippetAround } from './snippet'
import './search.css'

/** Typing delay before a query is sent. Long enough that typing a word does
 *  not fire a request per keystroke, short enough to feel like the results
 *  follow the keyboard. */
export const SEARCH_DEBOUNCE_MS = 250

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

/** The text a result's snippet is drawn from: prefer the field the query
 *  actually hit, so a row that matched on a decision shows that decision
 *  rather than a summary the query never appears in. */
function snippetSource(r: SearchResult): string | null {
  const matched = new Set(r.matched)
  if (matched.has('decisions') && r.decisions) return r.decisions
  if (matched.has('gotchas') && r.gotchas) return r.gotchas
  if (matched.has('ask') && r.intent) return r.intent
  return r.summaryFull || r.outcome || r.decisions || r.gotchas || null
}

/** True when the snippet would only repeat the outcome line above it -- a
 *  short session's summary IS its outcome, so rendering both spends a line
 *  saying the same thing twice. */
function isEcho(parts: { text: string }[], outcome: string): boolean {
  const snippet = parts.map(p => p.text).join('').replace(/^…|…$/g, '').trim()
  if (!snippet || !outcome) return false
  return outcome.includes(snippet) || snippet.includes(outcome.replace(/…$/, ''))
}

function ResultRow({ result, query, showAvatar }: { result: SearchResult; query: string; showAvatar: boolean }) {
  const raw = snippetAround(snippetSource(result), query)
  const parts = isEcho(raw, result.outcome) ? [] : raw
  const labels = matchLabels(result.matched)
  const body = (
    <>
      <div className="search-result-who">
        {showAvatar && <Avatar id={result.authorId} name={result.author} size={17} />}
        <span className="search-result-author">{result.author}</span>
        <span className="search-result-meta">
          {result.tool} · <span className="mono">{result.project}</span> · {relativeAgo(result.at)}
        </span>
      </div>
      {result.outcome && <div className="search-result-outcome">{result.outcome}</div>}
      {parts.length > 0 && (
        <p className="search-result-snippet">
          {parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
        </p>
      )}
      {labels.length > 0 && (
        <div className="search-result-matched">
          {labels.map(l => <span key={l} className="search-chip">{l}</span>)}
        </div>
      )}
    </>
  )
  // Same rule as the feed's rows: a result with a session is a real link (so
  // cmd-click and middle-click open a window); one without has nowhere to go.
  return result.session
    ? <Link href={sessionHref(result.session)} className="search-result search-result-link">{body}</Link>
    : <div className="search-result">{body}</div>
}

/** The Search screen: one ranked list over everything this machine holds --
 *  the viewer's own sessions, teammates' pulled rows, and the durable team
 *  archive the feed never pages back to.
 *
 *  This is the SAME corpus and scorer the MCP tools answer from
 *  (lib/activity.js), which is the point: an agent asking this machine "has
 *  anyone dealt with X" and the person sitting at it must never be told
 *  different things. */
export function SearchPage() {
  const statusQuery = useStatus()
  const solo = statusQuery.data?.solo ?? true

  const [typed, setTyped] = useState('')
  const [query, setQuery] = useState('')
  const [author, setAuthor] = useState('')
  const [project, setProject] = useState('')
  const [source, setSource] = useState('')

  // Debounce the typed value into the value the query hook actually sees.
  useEffect(() => {
    const id = setTimeout(() => setQuery(typed), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [typed])

  const projectsQuery = useProjects()
  const membersQuery = useMembers(!solo)
  const filters = useMemo(
    () => ({ author: author || null, project: project || null, source: source || null }),
    [author, project, source],
  )
  const searchQuery = useSearch(query, filters)

  const projects = projectsQuery.data ?? []
  const members = membersQuery.data ?? []
  const tools = statusQuery.data?.tools ?? []
  const results = searchQuery.data?.results ?? []
  const total = searchQuery.data?.total ?? 0
  const asked = query.trim().length > 0

  return (
    <div className="search-page">
      <div className="search-header">
        <h1 className="search-title">Search</h1>
      </div>

      <input
        type="search"
        className="search-input"
        placeholder="What has anyone here already done?"
        aria-label="Search team memory"
        value={typed}
        autoFocus
        onChange={e => setTyped(e.target.value)}
      />

      <div className="search-filters">
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

      {/* Resting state: never "no results" for a search nobody ran. */}
      {!asked && (
        <p className="search-resting">
          Ranked across every project on this machine — your sessions, your teammates', and the
          archive going back further than the feed does.
        </p>
      )}

      {asked && searchQuery.isError && (
        <p className="search-error" role="alert">Couldn't search. {errorMessage(searchQuery.error)}</p>
      )}

      {asked && !searchQuery.isError && !searchQuery.isPending && (
        <p className="search-count">
          {total === 0 ? 'No matches.' : `${total} ${total === 1 ? 'match' : 'matches'}`}
          {total > results.length && ` · showing the top ${results.length}`}
        </p>
      )}

      {results.map(r => (
        <ResultRow key={r.id} result={r} query={query} showAvatar={!solo} />
      ))}
    </div>
  )
}
