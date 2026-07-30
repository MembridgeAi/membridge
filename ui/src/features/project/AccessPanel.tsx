import { Avatar } from '../../components/Avatar'
import { RuledRow } from '../../components/RuledRow'
import { Toggle } from '../../components/Toggle'
import type { Role } from '../../data/types'

export interface AccessRow {
  id: string
  name: string
  role: Role
  canSee: boolean
}

interface AccessPanelProps {
  rows: AccessRow[]
  defaultAccess: boolean
  onToggle: (memberId: string, canSee: boolean) => void
  onToggleDefault: (next: boolean) => void
}

/**
 * "Who sees this project" — one Toggle per member (role="switch", accessible
 * name carries the member's name per Task 9), plus a consequence sentence
 * naming anyone currently hidden.
 *
 * "New members join with access" is now a real Toggle (Task 17/18): backed
 * by public.projects.default_access via POST /api/project/access-default,
 * read back from the same GET /api/project/access response as the rows
 * above (readAccess's defaultAccess field).
 */
export function AccessPanel({ rows, defaultAccess, onToggle, onToggleDefault }: AccessPanelProps) {
  const hidden = rows.filter(row => !row.canSee)
  return (
    <div className="panel">
      <div className="section-label">Who sees this project</div>
      {rows.map(row => (
        <RuledRow className="access-row" key={row.id}>
          <Avatar id={row.id} name={row.name} size={19} />
          <span className="access-name">{row.name}</span>
          <span className="access-role">{row.role}</span>
          <Toggle
            on={row.canSee}
            onChange={next => onToggle(row.id, next)}
            label={`${row.name} — sees this project`}
          />
        </RuledRow>
      ))}
      {hidden.map(row => (
        <p className="access-note" key={row.id}>
          {row.name} can't see this project's memory or activity.
        </p>
      ))}
      <div className="access-default">
        <span className="access-default-label">New members join with access</span>
        <Toggle on={defaultAccess} onChange={onToggleDefault} label="New members join with access" />
      </div>
    </div>
  )
}
