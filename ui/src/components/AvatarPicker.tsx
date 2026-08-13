import { Avatar } from './Avatar'
import { GLYPHS, AVATAR_COLORS } from './AvatarGlyph'

interface AvatarPickerProps {
  name: string
  viewerId: string
  glyph: string | null
  color: string | null
  onGlyph: (glyph: string | null) => void
  onColour: (colour: string | null) => void
}

/** Two rows, not one grid: shape and colour are independent, so a grid of
 *  fixed combinations would misrepresent 15 x 10 as 150 separate things to
 *  scroll. Each row is a radiogroup; null is a real option in both. */
export function AvatarPicker({ name, viewerId, glyph, color, onGlyph, onColour }: AvatarPickerProps) {
  return (
    <>
      <fieldset className="avatar-row" role="radiogroup" aria-label="Avatar shape">
        <label className="avatar-choice">
          <input type="radio" name="glyph" aria-label="Initial"
                 checked={glyph === null} onChange={() => onGlyph(null)} />
          <Avatar name={name} id={viewerId} size={28} avatar={null} avatarColor={color} />
        </label>
        {GLYPHS.map(g => (
          <label className="avatar-choice" key={g}>
            <input type="radio" name="glyph" aria-label={g}
                   checked={glyph === g} onChange={() => onGlyph(g)} />
            <Avatar name={name} id={viewerId} size={28} avatar={g} avatarColor={color} />
          </label>
        ))}
      </fieldset>

      <fieldset className="avatar-row" role="radiogroup" aria-label="Avatar colour">
        <label className="avatar-choice">
          <input type="radio" name="avatarColour" aria-label="Default colour"
                 checked={color === null} onChange={() => onColour(null)} />
          <Avatar name={name} id={viewerId} size={28} avatar={glyph} avatarColor={null} />
        </label>
        {AVATAR_COLORS.map((c, i) => (
          <label className="avatar-choice" key={c}>
            <input type="radio" name="avatarColour" aria-label={`Colour ${i + 1}`}
                   checked={color === c} onChange={() => onColour(c)} />
            <Avatar name={name} id={viewerId} size={28} avatar={glyph} avatarColor={c} />
          </label>
        ))}
      </fieldset>
    </>
  )
}
