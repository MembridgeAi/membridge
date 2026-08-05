import { useSearch as useWouterSearch } from 'wouter'
import type { FeedFilters } from '../data/types'

/** Single source of route paths. No route path string may be written twice
 *  in the codebase — import ROUTES instead of re-typing a literal.
 *
 *  `:slug` on the project route is the encodeURIComponent'd project PATH
 *  (the unique key -- basenames collide across checkouts), with a bare
 *  project name still accepted for old deep links; ProjectPage owns the
 *  decode + lookup. */
export const ROUTES = {
  today: '/', feed: '/feed', search: '/search', projects: '/projects', project: '/projects/:slug',
  session: '/sessions/:sessionId',
  days: '/days', day: '/days/:daySlug',
  team: '/team', members: '/team/members', insights: '/team/insights', settings: '/settings',
} as const

/** The current query string, UNDECODED, re-rendering whenever it changes.
 *
 *  wouter's own useSearch() cannot be used to read a param value, because it
 *  runs the whole query string through legacy `unescape()` before handing it
 *  over (wouter/src/paths.js sanitizeSearch). URLSearchParams then decodes a
 *  second time, and two decodes are not one:
 *
 *    ?from=%2Fprojects%2F%252FUsers%252Fx  ->  '/projects//Users/x'
 *
 *  which is a different project path, and
 *
 *    ?session=a%26b  ->  'a' plus a stray 'b' param
 *
 *  which is a value silently truncated at an ampersand it was encoded
 *  precisely to survive. Every param this app carries (project paths, session
 *  ids, a whole search URL) can contain those characters.
 *
 *  wouter's hook is still called, for its subscription: it is what re-renders
 *  the component when the query string changes. Only its RETURN value is
 *  discarded, in favour of the raw string the browser actually holds. */
export function useRawSearch(): string {
  const subscribed = useWouterSearch()
  return typeof window === 'undefined' ? subscribed : window.location.search
}

/** Concrete href for one project. Same single-source rule as sessionHref:
 *  ProjectsPage used to build this inline as `${ROUTES.projects}/${...}`,
 *  which is the project path pattern written a second time -- the exact thing
 *  the header rule above forbids, and the reason a route change could land in
 *  routes.ts and still leave one caller pointing at the old shape.
 *
 *  Takes the project PATH for anything that has one (paths are the unique
 *  key; basenames collide across checkouts). A bare NAME is also accepted,
 *  for the one caller that genuinely has no path: Insights groups by
 *  project_id and emits only `projectName` (lib/api-insights.js), and
 *  ProjectPage's name-match fallback resolves it. */
export function projectHref(pathOrName: string): string {
  return ROUTES.project.replace(':slug', encodeURIComponent(pathOrName))
}

/** Where the reader was before they opened a session, carried on the session
 *  URL so the page can name it. See backLink() below for why this is a param
 *  and not history.back(). */
export const FROM_PARAM = 'from'

/** Concrete href for one session -- the ONLY place the session path pattern
 *  is turned into a link target, so no caller ever re-types the literal.
 *  `:sessionId` is encodeURIComponent'd, same convention as the project
 *  route's encoded path slug.
 *
 *  `from` is the caller's own location (path plus query), so the back link on
 *  the session page can be honest about where it goes. Omitted, the URL is
 *  byte-for-byte the bare session path it always was. */
export function sessionHref(sessionId: string, from?: string | null): string {
  const href = ROUTES.session.replace(':sessionId', encodeURIComponent(sessionId))
  return from ? `${href}?${FROM_PARAM}=${encodeURIComponent(from)}` : href
}

/** The feed's active filters, carried on a day URL. Same names the Search
 *  screen uses for the same three things ('tool' rather than 'source' because
 *  that is what the control is labelled), written once and read back through
 *  this constant on both sides. */
export const DAY_FILTER_PARAMS = { author: 'author', project: 'project', source: 'tool' } as const

function withDayFilters(params: URLSearchParams, filters?: FeedFilters | null): URLSearchParams {
  if (filters?.author) params.set(DAY_FILTER_PARAMS.author, filters.author)
  if (filters?.project) params.set(DAY_FILTER_PARAMS.project, filters.project)
  if (filters?.source) params.set(DAY_FILTER_PARAMS.source, filters.source)
  return params
}

function dayUrl(slug: string, params: URLSearchParams): string {
  const href = ROUTES.day.replace(':daySlug', slug)
  const qs = params.toString()
  return qs ? `${href}?${qs}` : href
}

