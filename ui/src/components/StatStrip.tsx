export interface StatItem {
  value: string
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
        <div className="stat-cell" key={`${item.label}-${i}`}>
          <div className="mono stat-value">{item.value}</div>
          <div className="stat-label">{item.label}</div>
          {item.note && <div className="stat-note">{item.note}</div>}
        </div>
      ))}
    </div>
  )
}
