import { useState } from 'react'
import { FormDialog } from '../../components/FormDialog'
import { useSetSetting } from '../../data/queries'
import type { Settings } from '../../data/types'
import { linesToList, listToLines } from './textList'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

interface ContextFilesDialogProps {
  contextFiles: Settings['contextFiles']
  onClose: () => void
}

/**
 * "Choose files" for the Context block delivery channel: the always-on
 * targets list (config.targets, one path per line) plus the opt-in
 * extraTargets booleans (gemini/cursor/windsurf/copilot -- lib/util.js's
 * EXTRA_TARGETS, each labelled with the real file it writes). Two separate
 * POST /api/settings writes on Save (targets, then extraTargets) since
 * DataClient.setSetting is single-key; if the first succeeds and the second
 * fails, the error still surfaces and the dialog stays open rather than
 * claiming full success.
 */
export function ContextFilesDialog({ contextFiles, onClose }: ContextFilesDialogProps) {
  const [targetsText, setTargetsText] = useState(listToLines(contextFiles.targets))
  const [extraTargets, setExtraTargets] = useState(contextFiles.extraTargets)
  const setSetting = useSetSetting()

  async function handleSave() {
    try {
      await setSetting.mutateAsync({ key: 'targets', value: linesToList(targetsText) })
      await setSetting.mutateAsync({ key: 'extraTargets', value: extraTargets })
      onClose()
    } catch {
      // setSetting.isError renders the message below; nothing else to do.
    }
  }

  return (
    <FormDialog titleId="context-files-title" title="Choose context files" wide>
      <label className="dialog-field">
        Always written
        <div className="dialog-field-hint">One file per line, relative to each project's root.</div>
        <textarea
          className="dialog-textarea"
          value={targetsText}
          onChange={e => setTargetsText(e.target.value)}
          aria-label="Always-written context files"
        />
      </label>
      <div className="dialog-field">
        Also write when present
        <div className="dialog-checkboxes">
          {Object.entries(contextFiles.extraTargetFiles).map(([key, file]) => (
            <label className="dialog-checkbox-row" key={key}>
              <input
                type="checkbox"
                checked={!!extraTargets[key]}
                onChange={e => setExtraTargets(prev => ({ ...prev, [key]: e.target.checked }))}
              />
              {file}
            </label>
          ))}
        </div>
      </div>
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