/** Concrete href for one day view: one person's work across every project on
 *  one local calendar day, which the Feed now shows only the face of.
 *
 *  `slug` is the day card's own key, already made URL-safe by
 *  features/feed/dayCards.ts daySlug -- that module owns the key's format, so
 *  it owns the encoding of it, and this file owns the path pattern. DayPage
 *  matches the slug against the one it rebuilds from each card, so the two only
 *  have to agree, never round-trip.
 *
 *  NOT built from a card's project, ever. A card spans every project its
 *  person touched that day, so scoping the URL to one of them would open a day
 *  view narrower than the card that linked to it while the card still claimed
 *  the whole day.
 *
 *  `filters` is the feed's own filter state at the moment the card was
 *  clicked, and carrying it is load-bearing rather than cosmetic. useFeed keys
 *  its cache on the filters (data/queries.ts), so a day view that asked for the
 *  UNFILTERED feed while the reader had filtered by a person would be a
 *  different query key: a cold start, one page of unfiltered rows, and the card
 *  the reader had just clicked frequently not in it -- a visible card answering
 *  "That day is not in view". With the filters on the URL the day view runs the
 *  same query the card was built from, so arriving from the feed is a cache hit
 *  and the card is guaranteed to be there.
 *
 *  `from` follows sessionHref's convention exactly, so a session opened out of
 *  a day view can offer an honest back link to that day. */
export function dayHref(slug: string, from?: string | null, filters?: FeedFilters | null): string {
  const params = new URLSearchParams()
  if (from) params.set(FROM_PARAM, from)
  return dayUrl(slug, withDayFilters(params, filters))
}

/** Read a day URL's filters back. Defensive by contract, exactly as
 *  parseSearchState is: this runs on every location change inside a render
 *  path, and a hand-edited query string must degrade to "no filters" rather
 *  than throw the screen away. Empty means null, matching what FeedPage passes
 *  useFeed for an untouched control, so the two produce the same query key. */
export function parseDayFilters(search: string): FeedFilters {
  try {
    const params = new URLSearchParams(search)
    return {
      author: params.get(DAY_FILTER_PARAMS.author) || null,
      project: params.get(DAY_FILTER_PARAMS.project) || null,
      source: params.get(DAY_FILTER_PARAMS.source) || null,
    }
  } catch {
    return { author: null, project: null, source: null }
  }
}

/** A back link's target and its label, as one value: the two must agree, and
 *  computing them apart is how "Back to the Feed" ends up pointing at a
 *  project. */
export interface BackLink {
  href: string
  label: string
}

const FEED_BACK: BackLink = { href: ROUTES.feed, label: 'Back to the Feed' }

/** Only a path INTO this app may become a link target. `from` arrives from
 *  the address bar, so on any URL someone pastes into a chat it is
 *  attacker-supplied text: '//evil.example' and 'https://evil.example' are
 *  both perfectly valid <a href> targets that leave the app, and a browser
 *  normalises a backslash to '/', so '/\evil.example' leaves too. Every one
 *  of them would have sailed out of MemBridge wearing the word "Back". */
function internalPath(from: string | null | undefined): string | null {
  if (typeof from !== 'string' || from === '') return null
  if (from[0] !== '/' || from[1] === '/' || from[1] === '\\') return null
  if (from.includes('\\')) return null
  return from
}

/** Resolve a `from` param into the back link the session page renders.
 *
 *  WHY A PARAM AND NOT history.back(). A session URL reaches this app from
 *  outside it -- an MCP tool hands one to an agent, a teammate pastes one
 *  into chat -- and in a fresh tab that URL is the FIRST history entry, so
 *  back() has nothing to go to and the reader is stranded. Even where the
 *  entry exists, back() can only move; it cannot tell you what it is moving
 *  to, so there is nothing to write an honest label from and the link falls
 *  back to claiming "the Feed" whatever it does. The param carries the origin
 *  itself, which makes both the target and the words describing it derivable
 *  in one place -- routes.ts, which is where this file's own header rule says
 *  hrefs are built.
 *
 *  Anything unreadable, off-site, or simply unlabelled degrades to the Feed:
 *  a slightly wrong destination beats a dead link or a lie. */
