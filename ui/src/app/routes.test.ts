// routes.ts is the single place a route path becomes a link target. These
// tests pin the three href builders the nav work added (searchHref,
// sessionHref's `from`, projectHref) plus the two readers that parse them
// back, because every one of them is depended on by a caller that must not
// re-type a route literal to do its job.
import { describe, expect, it } from 'vitest'
import {
  ROUTES, backLink, dayHref, daySessionHref, feedSessionHref, parseDayFilters, parseSearchState, projectHref,
  searchHref, sessionHref,
} from './routes'

describe('searchHref (Task 1)', () => {
  it('is the bare search route when nothing is set -- never a trailing "?"', () => {
    expect(searchHref()).toBe(ROUTES.search)
    expect(searchHref({ q: '', author: '', project: '', source: '', hideMine: false })).toBe(ROUTES.search)
  })

  it('carries the query, so a search is a shareable URL', () => {
    expect(searchHref({ q: 'auth rotation' })).toBe(`${ROUTES.search}?q=auth+rotation`)
  })

  it('carries every filter, and round-trips through parseSearchState', () => {
    const state = { q: 'ports', author: 'u-1', project: '/x/api', source: 'Claude Code', hideMine: true }
    const href = searchHref(state)
    expect(parseSearchState(href.slice(href.indexOf('?')))).toEqual(state)
  })

  it('encodes a project path so a slash in it cannot invent a path segment', () => {
    const href = searchHref({ project: '/x/server/api' })
    expect(href.startsWith(`${ROUTES.search}?`)).toBe(true)
    expect(href).not.toContain('/x/server/api')
  })
})

describe('parseSearchState (Task 1)', () => {
  it('an empty query string is "no query, no filters"', () => {
    expect(parseSearchState('')).toEqual({ q: '', author: '', project: '', source: '', hideMine: false })
  })

  it('degrades a malformed query string to no filters instead of throwing', () => {
    // The render path calls this on every location change. A hand-edited or
    // truncated URL ("?q=%E0%A4%A", a bare "%") must produce a page, not a
    // crash -- same defensive contract FeedPage's ?session= read already has.
    for (const raw of ['%', '?%', '?q=%E0%A4%A', '?&&&=', '?%zz=%zz']) {
      expect(() => parseSearchState(raw)).not.toThrow()
      expect(parseSearchState(raw).hideMine).toBe(false)
    }
  })

  it('reads a leading "?" and a bare query string identically', () => {
    expect(parseSearchState('?q=ports')).toEqual(parseSearchState('q=ports'))
  })
})

describe('sessionHref + backLink (Task 2)', () => {
  it('with no origin is exactly the old bare session path', () => {
    expect(sessionHref('s-1')).toBe('/sessions/s-1')
    expect(sessionHref('a/b')).toBe('/sessions/a%2Fb')
  })

  it('carries where the reader came from as a param', () => {
    expect(sessionHref('s-1', ROUTES.feed)).toBe('/sessions/s-1?from=%2Ffeed')
  })

  it('an absent origin falls back to the Feed', () => {
    expect(backLink(null)).toEqual({ href: ROUTES.feed, label: 'Back to the Feed' })
    expect(backLink(undefined)).toEqual({ href: ROUTES.feed, label: 'Back to the Feed' })
    expect(backLink('')).toEqual({ href: ROUTES.feed, label: 'Back to the Feed' })
  })

  it('labels and targets each origin honestly', () => {
    expect(backLink(ROUTES.feed)).toEqual({ href: ROUTES.feed, label: 'Back to the Feed' })
    expect(backLink(ROUTES.projects)).toEqual({ href: ROUTES.projects, label: 'Back to Projects' })
    expect(backLink(ROUTES.today)).toEqual({ href: ROUTES.today, label: 'Back to Today' })
    expect(backLink(projectHref('/x/api'))).toEqual({ href: projectHref('/x/api'), label: 'Back to the project' })
    // The day view is where a session is opened from now that the feed no
    // longer expands. Without this case its `from` fell through to the Feed.
    expect(backLink(dayHref('abc'))).toEqual({ href: dayHref('abc'), label: 'Back to the day' })
  })

  it('preserves a Search origin whole, filters and all', () => {
    const from = searchHref({ q: 'ports', project: '/x/api' })
    expect(backLink(from)).toEqual({ href: from, label: 'Back to Search' })
  })

  it('refuses an off-site origin: a shared URL must not turn the back link into an exit', () => {
    // A `from` value arrives from the URL bar, so it is attacker-supplied on
    // any link someone pastes into chat. '//evil.example' and an absolute URL
    // are both navigable <a href> targets, and a backslash is normalised to
    // '/' by browsers -- all three would leave the app wearing "Back to the
    // Feed" as their label.
    for (const hostile of ['//evil.example', 'https://evil.example', 'javascript:alert(1)', '/\\evil.example', 'feed']) {
      expect(backLink(hostile)).toEqual({ href: ROUTES.feed, label: 'Back to the Feed' })
    }
  })

  it('an internal path this app has no label for still goes somewhere real', () => {
    expect(backLink('/nowhere')).toEqual({ href: ROUTES.feed, label: 'Back to the Feed' })
  })
})

