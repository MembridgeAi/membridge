import { useState } from 'react'
import { useDialogFocus } from './useDialogFocus'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel: string
  destructive?: boolean
  pending?: boolean
  error?: string | null
  /** Typed-confirmation variant (Task 6): the confirm button stays disabled
   *  until the user types `requiredText` exactly. For actions whose blast
   *  radius deserves more than a click (deleting a project's memory). */
  confirmInput?: { requiredText: string; label: string }
  /** Receives what the user actually TYPED into the confirmation field (the
   *  empty string when there is no field). Callers whose daemon route re-checks
   *  the word must forward this rather than re-typing the literal themselves:
   *  a hardcoded 'DELETE' on the wire makes the gate a UI formality, since the
   *  value the daemon checks would then never be the one the person typed. */
  onConfirm: (typed: string) => void
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
export function ConfirmDialog({ title, message, confirmLabel, destructive, pending, error, confirmInput, onConfirm, onCancel }: ConfirmDialogProps) {
  const panelRef = useDialogFocus(pending ? undefined : onCancel)
  const [typed, setTyped] = useState('')
  const confirmBlocked = !!confirmInput && typed !== confirmInput.requiredText
  return (
    <div className="dialog-overlay">
      <div ref={panelRef} tabIndex={-1} className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <h2 id="confirm-dialog-title" className="dialog-title">{title}</h2>
        <p className="dialog-message">{message}</p>
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
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="dialog-btn" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            className={`dialog-btn${destructive ? ' dialog-btn-danger' : ' dialog-btn-primary'}`}
            onClick={() => onConfirm(typed)}
            disabled={pending || confirmBlocked}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
