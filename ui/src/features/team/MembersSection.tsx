import { useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { LoadingBlock, LoadingRows } from '../../components/LoadingBlock'
import { useDataClient } from '../../data/DataClientProvider'
import {
  useAccessMatrix, useInvites, useMembers, useRemoveMember, useRevokeInvite, useSetMemberRole,
  useSettings, useStatus,
} from '../../data/queries'
import type { AccessMatrix, Member, Role } from '../../data/types'
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

type PendingAction = { kind: 'remove'; member: Member }

/** At most this many project names get spelled out in the removal warning; the
 *  rest are counted. A manager who has revoked someone from a dozen projects
 *  needs the number and a couple of examples, not a paragraph of names. */
const NAMED_PROJECT_CAP = 4

/**
 * Shared projects this member is explicitly blocked from, by project name.
 *
 * Gated on `row.shared` deliberately: the daemon fills `access` with `true`
 * for every member of an UNSHARED project (lib/api-access.js accessMatrix), so
 * a private project can never appear here -- but a `false` read without that
 * gate would still be the wrong question to ask of a row that has no team
 * link at all. Sorted so the same set of blocks always reads the same way.
 *
 * `undefined` matrix (still loading, or the read failed) answers [], which
 * collapses to the dialog's existing text. Silence is the honest floor here:
 * the warning is additive information, and a manager must never be prevented
 * from removing someone because an access read did not come back.
 */
function revokedProjectNames(matrix: AccessMatrix | undefined, memberId: string): string[] {
  return (matrix?.rows ?? [])
    .filter(row => row.shared && row.access[memberId] === false)
    .map(row => row.projectName)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * The sentence pair appended to the removal dialog when the member being
 * removed carries per-project revokes.
 *
 * Why it exists: public.project_access cascades on the team_members foreign
 * key, so removing a member deletes their revokes along with their membership.
 * The good half of that is well understood -- no stale GRANT is inherited on a
 * rejoin. The mirror half is not: no stale REVOKE is inherited either, so
 * revoke someone from a project, remove them, re-invite them, and the project
 * is visible to them again with nothing anywhere having said so. Removal is
 * the last moment this information both exists and is about to be destroyed,
 * which is why it is said here and not at invite time (an invite is a bearer
 * token with no addressee -- see the Team page's share control).
 *
 * Empty string when there is nothing to warn about: deliberately NOT a
 * reassuring "no blocks to lose" line, which would be a claim the matrix
 * cannot make when it failed to load.
 */
function revokeWarning(name: string, projects: string[]): string {
  if (projects.length === 0) return ''
  const named = projects.slice(0, NAMED_PROJECT_CAP).join(', ')
  const rest = projects.length - NAMED_PROJECT_CAP
  const list = rest > 0 ? `${named}, and ${rest} more` : named
  const one = projects.length === 1
  return ` ${name} is currently blocked from ${projects.length} shared ${one ? 'project' : 'projects'}`
    + ` (${list}). Removing ${name} deletes ${one ? 'that block' : 'those blocks'}:`
    + ` if ${name} rejoins later, ${one ? 'that project becomes' : 'those projects become'} visible again,`
    + ` and you would have to re-apply ${one ? 'the block' : 'the blocks'} by hand.`
}

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
      {/* Names the list and legends its three columns: without a label the
          first thing an owner reads is a bare token string with no clue it's
          the invite link's id. */}
      <div className="section-label">Outstanding invite links · token · uses · expiry</div>
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
  // Count only -- see the banner below for why there is no per-member chip.
  const keyAlerts = statusQuery.data?.encryption.keyAlerts ?? 0
  const settingsQuery = useSettings()
  const membersQuery = useMembers()

  // One useSetMemberRole() now, where there used to be two. The second backed
  // a transfer-ownership flow that could never succeed: set_role (migration
  // 002) raises "role must be admin or member", and no transfer_ownership RPC
  // exists in any migration, so the control was removed rather than left to
  // fail silently. See the note in MemberRow.tsx before re-adding either.
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
  // The REAL viewer id from GET /api/team, never a hardcoded placeholder: a
  // sentinel never matches a real user id, which silently disabled the
  // own-row guard (no menu on your own row) in production once already.
  const viewerId = settingsQuery.data?.viewerId ?? null

  const ready = statusQuery.data !== undefined && settingsQuery.data !== undefined && membersQuery.data !== undefined
  const members = sortMembers(membersQuery.data ?? [])

  // Read on mount rather than when the dialog opens, and gated on the same
  // owner/admin check as the removal control itself -- the endpoint is
  // manager-only anyway (lib/api-access.js accessMatrix 403s a member). The
  // ['accessMatrix'] key is shared with the Projects grid, so arriving from
  // there costs nothing; the warning has to be on screen the moment the dialog
  // is, since an admin who has already read the dialog and clicked Remove is
  // not helped by information that lands afterwards.
  const matrixQuery = useAccessMatrix(canManage)
  const revokedProjects = pendingAction
    ? revokedProjectNames(matrixQuery.data, pendingAction.member.id)
    : []

  function requestRemove(member: Member) {
    setPendingError(null)
    setPendingAction({ kind: 'remove', member })
  }
  function cancelPending() {
    setPendingAction(null)
    setPendingError(null)
  }
  async function confirmPending() {
    if (!pendingAction) return
    try {
      await removeMember.mutateAsync(pendingAction.member.id)
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
        {/* `members` is `membersQuery.data ?? []`, so this read "0 members" on
            a two-person team for 1,224ms (measured). The heading keeps its slot;
            it just does not put a number in it until one has been counted. */}
        <span className="mono team-members-count">
          {ready
            ? `${members.length} ${members.length === 1 ? 'member' : 'members'}`
            : <><LoadingBlock variant="short" /><span className="sr-only">Loading member count</span></>}
        </span>
      </div>

      {/* Key-substitution alerts. The daemon pins each teammate's encryption
          key and raises an alert when one changes underneath us -- the signal
          that someone else's account may have been taken over, and the reason
          to re-verify out of band before trusting new memory from them.
          statusPayload sends a COUNT only (state.keyAlerts is a per-member list
          the endpoint does not expose), which is why this is one banner rather
          than a chip on the named rows.

          It is here because until now this reached the UI's Status type and was
          rendered NOWHERE, while MemberRow carried a per-member chip gated on a
          field the mapper hardcoded to false. Between them the app could not
          show a key alert at all, and the silence read as "everyone verified". */}
      {keyAlerts > 0 && (
        <p className="team-key-alerts" role="status" data-testid="member-key-alerts">
          ⚠ {keyAlerts} {keyAlerts === 1 ? 'teammate’s encryption key has' : 'teammates’ encryption keys have'}
          {' '}changed since this machine pinned {keyAlerts === 1 ? 'it' : 'them'}. Re-verify out of band
          before trusting new memory from {keyAlerts === 1 ? 'that account' : 'those accounts'}.
          {/* Deliberately does not name anyone: the count is all the daemon
              sends, and guessing which member it refers to would be the same
              unearned confidence this replaced. */}
        </p>
      )}

      {canManage && <InvitesSection />}

      {setRoleFromSelect.isError && (
        <p className="members-error" role="alert">Couldn't change role. {errorMessage(setRoleFromSelect.error)}</p>
      )}

      {!ready && <LoadingRows rows={2} label="Loading the people on this team" testId="members-loading" />}
      {ready && members.map(member => (
        <MemberRow
          key={member.id}
          member={member}
          isSelf={member.id === viewerId}
          canManage={canManage}
          onSetRole={(memberId, nextRole) => setRoleFromSelect.mutate({ memberId, role: nextRole })}
          onRequestRemove={requestRemove}
        />
      ))}

      {canManage && <AuditList />}

      {pendingAction && (
        <ConfirmDialog
          title={`Remove ${pendingAction.member.name} from the team?`}
          // Two paragraphs, not one. The title asks the question and this line
          // answers it -- what removal DOES, immediately -- while everything
          // that follows from it goes in `detail` below. It was one <p> of five
          // sentences, which put the parts an admin most needs to have read at
          // the tail of a wall of text on a destructive action.
          message={`Removing ${pendingAction.member.name} cuts off access to every shared project right away.`}
          // The consequences, in the order the admin has to reason about them:
          // what reaches their machine from here, what happens to the copy
          // already on it, and then -- only when they actually hold blocks --
          // what those blocks cost to rebuild if this person comes back.
          //
          // Server-side the cut-off is real and immediate (migration 025), and
          // prune-on-revocation means their local archive for every shared
          // project is cleaned up the next time their machine syncs, but a
          // device that never syncs again keeps whatever it already has, and
          // nothing here can reach it. All three said plainly, since the
          // confirm dialog is where the admin forms their expectation.
          //
          // revokeWarning contributes an empty string when they hold no blocks,
          // and when the matrix is still loading or failed -- so this collapses
          // to exactly the sentences above in every one of those cases.
          detail={`Nothing new reaches their machine. Anything already synced there gets removed the next time it checks in, but a device that never syncs again keeps its copy, and we can't reach it.${revokeWarning(pendingAction.member.name, revokedProjects)}`}
          confirmLabel="Remove from team"
          destructive
          pending={removeMember.isPending}
          error={pendingError}
          onConfirm={confirmPending}
          onCancel={cancelPending}
        />
      )}
    </section>
  )
}
