import { useState } from 'react'
import { Avatar } from '../../components/Avatar'
import { useDialogFocus } from '../../components/useDialogFocus'
import type { AccessMemberRef } from './AccessSummary'

// Search appears only once the list is long enough to need it (spec: above 8
// members) -- a three-name list with a search box on top is just noise.
const SEARCH_THRESHOLD = 8

/**
 * The access popover behind the one Access cell (spec section 1).
 *
 * Permissions reuse the gate that already exists (showMatrix on
 * ProjectsPage): `canEdit` is true only for an owner/admin, whose toggles
 * write through useSetProjectAccess exactly as the old grid cells did. A
 * member gets the SAME popover as a read-only roster: avatars and names,
 * no toggles, no shortcuts, plus a one-line note -- a plain list, never a
 * disabled control set (disabled toggles read as broken to a screen reader).
 *
 * The viewer's own row is always shown and never toggleable (the existing
 * self-revoke guard, unchanged). Focus behavior (trap, Escape, focus back to
 * the triggering cell) comes from the shared useDialogFocus hook.
 */
export function AccessPopover({ projectName, members, access, canEdit, viewerId, onToggle, onClose }: {
  projectName: string
  members: AccessMemberRef[]
  access: Record<string, boolean>
  canEdit: boolean
  viewerId: string | null
  onToggle: (memberId: string, canSee: boolean) => void
  onClose: () => void
}) {
  const panelRef = useDialogFocus(onClose)
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
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
        {!canEdit && (
          <p className="access-note">Only owners and admins change access. Everyone listed here can see this project.</p>
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
          {visible.length === 0 && <li className="access-row access-empty">No members match "{search}".</li>}
        </ul>
        {canEdit && (
          <div className="dialog-actions access-shortcuts">
            <button type="button" className="dialog-btn" onClick={() => setAll(true)}>Everyone</button>
            <button type="button" className="dialog-btn" onClick={() => setAll(false)}>No one</button>
          </div>
        )}
      </div>
    </div>
  )
}
