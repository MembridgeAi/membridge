import { StateChip, type StateTone } from '../../components/StateChip'
import type { Problem, Severity } from '../../data/types'

interface ProblemGroupProps {
  testId: string
  severity: Severity
  title: string
  hint: string
  problems: Problem[]
  emptyNote: string
}

const BADGE: Record<Severity, { tone: StateTone; glyph: string; label: string }> = {
  broken: { tone: 'bad', glyph: '✕', label: 'Broken' },
  minor: { tone: 'muted', glyph: '', label: 'Minor' },
}

/**
 * One severity section — Broken or Minor — visually distinct via its own
 * heading and badge tone. Severity is never inferred here: it always comes
 * straight from `problem.severity`, set by the API (InsightsPage does not
 * recompute it). Every problem shows its denominator in the mono `scale`
 * line; an action button renders only when the API actually supplies one,
 * for either severity — this component never invents a diagnosis of its
 * own, it only renders what the problem payload contains.
 */
export function ProblemGroup({ testId, severity, title, hint, problems, emptyNote }: ProblemGroupProps) {
  const badge = BADGE[severity]
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
            <div className={severity === 'broken' ? 'problem-headline problem-headline-bad' : 'problem-headline'}>
              {problem.headline}
            </div>
            <div className="mono problem-scale">{problem.scale}</div>
          </div>
          {problem.action && (
            <button type="button" className="insights-btn-ghost">{problem.action.label}</button>
          )}
        </div>
      ))}
    </div>
  )
}
