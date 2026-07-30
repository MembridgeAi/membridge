import { useMemo } from 'react'
import { StatStrip, type StatItem } from '../../components/StatStrip'
import { useLiveSessions, useProjects, useSkeletonStats, useStatus, useSyncAll, useSyncProject } from '../../data/queries'
import type { LiveSession, Project, SkeletonStats } from '../../data/types'
import { LiveEntry } from './LiveEntry'
import { ProjectRow } from './ProjectRow'
import './today.css'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// UTC fields, never local -- the same reasoning as SyncStateView's shortDate
// (components/SyncState.tsx): the daemon's timestamps are UTC, and a
// local-time render could put the header on a different calendar day than
// the data it is describing. No comma, matching the mockup's "Tue Jul 29" --
// toLocaleDateString's weekday-included form always inserts one ("Tue, Jul 29").
export function todayDateLabel(now: Date = new Date()): string {
  return `${WEEKDAYS[now.getUTCDay()]} ${MONTHS[now.getUTCMonth()]} ${now.getUTCDate()}`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Replaces the old per-member synced count: team_members_list exposes no
// per-member sync state, and a teammate's daemon is invisible from this
// machine (see data/types.ts, the Member doc comment) -- so no honest
// per-member count exists. status.teamLastSync is the one team-sync fact
// this machine can actually observe, so that's what ships: a relative
// label, or `never`.
export function lastTeamSyncLabel(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never'
  const ms = now - new Date(iso).getTime()
  if (ms < MINUTE) return 'just now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`
  return `${Math.floor(ms / DAY)}d ago`
}

// dailyCounts is a guaranteed 7-entry partition, oldest first (types.ts) --
// the last entry is today's count.
const sessionsToday = (projects: Project[]) => projects.reduce((sum, p) => sum + (p.dailyCounts[6] ?? 0), 0)

// A team-labelled stat must never count a private project's summary. shared
// is checked first, before latestSummary, so a private project can never
// slip through regardless of what it has.
const updatesShared = (projects: Project[]) => projects.filter(p => p.shared && p.latestSummary).length

// Today's solo effectiveness stat, read from the real /api/savings ledger
// (DataClient.getSkeletonStats) -- never a session-count proxy. `pending` is
// the literal word rendered when the ledger has nothing yet; it is never
// replaced with a computed stand-in.
export function skeletonPercentLabel(stats: SkeletonStats): string {
  if (!stats.available) return 'pending'
  if (stats.repeatOpens <= 0) return '0%'
  return `${Math.round((stats.answeredFirst / stats.repeatOpens) * 100)}%`
}

const nameLookup = (liveSessions: LiveSession[]): Record<string, string> => {
  const names: Record<string, string> = {}
  for (const s of liveSessions) names[s.authorId] = s.author
  return names
}

/** The team-first home screen. Solo mode shows three stats and no team
 *  framing (absent, not disabled); team mode adds the two shared/team stats. */
export function TodayPage() {
  const statusQuery = useStatus()
  const projectsQuery = useProjects()
  const liveQuery = useLiveSessions()
  const skeletonQuery = useSkeletonStats()
  const syncProject = useSyncProject()
  const syncAll = useSyncAll()

  const liveSessions = liveQuery.data ?? []
  // Perf (spec §7): Today re-renders every 10s poll tick. Without this
  // memo, `memberNames` would be a brand-new object on every one of those
  // renders regardless of whether liveSessions actually changed, which would
  // defeat ProjectRow's React.memo below (a new object prop always fails the
  // shallow-equality check memo relies on) -- react-query's structural
  // sharing keeps `liveSessions` itself referentially stable across a poll
  // with no real change, so this recomputes only when it actually changed.
  // Hooks must run unconditionally (rules-of-hooks), so this sits above the
  // hasError early return below, alongside every other hook in this component.
  const memberNames = useMemo(() => nameLookup(liveSessions), [liveSessions])

  const hasError = statusQuery.isError || projectsQuery.isError || liveQuery.isError
  if (hasError) {
    const message = errorMessage(statusQuery.error ?? projectsQuery.error ?? liveQuery.error)
    return (
      <div className="today-page">
        <p className="today-error" role="alert">Couldn't reach the daemon. {message}</p>
      </div>
    )
  }

  const solo = statusQuery.data?.solo ?? true
  const teamLastSync = statusQuery.data?.teamLastSync ?? null
  const projects = projectsQuery.data ?? []
  // A load failure or a still-in-flight fetch degrades to "pending", the same
  // as a ledger with nothing in it -- never a guessed number.
  const skeleton: SkeletonStats = skeletonQuery.data ?? { available: false }

  const stats: StatItem[] = solo
    ? [
        { value: String(liveSessions.length), label: 'live now' },
        { value: String(sessionsToday(projects)), label: 'sessions today' },
        { value: skeletonPercentLabel(skeleton), label: 'repeat opens answered by memory' },
      ]
    : [
        { value: String(liveSessions.length), label: 'live now' },
        { value: String(sessionsToday(projects)), label: 'sessions today' },
        { value: String(updatesShared(projects)), label: 'updates shared' },
        { value: lastTeamSyncLabel(teamLastSync), label: 'last team sync' },
      ]

  return (
    <div className="today-page">
      <div className="today-header">
        <div>
          <h1 className="today-title">Today</h1>
          <span className="today-date">{todayDateLabel()}</span>
        </div>
        {/* The whole-account digest button is deliberately omitted here
            (deviation from today-v15.html, spec §3.1): there is no
            whole-account digest endpoint, only per-project POST
            /api/projects/copy, so that control lives on the project page
            (Task 9), not here. */}
        <div className="today-header-actions">
          <button type="button" className="today-btn today-btn-primary" onClick={() => syncAll.mutate()}>
            Sync now
          </button>
        </div>
      </div>

      <StatStrip items={stats} />

      <section>
        <div className="section-label">Happening now</div>
        <div className="live-list">
          {liveSessions.length === 0 && <p className="today-empty-note">Nothing happening right now.</p>}
          {liveSessions.map(session => <LiveEntry key={session.id} session={session} />)}
        </div>
      </section>

      <section>
        <div className="section-label">Projects · this week</div>
        <div className="project-list">
          {projects.length === 0 ? (
            <p className="today-empty-note">No projects yet — sync your first project to see it here.</p>
          ) : (
            projects.map(project => (
              <ProjectRow
                key={project.path}
                project={project}
                memberNames={memberNames}
                onSyncProject={syncProject.mutate}
              />
            ))
          )}
        </div>
      </section>
    </div>
  )
}
