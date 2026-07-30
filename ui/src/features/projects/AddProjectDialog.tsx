import { useState, type FormEvent } from 'react'
import { FormDialog } from '../../components/FormDialog'
import { useAddProject } from '../../data/queries'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

interface AddProjectDialogProps {
  onClose: () => void
}

/** "Add project" — a single path field, POST /api/projects/add
 *  (DataClient.addProject). Not destructive, but still an overlay: same
 *  FormDialog shell every other Settings/Members dialog uses. */
export function AddProjectDialog({ onClose }: AddProjectDialogProps) {
  const [path, setPath] = useState('')
  const addProject = useAddProject()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = path.trim()
    if (!trimmed) return
    try {
      await addProject.mutateAsync(trimmed)
      onClose()
    } catch {
      // addProject.isError renders the message below; nothing else to do.
    }
  }

  return (
    <FormDialog titleId="add-project-title" title="Add project">
      <form onSubmit={handleSubmit}>
        <label className="dialog-field">
          Folder path
          <div className="dialog-field-hint">The full path to a project on this machine.</div>
          <input
            className="dialog-input"
            value={path}
            onChange={e => setPath(e.target.value)}
            placeholder="/Users/you/code/my-project"
            aria-label="Folder path"
            autoFocus
          />
        </label>
        {addProject.isError && (
          <p className="dialog-error" role="alert">{errorMessage(addProject.error)}</p>
        )}
        <div className="dialog-actions">
          <button type="button" className="dialog-btn" onClick={onClose} disabled={addProject.isPending}>
            Cancel
          </button>
          <button type="submit" className="dialog-btn dialog-btn-primary" disabled={addProject.isPending || !path.trim()}>
            Add project
          </button>
        </div>
      </form>
    </FormDialog>
  )
}
