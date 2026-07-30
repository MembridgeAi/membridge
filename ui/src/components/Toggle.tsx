interface ToggleProps {
  on: boolean
  onChange: (next: boolean) => void
  label: string
}

/**
 * A 26x15 switch track. This is the ONE deliberate exception to the global
 * "no rounded corners besides avatars" rule (see components.css, `.toggle`):
 * a switch reads as a switch only when its track is pill-shaped. Its
 * accessible name comes straight from `label` via aria-label, so a caller
 * can render `<Toggle label="Sarah — auto-sync" .../>` and it is queryable
 * as `getByRole('switch', { name: /Sarah/ })`.
 */
export function Toggle({ on, onChange, label }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`toggle${on ? ' toggle-on' : ''}`}
      onClick={() => onChange(!on)}
    >
      <span className="toggle-thumb" />
    </button>
  )
}
