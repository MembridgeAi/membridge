import type { ReactNode } from 'react'

/** 'muted' carries no health signal — it's the neutral/absence case (e.g. paused). */
export type StateTone = 'ok' | 'warn' | 'bad' | 'muted'

interface StateChipProps {
  tone: StateTone
  glyph: string
  children: ReactNode
  /** Optional hover explanation for a chip whose short label is not
   *  self-explaining (e.g. "key changed"). The visible glyph+words stay the
   *  accessible name; this only adds detail on hover. */
  title?: string
}

/**
 * A soft-tinted state label. State must never be conveyed by color alone, so
 * the glyph and the words are rendered as one text run (not split across
 * separate elements) — the accessible name and the visible copy are always
 * the same string, e.g. "✓ up to date" or "⚠ behind · Jul 23".
 */
export function StateChip({ tone, glyph, children, title }: StateChipProps) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {glyph ? `${glyph} ` : ''}
      {children}
    </span>
  )
}
