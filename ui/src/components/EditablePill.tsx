import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

/**
 * Text that says it is editable when you point at it, and edits in place.
 *
 * WHY IT LOOKS LIKE NOTHING AT REST. The whole affordance is discoverability:
 * a team name that can be renamed looked exactly like one that could not, and
 * the only way to change it was a Rename button on a different screen. A pill
 * that is always visible would turn every editable string in the app into a
 * form field; one that appears on hover reads as "this responds to you"
 * without claiming any space until then.
 *
 * THE PILL'S GEOMETRY EXISTS AT REST, fully transparent. Border and padding
 * are painted in `transparent` rather than added on :hover, so arriving with
 * the mouse changes two colours and moves nothing. Adding the border on hover
 * instead shifts the heading by a pixel and every element after it -- the kind
 * of flinch that reads as a bug even when nobody can say what moved.
 *
 * SAVE APPEARS ONLY ONCE THE VALUE HAS CHANGED. An unchanged field offers
 * nothing to press, so the control cannot invite a write that would do
 * nothing. Enter saves, Escape cancels, and blurring with unsaved changes
 * keeps you in edit mode rather than silently discarding or silently
 * committing -- a rename is other people's business (every teammate sees the
 * new name), so neither guess is safe enough to make on a stray click.
 */

interface EditablePillProps {
  value: string
  /** Rejects to report failure; the pill keeps edit mode open and renders the
   *  message, so the typed value is never lost to a failed write. */
  onSave: (next: string) => Promise<void>
  /** False renders plain text with no pill and no affordance at all -- a
   *  member looking at a name only an admin can change must not be shown a
   *  control that would refuse them. */
  canEdit: boolean
  /** Accessible name for both the trigger and the field ("Team name"). */
  label: string
  maxLength?: number
  testId?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

export function EditablePill({ value, onSave, canEdit, label, maxLength = 60, testId }: EditablePillProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // An authoritative change from elsewhere (another machine renamed the team,
  // a refetch landed) must reach a pill that is NOT being edited. While it is
  // being edited, the person's own typing wins -- overwriting a draft with a
  // background refresh is how you lose a half-typed name to a poll.
  useEffect(() => { if (!editing) setDraft(value) }, [value, editing])

  useEffect(() => {
    if (!editing) return
    const el = inputRef.current
    if (!el) return
    el.focus()
    // Select-all rather than caret-at-end: renaming usually replaces the name
    // outright, and a caret at the end makes the common case a manual delete.
    el.select()
  }, [editing])

  const trimmed = draft.trim()
  const changed = trimmed !== value && trimmed.length > 0

  function begin() {
    if (!canEdit || pending) return
    setError(null)
    setDraft(value)
    setEditing(true)
  }

  function cancel() {
    setEditing(false)
    setDraft(value)
    setError(null)
  }

  async function commit() {
    if (!changed || pending) return
    setPending(true)
    setError(null)
    try {
      await onSave(trimmed)
      setEditing(false)
    } catch (err) {
      // Stay open, holding what was typed. The alternative -- closing and
      // reverting -- throws away the user's text to report that the server
      // did not take it, which is the worst of both.
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') { event.preventDefault(); void commit() }
    if (event.key === 'Escape') { event.preventDefault(); cancel() }
  }

  if (!canEdit) {
    return <span className="pill-static" data-testid={testId}>{value}</span>
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="pill pill-trigger"
        onClick={begin}
        // The full value stays reachable when the cap ellipsises it. The pill
        // is capped on purpose: this heading previously took an uncapped,
        // unvalidated name and a 150-character single token produced 648px of
        // horizontal scroll inside the content column.
        title={value}
        aria-label={`${label}: ${value}. Click to edit.`}
        data-testid={testId}
      >
        <span className="pill-text">{value}</span>
        <svg className="pill-pencil" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z" />
        </svg>
      </button>
    )
  }

  return (
    <span className="pill-editing-wrap">
      <span className="pill-row">
        <input
          ref={inputRef}
          className="pill pill-input"
          value={draft}
          maxLength={maxLength}
          disabled={pending}
          aria-label={label}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => { if (!changed) cancel() }}
          data-testid={testId ? `${testId}-input` : undefined}
        />
        {changed && (
          <button type="button" className="pill-save" onClick={() => { void commit() }} disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </button>
        )}
        <span className="pill-hint">esc to cancel</span>
      </span>
      {error && <span className="pill-error" role="alert">{error}</span>}
    </span>
  )
}
