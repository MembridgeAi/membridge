/** Single source of route paths. No route path string may be written twice
 *  in the codebase — import ROUTES instead of re-typing a literal.
 *
 *  `:slug` on the project route is the encodeURIComponent'd project PATH
 *  (the unique key -- basenames collide across checkouts), with a bare
 *  project name still accepted for old deep links; ProjectPage owns the
 *  decode + lookup. */
export const ROUTES = {
  today: '/', feed: '/feed', projects: '/projects', project: '/projects/:slug',
  members: '/team/members', insights: '/team/insights', settings: '/settings',
} as const
