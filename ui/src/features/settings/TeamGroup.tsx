import { useState, type FormEvent } from 'react'
import { Link } from 'wouter'
import { ROUTES } from '../../app/routes'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { FormDialog } from '../../components/FormDialog'
import { useLeaveTeam, useRenameTeam, useRotateInviteCode } from '../../data/queries'
import type { Role, Settings } from '../../data/types'
import { DeleteMyDataDialog } from './DeleteMyDataDialog'
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
  const [deleting, setDeleting] = useState(false)
  // The code a rotation just minted. NOT the only place a code is displayed
  // (see inviteCode below) -- it is an override for the window before the
  // refreshed /api/settings read catches up, on the same "the mutation result
  // is the newer truth about the same thing" precedent as the MCP rows.
  const [rotatedTo, setRotatedTo] = useState<string | null>(null)
  // 'copied' is set ONLY by a clipboard write that resolved, matching
  // TeamPage's share flow -- a denied or unavailable clipboard must never read
  // as a success and leave someone pasting nothing. The code stays on screen
  // either way, so a failed copy just needs saying.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [error, setError] = useState<string | null>(null)

  const inviteCode = rotatedTo ?? team.inviteCode

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
      // The old code is on the clipboard and in someone's draft message; a
      // stale "copied" beside the NEW value would be a lie.
      setCopyState('idle')
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  // The code is a shared secret: it is never logged, never interpolated into an
  // error message, and the failure path below reports only that the copy did
  // not happen.
  async function copyInviteCode(code: string) {
    if (!navigator.clipboard?.writeText) {
      setCopyState('failed')
      return
    }
    try {
      await navigator.clipboard.writeText(code)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
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
          leaked code had no in-app fix at all.

          The code itself is now the row's PERSISTENT value. Before, rotation
          stashed the new code in local state with no copy affordance, it
          vanished on navigation, and the current code was displayed nowhere in
          the app -- so the only route back to a code you had to send teammates
          was rotating again, which invalidated the one you may have just sent.
          Rotation updates this value in place: exactly one code on screen, and
          it is always the live one. */}
      {isTeamAdmin && (
        <SettingRow
          label="Invite code"
          description="Share this with a teammate to let them join. Rotate it if it has been shared somewhere it shouldn't be — that also cancels every invite link you've handed out."
          testId="setting-invite-code"
        >
          {inviteCode
            ? (
              <>
                <span className="mono settings-value">{inviteCode}</span>
                <button type="button" className="settings-btn" onClick={() => copyInviteCode(inviteCode)}>
                  Copy
                </button>
                {copyState === 'copied' && <span className="settings-metric">copied</span>}
                {copyState === 'failed' && (
                  <span className="settings-metric">couldn't copy — select it above</span>
                )}
              </>
            )
            : <span className="settings-unknown">not reported by this machine</span>}
          <button type="button" className="settings-btn" onClick={() => { setError(null); setRotating(true) }}>
            Rotate code
          </button>
        </SettingRow>
      )}

      {/* Deliberately NOT wrapped in isTeamAdmin, unlike the two rows above.
          Erasing what you wrote is not an administrative act -- see migration
          035 §1, whose DELETE policy is scoped on author_id alone precisely so
          that a plain member, an ex-member and someone whose project access
          was revoked can all still do it. */}
      <SettingRow
        label="My data"
        description="Delete everything you've synced to this team's backend. Your teammates lose these entries too, and it can't be undone."
        testId="setting-my-data"
      >
        <button type="button" className="settings-btn" onClick={() => setDeleting(true)}>
          Delete my data
        </button>
      </SettingRow>

      {deleting && <DeleteMyDataDialog onClose={() => setDeleting(false)} />}

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
