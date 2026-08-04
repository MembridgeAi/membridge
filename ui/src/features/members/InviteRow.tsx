import { Avatar } from '../../components/Avatar'
import { expiresIn } from '../../data/relativeTime'
import type { Invite } from '../../data/types'

interface InviteRowProps {
  invite: Invite
  pending: boolean
  onRevoke: (inviteId: string) => void
}

/** A pending invite LINK.
 *
 * The mockup (team-v1b.html) shows an addressee and a "Resend" button; neither
 * is rendered here because neither exists. public.invites has no email column
 * and POST /api/team/invite accepts no email, so there is nobody to name and
 * no mail-delivery path anywhere in this codebase to resend through. What the
 * row shows instead is what an invite link actually is: a bearer secret,
 * anyone holding it can redeem it, with an expiry and a use budget.
 *
 * "Revoke" is real (`DataClient.revokeInvite`), and it targets `invite.id` --
 * the token itself, which is what revoke_invite(p_token) matches.
 */
export function InviteRow({ invite, pending, onRevoke }: InviteRowProps) {
  return (
    <div className="invite-row">
      <Avatar id={invite.id} name="" size={19} />
      {/* The token is the secret, so only a short prefix is shown: enough to
          tell two invites apart when deciding which to revoke, without
          rendering a working join credential into a screenshot. */}
      <span className="mono invite-email">{invite.id.slice(0, 8)}…</span>
      <span className="tag tag-invited">Invite link</span>
      <span className="invite-expiry">{expiryLabel(invite)}</span>
      <span className="invite-uses">{usesLabel(invite)}</span>
      <div className="invite-actions">
        <button type="button" className="ghost-btn" onClick={() => onRevoke(invite.id)} disabled={pending}>
          Revoke
        </button>
      </div>
    </div>
  )
}

// A null expiry is the DEFAULT the app mints, not a missing value, so it gets
// its own honest label. Passing null to expiresIn() would render "unknown" and
// make the most common invite in the system look broken.
function expiryLabel(invite: Invite): string {
  return invite.expiresAt === null ? 'no expiry' : expiresIn(invite.expiresAt)
}

// "1 use" reads as a budget of one rather than one use spent, so the
// unlimited case is spelled out relative to what has actually happened.
function usesLabel(invite: Invite): string {
  if (invite.maxUses === null) return invite.uses === 1 ? 'used once' : `used ${invite.uses}×`
  return `${invite.uses} of ${invite.maxUses} used`
}
