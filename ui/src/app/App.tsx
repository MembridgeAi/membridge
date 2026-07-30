import { Route, Switch } from 'wouter'
import { Placeholder } from '../components/Placeholder'
import { Shell } from './Shell'
import { ROUTES } from './routes'

/** Route table over ROUTES — every screen renders <Placeholder> until its
 *  own feature task lands. No route path literal here; all come from
 *  routes.ts, the single source of truth. */
export function App() {
  return (
    <Shell>
      <Switch>
        <Route path={ROUTES.today}><Placeholder title="Today" /></Route>
        <Route path={ROUTES.feed}><Placeholder title="Feed" /></Route>
        <Route path={ROUTES.projects}><Placeholder title="Projects" /></Route>
        <Route path={ROUTES.project}>
          {(params) => <Placeholder title={`Project · ${params.name}`} />}
        </Route>
        <Route path={ROUTES.members}><Placeholder title="Members" /></Route>
        <Route path={ROUTES.insights}><Placeholder title="Insights" /></Route>
        <Route path={ROUTES.settings}><Placeholder title="Settings" /></Route>
        <Route><Placeholder title="Not found" /></Route>
      </Switch>
    </Shell>
  )
}
