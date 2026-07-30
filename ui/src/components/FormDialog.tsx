import type { ReactNode } from 'react'

interface FormDialogProps {
  titleId: string
  title: string
  wide?: boolean
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
export function FormDialog({ titleId, title, wide, children }: FormDialogProps) {
  return (
    <div className="dialog-overlay">
      <div className={`dialog${wide ? ' dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="dialog-title">{title}</h2>
        {children}
      </div>
    </div>
  )
}
