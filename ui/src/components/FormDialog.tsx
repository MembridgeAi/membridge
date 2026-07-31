import type { ReactNode } from 'react'
import { useDialogFocus } from './useDialogFocus'

interface FormDialogProps {
  titleId: string
  title: string
  wide?: boolean
  /** Called on Escape (Fix 11) -- the same "discard and close" the caller's
   *  own Cancel button performs. Optional only for back-compat; every
   *  caller should pass it. */
  onClose?: () => void
  children: ReactNode
}

/**
 * The overlay shell for a small edit form (Settings' choose-files/edit-list
 * dialogs, Projects' add-project dialog) — same overlay/panel/title as
 * ConfirmDialog, but leaves the body (fields, error, Save/Cancel actions) to
 * the caller, since each of those forms owns different fields and mutation
 * state. `.dialog-message`, `.dialog-error`, `.dialog-actions` and
 * `.dialog-btn*` (components.css) are the shared vocabulary callers render
 * their body with.
 */
export function FormDialog({ titleId, title, wide, onClose, children }: FormDialogProps) {
  // The modal half of aria-modal's promise (focus in, Tab trap, Escape
  // closes, focus restored to the opener) -- shared with ConfirmDialog via
  // useDialogFocus so the two can't drift.
  const panelRef = useDialogFocus(onClose)
  return (
    <div className="dialog-overlay">
      <div ref={panelRef} tabIndex={-1} className={`dialog${wide ? ' dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="dialog-title">{title}</h2>
        {children}
      </div>
    </div>
  )
}
