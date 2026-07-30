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
  onSync: () => void
}

/** One "Projects · this week" row: name/tag/avatars + latest summary on the
 *  left, a right-anchored metric+sync line with the sparkline directly
 *  beneath it on the right. `data-testid="project-row"` per the task brief. */
export function ProjectRow({ project, memberNames, onSync }: ProjectRowProps) {
  const behind = project.sync.state === 'behind'
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
          <SyncStateView state={project.sync} onSync={behind ? onSync : undefined} />
        </div>
        <Sparkline values={project.dailyCounts} muted={project.sync.state !== 'up-to-date'} />
      </div>
    </div>
  )
}
