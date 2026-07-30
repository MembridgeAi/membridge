import { Avatar } from '../../components/Avatar'
import type { Invite } from '../../data/types'

const DAY_MS = 24 * 60 * 60_000

function expiryLabel(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'expired'
  const days = Math.ceil(ms / DAY_MS)
  return days === 1 ? 'expires in 1 day' : `expires in ${days} days`
}

interface InviteRowProps {
  invite: Invite
  pending: boolean
  onRevoke: (inviteId: string) => void
}

/**
 * A pending invite row. The mockup (team-v1b.html) also shows a "Resend"
 * button, but there is no DataClient method that can resend an existing
 * invite — `inviteMember` mints a brand-new one, it cannot re-notify this
 * one — so it is omitted rather than wired to nothing. "Revoke" is real
 * (`DataClient.revokeInvite`).
 */
export function InviteRow({ invite, pending, onRevoke }: InviteRowProps) {
  return (
    <div className="invite-row">
      <Avatar id={invite.id} name="" size={19} />
      <span className="mono invite-email">{invite.email}</span>
      <span className="tag tag-invited">Invited</span>
      <span className="invite-expiry">{expiryLabel(invite.expiresAt)}</span>
      <div className="invite-actions">
        <button type="button" className="ghost-btn" onClick={() => onRevoke(invite.id)} disabled={pending}>
          Revoke
        </button>
      </div>
    </div>
  )
}
