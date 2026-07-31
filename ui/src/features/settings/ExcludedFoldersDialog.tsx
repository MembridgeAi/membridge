import { useState } from 'react'
import { FormDialog } from '../../components/FormDialog'
import { StateChip } from '../../components/StateChip'
import { useDataClient } from '../../data/DataClientProvider'
import { usePickPaths, useSetSetting } from '../../data/queries'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

interface ExcludedFoldersDialogProps {
  exclude: string[]
  // The subset of `exclude`, as of GET /api/settings, whose path no longer
  // exists on disk (server.js's staleExcludes). Checked against the
  // ORIGINAL list only -- a freshly typed or picked path this dialog hasn't
  // saved yet has no server-verified answer, so it never shows the badge
  // until the next load proves it one way or the other.
  excludeStale: string[]
  onClose: () => void
}

/**
 * Task 4a: excluded folders as a managed list, not a raw textarea. Every
 * entry gets its own Remove button (staged locally, committed on Save,
 * exactly like every other edit dialog on this page -- Cancel discards
 * everything), and any entry the daemon reported as no-longer-existing
 * (e.g. a leaked test fixture path) is marked stale rather than silently
 * dropped: the owner decides whether it goes, this dialog never deletes
 * anything on their behalf.
 */
export function ExcludedFoldersDialog({ exclude, excludeStale, onClose }: ExcludedFoldersDialogProps) {
  const [paths, setPaths] = useState(exclude)
  const [draft, setDraft] = useState('')
  const setSetting = useSetSetting()
  const pickPaths = usePickPaths()
  const { capabilities } = useDataClient()
  const staleSet = new Set(excludeStale)

  function handleRemove(target: string) {
    setPaths(prev => prev.filter(p => p !== target))
  }

  function handleAddDraft() {
    const trimmed = draft.trim()
    if (!trimmed) return
    setPaths(prev => (prev.includes(trimmed) ? prev : [...prev, trimmed]))
    setDraft('')
  }

  // try/catch (Fix 15): the Electron IPC call behind pickPaths CAN reject,
  // and an uncaught rejection here made the Browse click silently do
  // nothing. pickPaths.isError renders the inline message below.
  async function handleBrowse() {
    try {
      const picked = await pickPaths.mutateAsync({ kind: 'folder', multiple: true })
      if (picked.length === 0) return // cancelled -- leave the list exactly as it was
      setPaths(prev => [...prev, ...picked.filter(p => !prev.includes(p))])
    } catch {
      // pickPaths.isError renders the message below; nothing else to do.
    }
  }

  async function handleSave() {
    try {
      await setSetting.mutateAsync({ key: 'exclude', value: paths })
      onClose()
    } catch {
      // setSetting.isError renders the message below; nothing else to do.
    }
  }

  return (
    <FormDialog titleId="exclude-dialog-title" title="Excluded folders" wide onClose={onClose}>
      <div className="dialog-field">
        Never watched, never synced.
        {paths.length === 0 && <div className="dialog-field-hint">No folders excluded.</div>}
        {paths.map(p => (
          <div className="setting-row" key={p}>
            <div className="setting-row-label">
              <span className="mono">{p}</span>
              {staleSet.has(p) && (
                <div className="setting-row-desc">
                  <StateChip tone="warn" glyph="⚠">path no longer exists</StateChip>
                </div>
              )}
            </div>
            <div className="setting-row-ctl">
              <button type="button" className="settings-btn" aria-label={`Remove ${p}`} onClick={() => handleRemove(p)}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
      <label className="dialog-field">
        Add a folder
        <div className="dialog-field-hint">
          A path or glob (e.g. */node_modules).
          {!capabilities.filePicker && ' Open MemBridge.app for a Browse button — this browser tab can only take typed paths.'}
        </div>
        <input
          className="dialog-input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddDraft() } }}
          aria-label="New excluded folder"
        />
        <button type="button" className="dialog-btn" onClick={handleAddDraft} disabled={!draft.trim()}>
          Add
        </button>
        {capabilities.filePicker && (
          <button type="button" className="dialog-btn" onClick={handleBrowse} disabled={pickPaths.isPending}>
            Browse folders…
          </button>
        )}
        {pickPaths.isError && (
          <p className="dialog-error" role="alert">Couldn't open the folder picker. {errorMessage(pickPaths.error)}</p>
        )}
      </label>
      {setSetting.isError && (
        <p className="dialog-error" role="alert">{errorMessage(setSetting.error)}</p>
      )}
      <div className="dialog-actions">
        <button type="button" className="dialog-btn" onClick={onClose} disabled={setSetting.isPending}>
          Cancel
        </button>
        <button type="button" className="dialog-btn dialog-btn-primary" onClick={handleSave} disabled={setSetting.isPending}>
          Save
        </button>
      </div>
    </FormDialog>
  )
}
