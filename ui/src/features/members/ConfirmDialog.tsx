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
 * The one overlay in this page allowed a subtle shadow (see members.css
 * `.dialog`) — every resting surface elsewhere in this system stays flat.
 * Shared by the "remove member" and "transfer ownership" confirmations;
 * MembersPage renders a single instance, so only one is ever open.
 */
export function ConfirmDialog({ title, message, confirmLabel, destructive, pending, error, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div className="dialog-overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
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
