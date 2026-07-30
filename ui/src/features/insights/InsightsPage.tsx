import { useState } from 'react'
import { StatStrip, type StatItem } from '../../components/StatStrip'
import { useDataClient } from '../../data/DataClientProvider'
import { useInsights, useSettings, useStatus } from '../../data/queries'
import type { Insights, SkeletonStats } from '../../data/types'
import { PersonBars } from './PersonBars'
import { ProblemGroup } from './ProblemList'
import './insights.css'

type Window = 7 | 30 | 90
const WINDOWS: Window[] = [7, 30, 90]

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

const formatCount = (n: number): string => n.toLocaleString('en-US')

// Same union, same rule, as Today's skeletonPercentLabel (TodayPage.tsx):
// `pending` is the literal word rendered when the ledger has nothing yet —
// never a computed stand-in, never a zero dressed as a real figure. Kept as
// its own small copy here rather than a cross-feature import, matching the
// project's existing convention of each feature file owning its own small
// utilities (see members.css/projects.css `.tag`).
function headlinePercentLabel(skeleton: SkeletonStats): string {
  if (!skeleton.available) return 'pending'
  if (skeleton.repeatOpens <= 0) return '0%'
  return `${Math.round((skeleton.answeredFirst / skeleton.repeatOpens) * 100)}%`
}

function trendNote(deltaPct: number | null, windowDays: number): string | undefined {
  if (deltaPct === null) return undefined
  return `${deltaPct > 0 ? '+' : ''}${deltaPct}% vs prev ${windowDays}d`
}

function deltaNote(delta: number | null): string | undefined {
  if (delta === null) return undefined
  return `${delta > 0 ? '+' : ''}${delta}`
}

