import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { Avatar } from '../../components/Avatar'
import { parseSearchState, searchHref, sessionHref, useRawSearch, type SearchState } from '../../app/routes'
import { relativeAgo } from '../../data/relativeTime'
import { useMembers, useProjects, useSearch, useStatus, useTeamAccount } from '../../data/queries'
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

/** One result. The outcome leads and the attribution follows it, rather than
 *  the other way round: the reader is scanning for the ANSWER, and having to
 *  read past a name and a timestamp to reach it on every row is what made a
 *  page of results feel like a page of metadata. Everything identifying the
 *  row -- who, which tool, which project, when, and which fields matched --
 *  collapses into one quiet footer line instead of stacking three. */
function ResultRow({ result, query, showAvatar, from }: { result: SearchResult; query: string; showAvatar: boolean; from: string }) {
  const raw = snippetAround(snippetSource(result), query)
  const parts = isEcho(raw, result.outcome) ? [] : raw
  const labels = matchLabels(result.matched)
  const body = (
    <>
      {result.outcome && <div className="search-result-outcome">{result.outcome}</div>}
      {parts.length > 0 && (
        <p className="search-result-snippet">
          {parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
        </p>
      )}
      <div className="search-result-foot">
        {showAvatar && <Avatar id={result.authorId} name={result.author} size={16} />}
        <span className="search-result-author">{result.author}</span>
        <span className="search-result-meta">
          {result.tool} · <span className="mono">{result.project}</span> · {relativeAgo(result.at)}
        </span>
        {labels.length > 0 && (
          <span className="search-result-matched">
            {labels.map(l => <span key={l} className="search-chip">{l}</span>)}
          </span>
        )}
      </div>
    </>
  )
  // Same rule as the feed's rows: a result with a session is a real link (so
  // cmd-click and middle-click open a window); one without has nowhere to go.
  // `from` is this page's own URL, filters and all, so the session's back link
  // returns to the search that found the row rather than dumping the reader
  // in the Feed.
  return result.session
    ? <Link href={sessionHref(result.session, from)} className="search-result search-result-link">{body}</Link>
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
  const accountQuery = useTeamAccount()
  const selfId = accountQuery.data?.user?.userId ?? null

  // The URL is the state. Component state could not make a search shareable,
  // could not survive a reload, and left Back/Forward doing nothing on a
  // screen whose whole job is finding one row again.
  //
  // Read defensively, exactly like FeedPage's ?session=: a malformed query
  // string must degrade to "no query, no filters" and never throw into this
  // render path.
  const searchString = useRawSearch()
  const [, navigate] = useLocation()
  const { q: query, author, project, source, hideMine } = useMemo(
    () => parseSearchState(searchString),
    [searchString],
  )

  // What is in the box right now, which leads the URL by one debounce so the
  // input stays responsive per keystroke while the address bar (and the
  // request) only move once typing settles.
  const [typed, setTyped] = useState(query)
  // The last q THIS component put in the URL. Without it, an externally
  // driven change (Back/Forward, a pasted link) is indistinguishable from a
  // stale local value, and the two write over each other forever.
  const lastWrittenQuery = useRef(query)

  // Replace, never push, for a filter-preserving URL update: a filter change
  // is a deliberate act worth a history entry, a keystroke is not, and pushing
  // per debounce buries the page the reader actually wants to go Back to under
  // twenty near-identical entries.
  function applyState(next: Partial<SearchState>, replace = false) {
    navigate(searchHref({ q: query, author, project, source, hideMine, ...next }), { replace })
  }

  // The URL moved under us (Back/Forward, or a link opened into this screen):
  // adopt it into the box rather than letting the debounce below push our own
  // stale value straight back over it.
  useEffect(() => {
    if (query === lastWrittenQuery.current) return
    lastWrittenQuery.current = query
    setTyped(query)
  }, [query])

  // Debounce the typed value into the URL, which is what the query hook reads.
  const href = searchHref({ q: typed, author, project, source, hideMine })
  useEffect(() => {
    if (typed === lastWrittenQuery.current) return
    const id = setTimeout(() => {
      lastWrittenQuery.current = typed
      navigate(href, { replace: true })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [typed, href, navigate])

  const projectsQuery = useProjects()
  const membersQuery = useMembers(!solo)

  // "Hide mine" is only offerable to someone the corpus can tell apart from
  // their teammates: it needs a signed-in identity to negate, and on a solo
  // machine every row is yours, so the control would empty the page.
  const canHideMine = !solo && !!selfId

  // Sent as a negated person filter ('!<user id>'), which lib/activity.js
  // applies BEFORE ranking and before the page limit. Dropping self rows from
  // the returned page here in the browser would instead carve holes out of a
  // top-25 that is mostly your own work, and leave the match count describing
  // a list the reader cannot see. Picking a specific person supersedes it --
  // the two are the same field, and an explicit choice is the stronger signal.
  const effectiveAuthor = author || (canHideMine && hideMine ? `!${selfId}` : '')

  const filters = useMemo(
    () => ({ author: effectiveAuthor || null, project: project || null, source: source || null }),
    [effectiveAuthor, project, source],
  )
  const searchQuery = useSearch(query, filters)

  const projects = projectsQuery.data ?? []
  const members = membersQuery.data ?? []
  const tools = statusQuery.data?.tools ?? []
  const results = searchQuery.data?.results ?? []
  const total = searchQuery.data?.total ?? 0
  const asked = query.trim().length > 0
  const anyFilter = !!(author || project || source || hideMine)

  function clearFilters() {
    applyState({ author: '', project: '', source: '', hideMine: false })
  }

  // This page's own URL, handed to every result row so the session it opens
  // can offer a back link to the search that found it (routes.ts backLink).
  // Built from the state the page is ACTUALLY rendering, not from
  // window.location, so it can never describe a debounce-old query.
  const selfHref = searchHref({ q: query, author, project, source, hideMine })

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
          <select aria-label="Filter by person" value={author} onChange={e => applyState({ author: e.target.value })}>
            <option value="">Everyone</option>
            {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
        <select aria-label="Filter by project" value={project} onChange={e => applyState({ project: e.target.value })}>
          <option value="">All projects</option>
          {projects.map(p => <option key={p.path} value={p.path}>{p.name}</option>)}
        </select>
        <select aria-label="Filter by tool" value={source} onChange={e => applyState({ source: e.target.value })}>
          <option value="">All tools</option>
          {tools.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        {canHideMine && (
          <button
            type="button"
            className="search-toggle"
            aria-pressed={hideMine && !author}
            disabled={!!author}
            title={author ? 'Already filtered to one person' : 'Show only what your teammates did'}
            onClick={() => applyState({ hideMine: !hideMine })}
          >
            Hide mine
          </button>
        )}
        {anyFilter && (
          <button type="button" className="search-clear" onClick={clearFilters}>Clear</button>
        )}
      </div>

      {/* Resting state: never "no results" for a search nobody ran.
          T-78: the reference copy claimed "your teammates', and the archive
          going back further than the feed does" on every install -- but a
          solo user has neither teammates NOR a team archive, and reading that
          line as a promise about what search sees would send them looking for
          rows that structurally cannot exist. `solo` here is the SAME flag
          the filter row and Hide-mine below already gate on -- there is
          nothing to filter by person on a solo machine either. */}
      {!asked && (
        <p className="search-resting">
          {solo
            ? 'Ranked across every project on this machine — your own sessions across every tool that captures here.'
            : 'Ranked across every project on this machine — your sessions, your teammates\', and the archive going back further than the feed does.'}
        </p>
      )}

      {asked && searchQuery.isError && (
        <p className="search-error" role="alert">Couldn't search. {errorMessage(searchQuery.error)}</p>
      )}

      {/* A query in flight said NOTHING before: the count line is gated on
          !isPending and the rows have not arrived, so the whole area below the
          filters was blank. Blank is the same thing an answered-with-nothing
          search looks like, so the reader could not tell "still working" from
          "found nothing". */}
      {asked && !searchQuery.isError && searchQuery.isPending && (
        <p className="search-count" role="status">Searching…</p>
      )}

      {asked && !searchQuery.isError && !searchQuery.isPending && total > 0 && (
        <p className="search-count">
          {`${total} ${total === 1 ? 'match' : 'matches'}`}
          {total > results.length && ` · showing the top ${results.length}`}
          {hideMine && !author && ' · yours hidden'}
        </p>
      )}

      {/* Zero results used to be one dim 10.5px line reading "No matches."
          above an otherwise empty full-height pane -- which is what the screen
          "going black" actually was. It is a real state and gets a real
          treatment: what was searched, why nothing came back, and the way out.
          The filter case is called out separately because it is the recoverable
          one, and because a filter is by far the likeliest reason a machine
          with thousands of sessions returns nothing. */}
      {asked && !searchQuery.isError && !searchQuery.isPending && total === 0 && (
        <div className="search-empty">
          <p className="search-empty-title">No matches for "{query}".</p>
          {anyFilter ? (
            <>
              <p className="search-empty-hint">
                Filters are narrowing this search. Clearing them searches every project on this machine.
              </p>
              <button type="button" className="search-clear search-empty-clear" onClick={clearFilters}>
                Clear filters
              </button>
            </>
          ) : (
            <p className="search-empty-hint">
              Try fewer words, or a word you would expect in the summary rather than the code.
            </p>
          )}
        </div>
      )}

      {results.map(r => (
        <ResultRow key={r.id} result={r} query={query} showAvatar={!solo} from={selfHref} />
      ))}
    </div>
  )
}
