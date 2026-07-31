import { useEffect, useRef, useState } from 'react'
import { Avatar } from '../../components/Avatar'
import { StateChip } from '../../components/StateChip'
import { relativeAgo } from '../../data/relativeTime'
import type { Member, Role } from '../../data/types'

// The one machine running this UI cannot see a teammate's daemon, so the
// only honest thing to say is when something last arrived from them — never
// a diagnosis of why nothing has (see Member.lastSharedAt in data/types.ts).
function sharedLabel(iso: string | null): string {
  return iso ? `last shared ${relativeAgo(iso)}` : 'nothing shared yet'
}

interface MemberRowProps {
  member: Member
  isSelf: boolean
  canManage: boolean
  viewerIsOwner: boolean
  onSetRole: (memberId: string, role: Role) => void
  onRequestRemove: (member: Member) => void
  onRequestTransfer: (member: Member) => void
}

/**
 * One member row. The owner's row always shows a fixed "Owner" label —
 * never a select, never an overflow menu (there is nothing to change or
 * remove on the one owner from here; transfer happens FROM another row).
 * A plain member viewer (canManage=false) sees the same facts read-only:
 * no select, no menu — those are owner/admin actions.
 */
export function MemberRow({ member, isSelf, canManage, viewerIsOwner, onSetRole, onRequestRemove, onRequestTransfer }: MemberRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const moreBtnRef = useRef<HTMLButtonElement>(null)

  // Fix 11: a keyboard- or selection-driven close puts focus back on the ⋯
  // button that opened the menu, so a keyboard user isn't dumped at the top
  // of the document. An outside CLICK deliberately does not refocus -- the
  // user just pointed somewhere else, and yanking focus back would fight
  // that.
  function closeMenuAndRestoreFocus() {
    setMenuOpen(false)
    moreBtnRef.current?.focus()
  }

  useEffect(() => {
    if (!menuOpen) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeMenuAndRestoreFocus()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [menuOpen])

  const isOwnerRow = member.role === 'owner'
  // "Change role" lives ONLY in the select below, not duplicated as a menu
  // item -- see the report for why a second control doing the same thing
  // was left out rather than added.
  const showRoleSelect = canManage && !isOwnerRow
  const showMenu = canManage && !isSelf && !isOwnerRow

  return (
    <div className="member-row" data-testid={`member-row-${member.id}`}>
      <div className="member-id">
        <Avatar id={member.id} name={member.name} size={19} />
        <div>
          <div className="member-name">{member.name}</div>
          <div className="mono member-email">{member.email}</div>
        </div>
      </div>

      <div className="member-mid">
        {isOwnerRow ? (
          <span className="tag tag-owner">Owner</span>
        ) : showRoleSelect ? (
          <select
            className="role-select"
            aria-label={`Role for ${member.name}`}
            value={member.role}
            onChange={e => onSetRole(member.id, e.target.value as Role)}
          >
            <option value="admin">Admin</option>
            <option value="member">Member</option>
          </select>
        ) : (
          <span className="member-role-text">{member.role}</span>
        )}

        <span className="mono kvi">{member.projectCount} {member.projectCount === 1 ? 'project' : 'projects'}</span>
        <span className="kvi">{sharedLabel(member.lastSharedAt)}</span>
        {member.keyAlert && <StateChip tone="warn" glyph="⚠">key changed</StateChip>}

        {showMenu && (
          <div className="member-menu" ref={menuRef}>
            <button
              ref={moreBtnRef}
              type="button"
              className="more"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`More actions for ${member.name}`}
              onClick={() => setMenuOpen(v => !v)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="member-menu-list" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="member-menu-item"
                  onClick={() => { closeMenuAndRestoreFocus(); onRequestRemove(member) }}
                >
                  Remove from team
                </button>
                {viewerIsOwner && (
                  <button
                    type="button"
                    role="menuitem"
                    className="member-menu-item"
                    onClick={() => { closeMenuAndRestoreFocus(); onRequestTransfer(member) }}
                  >
                    Transfer ownership
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
