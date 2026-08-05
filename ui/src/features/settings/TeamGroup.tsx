import { useState, type FormEvent } from 'react'
import { Link } from 'wouter'
import { ROUTES } from '../../app/routes'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { FormDialog } from '../../components/FormDialog'
import { useDeleteMyData, useLeaveTeam, useMyData, useRenameTeam, useRotateInviteCode } from '../../data/queries'
import type { Role, Settings } from '../../data/types'
import { SettingRow } from './SettingRow'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

function memberCountLabel(n: number): string {
  return n === 1 ? '1 member' : `${n} members`
}

function roleLabel(role: Role): string {
  return role.charAt(0).toUpperCase() + role.slice(1)
}

interface TeamGroupProps {
  team: NonNullable<Settings['team']>
}

function entriesLabel(n: number): string {
  return n === 1 ? '1 entry' : `${n.toLocaleString()} entries`
}

/**
 * Delete my synced data: the one control on this screen that destroys
 * something on the backend, and the only one deliberately made hard to reach.
 *
 * BURIED BY DESIGN, and the burial is the feature. It sits inside a collapsed
 * disclosure that is closed on load (the same shape the Projects page's
 * "Archived (N)" section uses), and the ConfirmDialog behind it requires the
 * word DELETE typed in full. Two deliberate steps before anything is
 * destroyed. Nobody reaches this by clicking around.
 *
 * NOT ROLE GATED. Rename and the invite controls above are admin-only;
 * Leave team is ungated, and so is this. Every member can erase what they
 * pushed, including a member who was demoted five minutes ago -- the backend
 * policy is scoped on authorship alone (migration 028 §1). Do not wrap this
 * in an isTeamAdmin check.
 *
 * The dialog copy has to say three things, and each one is load-bearing:
 *   1. The REAL count, from the preview query, never a vague "your data".
 *   2. That teammates keep whatever they already pulled to their machines,
 *      because this deletes backend rows and cannot reach anyone else's disk.
 *      Someone deleting for privacy reasons must not be left believing
 *      otherwise.
 *   3. That the deletion is RECORDED in the team audit trail where owners and
 *      admins can see it. Andrew's decision: people learn that here, before
 *      they act, rather than discovering it afterwards.
 */
