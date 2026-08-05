import { StateChip, type StateTone } from '../../components/StateChip'
import type { Problem, Severity } from '../../data/types'

/**
 * How much confidence the section claims. `broken` and `minor` are the API's
 * own `problem.severity` values, rendered as-is. `unconfirmed` is NOT a
 * severity and never comes off the wire: it is the page saying it could not
 * establish the problem at all, because the feed fetch these problems are
 * derived from stopped short of the window (see the comment above the
 * `insights.truncated` branch in InsightsPage's right-hand column). Kept in
 * the same union as the severities because it occupies the same slot — a
 * problem is shown at exactly one confidence.
 */
export type ProblemTone = Severity | 'unconfirmed'

interface ProblemGroupProps {
  testId: string
  tone: ProblemTone
  title: string
  hint: string
  problems: Problem[]
  emptyNote: string
}

const BADGE: Record<ProblemTone, { tone: StateTone; glyph: string; label: string }> = {
  broken: { tone: 'bad', glyph: '✕', label: 'Broken' },
  minor: { tone: 'muted', glyph: '', label: 'Minor' },
  unconfirmed: { tone: 'muted', glyph: '?', label: 'Unconfirmed' },
}

/**
 * One section — Broken, Minor, or Can't tell — visually distinct via its own
 * heading and badge tone. Severity is never inferred here: it always comes
 * straight from `problem.severity`, set by the API (InsightsPage does not
 * recompute it), and the only judgement the caller may add is the
 * `unconfirmed` tone, which lowers confidence and never raises it. Every
 * problem shows its denominator in the mono `scale` line; an action button
 * renders only when the API actually supplies one — this component never
 * invents a diagnosis of its own, it only renders what the payload contains.
 *
 * An `unconfirmed` section drops the action button even when the payload
 * carries one. Every action here asks the reader to go and chase a named
 * teammate, and a problem the page cannot establish is not one you may send
 * someone after.
 */
export function ProblemGroup({ testId, tone, title, hint, problems, emptyNote }: ProblemGroupProps) {
  const badge = BADGE[tone]
  const actionable = tone !== 'unconfirmed'
  return (
    <div data-testid={testId}>
      <div className="insights-sect">
        {title} <span className="insights-hint">{hint}</span>
      </div>
      {problems.length === 0 && <p className="insights-empty-note">{emptyNote}</p>}
      {problems.map(problem => (
        <div className="problem-row" key={problem.id}>
          <StateChip tone={badge.tone} glyph={badge.glyph}>{badge.label}</StateChip>
          <div className="problem-body">
            <div className={tone === 'broken' ? 'problem-headline problem-headline-bad' : 'problem-headline'}>
              {problem.headline}
            </div>
            <div className="mono problem-scale">{problem.scale}</div>
          </div>
          {actionable && problem.action && (
            <button type="button" className="insights-btn-ghost">{problem.action.label}</button>
          )}
        </div>
      ))}
    </div>
  )
}
