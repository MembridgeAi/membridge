import { useState } from 'react'
import { FormDialog } from '../../components/FormDialog'
import { useDataClient } from '../../data/DataClientProvider'
import { usePickPaths, useSetSetting } from '../../data/queries'
import { linesToList, listToLines, mergeLines } from './textList'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

interface EditListDialogProps {
  titleId: string
  title: string
  hint: string
  settingKey: 'redactExtra' | 'exclude'
  initial: string[]
  onClose: () => void
}

/**
 * One entry per line, saved as a string[] through the same POST /api/settings
 * every other Settings write goes through (DataClient.setSetting). Shared by
 * "Edit redaction patterns" (redactExtra) and "Edit excluded folders"
 * (exclude) -- both are a flat string list with no per-item metadata, so one
 * generic dialog covers both rather than two near-identical ones.
 *
 * Only the excluded-folders list gets a native Browse button: its entries
 * are real filesystem folders (picking one is the point), while
 * redactExtra's entries are regular expressions a folder/file dialog has
 * nothing to offer. The button itself only renders when the desktop app's
 * Electron bridge is present (capabilities.filePicker) -- a plain browser
 * tab falls back to the textarea's typed-path entry, same as it always has.
 */
export function EditListDialog({ titleId, title, hint, settingKey, initial, onClose }: EditListDialogProps) {
  const [text, setText] = useState(listToLines(initial))
  const setSetting = useSetSetting()
  const pickPaths = usePickPaths()
  const { capabilities } = useDataClient()
  const isFolderList = settingKey === 'exclude'
  const showBrowseButton = isFolderList && capabilities.filePicker

  async function handleBrowse() {
    const picked = await pickPaths.mutateAsync({ kind: 'folder', multiple: true })
    if (picked.length === 0) return // cancelled -- leave the list exactly as typed
    setText(prev => mergeLines(prev, picked))
  }

  async function handleSave() {
    try {
      await setSetting.mutateAsync({ key: settingKey, value: linesToList(text) })
      onClose()
    } catch {
      // setSetting.isError renders the message below; nothing else to do.
    }
  }

  return (
    <FormDialog titleId={titleId} title={title} wide>
      <label className="dialog-field">
        {hint}
        {isFolderList && !capabilities.filePicker &&
          ' Open MemBridge.app for a Browse button — this browser tab can only take typed paths.'}
        <textarea
          className="dialog-textarea"
          value={text}
          onChange={e => setText(e.target.value)}
          aria-label={title}
          autoFocus
        />
        {showBrowseButton && (
          <button type="button" className="dialog-btn" onClick={handleBrowse} disabled={pickPaths.isPending}>
            Browse folders…
          </button>
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
