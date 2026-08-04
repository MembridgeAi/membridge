import { expiresIn } from '../../data/relativeTime'
import type { Invite } from '../../data/types'

interface InviteRowProps {
  invite: Invite
  pending: boolean
  onRevoke: (inviteId: string) => void
}

/** How many people can still use this link. "unlimited" and a real cap are
 *  different facts and are worded differently; a used-up invite is still
 *  shown, because "5 of 5 used" is exactly what someone chasing a link that
 *  stopped working needs to see. */
function usesLabel(invite: Invite): string {
  if (invite.maxUses === null) return `${invite.useCount} used · unlimited`
  return `${invite.useCount} of ${invite.maxUses} used`
}

/**
 * One outstanding invite link.
 *
 * It used to render `invite.email` — a field the daemon has never been able
 * to fill, because nothing in this product mails an invite, so the row showed
 * a permanently blank address. It now shows what an invite actually is: the
 * token, how much life it has left, and how many times it has been redeemed.
 * The token is the credential, so it is shown in full rather than masked —
 * this panel is owner/admin-only and its whole purpose is letting them match
 * a link they handed out against the row that revokes it.
 *
 * There is still no "Resend": nothing in this codebase can deliver mail.
 */
export function InviteRow({ invite, pending, onRevoke }: InviteRowProps) {
  return (
    <div className="invite-row" data-testid={`invite-row-${invite.id}`}>
      <span className="mono invite-token">{invite.id}</span>
      <span className="invite-uses">{usesLabel(invite)}</span>
      <span className="invite-expiry">
        {invite.expiresAt ? expiresIn(invite.expiresAt) : 'never expires'}
      </span>
      <div className="invite-actions">
        <button
          type="button"
          className="ghost-btn"
          aria-label={`Revoke invite ${invite.id}`}
          onClick={() => onRevoke(invite.id)}
          disabled={pending}
        >
          Revoke
        </button>
      </div>
    </div>
  )
}
