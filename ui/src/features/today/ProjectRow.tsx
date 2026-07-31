import { memo, useCallback } from 'react'
import { Avatar } from '../../components/Avatar'
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
function ProjectRowImpl({ project, memberNames, onSyncProject, syncPending }: ProjectRowProps) {
  const behind = project.sync.state === 'behind'
  const handleSync = useCallback(() => onSyncProject(project.path), [onSyncProject, project.path])
  return (
    <div className="project-row" data-testid="project-row">
      <div className="project-left">
        <div className="project-left-top">
          <span className="project-name">{project.name}</span>
          <span className={`tag ${project.shared ? 'tag-team' : 'tag-private'}`}>
            {project.shared ? 'Shared' : 'Private'}
          </span>
          <span className="project-faces">
            {project.memberIds.map(id => (
              <Avatar key={id} id={id} name={memberNames[id] ?? id} size={16} />
            ))}
          </span>
        </div>
        {project.latestSummary && (
          <div className="project-summary">
            {project.latestSummary.text}
            <span className="project-summary-by"> — {project.latestSummary.author}</span>
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
