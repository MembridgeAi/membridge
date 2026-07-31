import { useDialogFocus } from './useDialogFocus'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel: string
  destructive?: boolean
  pending?: boolean
  error?: string | null
  onConfirm: () => void
  onCancel: () => void
}

/**
 * A confirm/cancel overlay, shared across every feature that needs one
 * (Members: remove/transfer; Settings: leave team). The one place in this
 * system allowed a subtle shadow (see components.css `.dialog`) — every
 * resting surface elsewhere stays flat; the exception is reserved for true
 * overlays. Each caller renders at most one instance at a time.
 *
 * Modal behavior (focus into the panel, Tab trap, Escape cancels, focus
 * restored to the opener on close) comes from useDialogFocus -- Escape is
 * disabled while `pending`, matching the disabled Cancel button.
 */
export function ConfirmDialog({ title, message, confirmLabel, destructive, pending, error, onConfirm, onCancel }: ConfirmDialogProps) {
  const panelRef = useDialogFocus(pending ? undefined : onCancel)
  return (
    <div className="dialog-overlay">
      <div ref={panelRef} tabIndex={-1} className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <h2 id="confirm-dialog-title" className="dialog-title">{title}</h2>
        <p className="dialog-message">{message}</p>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="dialog-btn" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            className={`dialog-btn${destructive ? ' dialog-btn-danger' : ' dialog-btn-primary'}`}
            onClick={onConfirm}
            disabled={pending}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
