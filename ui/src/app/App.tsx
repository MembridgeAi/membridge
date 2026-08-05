import { lazy, Suspense } from 'react'
import { Route, Router, Switch } from 'wouter'
import { Placeholder } from '../components/Placeholder'
import { useStatus } from '../data/queries'
import { FirstRun } from '../features/settings/FirstRun'
import { RouteFallback } from './RouteFallback'
import { Shell } from './Shell'
import { ROUTES } from './routes'

// Perf (spec §7, cold-open < 700ms): each screen was previously a static
// import, so opening Today paid to download Insights/Members/Settings too --
// one 297kB chunk for all seven screens. React.lazy + route-level code
// splitting means a screen's JS loads only when its route is actually
// visited; the browser caches the chunk after that, so switching back to an
// already-visited screen never re-triggers this Suspense boundary.
// FirstRun stays a static import: it gates the ENTIRE app (below, before any
// route renders) whenever setup isn't done, so lazy-loading it would just
// move the same unavoidable wait behind an extra network round trip instead
// of removing it.
const TodayPage = lazy(() => import('../features/today/TodayPage').then(m => ({ default: m.TodayPage })))
const FeedPage = lazy(() => import('../features/feed/FeedPage').then(m => ({ default: m.FeedPage })))
const SearchPage = lazy(() => import('../features/search/SearchPage').then(m => ({ default: m.SearchPage })))
const ProjectsPage = lazy(() => import('../features/projects/ProjectsPage').then(m => ({ default: m.ProjectsPage })))
const ProjectPage = lazy(() => import('../features/project/ProjectPage').then(m => ({ default: m.ProjectPage })))
const SessionPage = lazy(() => import('../features/session/SessionPage').then(m => ({ default: m.SessionPage })))
const DayPage = lazy(() => import('../features/feed/DayPage').then(m => ({ default: m.DayPage })))
const TeamPage = lazy(() => import('../features/team/TeamPage').then(m => ({ default: m.TeamPage })))
const InsightsPage = lazy(() => import('../features/insights/InsightsPage').then(m => ({ default: m.InsightsPage })))
const SettingsPage = lazy(() => import('../features/settings/SettingsPage').then(m => ({ default: m.SettingsPage })))

/** Route table over ROUTES — every screen renders <Placeholder> until its
 *  own feature task lands. No route path literal here; all come from
 *  routes.ts, the single source of truth.
 *
 *  First-run takes over the whole app, regardless of path, while
 *  status.setupDone is false -- an explicit false is required (undefined,
 *  still loading, must not flash the takeover before status confirms it). */
/** The app is served at / in both the desktop build and tests (Vite's `base`
 *  is '/', same as jsdom's default test location), so this now normally
 *  resolves to an empty base -- but it still tracks BASE_URL rather than
 *  hardcoding '', so a future deploy-under-a-prefix needs no second change
 *  here. Trailing slash stripped: wouter wants '' / '/app', BASE_URL gives
 *  '/' / '/app/'. */
const routerBase = () => import.meta.env.BASE_URL.replace(/\/$/, '')

export function App() {
  const statusQuery = useStatus()

  if (statusQuery.data?.setupDone === false) {
    return (
      <Router base={routerBase()}>
        {/* routeReflected={false} because this branch renders FirstRun no
            matter what the path is. Without it, clicking a rail entry pushed
            that route and lit it in the rail while the Welcome screen stayed
            on the page, so the app reported a location it was not rendering.
            This only stops the rail from asserting something untrue; it does
            not make any route reachable during first run, which is a separate
            product decision. */}
        <Shell routeReflected={false}>
          <FirstRun />
        </Shell>
      </Router>
    )
  }

  return (
    <Router base={routerBase()}>
      <Shell>
        <Suspense fallback={<RouteFallback />}>
          <Switch>
            <Route path={ROUTES.today}><TodayPage /></Route>
            <Route path={ROUTES.feed}><FeedPage /></Route>
            <Route path={ROUTES.search}><SearchPage /></Route>
            <Route path={ROUTES.projects}><ProjectsPage /></Route>
            <Route path={ROUTES.project}>
              {(params) => <ProjectPage slug={params.slug} />}
            </Route>
            <Route path={ROUTES.session}>
              {(params) => <SessionPage sessionId={decodeURIComponent(params.sessionId)} />}
            </Route>
            {/* NOT decoded, unlike the two above, and it must not be: a day
                slug is base64url (dayCards.daySlug) precisely so that it holds
                no percent escape for anything to decode. wouter has ALREADY
                run decodeURI over the path by the time these params exist
                (wouter/src/paths.js), so a decode here would be the second
                pass routes.useRawSearch documents for the query string. */}
            <Route path={ROUTES.day}>
              {(params) => <DayPage slug={params.daySlug} />}
            </Route>
            {/* Before /team/members and /team/insights only for reading
                order -- wouter matches these patterns exactly, so '/team'
                never swallows the two nested paths. */}
            <Route path={ROUTES.team}><TeamPage /></Route>
            {/* /team/members is kept as an alias, not deleted: it was a real
                screen with real bookmarks, and 404ing them to prove a point
                helps nobody. It renders the Team page, whose People section
                is where that content went. */}
            <Route path={ROUTES.members}><TeamPage /></Route>
            <Route path={ROUTES.insights}><InsightsPage /></Route>
            <Route path={ROUTES.settings}><SettingsPage /></Route>
            <Route><Placeholder title="Not found" /></Route>
          </Switch>
        </Suspense>
      </Shell>
    </Router>
  )
}
