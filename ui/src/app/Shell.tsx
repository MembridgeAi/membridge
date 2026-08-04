import type { ReactNode } from 'react'
import { Link, useLocation, useRoute } from 'wouter'
import { MembridgeMark } from '../assets/MembridgeMark'
import { useDataClient } from '../data/DataClientProvider'
import { useSettings, useStatus, useTeamAccount } from '../data/queries'
import { ROUTES } from './routes'
import { TeamSwitcher } from './TeamSwitcher'

interface NavLinkProps {
  to: string
  label: string
  icon: string
}

/** One rail entry. Active state is border-left + accent-dim background only
 *  — see app.css `.nav-item-active` — no other decoration. */
function NavLink({ to, label, icon }: NavLinkProps) {
  const [isActive] = useRoute(to)
  return (
    <Link href={to} className={`nav-item${isActive ? ' nav-item-active' : ''}`}>
      <span className="nav-icon" aria-hidden="true">{icon}</span> {label}
    </Link>
  )
}

interface ShellProps {
  children: ReactNode
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
export function Shell({ children }: ShellProps) {
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

          {showTeamNav && (
            <>
              <NavLink to={ROUTES.members} label="Members" icon="◎" />
              <NavLink to={ROUTES.insights} label="Insights" icon="✦" />
            </>
          )}

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

        {/* The footer is the one piece of chrome present on every screen, so
            it is where the app has to state which account it is acting as.
            It used to read the literal word "You" in both states, which meant
            a freshly installed, signed-out app looked exactly like a signed-in
            one and offered no route in from anywhere in the rail. */}
        <div className="rail-footer">
          {status?.running && (
            <span className="status-dot" role="img" aria-label="Daemon running" title="Daemon running" />
          )}
          {/* A Link, not a button-plus-navigate like the create-team CTA
              above: this only ever changes route, so anchor semantics give it
              keyboard and middle-click behaviour for free. It points at the
              Team page because TeamPage's SignInCard is the only surface that
              accepts credentials; Settings has no sign-in control at all. */}
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
