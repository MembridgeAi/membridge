/**
 * Shared error-state guard for every polling page (P0 Fix 1). react-query v5
 * sets `isError` on a FAILED REFETCH even when cached data is still present,
 * and these pages poll every 10s -- so treating any `isError` as "blank the
 * screen" turned every daemon hiccup (including Settings -> Restart daemon)
 * into a full-page error over a populated screen. The rule, taken from
 * FeedPage's original handling:
 *
 *   - full error page ONLY when a failed query has no data at all
 *     (`isError && data === undefined` -- a genuine first-load failure);
 *   - a failure with cached data renders the data, plus a non-destructive
 *     inline "can't reach the daemon" banner while react-query's poll keeps
 *     retrying in the background.
 */
export interface QueryErrorState {
  isError: boolean
  error: unknown
  data: unknown
}

export interface DaemonErrorState {
  /** The first failed query's error, for the message. */
  error: unknown
  /** True when some failed query has NO data to fall back on -- the only
   *  case that justifies replacing the whole page with an error. */
  blocking: boolean
}

export function daemonErrorOf(queries: QueryErrorState[]): DaemonErrorState | null {
  const failed = queries.filter(q => q.isError)
  if (failed.length === 0) return null
  return {
    error: failed[0].error,
    blocking: failed.some(q => q.data === undefined),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

/** The inline, non-destructive variant: cached content stays on screen
 *  beneath this. `className` is the page's own error class (today-error,
 *  projects-error, ...) so the banner inherits that page's error styling
 *  without inventing a new one. */
export function DaemonErrorBanner({ className, error }: { className: string; error: unknown }) {
  return (
    <p className={className} role="alert">
      Can't reach the daemon, retrying. {messageOf(error)}
    </p>
  )
}
