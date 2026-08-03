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
  team: '/team', members: '/team/members', insights: '/team/insights', settings: '/settings',
} as const

/** Concrete href for one session -- the ONLY place the session path pattern
 *  is turned into a link target, so no caller ever re-types the literal.
 *  `:sessionId` is encodeURIComponent'd, same convention as the project
 *  route's encoded path slug. */
export function sessionHref(sessionId: string): string {
  return ROUTES.session.replace(':sessionId', encodeURIComponent(sessionId))
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
