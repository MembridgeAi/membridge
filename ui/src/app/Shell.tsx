import { createContext, useContext, type ReactNode } from 'react'
import { Link, useLocation, useRoute } from 'wouter'
import { MembridgeMark } from '../assets/MembridgeMark'
import { useDataClient } from '../data/DataClientProvider'
import { useSettings, useStatus, useTeamAccount } from '../data/queries'
import type { Status } from '../data/types'
import { ROUTES } from './routes'
import { TeamSwitcher } from './TeamSwitcher'

/** Whether the rail may reflect the current route in its active state.
 *
 *  True everywhere the app renders the route it is on. False during the
 *  first-run takeover, which App.tsx renders REGARDLESS of path: clicking
 *  Settings there pushed /settings and lit the Settings entry while the
 *  Welcome screen stayed on the page, so the rail asserted a location the
 *  app was not rendering. The rail is the app's own answer to "where am I",
 *  and a wrong answer there is worse than a link that does nothing.
 *
 *  A context rather than a prop on all eight NavLinks: the value is a
 *  property of the whole rail, and threading it through every call site
 *  would invite the next entry to be added without it.
 *
 *  Deliberately scoped to honesty. It does not disable the links or change
 *  what first run renders -- whether the takeover should be escapable at all
 *  is a product decision that lands separately. */
const RouteReflectedContext = createContext(true)

/**
 * The rail's health dot: the one status indicator present on every screen.
 *
 * It used to render on `status.running` alone, so the two `running: false`
 * states -- a WEDGED sync loop and a daemon nobody has observed yet -- both made
 * it simply disappear, and the degraded-but-alive 'erroring' state showed the
 * same healthy green as 'ok'. A dot that is absent asserts nothing, which is
 * right for "not observed" and wrong for "stalled": that is precisely when the
 * rail should be telling the user to go look.
 *
 * Colour is never the only carrier -- the state is in `aria-label`/`title` here,
 * and the Settings page states it in words with the remedy beside it.
 *
 * `health` ABSENT falls back to the original behaviour exactly (green iff
 * running): an older daemon sends `running` alone, and this must not editorialise
 * about a field it cannot see.
 */
function HealthDot({ status }: { status: Status | undefined }) {
  const health = status?.health
  if (!health) {
    if (!status?.running) return null
    return <span className="status-dot" role="img" aria-label="MemBridge running" title="MemBridge running" />
  }
  if (health.state === 'unknown') return null
  const label = health.state === 'ok'
    ? 'MemBridge running'
    : health.state === 'erroring'
      ? 'MemBridge running, last sync failed'
      : 'MemBridge sync stalled'
  const tone = health.state === 'ok' ? '' : health.state === 'erroring' ? ' status-dot-warn' : ' status-dot-bad'
  return <span className={`status-dot${tone}`} role="img" aria-label={label} title={label} />
}

interface NavLinkProps {
  to: string
  label: string
  icon: string
}

/** One rail entry. Active state is border-left + accent-dim background only
 *  — see app.css `.nav-item-active` — no other decoration. */
function NavLink({ to, label, icon }: NavLinkProps) {
  const [matchesRoute] = useRoute(to)
  const routeReflected = useContext(RouteReflectedContext)
  const isActive = routeReflected && matchesRoute
  return (
    <Link href={to} className={`nav-item${isActive ? ' nav-item-active' : ''}`}>
      <span className="nav-icon" aria-hidden="true">{icon}</span> {label}
    </Link>
  )
}

