import { useMemo } from 'react'
import { DaemonErrorBanner, daemonErrorOf } from '../../components/DaemonError'
import { LoadingRows } from '../../components/LoadingBlock'
import { StatStrip, type StatItem } from '../../components/StatStrip'
import { weekdayMonthDay } from '../../data/localTime'
import { groupLiveSessions } from '../../data/mappers'
import { relativeAgo } from '../../data/relativeTime'
import { useLiveSessions, useProjects, useSkeletonStats, useSoloView, useStatus, useSyncAll, useSyncProject } from '../../data/queries'
import type { LiveSession, Project, SkeletonStats } from '../../data/types'
import { LiveEntry } from './LiveEntry'
import { ProjectRow } from './ProjectRow'
import './today.css'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

// Local fields, never UTC -- the same fix as SyncStateView's shortStamp
// (components/SyncState.tsx). Reading UTC fields put tomorrow's date in the
// header of a page literally titled "Today" for every user west of
// Greenwich after 17:00. No comma, matching the mockup's "Tue Jul 29" --
// toLocaleDateString's weekday-included form always inserts one ("Tue, Jul 29").
export function todayDateLabel(now: Date = new Date()): string {
  return weekdayMonthDay(now)
}

// Replaces the old per-member synced count: team_members_list exposes no
// per-member sync state, and a teammate's daemon is invisible from this
// machine (see data/types.ts, the Member doc comment) -- so no honest
// per-member count exists. status.teamLastSync is the one team-sync fact
// this machine can actually observe, so that's what ships: a relative
// label, or `never`.
export function lastTeamSyncLabel(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never'
  return relativeAgo(iso, {}, now)
}

// dailyCounts is a guaranteed 7-entry partition, oldest first (types.ts) --
// the last entry is the most recent bucket. lib/server.js's
// dailySessionBuckets documents these as ROLLING 24h buckets, not calendar
// days (the server has no notion of the browser's timezone) -- so the stat
// label below says "last 24h", never "today" (Fix 5).
const sessionsLast24h = (projects: Project[]) => projects.reduce((sum, p) => sum + (p.dailyCounts[6] ?? 0), 0)

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

