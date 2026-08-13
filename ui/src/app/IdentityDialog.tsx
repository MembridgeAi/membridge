import { useState } from 'react'
import { FormDialog } from '../components/FormDialog'
import { AvatarPicker } from '../components/AvatarPicker'
import { useSetDisplayName } from '../data/queries'

// Local, matching Shell.tsx:88, InsightsPage.tsx:22 and DaemonGroup.tsx:11.
// There is no shared export in this repo; inventing a fourth module here
// would be a refactor, not this ticket.
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

interface IdentityDialogProps {
  currentName: string
  currentAvatar: string | null
  currentAvatarColor: string | null
  viewerId: string
  onClose: () => void
}

export function IdentityDialog({
  currentName, currentAvatar, currentAvatarColor, viewerId, onClose,
}: IdentityDialogProps) {
  const [name, setName] = useState(currentName)
  const [glyph, setGlyph] = useState<string | null>(currentAvatar)
  const [colour, setColour] = useState<string | null>(currentAvatarColor)
  const save = useSetDisplayName()
  const trimmed = name.trim()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    // Refused locally: an empty name is not a question worth a round trip,
    // and the daemon answers 400 for it anyway. (The 80-char cap is enforced
    // by the input's own maxLength, so there's nothing left to check here.)
    if (!trimmed) return
    save.mutate({ name: trimmed, avatar: glyph, avatarColor: colour }, { onSuccess: onClose })
  }

  return (
    <FormDialog titleId="identity-title" title="Your name" wide onClose={onClose}>
      <form onSubmit={submit}>
        {/* Exactly the field shape TeamGroup.tsx:46-50 uses for the team
            rename. There is no .dialog-label class in components.css. */}
        <label className="dialog-field">
          Display name
          <div className="dialog-field-hint">Your teammates see this. It has to be different from theirs.</div>
          <input
            className="dialog-input"
            aria-label="Display name"
            value={name}
            maxLength={80}
            autoFocus
            onChange={e => setName(e.target.value)}
          />
        </label>

        <AvatarPicker
          name={trimmed || currentName}
          viewerId={viewerId}
          glyph={glyph}
          color={colour}
          onGlyph={setGlyph}
          onColour={setColour}
        />

        {save.isError && (
          <p className="dialog-error" role="alert">{errorMessage(save.error)}</p>
        )}

        <div className="dialog-actions">
          <button type="button" className="dialog-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="dialog-btn dialog-btn-primary"
                  disabled={!trimmed || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </FormDialog>
  )
}
