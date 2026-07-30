import { useState, type FormEvent } from 'react'
import { useDataClient } from '../../data/DataClientProvider'
import {
  useInviteMember, useInvites, useMembers, useRemoveMember, useRevokeInvite,
  useSetMemberRole, useSettings, useStatus,
} from '../../data/queries'
import type { Member, Role } from '../../data/types'
import { AuditList } from './AuditList'
import { ConfirmDialog } from './ConfirmDialog'
import { InviteRow } from './InviteRow'
import { MemberRow } from './MemberRow'
import './members.css'

// Every DataClient method in this app reserves the literal id 'me' for the
// viewer (see ProjectsPage.tsx's VIEWER_ID) -- matching that convention is
// the only way this page can tell "your own row" apart from a teammate's.
const VIEWER_ID = 'me'

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
 * fires when this actually mounts. MembersPage below renders it (and
 * AuditList) only for an owner/admin viewer -- never for a member.
 */
function InvitesSection() {
  const invitesQuery = useInvites()
  const revokeInvite = useRevokeInvite()
  const invites = invitesQuery.data ?? []
  if (invitesQuery.isError || invites.length === 0) return null
  return (
    <div className="invites-section">
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
 * The team Members page: pending invites, member rows (role, project count,
 * what has actually arrived from them, and a key-changed warning), and —
 * owner/admin only — the audit trail. Matches team-v1b.html, with the
 * mockup's dead controls omitted rather than wired to nothing (see report):
 * "Copy invite link" has no backing method at all, and "Resend" on an
 * invite has no backing method distinct from minting a new invite.
 */
export function MembersPage() {
  const client = useDataClient()
  const statusQuery = useStatus()
  const settingsQuery = useSettings()
  const membersQuery = useMembers()

  const setRole = useSetMemberRole()
  const removeMember = useRemoveMember()
  const inviteMember = useInviteMember()

  const [showInviteForm, setShowInviteForm] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<Role>('member')
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [pendingError, setPendingError] = useState<string | null>(null)

  // Unknown (still loading, or failed) defaults to solo/no-role, same as
  // Shell.tsx -- a management control never flashes on before its data
  // confirms the viewer actually holds an admin role.
  const solo = statusQuery.data?.solo ?? true
  const role = settingsQuery.data?.team?.role ?? null
  const canManage = !solo && client.capabilities.teamAdminSupported && (role === 'owner' || role === 'admin')
  const viewerIsOwner = role === 'owner'

  const ready = statusQuery.data !== undefined && settingsQuery.data !== undefined && membersQuery.data !== undefined
  const hasError = statusQuery.isError || settingsQuery.isError || membersQuery.isError
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

  async function handleInviteSubmit(e: FormEvent) {
    e.preventDefault()
    try {
      await inviteMember.mutateAsync({ email: inviteEmail, role: inviteRole })
      setInviteEmail('')
      setInviteRole('member')
      setShowInviteForm(false)
    } catch {
      // inviteMember.isError renders the message below; nothing else to do.
    }
  }

  if (hasError) {
    const message = errorMessage(statusQuery.error ?? settingsQuery.error ?? membersQuery.error)
    return (
      <div className="members-page">
        <p className="members-error" role="alert">Couldn't reach the daemon. {message}</p>
      </div>
    )
  }

  return (
    <div className="members-page">
      <div className="members-header">
        <h1 className="members-title">Members</h1>
        <span className="mono members-count">{members.length} active</span>
        {canManage && (
          <div className="members-header-actions">
            <button type="button" className="members-btn members-btn-primary" onClick={() => setShowInviteForm(v => !v)}>
              Invite by email
            </button>
          </div>
        )}
      </div>

      {canManage && showInviteForm && (
        <form className="invite-form" onSubmit={handleInviteSubmit}>
          <input
            type="email"
            required
            className="invite-form-email"
            placeholder="teammate@company.com"
            aria-label="Invite email"
            value={inviteEmail}
            onChange={e => setInviteEmail(e.target.value)}
          />
          <select
            className="invite-form-role"
            aria-label="Invite role"
            value={inviteRole}
            onChange={e => setInviteRole(e.target.value as Role)}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button type="submit" className="members-btn members-btn-primary" disabled={inviteMember.isPending}>
            Send invite
          </button>
          <button type="button" className="members-btn" onClick={() => setShowInviteForm(false)}>
            Cancel
          </button>
          {inviteMember.isError && (
            <p className="invite-error" role="alert">{errorMessage(inviteMember.error)}</p>
          )}
        </form>
      )}

      <div className="members-cols">
        <div className="members-list">
          {canManage && <InvitesSection />}

          {!ready && <p className="members-empty-note">Loading…</p>}
          {ready && members.map(member => (
            <MemberRow
              key={member.id}
              member={member}
              isSelf={member.id === VIEWER_ID}
              canManage={canManage}
              viewerIsOwner={viewerIsOwner}
              onSetRole={(memberId, nextRole) => setRole.mutate({ memberId, role: nextRole })}
              onRequestRemove={requestRemove}
              onRequestTransfer={requestTransfer}
            />
          ))}
        </div>

        {canManage && (
          <div className="members-side">
            <AuditList />
          </div>
        )}
      </div>

      {pendingAction && (
        <ConfirmDialog
          title={pendingAction.kind === 'remove'
            ? `Remove ${pendingAction.member.name} from the team?`
            : `Transfer ownership to ${pendingAction.member.name}?`}
          message={pendingAction.kind === 'remove'
            ? `Removing ${pendingAction.member.name} revokes their access to every shared project immediately.`
            : `${pendingAction.member.name} becomes the team owner immediately. This can't be undone from here.`}
          confirmLabel={pendingAction.kind === 'remove' ? 'Remove from team' : 'Transfer ownership'}
          destructive={pendingAction.kind === 'remove'}
          pending={removeMember.isPending || setRole.isPending}
          error={pendingError}
          onConfirm={confirmPending}
          onCancel={cancelPending}
        />
      )}
    </div>
  )
}
