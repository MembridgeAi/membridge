import { useEffect, useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { DaemonErrorBanner, daemonErrorOf } from '../../components/DaemonError'
import { useDataClient } from '../../data/DataClientProvider'
import {
  useCreateInviteLink, useInvites, useMembers, useRemoveMember, useRevokeInvite,
  useSetMemberRole, useSettings, useStatus,
} from '../../data/queries'
import type { Member, Role } from '../../data/types'
import { AuditList } from './AuditList'
import { InviteRow } from './InviteRow'
import { MemberRow } from './MemberRow'
import './members.css'

const ROLE_WEIGHT: Record<Role, number> = { owner: 0, admin: 1, member: 2 }

function sortMembers(members: Member[]): Member[] {
  return [...members].sort((a, b) => ROLE_WEIGHT[a.role] - ROLE_WEIGHT[b.role] || a.name.localeCompare(b.name))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

type PendingAction = { kind: 'remove' | 'transfer'; member: Member }

// 'revealed' is the clipboard-unavailable-or-denied fallback: the value is
// shown in the page for the user to select and copy by hand. It must NEVER
// read as 'copied' -- a failed clipboard write that still claims success
// would leave someone pasting nothing into their teammate's invite prompt.
// `kind` tracks which of the two controls (mint-a-link vs copy-the-standing-
// code) produced the current status, so "Copied"/the revealed value renders
// next to the button that earned it, not the other one.
type InviteCopyState =
  | { status: 'idle' }
  | { status: 'copied'; kind: 'link' | 'code' }
  | { status: 'revealed'; kind: 'link' | 'code'; value: string }

/**
 * Pending invites, isolated in their own component so `getInvites()` only
 * fires when this actually mounts. MembersPage below renders it (and
 * AuditList) only for an owner/admin viewer -- never for a member.
 *
 * Finding (Part B): `revokeInvite.mutate()` fired without ever reading
 * `.isError` -- a rejected revoke looked identical to a successful one,
 * since the invite just stayed in the list either way with no explanation.
 * Now a rejection surfaces here the same way every other mutation on this
 * page does: a `role="alert"` message naming what failed.
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
 * The team Members page: pending invites, member rows (role, project count,
 * what has actually arrived from them, and a key-changed warning), and —
 * owner/admin only — the audit trail. Matches team-v1b.html. "Resend" on an
 * invite is permanently omitted -- Task 17 confirmed no mail-delivery path
 * exists anywhere in this codebase or backend for team invites, so there is
 * nothing a "resend" could honestly do. "Invite by email" is gone for the
 * same honesty reason (P0 Fix 2): no daemon endpoint accepts an email or
 * role (POST /api/team/invite mints a generic link only), so that form
 * could never do anything but reject; the invite-link/code path below is
 * the one real invite mechanism.
 *
 * "Copy invite link" (Fix 1) mints a fresh onboarding-invite token
 * (`POST /api/team/invite`, DataClient.createInviteLink) and copies
 * `${settings.webUrl}/#${token}` -- the exact shape cloudflare/join's hosted
 * page reads via `location.hash`, and the exact construction
 * cloudflare/ops-dashboard's own JOIN_BASE + token already uses. This used to
 * be labelled "Copy invite code" and copy `settings.team.inviteCode` (the
 * standing, never-rotated per-team code) instead, because
 * `teamsync.webUrl(config)` was empty in the shipped lib/backend.json --
 * building a link would have 404'd. lib/backend.json now bakes a real
 * webUrl, so the default install mints a real link. When no webUrl is
 * configured at all (a self-hosted build shipping an empty backend.json),
 * the control degrades to sharing the standing code instead of a broken URL
 * -- still labelled honestly ("Copy invite code" in that case) -- and a
 * "Copy code instead" secondary action stays available whenever both a
 * webUrl and a standing code exist, since the code still works with
 * `membridge join <code>` even when no one has a browser handy.
 */
export function MembersPage() {
  const client = useDataClient()
  const statusQuery = useStatus()
  const settingsQuery = useSettings()
  const membersQuery = useMembers()

  // Two independent useSetMemberRole() instances, not one shared between
  // both call sites: `setRole` backs the ConfirmDialog's "transfer
  // ownership" flow (awaited, its failure already surfaces via
  // pendingError below); `setRoleFromSelect` backs the inline role <select>
  // on each row. Sharing one mutation object between them would mean a
  // transfer failure and a plain role-change failure both flip the same
  // `.isError`, so a transfer error could bleed into the row-select banner
  // (or vice versa) depending on render timing.
  const setRole = useSetMemberRole()
  const setRoleFromSelect = useSetMemberRole()
  const removeMember = useRemoveMember()
  const createInviteLink = useCreateInviteLink()

  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [pendingError, setPendingError] = useState<string | null>(null)
  const [inviteCopy, setInviteCopy] = useState<InviteCopyState>({ status: 'idle' })
  const [mintError, setMintError] = useState<string | null>(null)

  // Unknown (still loading, or failed) defaults to solo/no-role, same as
  // Shell.tsx -- a management control never flashes on before its data
  // confirms the viewer actually holds an admin role.
  const solo = statusQuery.data?.solo ?? true
  const role = settingsQuery.data?.team?.role ?? null
  const canManage = !solo && client.capabilities.teamAdminSupported && (role === 'owner' || role === 'admin')
  const viewerIsOwner = role === 'owner'
  // Task 18/19: the real viewer id (settings.viewerId, from GET /api/team),
  // never a hardcoded two-letter placeholder -- a sentinel like that never
  // matches a real user id, which silently disabled the own-row guard below
  // (no menu on your own row) in production, same bug ProjectsPage.tsx had.
  const viewerId = settingsQuery.data?.viewerId ?? null

  const ready = statusQuery.data !== undefined && settingsQuery.data !== undefined && membersQuery.data !== undefined
  const members = sortMembers(membersQuery.data ?? [])
  const inviteCode = settingsQuery.data?.team?.inviteCode ?? null
  const webUrl = settingsQuery.data?.webUrl ?? null
  const teamId = settingsQuery.data?.team?.id ?? null
  // A real link can only be minted once both the hosted join page (webUrl)
  // and a team to mint it for are known; otherwise the primary action
  // degrades to sharing the standing code instead.
  const canMintLink = !!(webUrl && teamId)

  // Only the 'copied' confirmation auto-dismisses -- a revealed value stays
  // on screen until the viewer copies it themselves; hiding it after 2s
  // would defeat the whole point of revealing it.
  useEffect(() => {
    if (inviteCopy.status !== 'copied') return
    const id = setTimeout(() => setInviteCopy({ status: 'idle' }), 2000)
    return () => clearTimeout(id)
  }, [inviteCopy.status])

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

  // Clipboard failure must not claim success: a browser with no clipboard
  // API (navigator.clipboard absent -- non-HTTPS context, older WebView) or a
  // denied/failed write both fall through to 'revealed', never 'copied'.
  async function copyInviteValue(value: string, kind: 'link' | 'code') {
    if (!navigator.clipboard) {
      setInviteCopy({ status: 'revealed', kind, value })
      return
    }
    try {
      await navigator.clipboard.writeText(value)
      setInviteCopy({ status: 'copied', kind })
    } catch {
      setInviteCopy({ status: 'revealed', kind, value })
    }
  }

  // Primary action: mint a fresh onboarding-invite token and copy the real
  // join link (`${webUrl}/#${token}`). Degrades to sharing the standing code
  // when no hosted join page is configured (webUrl null) -- this never
  // produces a broken/incomplete URL, and never silently does nothing.
  async function handleCopyInvite() {
    setMintError(null)
    if (webUrl && teamId) {
      try {
        const { token } = await createInviteLink.mutateAsync(teamId)
        await copyInviteValue(`${webUrl}/#${token}`, 'link')
      } catch (err) {
        setMintError(errorMessage(err))
      }
      return
    }
    if (inviteCode) await copyInviteValue(inviteCode, 'code')
  }

  // Secondary action, only ever offered alongside the primary link button:
  // the standing code still works with `membridge join <code>` when a link
  // isn't convenient to share (no browser handy, reading it aloud, etc).
  async function handleCopyCode() {
    if (inviteCode) await copyInviteValue(inviteCode, 'code')
  }

  // Full error page only for a first-load failure (no data at all); a failed
  // refetch with cached data degrades to the inline banner below instead of
  // blanking a populated member list every time the daemon hiccups mid-poll.
  const daemonError = daemonErrorOf([statusQuery, settingsQuery, membersQuery])
  if (daemonError?.blocking) {
    return (
      <div className="members-page">
        <p className="members-error" role="alert">Couldn't reach the daemon. {errorMessage(daemonError.error)}</p>
      </div>
    )
  }

  return (
    <div className="members-page">
      {daemonError && <DaemonErrorBanner className="members-error" error={daemonError.error} />}
      <div className="members-header">
        <h1 className="members-title">Members</h1>
        <span className="mono members-count">{members.length} active</span>
        {canManage && (
          <div className="members-header-actions">
            {(canMintLink || inviteCode) && (
              <span className="invite-copy">
                <button type="button" className="members-btn" onClick={handleCopyInvite} disabled={createInviteLink.isPending}>
                  {inviteCopy.status === 'copied' && inviteCopy.kind === (canMintLink ? 'link' : 'code')
                    ? 'Copied'
                    : canMintLink ? 'Copy invite link' : 'Copy invite code'}
                </button>
                {/* Secondary, cheap escape hatch to the raw code -- only shown
                    when the primary button is minting a link, so there is
                    never a redundant second button doing the same thing the
                    primary one already does in the degraded (no webUrl) case. */}
                {canMintLink && inviteCode && (
                  <button type="button" className="members-btn" onClick={handleCopyCode}>
                    {inviteCopy.status === 'copied' && inviteCopy.kind === 'code' ? 'Copied' : 'Copy code instead'}
                  </button>
                )}
                {mintError && (
                  <p className="invite-error" role="alert">Couldn't create an invite link. {mintError}</p>
                )}
                {inviteCopy.status === 'revealed' && (
                  <span className="mono invite-code-reveal" role="status">
                    Couldn't copy automatically — copy this {inviteCopy.kind}: {inviteCopy.value}
                  </span>
                )}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="members-cols">
        <div className="members-list">
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
            // Server-side this is real and immediate (migration 025), and
            // prune-on-revocation (see AccessPanel.tsx's comment) means
            // their local archive for every shared project is cleaned up
            // the next time their machine syncs -- but a device that never
            // syncs again keeps whatever it already has; nothing here can
            // reach it. Say all three plainly, since a confirm dialog is
            // the moment the admin forms their expectation.
            ? `Removing ${pendingAction.member.name} cuts off access to every shared project right away — nothing new reaches their machine. Anything already synced there gets removed the next time it checks in, but a device that never syncs again keeps its copy — we can't reach it.`
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
