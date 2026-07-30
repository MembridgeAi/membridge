import type { ReactNode } from 'react'
import { Link, useLocation, useRoute } from 'wouter'
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

/** Fixed-width left rail + main content region. Team surfaces (switcher,
 *  Members, Insights) render only when the machine is actually on a team AND
 *  this transport/role can administer it — solo or a member role never sees
 *  them, absent rather than disabled (spec §3.7). */
export function Shell({ children }: ShellProps) {
  const { data: status } = useStatus()
  const { data: settings } = useSettings()
  const client = useDataClient()
  const [, navigate] = useLocation()

  // Unknown (still loading) defaults to solo — a control never flashes on
  // before its data confirms the machine is actually on a team.
  const solo = status?.solo ?? true
  const showTeamNav = !solo && client.capabilities.teamAdmin

  return (
    <div className="shell">
      <nav className="rail" aria-label="Primary">
        <div className="logo">
          <span className="logo-mark" aria-hidden="true" />
          MemBridge
        </div>

        {!solo && settings?.team && (
          <div className="team-switch">
            <span className="team-switch-name">{settings.team.name}</span>
          </div>
        )}

        <div className="nav">
          <NavLink to={ROUTES.today} label="Today" icon="⌂" />
          <NavLink to={ROUTES.feed} label="Feed" icon="☰" />
          <NavLink to={ROUTES.projects} label="Projects" icon="▦" />

          {showTeamNav && (
            <>
              <div className="nav-group-label">Team</div>
              <NavLink to={ROUTES.members} label="Members" icon="◎" />
              <NavLink to={ROUTES.insights} label="Insights" icon="✦" />
            </>
          )}

          {solo && (
            <button type="button" className="create-team" onClick={() => navigate(ROUTES.settings)}>
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

      <main className="shell-main">{children}</main>
    </div>
  )
}
