import { Route, Switch } from 'wouter'
import { Placeholder } from '../components/Placeholder'
import { useStatus } from '../data/queries'
import { InsightsPage } from '../features/insights/InsightsPage'
import { MembersPage } from '../features/members/MembersPage'
import { ProjectPage } from '../features/project/ProjectPage'
import { ProjectsPage } from '../features/projects/ProjectsPage'
import { FirstRun } from '../features/settings/FirstRun'
import { SettingsPage } from '../features/settings/SettingsPage'
import { TodayPage } from '../features/today/TodayPage'
import { Shell } from './Shell'
import { ROUTES } from './routes'

/** Route table over ROUTES — every screen renders <Placeholder> until its
 *  own feature task lands. No route path literal here; all come from
 *  routes.ts, the single source of truth.
 *
 *  First-run takes over the whole app, regardless of path, while
 *  status.setupDone is false -- an explicit false is required (undefined,
 *  still loading, must not flash the takeover before status confirms it). */
export function App() {
  const statusQuery = useStatus()

  if (statusQuery.data?.setupDone === false) {
    return (
      <Shell>
        <FirstRun />
      </Shell>
    )
  }

  return (
    <Shell>
      <Switch>
        <Route path={ROUTES.today}><TodayPage /></Route>
        <Route path={ROUTES.feed}><Placeholder title="Feed" /></Route>
        <Route path={ROUTES.projects}><ProjectsPage /></Route>
        <Route path={ROUTES.project}>
          {(params) => <ProjectPage name={params.name} />}
        </Route>
        <Route path={ROUTES.members}><MembersPage /></Route>
        <Route path={ROUTES.insights}><InsightsPage /></Route>
        <Route path={ROUTES.settings}><SettingsPage /></Route>
        <Route><Placeholder title="Not found" /></Route>
      </Switch>
    </Shell>
  )
}
