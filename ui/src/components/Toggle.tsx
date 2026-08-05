interface ToggleProps {
  on: boolean
  onChange: (next: boolean) => void
  label: string
  /** A write for this switch is in flight. The switch keeps showing the value
   *  the user just chose (callers update optimistically) but refuses a second
   *  flip until the first resolves. */
  pending?: boolean
}

/**
 * A 26x15 switch track. This is the ONE deliberate exception to the global
 * "no rounded corners besides avatars" rule (see components.css, `.toggle`):
 * a switch reads as a switch only when its track is pill-shaped. Its
 * accessible name comes straight from `label` via aria-label, so a caller
 * can render `<Toggle label="Sarah — auto-sync" .../>` and it is queryable
 * as `getByRole('switch', { name: /Sarah/ })`.
 *
 * `pending` exists because this component could not express in-flight at all,
 * and every Settings switch is a round trip: the switch did not move until
 * the write returned and its query refetched, which reads as "it didn't take",
 * so users flipped again and landed on the opposite value from a second
 * queued write.
 *
 * It sets aria-busy and drops the click rather than setting `disabled`: a
 * disabled button loses focus, so disabling the control a keyboard user just
 * activated would throw them back to the top of the page for the duration of
 * the write. Blocking the second write without moving focus is the same
 * protection without that cost.
 */
export function Toggle({ on, onChange, label, pending = false }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-busy={pending || undefined}
      className={`toggle${on ? ' toggle-on' : ''}${pending ? ' toggle-pending' : ''}`}
      onClick={() => { if (!pending) onChange(!on) }}
    >
      <span className="toggle-thumb" />
    </button>
  )
}