function toCsvCell(value: string | number): string {
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsvRow(cells: (string | number)[]): string {
  return cells.map(toCsvCell).join(',')
}

// Every figure here already lives in the fetched Insights payload -- this is
// a pure client-side transform, never a new number, never a dollar amount.
function buildCsv(insights: Insights): string {
  const lines: string[] = [
    toCsvRow(['metric', 'value']),
    toCsvRow(['window_days', insights.window]),
    toCsvRow(['sessions', insights.sessions.count]),
    toCsvRow(['members_syncing_ok', insights.membersSyncing.ok]),
    toCsvRow(['members_syncing_total', insights.membersSyncing.total]),
    toCsvRow(['entries_shared', insights.entriesShared.count]),
    toCsvRow(['repeat_file_opens', insights.skeleton.available ? insights.skeleton.repeatOpens : 'pending']),
    toCsvRow(['answered_by_memory_first', insights.skeleton.available ? insights.skeleton.answeredFirst : 'pending']),
    '',
    toCsvRow(['person', 'sessions', 'shared']),
    ...insights.perPerson.map(p => toCsvRow([p.name, p.sessions, p.shared])),
    '',
    toCsvRow(['project', 'sessions', 'people']),
    ...insights.topProjects.map(p => toCsvRow([p.name, p.sessions, p.people])),
    '',
    toCsvRow(['problem_severity', 'headline', 'scale']),
    ...insights.problems.map(p => toCsvRow([p.severity, p.headline, p.scale])),
  ]
  return lines.join('\n')
}

function exportCsv(insights: Insights): void {
  const blob = new Blob([buildCsv(insights)], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `membridge-insights-${insights.window}d.csv`
  link.click()
  URL.revokeObjectURL(url)
}

function LRow({ name, sub, value }: { name: string; sub?: string; value: string }) {
  return (
    <div className="lrow">
      <span className="lrow-name">
        {name} {sub && <span className="lrow-muted">{sub}</span>}
      </span>
      <span className="mono lrow-value">{value}</span>
    </div>
  )
}

interface InsightsContentProps {
  window: Window
  onWindowChange: (w: Window) => void
  teamLabel: string | null
}

/** The data-fetching half of the page. Split out from InsightsPage so
 *  useInsights() -- and therefore GET /api/team/insights -- only fires once
 *  this actually mounts, which InsightsPage gates on the viewer being an
 *  owner/admin on a team. A member navigating here directly never triggers
 *  this component, and so never triggers the request. */
function InsightsContent({ window, onWindowChange, teamLabel }: InsightsContentProps) {
  const insightsQuery = useInsights(window)

  if (insightsQuery.isError) {
    return (
      <div className="insights-page">
        <p className="insights-error" role="alert">Couldn't reach the daemon. {errorMessage(insightsQuery.error)}</p>
      </div>
    )
  }
  if (!insightsQuery.data) {
    return (
      <div className="insights-page">
        <p className="insights-loading-note">Loading…</p>
      </div>
    )
  }

  const insights = insightsQuery.data
  const broken = insights.problems.filter(p => p.severity === 'broken')
  const minor = insights.problems.filter(p => p.severity === 'minor')

  const stats: StatItem[] = [
    { value: formatCount(insights.sessions.count), label: 'sessions', note: trendNote(insights.sessions.deltaPct, window) },
    { value: headlinePercentLabel(insights.skeleton), label: 'repeat opens answered by memory' },
    {
      value: `${insights.membersSyncing.ok}/${insights.membersSyncing.total}`,
      label: 'members syncing',
      note: insights.membersSyncing.ok === insights.membersSyncing.total ? 'all healthy' : undefined,
    },
    { value: formatCount(insights.entriesShared.count), label: 'memory entries shared', note: deltaNote(insights.entriesShared.delta) },
  ]

  return (
    <div className="insights-page">
      <div className="insights-header">
        <h1 className="insights-title">Insights</h1>
        {teamLabel && <span className="mono insights-count">{teamLabel}</span>}
        <div className="insights-header-actions">
          <div className="seg" role="group" aria-label="Time window">
            {WINDOWS.map(w => (
              <button
                key={w}
                type="button"
                aria-pressed={w === window}
                className={w === window ? 'seg-btn seg-btn-on' : 'seg-btn'}
                onClick={() => onWindowChange(w)}
              >
                {w} days
              </button>
            ))}
          </div>
          <button type="button" className="insights-btn-ghost" onClick={() => exportCsv(insights)}>
            Export CSV
          </button>
        </div>
      </div>

      <StatStrip items={stats} />

      <div className="insights-cols">
        <div className="insights-colL">
          <div className="insights-sect">
            Activity by person <span className="insights-hint">sessions · summaries shared</span>
          </div>
          <PersonBars people={insights.perPerson} />

          <div className="insights-sect">
            How well the skeleton is working <span className="insights-hint">last {window} days</span>
          </div>
          <div className="skeleton-panel" data-testid="skeleton-panel">
            <div className="lrow" role="row">
              <span className="lrow-name">Repeat file opens</span>
              <span className="mono lrow-value">
                {insights.skeleton.available ? formatCount(insights.skeleton.repeatOpens) : 'pending'}
              </span>
            </div>
            <div className="lrow" role="row">
              <span className="lrow-name">Answered by our memory first</span>
              <span className="mono lrow-value lrow-value-good">
                {insights.skeleton.available
                  ? `${formatCount(insights.skeleton.answeredFirst)} · ${headlinePercentLabel(insights.skeleton)}`
                  : 'pending'}
              </span>
            </div>
          </div>

          <div className="insights-sect">Most active projects</div>
          {insights.topProjects.map(p => (
            <LRow key={p.name} name={p.name} sub={`${p.people} ${p.people === 1 ? 'person' : 'people'}`} value={`${formatCount(p.sessions)} sessions`} />
          ))}
        </div>

        <div className="insights-colR">
          <ProblemGroup testId="problems-broken" severity="broken" title="Broken" hint="nothing is reaching the team" problems={broken} emptyNote="Nothing is broken right now." />
          <ProblemGroup testId="problems-minor" severity="minor" title="Minor" hint="isolated, no action needed" problems={minor} emptyNote="No minor issues." />

          <div className="insights-sect">
            Knowledge concentration <span className="insights-hint">who is the only one who has touched a project</span>
          </div>
          {insights.concentration.map(c => (
            <LRow key={c.projectName} name={c.projectName} value={`${c.onlyPerson} only · ${c.detail}`} />
          ))}
          {insights.concentration.length > 0 && (
            <p className="insights-foot">
              Single-owner projects are where a departure hurts most. Sharing them is one toggle on the project page.
            </p>
          )}

          <div className="insights-sect">Cross-tool reach</div>
          {insights.byTool.map(t => (
            <LRow key={t.tool} name={t.tool} value={`${formatCount(t.sessions)} sessions`} />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * The team Insights page: is the team getting value, and what is silently
 * broken. Matches insights-v4.html. Owner/admin only -- Shell already hides
 * the nav entry, but a member could still type the URL, so this page holds
 * its own gate too and never mounts InsightsContent (and therefore never
 * calls getInsights()) for anyone else. Unknown (still loading, or failed)
 * defaults to solo/no-role, same as Shell.tsx and MembersPage.tsx -- this
 * screen never flashes on before its data confirms the viewer actually
 * holds an admin role on an actual team.
 */
export function InsightsPage() {
  const client = useDataClient()
  const statusQuery = useStatus()
  const settingsQuery = useSettings()
  const [window, setWindow] = useState<Window>(30)

  const hasError = statusQuery.isError || settingsQuery.isError
  if (hasError) {
    return (
      <div className="insights-page">
        <p className="insights-error" role="alert">Couldn't reach the daemon. {errorMessage(statusQuery.error ?? settingsQuery.error)}</p>
      </div>
    )
  }

  const ready = statusQuery.data !== undefined && settingsQuery.data !== undefined
  if (!ready) {
    return <div className="insights-page" />
  }

  const solo = statusQuery.data?.solo ?? true
  const role = settingsQuery.data?.team?.role ?? null
  const isTeamAdmin = role === 'owner' || role === 'admin'
  const authorized = !solo && client.capabilities.teamAdminSupported && isTeamAdmin

  if (!authorized) {
    return (
      <div className="insights-page">
        <p className="insights-restricted">Insights is available to team owners and admins.</p>
      </div>
    )
  }

  const team = settingsQuery.data.team
  const teamLabel = team ? `${team.name} · ${team.memberCount} members` : null

  return <InsightsContent window={window} onWindowChange={setWindow} teamLabel={teamLabel} />
}
