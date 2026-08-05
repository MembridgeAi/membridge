import { useState } from 'react'
import { useDialogFocus } from './useDialogFocus'

interface ConfirmDialogProps {
  title: string
  message: string
  /** A second paragraph beneath `message`, for the CONSEQUENCES of the action
   *  when `message` is the thing being asked. Optional, and omitting it renders
   *  exactly what this component rendered before it existed.
   *
   *  It exists because a destructive dialog is the worst place to put a wall of
   *  text: the removal dialog had grown to five sentences in one <p>, so the
   *  part the user most needs to have read was the tail of a paragraph. Same
   *  colour and size as `message` deliberately -- this is not secondary text to
   *  be dimmed (--text3 would not clear contrast on the light theme anyway); the
   *  paragraph break IS the hierarchy. */
  detail?: string | null
  confirmLabel: string
  destructive?: boolean
  pending?: boolean
  error?: string | null
  /** How final the `error` line reads. 'error' (the default) is red: the action
   *  failed and repeating it unchanged will fail again. 'retryable' is amber:
   *  the action did not happen, nothing was changed, and the identical attempt
   *  may well succeed -- red there tells the user to go solve a problem they do
   *  not have. Callers must decide this from a machine-readable signal, never by
   *  matching on the message text. */
  errorTone?: 'error' | 'retryable'
  /** Typed-confirmation variant (Task 6): the confirm button stays disabled
   *  until the user types `requiredText` exactly. For actions whose blast
   *  radius deserves more than a click (deleting a project's memory). */
  confirmInput?: { requiredText: string; label: string }
  onConfirm: () => void
  onCancel: () => void
}

/**
 * A confirm/cancel overlay, shared across every feature that needs one
 * (Members: remove/transfer; Settings: leave team; Projects: delete). The one
 * place in this system allowed a subtle shadow (see components.css `.dialog`):
 * every resting surface elsewhere stays flat; the exception is reserved for
 * true overlays. Each caller renders at most one instance at a time.
 *
 * Modal behavior (focus into the panel, Tab trap, Escape cancels, focus
 * restored to the opener on close) comes from useDialogFocus -- Escape is
 * disabled while `pending`, matching the disabled Cancel button.
 */
export function ConfirmDialog({ title, message, detail, confirmLabel, destructive, pending, error, errorTone = 'error', confirmInput, onConfirm, onCancel }: ConfirmDialogProps) {
  const panelRef = useDialogFocus(pending ? undefined : onCancel)
  const [typed, setTyped] = useState('')
  const confirmBlocked = !!confirmInput && typed !== confirmInput.requiredText
  return (
    <div className="dialog-overlay">
      <div ref={panelRef} tabIndex={-1} className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <h2 id="confirm-dialog-title" className="dialog-title">{title}</h2>
        <p className="dialog-message">{message}</p>
        {detail && <p className="dialog-message">{detail}</p>}
        {confirmInput && (
          <input
            type="text"
            className="dialog-confirm-input"
            aria-label={confirmInput.label}
            placeholder={confirmInput.requiredText}
            value={typed}
            onChange={e => setTyped(e.target.value)}
            disabled={pending}
          />
        )}
        {/* role="alert" either way: it is the answer to something the user just
            did, so it has to be announced. Only the colour and the finality it
            implies change with the tone. */}
        {error && (
          <p
            className={errorTone === 'retryable' ? 'dialog-error dialog-error-retryable' : 'dialog-error'}
            data-tone={errorTone}
            role="alert"
          >
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="dialog-btn" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            className={`dialog-btn${destructive ? ' dialog-btn-danger' : ' dialog-btn-primary'}`}
            onClick={onConfirm}
            disabled={pending || confirmBlocked}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
