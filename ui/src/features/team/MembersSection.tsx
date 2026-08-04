import { useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useDataClient } from '../../data/DataClientProvider'
import {
  useInvites, useMembers, useRemoveMember, useRevokeInvite, useSetMemberRole,
  useSettings, useStatus,
} from '../../data/queries'
import type { Member, Role } from '../../data/types'
import { AuditList } from '../members/AuditList'
import { InviteRow } from '../members/InviteRow'
import { MemberRow } from '../members/MemberRow'
import '../members/members.css'

const ROLE_WEIGHT: Record<Role, number> = { owner: 0, admin: 1, member: 2 }

function sortMembers(members: Member[]): Member[] {
  return [...members].sort((a, b) => ROLE_WEIGHT[a.role] - ROLE_WEIGHT[b.role] || a.name.localeCompare(b.name))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

type PendingAction = { kind: 'remove' | 'transfer'; member: Member }

/**
 * Pending invites, isolated in their own component so `getInvites()` only
 * fires when this actually mounts — it renders for an owner/admin viewer,
 * never for a plain member.
 *
 * A rejected revoke used to look identical to a successful one, since the
 * invite stayed in the list either way with no explanation; it now surfaces
 * a `role="alert"` naming what failed, like every other mutation here.
 */
function InvitesSection() {
  const invitesQuery = useInvites()
  const revokeInvite = useRevokeInvite()
  const invites = invitesQuery.data ?? []
  if (invitesQuery.isError || invites.length === 0) return null
  return (
    <div className="invites-section">
      {revokeInvite.isError && (
        <p className="invite-error" role="alert">Couldn't revoke the invite. {errorMessage(revokeInvite.error)}</p>
      )}
      {invites.map(invite => (
        <InviteRow
          key={invite.id}
          invite={invite}
          pending={revokeInvite.isPending}
          onRevoke={id => revokeInvite.mutate(id)}
        />
      ))}
    </div>
  )
}

/**
 * The roster, on the Team page.
 *
 * This was its own screen at /team/members. It is a section now because the
 * split forced the same team into two places: /team owned identity, joining
 * and the invite button, /team/members owned the people that invite produces
 * — and BOTH shipped their own "Copy invite link" control, wired to different
 * code paths. Merging removes that duplicate outright; the Team page's own
 * share control is the single one now.
 *
 * Deliberately NOT rendered for a member-role viewer: invites and the audit
 * trail are management surfaces, and per-person figures for every teammate is
 * exactly what can_see_project exists to keep from leaking sideways. The
 * member list itself is fine for anyone on the team.
 *
 * "Resend" on an invite stays permanently omitted: no mail-delivery path
 * exists in this codebase or the backend, so there is nothing it could
 * honestly do. "Invite by email" is gone for the same reason — POST
 * /api/team/invite mints a generic link and accepts neither an email nor a
 * role, so the form could only ever have rejected.
 */
export function MembersSection() {
  const client = useDataClient()
  const statusQuery = useStatus()
  const settingsQuery = useSettings()
  const membersQuery = useMembers()

  // Two independent useSetMemberRole() instances, not one shared: `setRole`
  // backs the ConfirmDialog's transfer-ownership flow (awaited, its failure
  // surfaces via pendingError), `setRoleFromSelect` backs the inline role
  // <select> on each row. One shared mutation would let a transfer failure
  // bleed into the row-select banner, or vice versa, on render timing.
  const setRole = useSetMemberRole()
  const setRoleFromSelect = useSetMemberRole()
  const removeMember = useRemoveMember()

  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [pendingError, setPendingError] = useState<string | null>(null)

  // Unknown (still loading, or failed) defaults to solo/no-role, same as
  // Shell.tsx — a management control never flashes on before its data
  // confirms the viewer actually holds an admin role.
  const solo = statusQuery.data?.solo ?? true
  const role = settingsQuery.data?.team?.role ?? null
  const canManage = !solo && client.capabilities.teamAdminSupported && (role === 'owner' || role === 'admin')
  const viewerIsOwner = role === 'owner'
  // The REAL viewer id from GET /api/team, never a hardcoded placeholder: a
  // sentinel never matches a real user id, which silently disabled the
  // own-row guard (no menu on your own row) in production once already.
  const viewerId = settingsQuery.data?.viewerId ?? null

  const ready = statusQuery.data !== undefined && settingsQuery.data !== undefined && membersQuery.data !== undefined
  const members = sortMembers(membersQuery.data ?? [])

  function requestRemove(member: Member) {
    setPendingError(null)
    setPendingAction({ kind: 'remove', member })
  }
  function requestTransfer(member: Member) {
    setPendingError(null)
    setPendingAction({ kind: 'transfer', member })
  }
  function cancelPending() {
    setPendingAction(null)
    setPendingError(null)
  }
  async function confirmPending() {
    if (!pendingAction) return
    try {
      if (pendingAction.kind === 'remove') await removeMember.mutateAsync(pendingAction.member.id)
      else await setRole.mutateAsync({ memberId: pendingAction.member.id, role: 'owner' })
      setPendingAction(null)
      setPendingError(null)
    } catch (err) {
      setPendingError(errorMessage(err))
    }
  }

  return (
    <section className="team-card team-members" aria-labelledby="team-members-heading">
      <div className="team-members-head">
        <h2 className="team-card-title" id="team-members-heading">People</h2>
        <span className="mono team-members-count">{members.length} active</span>
      </div>

      {canManage && <InvitesSection />}

      {setRoleFromSelect.isError && (
        <p className="members-error" role="alert">Couldn't change role. {errorMessage(setRoleFromSelect.error)}</p>
      )}

      {!ready && <p className="members-empty-note">Loading…</p>}
      {ready && members.map(member => (
        <MemberRow
          key={member.id}
          member={member}
          isSelf={member.id === viewerId}
          canManage={canManage}
          viewerIsOwner={viewerIsOwner}
          onSetRole={(memberId, nextRole) => setRoleFromSelect.mutate({ memberId, role: nextRole })}
          onRequestRemove={requestRemove}
          onRequestTransfer={requestTransfer}
        />
      ))}

      {canManage && <AuditList />}

      {pendingAction && (
        <ConfirmDialog
          title={pendingAction.kind === 'remove'
            ? `Remove ${pendingAction.member.name} from the team?`
            : `Transfer ownership to ${pendingAction.member.name}?`}
          message={pendingAction.kind === 'remove'
            // Server-side this is real and immediate (migration 025), and
            // prune-on-revocation means their local archive for every shared
            // project is cleaned up the next time their machine syncs — but a
            // device that never syncs again keeps whatever it already has,
            // and nothing here can reach it. All three said plainly, since
            // the confirm dialog is where the admin forms their expectation.
            ? `Removing ${pendingAction.member.name} cuts off access to every shared project right away. Nothing new reaches their machine. Anything already synced there gets removed the next time it checks in, but a device that never syncs again keeps its copy — we can't reach it.`
            : `${pendingAction.member.name} becomes the team owner immediately. This can't be undone from here.`}
          confirmLabel={pendingAction.kind === 'remove' ? 'Remove from team' : 'Transfer ownership'}
          destructive={pendingAction.kind === 'remove'}
          pending={removeMember.isPending || setRole.isPending}
          error={pendingError}
          onConfirm={confirmPending}
          onCancel={cancelPending}
        />
      )}
    </section>
  )
}