function DeleteMyDataSection({ team }: TeamGroupProps) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const myData = useMyData(team.id, open)
  const deleteMyData = useDeleteMyData()
  const [deletedCount, setDeletedCount] = useState<number | null>(null)

  const total = myData.data?.total ?? 0
  const projects = myData.data?.projects ?? []

  // `typed` is what the person actually put in the confirmation field, sent as
  // it stands. The daemon re-checks it (lib/server.js /api/team/delete-my-data
  // refuses anything that is not the exact string), and re-typing the literal
  // here instead would have made that check a formality: the wire would say
  // DELETE whatever the field held.
  async function confirmDelete(typed: string) {
    try {
      const n = await deleteMyData.mutateAsync({ teamId: team.id, confirm: typed })
      setConfirming(false)
      setDeletedCount(n)
    } catch {
      // Swallowed here so the rejection is not unhandled, and ONLY here: the
      // dialog stays open with deleteMyData.error rendered in it. Closing on
      // failure would leave someone believing their data is gone when it is
      // not, which on this particular screen is the worst thing the UI can do.
    }
  }

  return (
    <section className="settings-danger-section">
      <button
        type="button"
        className="settings-danger-toggle"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        Danger zone
      </button>
      {open && (
        <SettingRow
          label="Delete my synced data"
          description={
            deletedCount !== null
              ? `Deleted. ${entriesLabel(deletedCount)} removed from ${team.name}.`
              : myData.isPending
                ? 'Counting what you have synced to this team...'
                : myData.isError
                  ? 'Could not read what you have synced to this team.'
                  : total === 0
                    ? `You have nothing synced to ${team.name}.`
                    : `${entriesLabel(total)} you pushed to ${team.name} are stored on the backend. Removing them is permanent, and it is recorded in the team audit trail.`
          }
          testId="setting-delete-my-data"
        >
          {deletedCount === null && (
            <button
              type="button"
              className="settings-btn settings-btn-danger"
              disabled={myData.isPending || total === 0}
              onClick={() => setConfirming(true)}
            >
              Delete my data
            </button>
          )}
        </SettingRow>
      )}

      {confirming && (
        <ConfirmDialog
          title="Delete your synced data?"
          message={
            `This permanently deletes ${entriesLabel(total)} you pushed to ${team.name}` +
            `${projects.length > 1 ? ` across ${projects.length} projects` : ''}. ` +
            'Only your own entries go; nobody else\'s are touched, and your local memory on this machine is untouched. ' +
            'Teammates keep whatever they have already pulled to their own machines, which this cannot reach. ' +
            'The deletion is recorded in the team audit trail, where the team\'s owners and admins can see that you did it.'
          }
          confirmLabel="Delete my data"
          destructive
          pending={deleteMyData.isPending}
          error={deleteMyData.isError ? errorMessage(deleteMyData.error) : null}
          confirmInput={{ requiredText: 'DELETE', label: 'Type DELETE to confirm' }}
          onConfirm={typed => { void confirmDelete(typed) }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  )
}

/** Rename, in the same FormDialog shell every other Settings edit uses. */
function RenameDialog({ team, onClose }: { team: NonNullable<Settings['team']>; onClose: () => void }) {
  const renameTeam = useRenameTeam()

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = String(new FormData(event.currentTarget).get('teamName') || '').trim()
    if (!name || name === team.name) { onClose(); return }
    try {
      await renameTeam.mutateAsync({ teamId: team.id, name })
      onClose()
    } catch {
      // renameTeam.isError renders the message below.
    }
  }

  return (
    <FormDialog titleId="rename-team-title" title="Rename team" onClose={onClose}>
      <form onSubmit={submit}>
        <label className="dialog-field">
          Team name
          <div className="dialog-field-hint">Everyone on the team sees the new name.</div>
          <input className="dialog-input" name="teamName" defaultValue={team.name} aria-label="Team name" autoFocus />
        </label>
        {renameTeam.isError && (
          <p className="dialog-error" role="alert">Couldn't rename. {errorMessage(renameTeam.error)}</p>
        )}
        <div className="dialog-actions">
          <button type="button" className="dialog-btn" onClick={onClose} disabled={renameTeam.isPending}>Cancel</button>
          <button type="submit" className="dialog-btn dialog-btn-primary" disabled={renameTeam.isPending}>Save</button>
        </div>
      </form>
    </FormDialog>
  )
}

/** The Team group: name/role/member count, Manage (admin/owner only, links
 *  to Members), Rename and Rotate invite code (both admin/owner, both
 *  previously CLI-only), and Leave team -- destructive, confirmed in a
 *  role="dialog" per the global rule, backed by DataClient.leaveTeam. */
export function TeamGroup({ team }: TeamGroupProps) {
  const isTeamAdmin = team.role === 'owner' || team.role === 'admin'
  const leaveTeam = useLeaveTeam()
  const rotateInvite = useRotateInviteCode()
  const [confirming, setConfirming] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [rotatedTo, setRotatedTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function confirmLeave() {
    try {
      await leaveTeam.mutateAsync(team.id)
      setConfirming(false)
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function confirmRotate() {
    setError(null)
    try {
      const code = await rotateInvite.mutateAsync(team.id)
      setRotating(false)
      setRotatedTo(code)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <>
      <div className="settings-group-label">Team</div>
      <SettingRow
        label={team.name}
        description={`You are the ${roleLabel(team.role)} · ${memberCountLabel(team.memberCount)}`}
        testId="setting-team"
      >
        {isTeamAdmin && <Link href={ROUTES.team} className="settings-btn">Manage</Link>}
        {isTeamAdmin && (
          <button type="button" className="settings-btn" onClick={() => setRenaming(true)}>Rename</button>
        )}
        <button type="button" className="settings-btn settings-btn-danger" onClick={() => { setError(null); setConfirming(true) }}>
          Leave team
        </button>
      </SettingRow>

      {/* The standing invite code is long-lived and unlimited-use, so a leak
          has no remedy except replacing it. That was CLI-only, which meant a
          leaked code had no in-app fix at all. */}
      {isTeamAdmin && (
        <SettingRow
          label="Invite code"
          description="Rotate it if the code has been shared somewhere it shouldn't be. This also cancels every invite link you've handed out."
          testId="setting-invite-code"
        >
          {rotatedTo
            ? <span className="mono settings-value">New code: {rotatedTo}</span>
            : (
              <button type="button" className="settings-btn" onClick={() => { setError(null); setRotating(true) }}>
                Rotate code
              </button>
            )}
        </SettingRow>
      )}

      {/* Last in the group, behind its own closed disclosure. Ungated: see
          DeleteMyDataSection's own note for why there is no isTeamAdmin here
          and why one must never be added. */}
      <DeleteMyDataSection team={team} />

      {renaming && <RenameDialog team={team} onClose={() => setRenaming(false)} />}

      {rotating && (
        <ConfirmDialog
          title="Rotate the invite code?"
          message="The current code stops working immediately, and every invite link you have already sent is cancelled with it. Anyone still holding one will need a new invite. People already on the team are unaffected."
          confirmLabel="Rotate code"
          destructive
          pending={rotateInvite.isPending}
          error={error}
          onConfirm={confirmRotate}
          onCancel={() => { setRotating(false); setError(null) }}
        />
      )}

      {confirming && (
        <ConfirmDialog
          title={`Leave ${team.name}?`}
          message="You'll lose access to every project this team shares. An owner or admin can re-invite you later."
          confirmLabel="Leave team"
          destructive
          pending={leaveTeam.isPending}
          error={error}
          onConfirm={confirmLeave}
          onCancel={() => { setConfirming(false); setError(null) }}
        />
      )}
    </>
  )
}