describe('projectHref (Task 3)', () => {
  it('is the project route with an encoded path slug', () => {
    expect(projectHref('/x/server/api')).toBe(`/projects/${encodeURIComponent('/x/server/api')}`)
  })

  it('encodes the characters that broke a raw name outright', () => {
    expect(projectHref('api#2')).toBe('/projects/api%232')
    expect(projectHref('a?b')).toBe('/projects/a%3Fb')
  })

  it('is what ROUTES.project resolves to, so no caller re-types the literal', () => {
    expect(projectHref('p')).toBe(ROUTES.project.replace(':slug', 'p'))
  })
})

describe('the existing builders are untouched', () => {
  it('feedSessionHref still points at the feed with a ?session= target', () => {
    expect(feedSessionHref('s-1')).toBe('/feed?session=s-1')
  })
})

// The day route. The slug itself is minted by features/feed/dayCards (and
// tested there); what belongs here is the path pattern and, above all, the
// filters -- useFeed keys its cache on them, so a day URL that drops them
// opens a different query from the feed the card was built in.
describe('dayHref + parseDayFilters', () => {
  it('is the day route with the slug the card minted, untouched', () => {
    expect(dayHref('abc')).toBe('/days/abc')
    expect(dayHref('abc')).toBe(ROUTES.day.replace(':daySlug', 'abc'))
  })

  it('carries the feed\'s filters, and reads them back to the same values', () => {
    const filters = { author: 'marco', project: '/x/api', source: 'Codex' }
    const href = dayHref('abc', null, filters)
    expect(parseDayFilters(href.slice(href.indexOf('?')))).toEqual(filters)
  })

  it('omits an unset filter entirely, so an unfiltered day is a clean URL', () => {
    expect(dayHref('abc', null, { author: null, project: null, source: null })).toBe('/days/abc')
    expect(dayHref('abc')).toBe('/days/abc')
  })

  it('reads an unfiltered URL back as the same nulls FeedPage passes useFeed', () => {
    // Same value, so the two produce the SAME react-query key and arriving
    // from the feed is a cache hit rather than a cold start.
    expect(parseDayFilters('')).toEqual({ author: null, project: null, source: null })
    expect(parseDayFilters('?tool=')).toEqual({ author: null, project: null, source: null })
  })

  it('never throws on a hand-edited query string, whatever is in it', () => {
    // This runs inside a render path on every location change, so the one
    // thing it may not do is take the screen down. A truncated percent triple
    // is decoded to U+FFFD rather than rejected, which is fine -- it is a
    // filter that matches nothing, not an exception.
    for (const bad of ['?author=%E0%A4%A', '?%', '?a=b=c&&&', '?tool=%ZZ']) {
      expect(() => parseDayFilters(bad)).not.toThrow()
      expect(Object.keys(parseDayFilters(bad)).sort()).toEqual(['author', 'project', 'source'])
    }
  })

  it('carries a `from` alongside the filters, same convention as sessionHref', () => {
    const href = dayHref('abc', ROUTES.feed, { author: 'marco', project: null, source: null })
    const params = new URLSearchParams(href.slice(href.indexOf('?')))
    expect(params.get('from')).toBe(ROUTES.feed)
    expect(params.get('author')).toBe('marco')
  })

  it('daySessionHref targets a session inside the day, with the same filters', () => {
    const filters = { author: 'marco', project: null, source: null }
    const href = daySessionHref('abc', 's-1', filters)
    expect(href.startsWith('/days/abc?')).toBe(true)
    const params = new URLSearchParams(href.slice(href.indexOf('?')))
    expect(params.get('session')).toBe('s-1')
    expect(params.get('author')).toBe('marco')
    // And it agrees with the untargeted builder about the query it will run.
    expect(parseDayFilters(href.slice(href.indexOf('?')))).toEqual(filters)
  })
})
