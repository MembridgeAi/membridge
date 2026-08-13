import { AvatarGlyph, isGlyph } from './AvatarGlyph'
import { useRegisteredAvatar } from './AvatarRegistry'

interface AvatarProps {
  name: string
  id: string
  size?: number
  /** Overrides the registry lookup. Only the picker's live preview passes
   *  these; every other call site resolves through the registry. */
  avatar?: string | null
  avatarColor?: string | null
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
export function Avatar({ name, id, size = DEFAULT_SIZE, avatar, avatarColor }: AvatarProps) {
  const registered = useRegisteredAvatar(id)
  const glyph = avatar !== undefined ? avatar : registered?.glyph ?? null
  const picked = avatarColor !== undefined ? avatarColor : registered?.color ?? null
  // Null color means "the color my id already derives" -- a real choice, and
  // the reason nobody's avatar changes colour when this ships.
  const color = picked || colorForId(id)

  if (isGlyph(glyph)) {
    return <AvatarGlyph glyph={glyph} color={color} name={name} size={size} />
  }

  const initial = name.trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      className="avatar"
      title={name}
      aria-label={name}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5), background: color }}
    >
      {initial}
    </span>
  )
}