interface ShellProps {
  children: ReactNode
  /** False when `children` is a takeover screen rendered independently of
   *  the URL (first run), so the rail does not claim a route as current
   *  that the app is not actually rendering. Defaults to true. */
  routeReflected?: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

/** Fixed-width left rail + main content region. Team surfaces (switcher,
 *  Members, Insights) render only when the machine is actually on a team.
 *  Members/Insights additionally require the VIEWER's role — owner or admin,
 *  read from `Settings.team.role` — since `capabilities.teamAdminSupported`
 *  only says the transport *can* carry admin calls, never that this user may
 *  make them (spec §3.7). Until status and settings both resolve, neither the
 *  Team group nor the solo "Create a team" CTA renders — defaulting either
 *  way would flash a control the user may not be entitled to. */
export function Shell({ children, routeReflected = true }: ShellProps) {
  const statusQuery = useStatus()
  const settingsQuery = useSettings()
  const accountQuery = useTeamAccount()
  const client = useDataClient()
  const [, navigate] = useLocation()

  const status = statusQuery.data
  const settings = settingsQuery.data
  const account = accountQuery.data
  const ready = status !== undefined && settings !== undefined
  const hasError = statusQuery.isError || settingsQuery.isError

  // Unknown (still loading, or failed) defaults to solo/no-role — a control
  // never flashes on before its data confirms the machine is actually on a
  // team and the viewer actually holds an admin role.
  const role = settings?.team?.role ?? null
  const isTeamAdmin = role === 'owner' || role === 'admin'
  // Membership, not `solo`: solo answers "is anyone else actually here",
  // which is the wrong question for "do you already have a team". Keying
  // these off solo is what left a real member with no Members/Insights nav
  // and an owner being asked to create the team they had just created.
  const onTeam = !!settings?.team
  const showTeamNav = ready && onTeam && client.capabilities.teamAdminSupported && isTeamAdmin

  // GET /api/team's `authenticated` is the ONLY field that answers "are there
  // credentials on this machine". Neither of the other two queries can:
  // status.solo means no linked project on a multi-member team rather than
  // "has no team", and settings.team is null both when signed out and when
  // signed in with no team yet. Undefined here means the account query has not
  // settled, which deliberately renders NEITHER branch of the footer: showing
  // "Sign in" to someone who turns out to be signed in is the same lie as
  // showing a name to someone who is signed out, just pointing the other way.
  const signedIn = account?.authenticated === true
  const signedOut = account !== undefined && !account.authenticated
  // Prefer what the person chose to be called, then the address they signed
  // up with. A signed-in account with neither still gets a truthful label
  // rather than falling through to an empty span.
  const identity = account?.user?.displayName || account?.user?.email || 'Signed in'

  // Creating a team requires an account, so a signed-out machine gets the
  // sign-in control in the footer instead of this. Gating on solo alone sent
  // a signed-out user to a create-team form they could not submit -- and
  // gating on solo at all offered it to people already on a team.
  const showCreateTeam = ready && !onTeam && signedIn

  return (
    <div className="shell">
      <nav className="rail" aria-label="Primary">
        {/* MembridgeMark is an inlined SVG component (see
            assets/MembridgeMark.tsx for why), not an <img src>. It carries
            the accessible name itself (role="img" + aria-label), so the
            adjacent wordmark stays aria-hidden and the two don't
            double-announce. */}
        <div className="logo">
          <MembridgeMark className="logo-mark" />
          <span aria-hidden="true">MemBridge</span>
        </div>

        {/* Same correction as showTeamNav above: your team's name belongs in
            the rail as soon as you are ON a team, not only once a second
            person's work has reached a linked project. On more than one team
            this is a real switcher; on one it renders the same label it
            always did. */}
        {settings?.team && <TeamSwitcher current={settings.team} />}

        {/* Every NavLink reads routeReflected from here rather than taking it
            as a prop, so a rail entry added later cannot forget to honor it. */}
        <RouteReflectedContext.Provider value={routeReflected}>
        <div className="nav">
          <NavLink to={ROUTES.today} label="Today" icon="⌂" />
          <NavLink to={ROUTES.feed} label="Feed" icon="☰" />
          <NavLink to={ROUTES.search} label="Search" icon="⌕" />
          <NavLink to={ROUTES.projects} label="Projects" icon="▦" />

          {/* Team is UNCONDITIONAL, unlike Members/Insights below it: it is
              the screen that says whether this machine is even signed in,
              and gating it on being on a team is what left a signed-out (or
              teamless) user with nowhere to go. */}
          <div className="nav-group-label">Team</div>
          <NavLink to={ROUTES.team} label="Team" icon="◈" />

          {/* No Members item: the roster is a section of the Team page now.
              Two nav entries for one team put identity and invites on one
              screen and the people those invites produce on another, and
              each grew its own invite control. */}
          {showTeamNav && <NavLink to={ROUTES.insights} label="Insights" icon="✦" />}

          {/* Now lands on the Team page, which actually has a create-a-team
              form. It used to navigate to Settings, whose only team control
              is "Leave team" -- a dead end. */}
          {showCreateTeam && (
            <button type="button" className="create-team" onClick={() => navigate(ROUTES.team)}>
              + Create a team
            </button>
          )}

          <div className="nav-group-label">You</div>
          <NavLink to={ROUTES.settings} label="Settings" icon="⚙" />
        </div>
        </RouteReflectedContext.Provider>

        {/* The footer is the one piece of chrome present on every screen, so
            it is where the app has to state which account it is acting as.
            It used to read the literal word "You" in both states, which meant
            a freshly installed, signed-out app looked exactly like a signed-in
            one and offered no route in from anywhere in the rail. */}
        <div className="rail-footer">
          <HealthDot status={status} />
          {/* A Link, not a button-plus-navigate like the create-team CTA
              above: this only ever changes route, so anchor semantics give it
              keyboard and middle-click behaviour for free. It points at the
              Team page because AuthScreen is the only surface that accepts
              credentials; Settings has no sign-in control at all. */}
          {signedOut && (
            <Link href={ROUTES.team} className="rail-signin">Sign in</Link>
          )}
          {signedIn && (
            <span className="rail-identity" data-testid="rail-identity" title={identity}>{identity}</span>
          )}
        </div>
      </nav>

      <main className="shell-main">
        {hasError && (
          <p className="shell-error" role="alert">
            Couldn't load your account status. {errorMessage(statusQuery.error ?? settingsQuery.error)}
          </p>
        )}
        {children}
      </main>
    </div>
  )
}
