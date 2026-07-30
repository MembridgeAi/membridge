interface SparklineProps {
  values: number[]
  muted?: boolean
}

const BAR_WIDTH = 3
const BAR_GAP = 2
const HEIGHT = 20

/** Bars, no axis. The `aria-label` carries the whole series in words, since
 *  the bars themselves convey nothing to assistive tech. */
export function Sparkline({ values, muted }: SparklineProps) {
  const max = Math.max(1, ...values)
  const step = BAR_WIDTH + BAR_GAP
  const width = Math.max(step, values.length * step - BAR_GAP)
  const summary = `Activity, last ${values.length} day${values.length === 1 ? '' : 's'}: ${values.join(', ')}`

  return (
    <svg
      className={`sparkline${muted ? ' sparkline-muted' : ''}`}
      role="img"
      aria-label={summary}
      width={width}
      height={HEIGHT}
      viewBox={`0 0 ${width} ${HEIGHT}`}
    >
      {values.map((value, i) => {
        const barHeight = Math.max(1, (value / max) * HEIGHT)
        return (
          <rect key={i} x={i * step} y={HEIGHT - barHeight} width={BAR_WIDTH} height={barHeight} />
        )
      })}
    </svg>
  )
}
