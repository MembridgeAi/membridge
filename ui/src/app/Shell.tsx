import type { ReactNode } from 'react'
import { Link, useLocation, useRoute } from 'wouter'
import { MembridgeMark } from '../assets/MembridgeMark'
import { useDataClient } from '../data/DataClientProvider'
import { useSettings, useStatus } from '../data/queries'
import { ROUTES } from './routes'

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
  const client = useDataClient()
  const [, navigate] = useLocation()

  const status = statusQuery.data
  const settings = settingsQuery.data
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
  const showCreateTeam = ready && !onTeam

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
            person's work has reached a linked project. */}
        {settings?.team && (
          <div className="team-switch">
            <span className="team-switch-name">{settings.team.name}</span>
          </div>
        )}

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

        <div className="rail-footer">
          {status?.running && (
            <span className="status-dot" role="img" aria-label="Daemon running" title="Daemon running" />
          )}
          <span>You</span>
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
