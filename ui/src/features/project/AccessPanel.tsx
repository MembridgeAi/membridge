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
 * That consequence sentence used to say a toggled-off member "can't see
 * this project's memory or activity" -- true for the server (migration 025
 * covers memory_entries RLS, project_stats, and team_feed), but false as a
 * blanket claim: searchMemory on their own machine reads local state plus a
 * durable on-disk archive and never consults the backend, so entries
 * already synced before the toggle stay readable by their local tools until
 * that archive ages out or is overwritten.
 *
 * Prune-on-revocation has since shipped: the next time the member's machine
 * syncs, its cached rows for this project are dropped, the on-disk archive
 * is pruned, and MCP search stops serving it -- their own local entries are
 * never touched. A read-path guard also stops a flagged project from
 * answering before that sync lands. None of that reaches a machine that
 * never syncs again; nothing client-side can purge a remote copy, so that
 * case is stated as a fact, not softened into "may". The note below carries
 * all three: revoked now, cleaned up next sync, untouched if it never syncs.
 *
 * Edge case NOT covered by this note: revoking a member's LAST remaining
 * shared project (toggling them off here when this happens to be the only
 * project they can still see) hits the backend's own ambiguity -- an empty
 * project_stats result from visibleProjectIds (lib/teamsync.js) can't be
 * told apart from a backend that simply couldn't answer, so that probe
 * deliberately fails safe and skips pruning rather than risk wiping a
 * member's whole archive on a false signal. This component doesn't try to
 * detect that moment and warn differently, because it has no reliable way
 * to: Member.projectCount (data/types.ts) is capped to whatever /api/feed
 * page is in hand and counts authored activity, not current access grants,
 * so it cannot safely answer "is this their only project?". Future dev: if
 * a real per-member accessible-project count ever becomes available here,
 * revisit this to surface the fail-safe explicitly at that moment.
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
          {row.name} loses access to this project right away — nothing new reaches their machine. Anything already synced there gets removed the next time it checks in, but a device that never syncs again keeps its copy — we can't reach it.
        </p>
      ))}
      <div className="access-default">
        <span className="access-default-label">New members join with access</span>
        <Toggle on={defaultAccess} onChange={onToggleDefault} label="New members join with access" />
      </div>
    </div>
  )
}
