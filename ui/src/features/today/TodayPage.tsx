import { StatStrip, type StatItem } from '../../components/StatStrip'
import { useLiveSessions, useProjects, useStatus, useSyncAll, useSyncProject } from '../../data/queries'
import type { LiveSession, Project } from '../../data/types'
import { LiveEntry } from './LiveEntry'
import { ProjectRow } from './ProjectRow'
import './today.css'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

const todayDate = () => new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })

// dailyCounts is a guaranteed 7-entry partition, oldest first (types.ts) --
// the last entry is today's count.
const sessionsToday = (projects: Project[]) => projects.reduce((sum, p) => sum + (p.dailyCounts[6] ?? 0), 0)

// A project with prior history (sessionsTotal beyond this week) means this
// week's opens landed on memory that already existed -- the closest honest
// proxy Today's data surface offers for "repeat opens answered by memory"
// (the real per-question signal lives in Insights, not consumed here).
const repeatOpensAnsweredByMemory = (projects: Project[]) =>
  projects.filter(p => p.sessionsTotal > p.sessionsThisWeek).reduce((sum, p) => sum + p.sessionsThisWeek, 0)

// A project's latestSummary is the newest distilled update that reached
// memory this week -- counting projects that have one is a project-level
// proxy for "updates shared" (a raw event count needs the Feed page's data).
const updatesShared = (projects: Project[]) => projects.filter(p => p.latestSummary).length

// Members actually seen contributing to a shared project this week. Today
// has no team roster (getMembers is Members' page, not consumed here), so
// this is "members active", not a fraction against a known team size.
const membersSynced = (projects: Project[]) => {
  const ids = new Set<string>()
  for (const p of projects) if (p.shared) for (const id of p.memberIds) ids.add(id)
  return ids.size
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
  const syncProject = useSyncProject()
  const syncAll = useSyncAll()

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
  const projects = projectsQuery.data ?? []
  const liveSessions = liveQuery.data ?? []
  const memberNames = nameLookup(liveSessions)

  const stats: StatItem[] = solo
    ? [
        { value: String(liveSessions.length), label: 'live now' },
        { value: String(sessionsToday(projects)), label: 'sessions today' },
        { value: String(repeatOpensAnsweredByMemory(projects)), label: 'repeat opens answered by memory' },
      ]
    : [
        { value: String(liveSessions.length), label: 'live now' },
        { value: String(sessionsToday(projects)), label: 'sessions today' },
        { value: String(updatesShared(projects)), label: 'updates shared' },
        { value: String(membersSynced(projects)), label: 'members synced' },
      ]

  return (
    <div className="today-page">
      <div className="today-header">
        <div>
          <h1 className="today-title">Today</h1>
          <span className="today-date">{todayDate()}</span>
        </div>
        <div className="today-header-actions">
          <button type="button" className="today-btn today-btn-ghost">Copy for AI</button>
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
                onSync={() => syncProject.mutate(project.path)}
              />
            ))
          )}
        </div>
      </section>
    </div>
  )
}
