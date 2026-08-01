import type { Insights } from '../../data/types'

interface AssistsBreakdownProps {
  assists: Insights['assists']
}

const formatCount = (n: number): string => n.toLocaleString('en-US')

// The auditable evidence behind the "memory helped N times" headline (see
// InsightsPage.tsx's assistsHeadlineValue) -- the owner has repeatedly
// rejected numbers that cannot be traced, so this renders exactly the
// channels lib/api-insights.js's assistsFrom sums into that headline, and
// nothing more. Renders nothing at all when unavailable (a fresh install
// with no ledger yet) rather than a fabricated all-zero breakdown -- the
// headline and the two-line skeleton panel above it already say `pending`.
//
// The MCP figure is rendered BELOW those rows, as a fraction, and is
// deliberately not one of them: the daemon records which memory tools see
// use, never how often, so it is coverage (at most one per tool that exists)
// and can never be an instance count. Putting it in the sum understated
// heavy MCP use to almost nothing and made the headline untraceable, which
// is exactly what this panel exists to prevent.
export function AssistsBreakdown({ assists }: AssistsBreakdownProps) {
  if (!assists.available) return null
  const rows: { label: string; value: number }[] = [
    { label: 'Recall served a file instead of a read', value: assists.byKind.recallServed },
    { label: 'Teammate notes delivered into a session', value: assists.byKind.teammateNotes },
  ]
  return (
    <div className="assists-breakdown" data-testid="assists-breakdown">
      {rows.map(row => (
        <div className="lrow" role="row" key={row.label}>
          <span className="lrow-name">{row.label}</span>
          <span className="mono lrow-value">{formatCount(row.value)}</span>
        </div>
      ))}
      <div className="lrow" data-testid="assists-mcp-tools">
        <span className="lrow-name">
          Distinct memory tools in use{' '}
          <span className="lrow-muted">coverage, not a call count</span>
        </span>
        <span className="mono lrow-value">
          {formatCount(assists.mcpTools.inUse)} of {formatCount(assists.mcpTools.total)}
        </span>
      </div>
    </div>
  )
}
