interface AvatarProps {
  name: string
  id: string
  size?: number
}

const DEFAULT_SIZE = 24

// A small, fixed palette pulled from the design tokens rather than an
// arbitrary hash-to-hue — every avatar color is one this theme already uses.
const PALETTE = ['#4D7CFF', '#22C08F', '#E79A3C', '#F0616D', '#7A9DFF', '#0D9673', '#C77414', '#D14350']

function colorForId(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  }
  return PALETTE[hash % PALETTE.length]
}

/** Circle, initial, deterministic color — the one non-switch exception to
 *  the no-rounded-corners rule: avatars represent people, so they are
 *  circles (see components.css, `.avatar`). */
export function Avatar({ name, id, size = DEFAULT_SIZE }: AvatarProps) {
  const initial = name.trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      className="avatar"
      title={name}
      aria-label={name}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5), background: colorForId(id) }}
    >
      {initial}
    </span>
  )
}