// FIX 2: "Projects · this week" must mean this week -- a watched project
// with zero sessions in the last 7 days is not part of that week's story
// (it's still visible on the Projects screen, just not here). A project
// behind on sync still belongs here as long as it has activity: sync lag is
// a different signal from inactivity, and hiding it would bury exactly the
// project that most needs to be seen. Sorted most-recent-activity first, so
// the section reads like what actually happened this week, not alphabetical
// noise.
export function projectsThisWeek(projects: Project[]): Project[] {
  return projects
    .filter(p => p.sessionsThisWeek > 0)
    .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))
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
  // T-78: the SURFACE gate for team language. See useSoloView doc. Called
  // here, alongside every other hook, because rules-of-hooks requires the
  // call to run before any conditional return below.
  const soloView = useSoloView()

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
  // FIX 1c: group person+project into one "Happening now" row per goal --
  // same referential-stability reasoning as memberNames above (react-query's
  // structural sharing keeps `liveSessions` stable across a no-change poll).
  const liveGroups = useMemo(() => groupLiveSessions(liveSessions), [liveSessions])

  // Full error page only for a first-load failure (no data at all); a failed
  // refetch with cached data degrades to an inline banner below instead of
  // blanking a populated screen every time the daemon hiccups mid-poll.
  const daemonError = daemonErrorOf([statusQuery, projectsQuery, liveQuery])
  if (daemonError?.blocking) {
    return (
      <div className="today-page">
        <p className="today-error" role="alert">Couldn't reach MemBridge.</p>
        <p className="today-empty-note">{errorMessage(daemonError.error)}</p>
      </div>
    )
  }

  const solo = statusQuery.data?.solo ?? true
  const teamLastSync = statusQuery.data?.teamLastSync ?? null
  const projects = projectsQuery.data ?? []
  const weekProjects = projectsThisWeek(projects)
  // A load failure or a still-in-flight fetch degrades to "pending", the same
  // as a ledger with nothing in it -- never a guessed number.
  const skeleton: SkeletonStats = skeletonQuery.data ?? { available: false }

  // Each figure is withheld until the query that answers IT has answered --
  // per query, not per page. `isPending` is react-query's "no data and none
  // has arrived yet"; it is false once data lands AND false on a failed first
  // load (which the blocking branch above has already handled) and on a failed
  // refetch over cached data, so this can never leave a bar pulsing forever
  // over an error the user cannot see.
  //
  // The figures this gates were previously computed from `?? []` / `?? {
  // available: false }` fallbacks, which is how a ten-project install came to
  // read "0 sessions · last 24h" for as long as /api/feed took. The fallbacks
  // stay -- they are what the derivations below need in order to be pure --
  // but their OUTPUT is no longer presented as a measurement.
  const liveKnown = !liveQuery.isPending
  const projectsKnown = !projectsQuery.isPending
  const statusKnown = !statusQuery.isPending
  // Not `skeleton.available`: that is the ledger's own answer ("nothing
  // recorded yet", rendered as the literal word `pending`), which is a fact
  // about the ledger. This is a fact about the request. Collapsing them would
  // report our own ignorance as the ledger's.
  const skeletonKnown = !skeletonQuery.isPending

  // liveGroups.length, never liveSessions.length (Fix 4): the "Happening
  // now" rows below render GROUPED person+project goals, and mappers.ts's
  // contract is that the count and the dots are one set -- a person with two
  // sessions on one goal is one row, so they are one in this count too.
  const liveNowStat: StatItem = { value: liveKnown ? String(liveGroups.length) : null, label: 'live now' }
  const sessionsStat: StatItem = { value: projectsKnown ? String(sessionsLast24h(projects)) : null, label: 'sessions · last 24h' }
  const stats: StatItem[] = solo
    ? [
        liveNowStat,
        sessionsStat,
        { value: skeletonKnown ? skeletonPercentLabel(skeleton) : null, label: 'repeat opens answered by memory' },
      ]
    : [
        liveNowStat,
        sessionsStat,
        { value: projectsKnown ? String(updatesShared(projects)) : null, label: 'updates shared' },
        { value: statusKnown ? lastTeamSyncLabel(teamLastSync) : null, label: 'last team sync' },
      ]

  return (
    <div className="today-page">
      {daemonError && <DaemonErrorBanner className="today-error" error={daemonError.error} />}
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
          {/* Fix 9: reflect the mutation's own state -- disabled + "Syncing…"
              while pending, and a visible alert on failure (below) instead
              of a click that silently does nothing. */}
          <button type="button" className="today-btn today-btn-primary" onClick={() => syncAll.mutate()} disabled={syncAll.isPending}>
            {syncAll.isPending ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </div>

      {syncAll.isError && (
        <p className="today-error" role="alert">Couldn't sync. {errorMessage(syncAll.error)}</p>
      )}
      {syncProject.isError && (
        <p className="today-error" role="alert">Couldn't sync. {errorMessage(syncProject.error)}</p>
      )}

      <StatStrip items={stats} />

      <section>
        <div className="section-label">Happening now</div>
        <div className="live-list">
          {/* "Nothing happening right now." is an ANSWER, and it was being
              given before the question had been asked. Two placeholder rows
              rather than one: a strip that draws a single row and then grows
              to three moves everything below it, and this section sits above
              the project list. */}
          {!liveKnown
            ? <LoadingRows rows={2} label="Loading what's happening now" testId="live-loading" />
            : liveGroups.length === 0
              ? <p className="today-empty-note">Nothing happening right now.</p>
              : liveGroups.map(group => <LiveEntry key={group.id} group={group} />)}
        </div>
      </section>

      <section>
        <div className="section-label">Projects · this week</div>
        <div className="project-list">
          {/* The worst of the three. "No projects yet. Sync your first project
              to see it here." is FIRST-RUN copy: it tells an established user
              their setup is gone and instructs them to redo it, and it was on
              screen for as long as getProjects() took -- 1.4s measured,
              because that call awaits /api/feed alongside /api/projects. */}
          {!projectsKnown ? (
            <LoadingRows rows={3} label="Loading this week's projects" testId="projects-loading" />
          ) : projects.length === 0 ? (
            <p className="today-empty-note">No projects yet. Sync your first project to see it here.</p>
          ) : weekProjects.length === 0 ? (
            <p className="today-empty-note">No project activity in the last 7 days.</p>
          ) : (
            weekProjects.map(project => (
              <ProjectRow
                key={project.path}
                project={project}
                memberNames={memberNames}
                onSyncProject={syncProject.mutate}
                syncPending={syncProject.isPending && syncProject.variables === project.path}
                soloView={soloView}
              />
            ))
          )}
        </div>
      </section>
    </div>
  )
}
