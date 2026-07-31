import { Avatar } from '../../components/Avatar'
import { expiresIn } from '../../data/relativeTime'
import type { Invite } from '../../data/types'

interface InviteRowProps {
  invite: Invite
  pending: boolean
  onRevoke: (inviteId: string) => void
}

/**
 * A pending invite row. The mockup (team-v1b.html) also shows a "Resend"
 * button, but there is no DataClient method that can resend an existing
 * invite — no mail-delivery path exists anywhere in this codebase — so it
 * is omitted rather than wired to nothing. "Revoke" is real
 * (`DataClient.revokeInvite`).
 */
export function InviteRow({ invite, pending, onRevoke }: InviteRowProps) {
  return (
    <div className="invite-row">
      <Avatar id={invite.id} name="" size={19} />
      <span className="mono invite-email">{invite.email}</span>
      <span className="tag tag-invited">Invited</span>
      <span className="invite-expiry">{expiresIn(invite.expiresAt)}</span>
      <div className="invite-actions">
        <button type="button" className="ghost-btn" onClick={() => onRevoke(invite.id)} disabled={pending}>
          Revoke
        </button>
      </div>
    </div>
  )
}