export function backLink(from: string | null | undefined): BackLink {
  const href = internalPath(from)
  if (!href) return FEED_BACK
  // Compare on the path alone: a Search origin carries its whole query
  // string, and that is deliberately preserved in `href` so going back
  // restores the filters the reader had.
  const path = href.split('?')[0]
  if (path === ROUTES.search) return { href, label: 'Back to Search' }
  if (path === ROUTES.projects) return { href, label: 'Back to Projects' }
  if (path.startsWith(`${ROUTES.projects}/`)) return { href, label: 'Back to the project' }
  // The day view is where a session is opened from now that the feed no longer
  // expands. Without this case its own `from` fell through to the Feed, which
  // dropped the reader a screen further out than they came from and told them
  // it was going back.
  if (path.startsWith(`${ROUTES.days}/`)) return { href, label: 'Back to the day' }
  if (path === ROUTES.today) return { href, label: 'Back to Today' }
  if (path === ROUTES.feed) return { href, label: FEED_BACK.label }
  return FEED_BACK
}

/** The Search screen's whole readable state. It lives in the URL rather than
 *  in component state so a search is shareable, survives a reload, and moves
 *  with the browser's own Back/Forward -- none of which a useState could do. */
export interface SearchState {
  q: string
  author: string
  project: string
  source: string
  hideMine: boolean
}

/** Param names, written once and read back through the same constant on both
 *  sides (same rule FEED_SESSION_PARAM follows). 'tool' rather than 'source'
 *  because that is the word the control is labelled with. */
export const SEARCH_PARAMS = {
  q: 'q', author: 'author', project: 'project', source: 'tool', hideMine: 'mine',
} as const

export const EMPTY_SEARCH: SearchState = {
  q: '', author: '', project: '', source: '', hideMine: false,
}

/** The search screen at a given query and set of filters. Empty values are
 *  omitted entirely, so an untouched Search page is a clean `/search` rather
 *  than a URL full of `&author=&project=`. */
export function searchHref(state: Partial<SearchState> = {}): string {
  const params = new URLSearchParams()
  if (state.q) params.set(SEARCH_PARAMS.q, state.q)
  if (state.author) params.set(SEARCH_PARAMS.author, state.author)
  if (state.project) params.set(SEARCH_PARAMS.project, state.project)
  if (state.source) params.set(SEARCH_PARAMS.source, state.source)
  if (state.hideMine) params.set(SEARCH_PARAMS.hideMine, '1')
  const qs = params.toString()
  return qs ? `${ROUTES.search}?${qs}` : ROUTES.search
}

/** Read a search URL back. Defensive by contract, the same shape FeedPage's
 *  ?session= read already uses: this runs on every location change inside a
 *  render path, and a hand-edited or truncated query string ("?q=%E0%A4%A")
 *  must degrade to "no query, no filters" rather than throw the screen away. */
export function parseSearchState(search: string): SearchState {
  try {
    const params = new URLSearchParams(search)
    return {
      q: params.get(SEARCH_PARAMS.q) ?? '',
      author: params.get(SEARCH_PARAMS.author) ?? '',
      project: params.get(SEARCH_PARAMS.project) ?? '',
      source: params.get(SEARCH_PARAMS.source) ?? '',
      hideMine: params.get(SEARCH_PARAMS.hideMine) === '1',
    }
  } catch {
    return { ...EMPTY_SEARCH }
  }
}

/** The feed, scrolled to one session. Same single-source rule as
 *  sessionHref: FeedPage reads this param back with the same name, so the
 *  literal 'session' is written once on each side and nowhere else.
 *
 *  The feed is PAGED, so the target may not be on the loaded pages. That is
 *  a plain miss, not an error: the feed renders as normal and nothing is
 *  marked. */
export const FEED_SESSION_PARAM = 'session'

export function feedSessionHref(sessionId: string): string {
  return `${ROUTES.feed}?${FEED_SESSION_PARAM}=${encodeURIComponent(sessionId)}`
}

/** One day view, scrolled to one session inside it. The same param name as
 *  the feed's, deliberately: a `?session=` deep link (every Today card is one)
 *  still arrives at the Feed, which hands it on to the day holding that
 *  session, and the day view reads it back through this same constant. Three
 *  readers, one literal.
 *
 *  Carries the feed's filters for the same reason dayHref does, and through
 *  the same builder, so the targeted and untargeted links can never disagree
 *  about which query the day view is going to run. */
export function daySessionHref(slug: string, sessionId: string, filters?: FeedFilters | null): string {
  const params = new URLSearchParams()
  params.set(FEED_SESSION_PARAM, sessionId)
  return dayUrl(slug, withDayFilters(params, filters))
}
