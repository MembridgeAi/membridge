import { LoadingBlock } from './LoadingBlock'

export interface StatItem {
  /**
   * The figure, already formatted.
   *
   * `null` means NOT KNOWN YET, and renders a loading bar in place of the
   * number. This is deliberately a third value rather than a `loading` flag on
   * the strip: on Today, "last team sync" is answered by /api/status in ~20ms
   * while "live now" waits on a separate request, so a strip-wide flag would
   * hide a figure it already had in order to keep four cells looking alike.
   *
   * A zero must never be passed for an unknown. `'0'` and `null` render
   * differently on purpose -- one is an answer, the other is the absence of
   * one, and a screen that reports "0 sessions · last 24h" to someone with
   * nineteen is not loading, it is wrong.
   */
  value: string | null
  label: string
  note?: string
}

interface StatStripProps {
  items: StatItem[]
}

/** A ruled grid of stats — never a big number inside a rounded card. */
export function StatStrip({ items }: StatStripProps) {
  return (
    <div className="stat-strip">
      {items.map((item, i) => (
        <div className="stat-cell" key={`${item.label}-${i}`} aria-busy={item.value === null || undefined}>
          <div className="mono stat-value">
            {item.value === null
              // The bar itself is aria-hidden, so without this a screen reader
              // reads the label with no value at all and the cell sounds
              // finished. One word, in the value's own slot, so the wait is
              // heard exactly where the number will be.
              ? <><LoadingBlock variant="value" /><span className="sr-only">Loading</span></>
              : item.value}
          </div>
          <div className="stat-label">{item.label}</div>
          {item.note && <div className="stat-note">{item.note}</div>}
        </div>
      ))}
    </div>
  )
}
