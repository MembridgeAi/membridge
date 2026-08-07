import { memo, useCallback } from 'react'
import { Link } from 'wouter'
import { Avatar } from '../../components/Avatar'
import { projectHref } from '../../app/routes'
import { Sparkline } from '../../components/Sparkline'
import { SyncStateView } from '../../components/SyncState'
import type { Project } from '../../data/types'

interface ProjectRowProps {
  project: Project
  /** id -> display name, built from whatever this screen has actually seen
   *  (live sessions). A member never observed there falls back to their raw
   *  id -- Today has no member roster to resolve against (that's Members'
   *  getMembers(), not consumed here). */
  memberNames: Record<string, string>
  /** Takes the project path itself, rather than being pre-bound per row, so
   *  the caller can pass a mutation's own stable `.mutate` reference straight
   *  through (TodayPage.tsx) instead of a fresh closure on every render --
   *  that stability is what lets React.memo below actually skip work on
   *  Today's 10s poll tick when this project's own data hasn't changed. */
  onSyncProject: (path: string) => void
  /** True while THIS project's sync request is in flight (Fix 9) -- the
   *  caller compares its mutation's variables against this row's path, so a
   *  pending sync on one project never disables another row's button. */
  syncPending?: boolean
  /** T-78: on a solo install (or a signed-out one) the Shared/Private tag is
   *  hidden entirely. `project.shared` on this row is derived from whatever
   *  `.membridge/team.json` happens to sit next to the source (a stray copy
   *  from a teammate's clone marks a private project as team-linked), so a
   *  "Shared" chip pointed at a team the user is not on is worse than absent
   *  — a decorative <span> with no click handler leaves them no way to
   *  disagree. Passed as a prop rather than read here so React.memo's shallow
   *  equality can skip re-renders when the flag hasn't changed. */
  soloView?: boolean
}

/** One "Projects · this week" row: name/tag/avatars + latest summary on the
 *  left, a right-anchored metric+sync line with the sparkline directly
 *  beneath it on the right. `data-testid="project-row"` per the task brief.
 *
 *  Wrapped in React.memo (perf, spec §7): Today polls every 10s, and a poll
 *  that returns identical data must not repaint every row -- react-query's
 *  structural sharing already keeps an unchanged `project` object's identity
 *  stable across a poll, so memo here only re-renders a row whose own data
 *  actually changed. */
function ProjectRowImpl({ project, memberNames, onSyncProject, syncPending, soloView }: ProjectRowProps) {
  const behind = project.sync.state === 'behind'
  const handleSync = useCallback(() => onSyncProject(project.path), [onSyncProject, project.path])
  // One announced label for the avatar group below. Same treatment, and the
  // same reason, as ProjectPage's header stack: recentAuthorIds is who has
  // SHOWN UP here lately, and a row of unlabelled faces sitting immediately
  // right of the Shared/Private tag states the share roster whether it means to
  // or not. The set genuinely cannot answer that (see its doc in types.ts), so
  // the faces get named for what they are.
  //
  // Falls back to the raw id, never dropping the person: memberNames here is
  // built only from what Today has actually observed (live sessions), so a
  // teammate active earlier in the week is legitimately absent from it, and a
  // label that omitted them would not account for every face shown.
  const recentAuthorNames = project.recentAuthorIds.map(id => memberNames[id] ?? id)
  const hasFaces = recentAuthorNames.length > 0
  const facesLabel = `Recently active here: ${recentAuthorNames.join(', ')}`
  return (
    <div className="project-row" data-testid="project-row">
      <div className="project-left">
        <div className="project-left-top">
          {/* The name is the way in. This row named a project, showed a week
              of its activity, and then gave the reader nowhere to take it --
              projectHref keeps the target identical to the one the Projects
              table builds, so the two screens can never point apart. */}
          <Link href={projectHref(project.path)} className="project-name">{project.name}</Link>
          {!soloView && (
            <span className={`tag ${project.shared ? 'tag-team' : 'tag-private'}`}>
              {project.shared ? 'Shared' : 'Private'}
            </span>
          )}
          {/* Gated on a non-empty set, the same way ProjectPage's header stack
              is. An empty span still costs .project-left-top's 8px flex gap, so
              a project with no recent authors used to sit with a visible hole
              between its Shared/Private tag and nothing at all. */}
          {hasFaces && (
            <span
              className="project-faces"
              role="img"
              aria-label={facesLabel}
              title={facesLabel}
            >
              {project.recentAuthorIds.map(id => (
                <Avatar key={id} id={id} name={memberNames[id] ?? id} size={16} />
              ))}
            </span>
          )}
        </div>
        {project.latestSummary && (
          <div className="project-summary">
            {project.latestSummary.text}
            <span className="project-summary-by">, {project.latestSummary.author}</span>
          </div>
        )}
      </div>
      <div className="project-right">
        <div className="project-metric-line">
          <span className="mono project-metric">{project.sessionsThisWeek} sessions · last 7 days</span>
          <SyncStateView state={project.sync} onSync={behind ? handleSync : undefined} syncPending={syncPending} />
        </div>
        <Sparkline values={project.dailyCounts} muted={project.sync.state !== 'up-to-date'} />
      </div>
    </div>
  )
}

export const ProjectRow = memo(ProjectRowImpl)
