import { useState, type FormEvent } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { FormDialog } from '../../components/FormDialog'
import { useDisbandTeam, useLeaveTeam, useMembers, useTransferOwnership } from '../../data/queries'
import type { TeamSummary } from '../../data/types'

/**
 * The irreversible operations, gathered at the foot of the Team tab.
 *
 * WHY THEY ARE COLLECTED RATHER THAN SCATTERED. Each of these was reachable
 * from somewhere else, or from nowhere at all: Leave lived only in Settings,
 * and transfer and disband did not exist. Putting them together, last, behind
 * one red heading, is the GitHub arrangement and it earns its place for the
 * same reason -- you cannot reach one of them while looking for something
 * else.
 *
 * WHAT IS DELIBERATELY NOT HERE: removing a member. That control already
 * exists inline on each person's row in MembersSection, which is a better
 * place for it -- you pick the person by looking at them, not by finding
 * their name in a list detached from their role and their activity. Moving it
 * here would trade a direct affordance for a modal, and GitHub keeps member
 * removal in the member list too.
 *
 * ROLE SHAPES (owner's call, 2026-08-12):
 *   owner, others present -> Transfer ownership. Leave is shown DISABLED with
 *     the reason, because leave_team refuses owners (045:96) and a handover is
 *     the only exit that exists.
 *   owner, last member    -> Disband. There is nobody to transfer to, so it is
 *     the only exit, and with one member it can only destroy the owner's own
 *     memory.
 *   admin or member       -> Leave. Disband is owner-only; transfer is not
 *     theirs to make.
 */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

type ActiveDialog = 'leave' | 'transfer' | 'disband' | null

export function DangerZone({ team }: { team: TeamSummary }) {
  const isOwner = team.role === 'owner'
  // `memberCount` is nullable -- the daemon reports null when it has not
  // resolved the roster. null is treated as "not the last member", never as
  // "probably one": guessing wrong in that direction offers a disband to
  // someone with teammates, which is the one outcome the member gate exists
  // to prevent.
  const isLastMember = team.memberCount === 1

  const [active, setActive] = useState<ActiveDialog>(null)
  const [error, setError] = useState<string | null>(null)
  const leaveTeam = useLeaveTeam()
  const disbandTeam = useDisbandTeam()
  const transferOwnership = useTransferOwnership()
  // Only fetched when the transfer dialog is actually open: this is a roster
  // round trip, and nothing else on this panel needs it.
  const membersQuery = useMembers(active === 'transfer')
  // The viewer IS the owner wherever this list is used, and a team has exactly
  // one owner, so dropping the owner row drops the viewer without needing a
  // viewer id to compare against.
  const candidates = (membersQuery.data ?? []).filter(m => m.role !== 'owner')

  function close() { setActive(null); setError(null) }

  // Shared by leave and disband: on success the dialog closes, on failure it
  // stays open holding the daemon's own words. Both are irreversible, so a
  // dialog that closed on a rejected write would report success by
  // disappearing -- this repo's characteristic bug, in UI form.
  async function run(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      setActive(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function submitTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const userId = String(new FormData(event.currentTarget).get('newOwner') || '')
    if (!userId) return
    setError(null)
    try {
      await transferOwnership.mutateAsync({ teamId: team.id, userId })
      setActive(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <section className="team-card danger-zone" aria-labelledby="danger-zone-heading">
      <h2 className="danger-zone-title" id="danger-zone-heading">Danger zone</h2>

      {isOwner && !isLastMember && (
        <div className="danger-row">
          <div className="danger-row-text">
            <div className="danger-row-label">Transfer ownership</div>
            <p className="danger-row-desc">
              Hand this team to another member. You stay on the team as an admin, and you'll be able to leave afterwards.
            </p>
          </div>
          <button type="button" className="danger-btn" onClick={() => { setError(null); setActive('transfer') }}>
            Transfer ownership
          </button>
        </div>
      )}

      {isOwner && isLastMember && (
        <div className="danger-row">
          <div className="danger-row-text">
            <div className="danger-row-label">Disband this team</div>
            <p className="danger-row-desc">
              Deletes the team and everything synced to it — every project, and every memory entry in them. This cannot be undone.
            </p>
          </div>
          <button type="button" className="danger-btn" onClick={() => { setError(null); setActive('disband') }}>
            Disband team
          </button>
        </div>
      )}

      {!isLastMember && (
        <div className="danger-row">
          <div className="danger-row-text">
            <div className="danger-row-label">Leave {team.name}</div>
            <p className="danger-row-desc">
              {isOwner
                ? "The owner can't leave. Transfer ownership to someone else first, then you can go."
                : "You'll lose access to every project this team shares. What you've already shared stays with the team."}
            </p>
          </div>
          <button
            type="button"
            className="danger-btn"
            disabled={isOwner}
            title={isOwner ? 'Transfer ownership first.' : undefined}
            onClick={() => { setError(null); setActive('leave') }}
            data-testid="danger-leave"
          >
            Leave team
          </button>
        </div>
      )}

      {active === 'leave' && (
        <ConfirmDialog
          title={`Leave ${team.name}?`}
          message="You'll lose access to every project this team shares, and to your teammates' memory. What you've already shared stays with the team — remove it separately with Delete my data in Settings."
          confirmLabel="Leave team"
          destructive
          pending={leaveTeam.isPending}
          error={error}
          onConfirm={() => run(() => leaveTeam.mutateAsync(team.id))}
          onCancel={close}
        />
      )}

      {active === 'disband' && (
        <ConfirmDialog
          title={`Disband ${team.name}?`}
          // The count is not stated here because this panel does not have it.
          // Naming a number it has not counted would be worse than naming
          // none: the one screen where a figure must be true is the one a
          // person reads before agreeing to destroy something.
          message="This deletes the team and everything synced to it — every project, and every memory entry in them. It cannot be undone, and there is no recovery window."
          confirmLabel="Disband team"
          destructive
          confirmInput={{ requiredText: 'DELETE', label: 'Type DELETE to confirm' }}
          pending={disbandTeam.isPending}
          error={error}
          onConfirm={() => run(() => disbandTeam.mutateAsync(team.id))}
          onCancel={close}
        />
      )}

      {active === 'transfer' && (
        <FormDialog titleId="transfer-owner-title" title="Transfer ownership" onClose={close}>
          <form onSubmit={submitTransfer}>
            <label className="dialog-field" htmlFor="new-owner-select">
              New owner
              <div className="dialog-field-hint">
                They become the owner and you become an admin. Only the new owner can undo this.
              </div>
              {membersQuery.isPending && <p className="dialog-field-hint">Loading the roster…</p>}
              {!membersQuery.isPending && candidates.length === 0 && (
                <p className="dialog-field-hint">
                  There is nobody else on this team to transfer to.
                </p>
              )}
              {candidates.length > 0 && (
                <select id="new-owner-select" name="newOwner" className="dialog-input" defaultValue={candidates[0].id}>
                  {candidates.map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              )}
            </label>
            {error && <p className="dialog-error" role="alert">Couldn't transfer ownership. {error}</p>}
            <div className="dialog-actions">
              <button type="button" className="dialog-btn" onClick={close} disabled={transferOwnership.isPending}>
                Cancel
              </button>
              <button
                type="submit"
                className="dialog-btn dialog-btn-primary"
                disabled={transferOwnership.isPending || candidates.length === 0}
              >
                {transferOwnership.isPending ? 'Transferring…' : 'Transfer ownership'}
              </button>
            </div>
          </form>
        </FormDialog>
      )}
    </section>
  )
}
