import { useState } from 'react'
import { Link } from 'wouter'
import { projectHref } from '../../app/routes'
import { DaemonErrorBanner, daemonErrorOf } from '../../components/DaemonError'
import { LoadingRows } from '../../components/LoadingBlock'
import { StatStrip, type StatItem } from '../../components/StatStrip'
import { useDataClient } from '../../data/DataClientProvider'
import { useInsights, useSettings, useStatus } from '../../data/queries'
import type { AssistsStats, Insights, SkeletonStats } from '../../data/types'
import { AssistsBreakdown } from './AssistsBreakdown'
import { PersonBars } from './PersonBars'
import { ProblemGroup } from './ProblemList'
import './insights.css'

// Named WindowDays, never `Window` (Fix 14c): a local type called Window
// shadowed the global DOM Window type, and a `window` state variable
// shadowed globalThis.window -- any future `window.x` in this file would
// silently read the number 30 instead of the browser window.
type WindowDays = 7 | 30 | 90
const WINDOWS: WindowDays[] = [7, 30, 90]

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

// The headline stat (spec: "answered by our memory first should be a
// better stat -- it should be any instance where the memory helped").
// `total` already sums every channel AssistsBreakdown lists below it, by
// construction (lib/api-insights.js assistsFrom) -- this only formats it.
function assistsHeadlineValue(assists: AssistsStats): string {
  return assists.available ? formatCount(assists.total) : 'pending'
}

function trendNote(deltaPct: number | null, windowDays: number): string | undefined {
  if (deltaPct === null) return undefined
  return `${deltaPct > 0 ? '+' : ''}${deltaPct}% vs prev ${windowDays}d`
}

function deltaNote(delta: number | null): string | undefined {
  if (delta === null) return undefined
  return `${delta > 0 ? '+' : ''}${delta}`
}

// Counts are exact: 027_team_feed_counts.sql counts in the database, so the
// figure is the real total however large the window. The only time that is
// not true is a backend predating that migration, where the paged fallback
// can still run out of pages -- `exact: false` with `truncated: true`. That
// combination is the ONLY thing this note is for, and it should never be
// seen against a current backend.
const CAP_NOTE = 'approximate — this MemBridge server is out of date'

// For a figure that is a floor because the feed fetch stopped short, rather
// than because the server is old. Separate from CAP_NOTE on purpose: the fix
// for CAP_NOTE is upgrading the backend, and upgrading does NOT extend the
// feed fetch -- it only makes the two headline counts exact.
const COVERAGE_NOTE = 'a floor — part of the window was unread'

// Shown wherever a figure reads "pending" (a fresh install whose ledger has
// nothing yet): names what it's waiting on so it doesn't read as stuck.
const PENDING_NOTE = 'No data yet — fills in as your tools run'

function countValue(count: number, capped: boolean): string {
  return capped ? `≥${formatCount(count)}` : formatCount(count)
}

