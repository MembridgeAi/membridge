import { useState } from 'react'
import { Avatar } from '../../components/Avatar'
import { useDialogFocus } from '../../components/useDialogFocus'
import type { AccessMemberRef } from './AccessSummary'

// Search appears only once the list is long enough to need it (spec: above 8
// members) -- a three-name list with a search box on top is just noise.
const SEARCH_THRESHOLD = 8

/**
 * Who this popover is about, as one value rather than a members array plus a
 * pair of booleans.
 *
 * Only an owner/admin can be told the answer at all: public.project_access's
 * select policy is `is_team_manager(team_id)`
 * (supabase/migrations/025_enforce_project_access.sql section 6), and RLS
 * FILTERS rather than errors -- so a plain member's read of that table comes
 * back empty and lib/api-access.js readAccess, whose "no row means visible"
 * default is correct for a manager, then reports every member as able to see
 * the project. A fabricated full roster instead of a 403. Hence `restricted`:
 * for a member this popover names the boundary instead of asking a question the
 * backend answers wrongly. `loading`/`error` cover the manager's own fetched
 * fallback; an empty member list is never used to mean any of the three,
 * because it reads as "nobody can see this project".
 */
export type PopoverRoster =
  | { state: 'known'; members: AccessMemberRef[]; access: Record<string, boolean> }
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'restricted' }

/**
 * The access popover behind the one Access cell (spec section 1).
 *
 * Permissions reuse the gate that already exists (showMatrix on
 * ProjectsPage): `canEdit` is true only for an owner/admin, whose toggles
 * write through useSetProjectAccess exactly as the old grid cells did. A
 * member reaches only the `restricted` state above, so they never see toggles
 * or shortcuts -- and never a list, which is the point: the backend cannot
 * tell them who has access without inventing an answer (see PopoverRoster).
 * A disabled control set was rejected for the same reason it always is here:
 * disabled toggles read as broken to a screen reader.
 *
 * The viewer's own row is always shown and never toggleable (the existing
 * self-revoke guard, unchanged). Focus behavior (trap, Escape, focus back to
 * the triggering cell) comes from the shared useDialogFocus hook.
 */
export function AccessPopover({ projectName, roster, canEdit, viewerId, onToggle, onClose }: {
  projectName: string
  roster: PopoverRoster
  canEdit: boolean
  viewerId: string | null
  onToggle: (memberId: string, canSee: boolean) => void
  onClose: () => void
}) {
  const panelRef = useDialogFocus(onClose)
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const members = roster.state === 'known' ? roster.members : []
  const access = roster.state === 'known' ? roster.access : {}
  const visible = query ? members.filter(m => m.name.toLowerCase().includes(query)) : members

  // Everyone / No one shortcuts: one write per member whose state actually
  // differs, never the viewer's own row.
  function setAll(canSee: boolean) {
    for (const m of members) {
      if (m.id === viewerId) continue
      if ((access[m.id] ?? false) !== canSee) onToggle(m.id, canSee)
    }
  }

  return (
    <div className="dialog-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={panelRef} tabIndex={-1} className="dialog access-popover" role="dialog" aria-modal="true" aria-labelledby="access-popover-title">
        <h2 id="access-popover-title" className="dialog-title">Access · {projectName}</h2>
        {/* The two fetched states are rendered as themselves rather than as an
            empty list: an empty list here MEANS "nobody can see this project",
            which is the exact wrong answer this ticket removed from the grid. */}
        {roster.state === 'restricted' && (
          <p className="access-note">
            Only owners and admins can see who has access to a project. Ask one of them if you need the list.
          </p>
        )}
        {roster.state === 'loading' && (
          <p className="access-note">Checking who can see this project…</p>
        )}
        {roster.state === 'error' && (
          <p className="access-note" role="alert">
            Couldn't load who can see this project. {roster.message}
          </p>
        )}
        {roster.state === 'known' && (
          <>
            {members.length > SEARCH_THRESHOLD && (
              <input
                type="text"
                className="access-search"
                placeholder="Search members…"
                aria-label="Search members"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            )}
            <ul className="access-list">
              {visible.map(m => {
                const self = m.id === viewerId
                return (
                  <li key={m.id} className="access-row">
                    <Avatar id={m.id} name={m.name} size={20} />
                    <span className="access-name">{m.name}</span>
                    {self && <span className="access-self-note">always (you)</span>}
                    {canEdit && !self && (
                      <input
                        type="checkbox"
                        className="access-cell"
                        checked={access[m.id] ?? false}
                        aria-label={`${m.name} can see this project`}
                        onChange={e => onToggle(m.id, e.target.checked)}
                      />
                    )}
                  </li>
                )
              })}
              {members.length === 0 && (
                <li className="access-row access-empty">No one can see this project yet.</li>
              )}
              {members.length > 0 && visible.length === 0 && (
                <li className="access-row access-empty">No members match "{search}".</li>
              )}
            </ul>
            {canEdit && (
              <div className="dialog-actions access-shortcuts">
                <button type="button" className="dialog-btn" onClick={() => setAll(true)}>Everyone</button>
                <button type="button" className="dialog-btn" onClick={() => setAll(false)}>No one</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
