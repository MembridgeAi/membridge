/**
 * The shape of a value that has not arrived yet.
 *
 * WHY THIS EXISTS. Every data-driven screen in this app rendered its
 * not-yet-known state as its EMPTY state: Today showed "0 live now", "0
 * sessions · last 24h" and the first-run line "No projects yet. Sync your
 * first project to see it here." for as long as its slowest request took
 * (measured: 1.4s on a 10-project install), to a user with ten projects and
 * nineteen sessions that day. Insights rendered an empty div, then a bare
 * "Loading…" with no page frame, for 4.4s. A zero is an ANSWER. An absent
 * figure is the absence of one, and rendering the two identically is the same
 * failure as any other flag in this codebase that reports a success the code
 * never achieved -- it just points at the reader instead of at the daemon.
 *
 * WHY A BAR AND NOT A SPINNER. A bar occupies the line box of the text it
 * stands in for, so the real value lands without moving anything around it.
 * A spinner replaces the layout and then throws it away.
 *
 * NOT NAMED "Skeleton". That word is taken in this product: the memory
 * skeleton is a real domain concept (SkeletonStats, /api/savings, Insights'
 * `.skeleton-panel`), and a loading primitive sharing its name would make
 * every future grep ambiguous.
 *
 * Sizes live in components.css, keyed off the `variant`, rather than being
 * passed in as a width: a pixel value in a feature file is a bug per the
 * house rules, and the widths here are measurements of the type they stand in
 * for, so they belong next to that type.
 */
export type LoadingVariant = 'value' | 'title' | 'line' | 'short'

interface LoadingBlockProps {
  /** Which piece of type this bar stands in for. `value` is a stat figure,
   *  `title` a row's name, `line` a full-width sentence, `short` a metric. */
  variant?: LoadingVariant
  className?: string
}

/** One bar. `aria-hidden` because it carries no information a screen reader
 *  can use -- callers announce the wait once, on the region, via LoadingRows
 *  or an `.sr-only` label, instead of once per bar. */
export function LoadingBlock({ variant = 'line', className }: LoadingBlockProps) {
  return (
    <span
      className={`loading-block loading-block-${variant}${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    />
  )
}

interface LoadingRowsProps {
  /** How many placeholder rows to draw. Set it to roughly what the list
   *  usually holds so the page does not jump when the real rows arrive. */
  rows?: number
  /** What is being waited on, announced once for the whole region. Written as
   *  a sentence a screen-reader user hears in place of the list, e.g.
   *  "Loading what's happening now". */
  label: string
  testId?: string
}

/** A ruled run of placeholder rows, for a list whose contents are in flight.
 *  One `role="status"` for the region -- never one per row, which would make
 *  a loading list noisier to a screen reader than a loaded one. */
export function LoadingRows({ rows = 3, label, testId }: LoadingRowsProps) {
  return (
    <div className="loading-rows" role="status" aria-busy="true" aria-label={label} data-testid={testId}>
      {Array.from({ length: rows }, (_, i) => (
        <div className="loading-row" key={i}>
          <LoadingBlock variant="title" />
          <LoadingBlock variant="line" />
        </div>
      ))}
    </div>
  )
}