function toCsvCell(value: string | number): string {
  let s = String(value)
  // Formula-injection guard (Fix 14b): a TEXT cell starting with =, +, - or
  // @ executes as a formula when the export lands in Excel/Sheets, and
  // person names, project names and problem headlines are all text this app
  // does not author. The leading apostrophe is the standard neutralizer
  // (spreadsheets render it as plain text). Numbers are never escaped --
  // they are this export's own figures, not attacker-influenceable text.
  if (typeof value === 'string' && /^[=+\-@]/.test(s)) s = `'${s}`
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsvRow(cells: (string | number)[]): string {
  return cells.map(toCsvCell).join(',')
}

// Every figure here already lives in the fetched Insights payload -- this is
// a pure client-side transform, never a new number, never a dollar amount.
// Exported for the formula-escaping tests only.
export function buildCsv(insights: Insights): string {
  const lines: string[] = [
    toCsvRow(['metric', 'value']),
    toCsvRow(['window_days', insights.window]),
    // Carried as its own row rather than by decorating the counts: a
    // spreadsheet wants those cells numeric, and "≥2000" is a string that
    // silently stops summing. When this is true every count below is a
    // lower bound, because the feed fetch stopped at its page cap.
    toCsvRow(['feed_truncated', insights.truncated ? 'true' : 'false']),
    // T-71: the actual reach of the paged fetch, in days. On an untruncated
    // fetch this equals window * 2; on a truncated fetch it shrinks to the
    // floor the fetch hit. Carried as its own numeric row (not folded into a
    // decoration on window_days) so a spreadsheet can compare requested vs
    // reached without parsing a string. Named `feed_covered_days` to match
    // `feed_truncated` above rather than the daemon's internal `lookbackDays`,
    // which is the SAME NUMBER (#79 commit body) -- one name here, one name
    // there, no helper across them.
    toCsvRow(['feed_covered_days', insights.coveredDays]),
    toCsvRow(['sessions', insights.sessions.count]),
    toCsvRow(['members_syncing_ok', insights.membersSyncing.ok]),
    toCsvRow(['members_syncing_total', insights.membersSyncing.total]),
    toCsvRow(['entries_shared', insights.entriesShared.count]),
    toCsvRow(['repeat_file_opens', insights.skeleton.available ? insights.skeleton.repeatOpens : 'pending']),
    toCsvRow(['answered_by_memory_first', insights.skeleton.available ? insights.skeleton.answeredFirst : 'pending']),
    toCsvRow(['memory_assists_total', insights.assists.available ? insights.assists.total : 'pending']),
    toCsvRow(['assists_recall_served', insights.assists.available ? insights.assists.byKind.recallServed : 'pending']),
    toCsvRow(['assists_teammate_notes', insights.assists.available ? insights.assists.byKind.teammateNotes : 'pending']),
    // Exported as its own pair, outside the assist total, because that is
    // what it is: a coverage fraction over the memory-tool allowlist.
    toCsvRow(['mcp_tools_in_use', insights.assists.available ? insights.assists.mcpTools.inUse : 'pending']),
    toCsvRow(['mcp_tools_available', insights.assists.available ? insights.assists.mcpTools.total : 'pending']),
    '',
    toCsvRow(['person', 'sessions', 'shared']),
    ...insights.perPerson.map(p => toCsvRow([p.name, p.sessions, p.shared])),
    '',
    toCsvRow(['project', 'sessions', 'people']),
    ...insights.topProjects.map(p => toCsvRow([p.name, p.sessions, p.people])),
    '',
    toCsvRow(['problem_severity', 'headline', 'scale']),
    // The severity column follows the SCREEN, not the wire. Every problem is
    // an absence claim about a named person built from the paged feed, so when
    // that feed stopped short the page shows them as unconfirmed -- and this
    // file is the copy that gets forwarded to the person it names. Exporting
    // `broken` here while the screen says "can't tell" would let the export
    // out-claim the app it came from. `feed_truncated` above is the same fact
    // stated once; this states it per row, where the accusation is.
    ...insights.problems.map(p => toCsvRow([insights.truncated ? 'unconfirmed' : p.severity, p.headline, p.scale])),
  ]
  return lines.join('\n')
}

function exportCsv(insights: Insights): void {
  const blob = new Blob([buildCsv(insights)], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `membridge-insights-${insights.window}d.csv`
  // Fix 14a: the anchor must be IN the document when clicked (Firefox
  // ignores a click on a detached anchor), and the object URL must outlive
  // the click -- revoking synchronously raced the browser's own async fetch
  // of the blob and could yield an empty download. Deferring a tick lets the
  // download start first; the anchor is removed on the same tick.
  document.body.appendChild(link)
  link.click()
  setTimeout(() => {
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }, 0)
}

/**
 * A ruled list row in either of two shapes, chosen by which slot the caller
 * fills.
 *
 * `value` is a SHORT metric ("268 sessions") and stays on the name's line,
 * right-aligned in the nowrap `.lrow-value`. `reason` is a SENTENCE, and
 * gets its own wrapping line beneath the name instead -- the same
 * label+description shape SettingRow.tsx uses.
 *
 * The split exists because `.lrow-value` is `white-space: nowrap`, so a flex
 * item there has an intrinsic minimum equal to its full text width. Putting
 * the knowledge-concentration reason in that slot let one long sentence set
 * the minimum width of the entire 340px right column and push the page to
 * 1577px at a 1280px viewport (measured). Ellipsising it was not an option:
 * the reason is the whole point of the row, so it has to wrap, not vanish.
 */
function LRow({ name, sub, value, reason, href }: { name: string; sub?: string; value?: string; reason?: string; href?: string }) {
  return (
    <div className="lrow">
      <div className="lrow-label">
        <span className="lrow-name">
          {href ? <Link href={href} className="lrow-link">{name}</Link> : name} {sub && <span className="lrow-muted">{sub}</span>}
        </span>
        {reason && <div className="lrow-reason">{reason}</div>}
      </div>
      {value && <span className="mono lrow-value">{value}</span>}
    </div>
  )
}

/**
 * Shown only when the payload admits the team-feed fetch stopped at its page
 * cap. Until this existed, a window that was cut short looked exactly like one
 * that was honoured: picking 90 days on a team with real history produced the
 * same page as picking 30, because both saturate the same cap, and nothing on
 * screen said the extra 60 days were never read.
 *
 * TWO CASES, chosen by whether the current window itself is short.
 *
 *   * `coveredDays < windowDays` -- the current window is CUT. The reader is
 *     looking at rows from the last `coveredDays` days when they asked for
 *     the last `windowDays`. Everything on the page is a floor of a genuinely
 *     truncated view. This is the ticket's headline case ("30 days requested,
 *     12 days reached") and the sentence names both numbers.
 *
 *   * `coveredDays >= windowDays` (but still truncated) -- the current window
 *     is whole and the PRIOR one is short, so the year-over-year figure
 *     (delta) is what got capped. The daemon nulls those deltas already, but
 *     the reader should still know why the trend cell is empty.
 *
 * `coveredDays` is what the notice quotes; `lookbackDays` is the same integer
 * under the daemon's own name and reads as "in the last Nd" inside a problem's
 * scale line. Kept separate on purpose: a helper that abstracts across them
 * is how the two names drift when the daemon later diverges them, and picking
 * one per site + citing the other in a comment is the discipline (see #79
 * commit body).
 */
function TruncationNotice({ windowDays, coveredDays }: { windowDays: number; coveredDays: number }) {
  const currentWindowCut = coveredDays < windowDays
  return (
    <div className="insights-truncated" role="status" data-testid="insights-truncated">
      {/* Glyph and words in one run, same rule StateChip follows: the amber
          tint must not be the only thing carrying "attention" here. */}
      {currentWindowCut ? (
        <>
          <p className="insights-truncated-head">
            ⚠ {windowDays} days requested, {coveredDays} days reached
          </p>
          <p className="insights-truncated-body">
            The team feed stopped at its page limit, and it reads newest first — so the oldest {windowDays - coveredDays}
            {' '}days of what you asked for were never read. Every figure here, including who looks quiet, is a floor
            over the {coveredDays} days that were.
          </p>
        </>
      ) : (
        <>
          <p className="insights-truncated-head">
            ⚠ The comparison against the previous {windowDays} days is capped
          </p>
          <p className="insights-truncated-body">
            The last {windowDays} days are complete, but the fetch stopped {coveredDays} days back — so the
            trend against the previous {windowDays} days is unavailable, and any teammate who last shared
            more than {coveredDays} days ago is not visible here.
          </p>
        </>
      )}
    </div>
  )
}

// The four stat labels, and the two section headings the loading frame below
// reuses, hoisted so the frame and the loaded page cannot drift apart. A
// loading strip that shows three cells for a page that renders four, or a
// heading that changes wording when the data lands, is a layout jump plus a
// second reading of the same page.
const STAT_SESSIONS = 'sessions'
const STAT_ASSISTS = 'times memory helped'
const STAT_SYNCING = 'members syncing'
const STAT_SHARED = 'memory entries shared'
const SECT_PEOPLE = 'Activity by person'
const SECT_MEMORY = 'How well shared memory is working'

// Four labelled cells with no figures. Not a zero in sight: GET
// /api/team/insights takes 3.6-4.0s on a real install (measured), and for all
// of it this page used to render an empty <div> and then a bare "Loading…"
// with no frame at all.
const LOADING_STATS: StatItem[] = [STAT_SESSIONS, STAT_ASSISTS, STAT_SYNCING, STAT_SHARED]
  .map(label => ({ value: null, label }))

interface InsightsHeaderProps {
  teamLabel: string | null
  windowDays: WindowDays
  onWindowChange: (w: WindowDays) => void
  /** Omitted while the payload is in flight. There is nothing to export yet,
   *  and an absent control is honest where a disabled one is a dead button --
   *  the same call TodayPage makes about its missing whole-account digest. */
  onExport?: () => void
}

/** Title, team label, window selector, export. Shared by the loading frame
 *  and the loaded page so the header does not move when the data lands.
 *
 *  The window selector stays LIVE during loading on purpose: a 30-day window
 *  that takes four seconds is exactly when a reader wants to ask for 7
 *  instead, and disabling the control would make them wait out an answer they
 *  have already decided against. */
function InsightsHeader({ teamLabel, windowDays, onWindowChange, onExport }: InsightsHeaderProps) {
  return (
    <div className="insights-header">
      <h1 className="insights-title">Insights</h1>
      {teamLabel && <span className="mono insights-count">{teamLabel}</span>}
      <div className="insights-header-actions">
        <div className="seg" role="group" aria-label="Time window">
          {WINDOWS.map(w => (
            <button
              key={w}
              type="button"
              aria-pressed={w === windowDays}
              className={w === windowDays ? 'seg-btn seg-btn-on' : 'seg-btn'}
              onClick={() => onWindowChange(w)}
            >
              {w} days
            </button>
          ))}
        </div>
        {onExport && (
          <button type="button" className="insights-btn-ghost" onClick={onExport}>
            Export CSV
          </button>
        )}
      </div>
    </div>
  )
}

interface InsightsContentProps {
  windowDays: WindowDays
  onWindowChange: (w: WindowDays) => void
  teamLabel: string | null
}

/** The data-fetching half of the page. Split out from InsightsPage so
 *  useInsights() -- and therefore GET /api/team/insights -- only fires once
 *  this actually mounts, which InsightsPage gates on the viewer being an
 *  owner/admin on a team. A member navigating here directly never triggers
 *  this component, and so never triggers the request. */
function InsightsContent({ windowDays, onWindowChange, teamLabel }: InsightsContentProps) {
  const insightsQuery = useInsights(windowDays)

  // Full error page only for a first-load failure (no data at all); a failed
  // refetch with cached data degrades to the inline banner below instead of
  // blanking a populated screen every time the daemon hiccups.
  const daemonError = daemonErrorOf([insightsQuery])
  if (daemonError?.blocking) {
    return (
      <div className="insights-page">
        <p className="insights-error" role="alert">Couldn't reach MemBridge.</p>
        <p className="insights-foot">{errorMessage(daemonError.error)}</p>
      </div>
    )
  }
  // The whole page frame, immediately, with bars where the figures will be.
  // This branch used to be a bare "Loading…" paragraph with no header, no stat
  // strip and no columns, so the 3.6-4.0s GET /api/team/insights was spent on
  // a screen that carried neither the answer nor the shape of it -- and then
  // the entire layout arrived at once.
  if (!insightsQuery.data) {
    return (
      <div className="insights-page">
        <InsightsHeader teamLabel={teamLabel} windowDays={windowDays} onWindowChange={onWindowChange} />
        <StatStrip items={LOADING_STATS} />
        <div className="insights-cols">
          <div className="insights-colL">
            <div className="insights-sect">{SECT_PEOPLE}</div>
            <LoadingRows rows={3} label="Loading activity by person" testId="insights-people-loading" />
            <div className="insights-sect">{SECT_MEMORY}</div>
            <LoadingRows rows={2} label="Loading how well shared memory is working" />
          </div>
          <div className="insights-colR">
            <LoadingRows rows={3} label="Loading problems" testId="insights-problems-loading" />
          </div>
        </div>
      </div>
    )
  }

  const insights = insightsQuery.data
  const broken = insights.problems.filter(p => p.severity === 'broken')
  const minor = insights.problems.filter(p => p.severity === 'minor')

  const stats: StatItem[] = [
    {
      value: countValue(insights.sessions.count, insights.truncated),
      label: STAT_SESSIONS,
      note: insights.truncated ? CAP_NOTE : trendNote(insights.sessions.deltaPct, windowDays),
    },
    {
      value: assistsHeadlineValue(insights.assists),
      label: STAT_ASSISTS,
      // Unlike the windowed cells around it, this is cumulative: assistsFrom
      // (lib/api-insights.js) sums savingsPayload's per-project ledger totals
      // with no window filter, so the honest scope is all time, not windowDays.
      note: insights.assists.available ? 'all time' : PENDING_NOTE,
    },
    {
      // `ok` counts members with a row in the fetched window, so a fetch that
      // stopped short can only ever UNDERCOUNT it -- which makes the plain
      // fraction read as a diagnosis of the people it left out. Marked as a
      // floor for the same reason the two counts either side of it are.
      value: `${countValue(insights.membersSyncing.ok, insights.truncated)}/${insights.membersSyncing.total}`,
      label: STAT_SYNCING,
      // "ok" = members who have shared into the window; the rest we can only
      // observe as quiet, never diagnose as broken (their machine is not
      // visible from here), so the unequal note states what we can see. Under
      // truncation we cannot even say that much: "1 hasn't shared recently" is
      // a claim about a person built from a window that was never fully read.
      note: insights.truncated
        ? COVERAGE_NOTE
        : insights.membersSyncing.ok === insights.membersSyncing.total
          ? 'all healthy'
          : `${insights.membersSyncing.total - insights.membersSyncing.ok} haven't shared recently`,
    },
    {
      value: countValue(insights.entriesShared.count, insights.truncated),
      label: STAT_SHARED,
      note: insights.truncated ? CAP_NOTE : deltaNote(insights.entriesShared.delta),
    },
  ]

  return (
    <div className="insights-page">
      {daemonError && <DaemonErrorBanner className="insights-error" error={daemonError.error} />}
      <InsightsHeader
        teamLabel={teamLabel}
        windowDays={windowDays}
        onWindowChange={onWindowChange}
        onExport={() => exportCsv(insights)}
      />

      {/* Above the figures, not below them: it changes how every number on the
          page should be read, so it cannot be a footnote they scroll past.
          Sized from `insights.window` rather than the selector's state -- the
          notice is a statement about THIS payload, and the two can only ever
          drift apart in the direction of naming a window the data is not for. */}
      {insights.truncated && <TruncationNotice windowDays={insights.window} coveredDays={insights.coveredDays} />}

      <StatStrip items={stats} />

      <div className="insights-cols">
        <div className="insights-colL">
          <div className="insights-sect">
            {SECT_PEOPLE} <span className="insights-hint">sessions · summaries shared</span>
          </div>
          <PersonBars people={insights.perPerson} />

          <div className="insights-sect">
            {SECT_MEMORY} <span className="insights-hint">last {windowDays} days</span>
          </div>
          <div className="skeleton-panel" data-testid="skeleton-panel">
            <div className="lrow" role="row">
              <span className="lrow-name">Repeat file opens</span>
              <span className="mono lrow-value" title={insights.skeleton.available ? undefined : PENDING_NOTE}>
                {insights.skeleton.available ? formatCount(insights.skeleton.repeatOpens) : 'pending'}
              </span>
            </div>
            <div className="lrow" role="row">
              <span className="lrow-name">Answered by our memory first</span>
              <span className="mono lrow-value lrow-value-good" title={insights.skeleton.available ? undefined : PENDING_NOTE}>
                {insights.skeleton.available
                  ? `${formatCount(insights.skeleton.answeredFirst)} · ${headlinePercentLabel(insights.skeleton)}`
                  : 'pending'}
              </span>
            </div>
          </div>
          <p className="insights-foot">
            Repeat file opens: a file a past session already read, opened again. Answered first: how often
            memory served it before the re-read — higher is better.
          </p>

          <div className="insights-sect">
            Where memory helped <span className="insights-hint">behind the headline above</span>
          </div>
          <AssistsBreakdown assists={insights.assists} />

          <div className="insights-sect">Most active projects</div>
          {insights.topProjects.map(p => (
            <LRow key={p.name} name={p.name} sub={`${p.people} ${p.people === 1 ? 'person' : 'people'}`} value={`${formatCount(p.sessions)} sessions`} />
          ))}
        </div>

        <div className="insights-colR">
          {/* THE ONE CLAIM ON THIS PAGE THAT NAMES A PERSON, and it is drawn
              from the same fetch the cap truncates. lib/api-insights.js builds
              `problems` from silentTeammateProblems and nothing else, so every
              problem here is "nothing has arrived from <name>", derived from
              rows the fetch may simply never have reached. A teammate who
              shared 40 days into a 90-day window that only reached back 12
              days produces a byte-identical payload to one who has genuinely
              gone quiet -- so under truncation this section cannot be Broken
              ("nothing is reaching the team" is exactly what is unestablished)
              and it cannot be empty-noted "Nothing is broken right now"
              either. Both are the same defect the rest of this page was just
              fixed for: an unknown rendered as an answer.

              Deliberately ALL problems rather than only the ones whose id
              starts with `silent:`. Matching on the id shape would silently
              restore full confidence to any future problem the daemon adds,
              and a new problem is far likelier to be another read of the same
              capped feed than a local certainty. Over-qualifying is visible
              and recoverable; a false accusation about a named colleague is
              neither. */}
          {insights.truncated ? (
            <ProblemGroup
              testId="problems-unconfirmed"
              tone="unconfirmed"
              title="Can't tell"
              hint="the window was cut short, so silence here may be unread data"
              problems={insights.problems}
              emptyNote="Nobody looked quiet in the part that was read."
            />
          ) : (
            <>
              <ProblemGroup testId="problems-broken" tone="broken" title="Broken" hint="nothing is reaching the team" problems={broken} emptyNote="Nothing is broken right now." />
              <ProblemGroup testId="problems-minor" tone="minor" title="Minor" hint="isolated, no action needed" problems={minor} emptyNote="No minor issues." />
            </>
          )}

          <div className="insights-sect">
            Knowledge concentration <span className="insights-hint">who is the only one who has touched a project</span>
          </div>
          {/* The footnote below tells the reader the fix is "one toggle on
              the project page" and, until now, gave them no way to reach it:
              they had to memorise the name, walk to Projects, and find it.
              Insights carries a project NAME and no path (lib/api-insights.js
              groups by project_id and emits projectName), which the project
              route already accepts -- ProjectPage looks a slug up by path and
              falls back to a name match for exactly this. */}
          {insights.concentration.map(c => (
            <LRow
              key={c.projectName}
              name={c.projectName}
              href={projectHref(c.projectName)}
              reason={`${c.onlyPerson} only · ${c.detail}`}
            />
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
 * defaults to no-team/no-role, same as Shell.tsx and MembersPage.tsx -- this
 * screen never flashes on before its data confirms the viewer actually
 * holds an admin role on an actual team.
 */
export function InsightsPage() {
  const client = useDataClient()
  const statusQuery = useStatus()
  const settingsQuery = useSettings()
  const [windowDays, setWindowDays] = useState<WindowDays>(30)

  // Same rule as InsightsContent above: blank the page only when a failed
  // query has no data at all. A refetch failure with cached status/settings
  // proceeds -- InsightsContent renders the data and its own inline banner
  // covers the degraded state, so no second banner is stacked here.
  const outerError = daemonErrorOf([statusQuery, settingsQuery])
  if (outerError?.blocking) {
    return (
      <div className="insights-page">
        <p className="insights-error" role="alert">Couldn't reach MemBridge.</p>
        <p className="insights-foot">{errorMessage(outerError.error)}</p>
      </div>
    )
  }

  const ready = statusQuery.data !== undefined && settingsQuery.data !== undefined
  if (!ready) {
    // Was `<div className="insights-page" />` -- a literally empty element, so
    // the window was blank while getSettings() fanned out to /api/settings +
    // /api/status + /api/team (measured: ~250ms, dominated by /api/team).
    //
    // Deliberately NOT the full frame InsightsContent's loading branch uses:
    // this runs BEFORE the role check below, and the window selector and stat
    // labels are the authorized page's furniture. A member who typed this URL
    // must not watch the admin page assemble itself and then be told no. The
    // title is the exception, and it is not a leak -- it is the app answering
    // "where am I" about a route the user chose.
    return (
      <div className="insights-page">
        <div className="insights-header">
          <h1 className="insights-title">Insights</h1>
        </div>
        <LoadingRows rows={3} label="Loading insights" testId="insights-outer-loading" />
      </div>
    )
  }

  const role = settingsQuery.data?.team?.role ?? null
  const isTeamAdmin = role === 'owner' || role === 'admin'
  // Membership, not `solo` -- the same correction Shell.tsx already carries.
  // `solo` answers "is anyone else actually here", which it derives from
  // whether a LINKED PROJECT belongs to a multi-member team. That is a
  // different question from "do you have a team", and gating on it locked the
  // owner of a real team out of their own Insights whenever no project
  // happened to be linked. Membership is what authorization actually turns on;
  // an owner with a team of one still owns the team.
  const onTeam = !!settingsQuery.data?.team
  const authorized = onTeam && client.capabilities.teamAdminSupported && isTeamAdmin

  if (!authorized) {
    return (
      <div className="insights-page">
        <p className="insights-restricted">Insights is available to team owners and admins.</p>
      </div>
    )
  }

  const team = settingsQuery.data.team
  const teamLabel = team ? `${team.name} · ${team.memberCount} members` : null

  return <InsightsContent windowDays={windowDays} onWindowChange={setWindowDays} teamLabel={teamLabel} />
}
