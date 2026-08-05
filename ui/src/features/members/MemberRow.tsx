import { useEffect, useRef, useState } from 'react'
import { Avatar } from '../../components/Avatar'
import { StateChip } from '../../components/StateChip'
import { absoluteTime, relativeAgo } from '../../data/relativeTime'
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
  onSetRole: (memberId: string, role: Role) => void
  onRequestRemove: (member: Member) => void
}

/**
 * One member row. The owner's row always shows a fixed "Owner" label —
 * never a select, never an overflow menu (there is nothing to change or
 * remove on the one owner from here).
 * A plain member viewer (canManage=false) sees the same facts read-only:
 * no select, no menu — those are owner/admin actions.
 */
export function MemberRow({ member, isSelf, canManage, onSetRole, onRequestRemove }: MemberRowProps) {
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
  // !isSelf belongs on BOTH lines. It was on the menu and missing here, so an
  // admin still got a role select on their own row -- the one control that can
  // strip the viewer of the ability to use every other control on this page.
  // The daemon refuses the write regardless (set_role is owner-only, and it
  // rejects a self-targeted change outright), which makes offering the select
  // worse rather than safer: the admin picks "Member", nothing changes, and
  // the only feedback is an error explaining a rule the UI invited them to
  // break. Changing your own role is not an action this page offers.
  const showRoleSelect = canManage && !isSelf && !isOwnerRow
  const showMenu = canManage && !isSelf && !isOwnerRow

  return (
    <div className="member-row" data-testid={`member-row-${member.id}`}>
      <div className="member-id">
        <Avatar id={member.id} name={member.name} size={19} />
        {/* Name only. There was a second line here rendering `member.email`,
            which mapMember filled with '' on every row because the members RPC
            has never returned an address -- so it painted a blank 10.5px line
            under every name, reading as a field that failed to load. Same
            defect InviteRow already fixed for `invite.email`; the field is now
            gone from `Member` entirely. What the app actually knows about a
            member (role, projects posted into, last shared, key alerts) is in
            .member-mid below. Arbitrary-length user data, so it still wraps. */}
        <div>
          <div className="member-name wrap-anywhere">{member.name}</div>
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

        {/* "active in N projects", not "N projects": this counts projects the
            member has POSTED INTO (types.ts), not projects they can see. On a
            page about membership and permissions the bare noun reads as an
            access count, so a member with access to eight quiet projects
            looked like a permissions bug at "0 projects". */}
        <span className="mono kvi">active in {member.projectCount} {member.projectCount === 1 ? 'project' : 'projects'}</span>
        {/* The visible label is coarse ("2d ago"); the title pins it to the
            exact local time, so recency here is as verifiable as the audit
            trail's exact-time rows. undefined when nothing was ever shared. */}
        <span className="kvi" title={absoluteTime(member.lastSharedAt) || undefined}>{sharedLabel(member.lastSharedAt)}</span>
        {member.keyAlert && (
          <StateChip
            tone="warn"
            glyph="⚠"
            title="Their encryption key changed since you last verified them. Re-confirm out of band that it's really them before trusting new memory from this account."
          >
            key changed
          </StateChip>
        )}

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
                {/* No "Transfer ownership" here. It shipped, and it could
                    never work: it called setRole(id, 'owner'), and set_role
                    (supabase/migrations/002_team_v2.sql) raises `role must be
                    admin or member` for any p_role outside that pair. There is
                    no transfer_ownership RPC anywhere in supabase/migrations/,
                    so nothing else could have served it either. Building that
                    RPC is backend work nobody has asked for; until it exists,
                    the honest UI is no control at all. Do not re-add this item
                    without it. */}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
