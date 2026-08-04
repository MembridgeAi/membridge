// routes.ts is the single place a route path becomes a link target. These
// tests pin the three href builders the nav work added (searchHref,
// sessionHref's `from`, projectHref) plus the two readers that parse them
// back, because every one of them is depended on by a caller that must not
// re-type a route literal to do its job.
import { describe, expect, it } from 'vitest'
import {
  ROUTES, backLink, feedSessionHref, parseSearchState, projectHref, searchHref, sessionHref,
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
