import { useState } from 'react'
import { FormDialog } from '../../components/FormDialog'
import { useSetSetting } from '../../data/queries'
import { linesToList, listToLines } from './textList'

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
 */
export function EditListDialog({ titleId, title, hint, settingKey, initial, onClose }: EditListDialogProps) {
  const [text, setText] = useState(listToLines(initial))
  const setSetting = useSetSetting()

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
        <textarea
          className="dialog-textarea"
          value={text}
          onChange={e => setText(e.target.value)}
          aria-label={title}
          autoFocus
        />
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
