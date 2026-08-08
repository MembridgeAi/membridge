import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useDeleteMyData, useMyData } from '../../data/queries'
import type { MyData } from '../../data/types'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

function entryCount(n: number): string {
  return n === 1 ? '1 entry' : `${n.toLocaleString()} entries`
}

function projectCount(n: number): string {
  return n === 1 ? '1 project' : `${n} projects`
}

/** The blast radius, in one sentence, from the BACKEND's numbers.
 *
 *  Deliberately counts projects with no local path the same as any other. A
 *  project synced only from another machine is still this user's data on the
 *  server and the delete still removes it -- excluding it here to match what
 *  this machine can see would under-report the very number the user is being
 *  asked to agree to. */
function summarize(data: MyData): string {
  return `This removes ${entryCount(data.total)} across ${projectCount(data.projects.length)} from the team's backend.`
}

interface DeleteMyDataDialogProps {
  onClose: () => void
}

/**
 * Self-serve deletion of everything the current user has synced to the team.
 *
 * Not gated on role, deliberately, and matching the DELETE policy in migration
 * 035 §1: that policy is scoped on `author_id` ALONE, without the team
 * membership or project-access predicates every other policy on the table
 * carries. Someone who left the team, or whose access to a project was
 * revoked, can still erase what they wrote -- and they are the people most
 * likely to want to. A role check in this component would put back exactly the
 * gate the migration went out of its way to leave off.
 *
 * Four states, because collapsing them lies in at least one direction:
 * loading (no number to show yet, so nothing may be confirmed), failed-to-load
 * (never offer a destructive action against an unknown blast radius), nothing
 * to delete, and the real confirmation.
 */
export function DeleteMyDataDialog({ onClose }: DeleteMyDataDialogProps) {
  // `true`: this component only mounts when the user has opened it, which is
  // the moment the preview should be read. See useMyData -- it never serves a
  // cached count here.
  const preview = useMyData(true)
  const deleteMyData = useDeleteMyData()

  if (preview.isPending) {
    return (
      <ConfirmDialog
        title="Delete my data"
        message="Checking what you have on the team's backend…"
        confirmLabel="Delete"
        destructive
        // Doubles as the disable: there is no number yet, so there is nothing
        // a person could be agreeing to.
        pending
        onConfirm={() => {}}
        onCancel={onClose}
      />
    )
  }

  if (preview.isError) {
    return (
      <ConfirmDialog
        title="Delete my data"
        message="Could not reach the team's backend to check what would be deleted."
        detail="Nothing has been changed. Close this and try again once you are back online."
        confirmLabel="Close"
        // Retryable, not an error: the read failed, nothing was written, and
        // the identical attempt may well succeed. Red here would send someone
        // to fix a problem they do not have.
        errorTone="retryable"
        error={errorMessage(preview.error)}
        onConfirm={onClose}
        onCancel={onClose}
      />
    )
  }

  const data = preview.data

  if (!data || data.total === 0) {
    return (
      <ConfirmDialog
        title="Delete my data"
        message="You have nothing synced to this team's backend."
        detail="Sessions stay on this machine until they sync. Nothing here has left it."
        confirmLabel="Close"
        onConfirm={onClose}
        onCancel={onClose}
      />
    )
  }

  return (
    <ConfirmDialog
      title="Delete my data?"
      message={summarize(data)}
      // What the count alone does not say. Teammates losing the entries is the
      // consequence people are most likely not to have considered, so it leads.
      detail="Your teammates lose these entries too — deletion is not local. It cannot be undone, and the fact that you deleted them is recorded in the team's audit trail."
      confirmLabel="Delete my data"
      destructive
      confirmInput={{ requiredText: 'DELETE', label: 'Type DELETE to confirm' }}
      pending={deleteMyData.isPending}
      error={deleteMyData.isError ? errorMessage(deleteMyData.error) : null}
      onConfirm={() => {
        // null = every project in this team. The per-project narrowing the RPC
        // supports has no UI yet; this control is deliberately the all-or-
        // nothing one, and a partial delete offered without a way to see what
        // it left behind would be worse than no partial delete.
        deleteMyData.mutate(null, { onSuccess: onClose })
      }}
      onCancel={onClose}
    />
  )
}
