import { useState, type FormEvent } from 'react'
import { Link } from 'wouter'
import { ROUTES } from '../../app/routes'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { FormDialog } from '../../components/FormDialog'
import { useLeaveTeam, useRenameTeam, useRotateInviteCode } from '../../data/queries'
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
