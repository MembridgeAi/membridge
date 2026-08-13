/**
 * Choosable avatar glyphs, "Signal" family. Companion to components/Avatar.tsx.
 *
 * Fifteen stroked marks in the language of the MemBridge wordmark: white stroke
 * at weight 2.6 on a 32 viewBox, round caps and joins, over a flat token-color
 * circle. No second tone, no gradient.
 *
 * Shape and color are INDEPENDENT choices. 15 glyphs x 10 token colors = 150
 * distinct avatars, which is why the picker should be two rows (shape, then
 * color) rather than one grid of fixed combinations.
 *
 * Constraints this respects, from ui/src/components/components.css:
 *   - avatars are the one circular element in the app (the documented exception
 *     to the --r / --r-sm radius scale)
 *   - no gradients, no drop shadow on resting content
 *   - every color is a design token, never an arbitrary hash-to-hue
 */

export const GLYPHS = [
  'orbit', 'fork', 'pulse', 'hop', 'stack',
  'wave', 'zag', 'peak', 'cross', 'fan',
  'braid', 'step', 'grid', 'halo', 'prism',
] as const

export type Glyph = (typeof GLYPHS)[number]

/**
 * Token colors only. The first eight are Avatar.tsx's existing PALETTE
 * unchanged, so a user who never picks keeps the exact color colorForId
 * already gave them. The two neutrals are additions, so someone who does not
 * want a bright avatar has an out.
 */
export const AVATAR_COLORS = [
  '#4D7CFF', '#22C08F', '#E79A3C', '#F0616D',
  '#7A9DFF', '#0D9673', '#C77414', '#D14350',
  '#485464', '#0052FF',
] as const

export type AvatarColor = (typeof AVATAR_COLORS)[number]

/** Shared stroke attributes. `cap` covers glyphs with open ends; `join` adds
 *  the corner treatment for glyphs that change direction. */
const CAP = {
  fill: 'none', stroke: '#fff', strokeWidth: 2.6, strokeLinecap: 'round',
} as const
const JOIN = { ...CAP, strokeLinejoin: 'round' } as const

function shape(glyph: Glyph) {
  switch (glyph) {
    case 'orbit':
      return <>
        <circle cx="14.5" cy="18" r="6.5" fill="none" stroke="#fff" strokeWidth="2.6" />
        <circle cx="23.5" cy="8.5" r="3.4" fill="#fff" />
      </>
    case 'fork':
      return <>
        <path d="M16 25v-7M16 18l-6-5.5M16 18l6-5.5" {...JOIN} />
        <circle cx="9.4" cy="10.6" r="2.2" fill="#fff" />
        <circle cx="22.6" cy="10.6" r="2.2" fill="#fff" />
      </>
    case 'pulse':
      return <path d="M6 16h4.5l3-6.5 4.5 13 3-6.5H26" {...JOIN} />
    case 'hop':
      return <>
        <path d="M9 21q7-13 14 0" {...CAP} />
        <circle cx="9" cy="21" r="3.1" fill="#fff" />
        <circle cx="23" cy="21" r="3.1" fill="#fff" />
      </>
    case 'stack':
      return <path d="M8 11h16M8 16h11M8 21h6" {...CAP} />
    case 'wave':
      return <path d="M5 17q5.5-8 11 0t11 0" {...CAP} />
    case 'zag':
      return <path d="M8 22l5.5-11 4.5 9L24 10" {...JOIN} />
    case 'peak':
      return <path d="M7.5 20.5L16 10.5l8.5 10" {...JOIN} />
    case 'cross':
      return <path d="M16 6.5v6M16 19.5v6M6.5 16h6M19.5 16h6" {...CAP} />
    case 'fan':
      return <>
        <g {...CAP}>
          <path d="M15 22a5 5 0 0 0-5-5" />
          <path d="M19 22a9 9 0 0 0-9-9" />
          <path d="M23 22a13 13 0 0 0-13-13" />
        </g>
        <circle cx="10" cy="22" r="2.6" fill="#fff" />
      </>
    case 'braid':
      return <path d="M9.5 9.5l13 13M22.5 9.5l-13 13" {...CAP} />
    case 'step':
      return <path d="M7 22h6v-5.5h6V11h6" {...JOIN} />
    case 'grid':
      return <path d="M12.5 8v16M19.5 8v16M8 12.5h16M8 19.5h16" {...CAP} />
    case 'halo':
      return <>
        <circle cx="16" cy="16" r="9" fill="none" stroke="#fff" strokeWidth="2.6" />
        <circle cx="16" cy="16" r="3.1" fill="#fff" />
      </>
    case 'prism':
      return <path d="M16 8.5l8.5 14.5h-17z" fill="none" stroke="#fff"
                   strokeWidth="2.6" strokeLinejoin="round" />
    default: {
      const _exhaustive: never = glyph
      return _exhaustive
    }
  }
}

interface AvatarGlyphProps {
  glyph: Glyph
  /** A value from AVATAR_COLORS. Typed loose so a caller can pass a token var. */
  color: AvatarColor | string
  /** Used for the accessible name, same contract as Avatar.tsx. */
  name: string
  size?: number
}

export function AvatarGlyph({ glyph, color, name, size = 24 }: AvatarGlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label={name}
      style={{ color, display: 'block', borderRadius: '50%' }}
    >
      <title>{name}</title>
      <circle cx="16" cy="16" r="16" fill="currentColor" />
      {shape(glyph)}
    </svg>
  )
}

export function isGlyph(v: string | null | undefined): v is Glyph {
  return !!v && (GLYPHS as readonly string[]).includes(v)
}
