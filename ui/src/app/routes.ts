/** Single source of route paths. No route path string may be written twice
 *  in the codebase — import ROUTES instead of re-typing a literal. */
export const ROUTES = {
  today: '/', feed: '/feed', projects: '/projects', project: '/projects/:name',
  members: '/team/members', insights: '/team/insights', settings: '/settings',
} as const
