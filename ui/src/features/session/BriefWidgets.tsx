import type { ReactNode } from 'react'
import { whatGroups } from './distill'
import type { FileChange, Session } from '../../data/types'

// The collapsible brief widgets, native <details>/<summary> (keyboard and
// screen-reader behavior for free). Locked decisions honored here:
//   * fixed order Key files -> Changes -> What, so the page reads the same on
//     every session; only open state varies. Files lead because the first
//     question asked of a teammate's session is what it touched, and that
//     answer used to sit below two paragraphs of prose.
//   * Key files + What open by default; the full Changes list closed with a
//     one-line truncated peek in the summary row so the reader can judge
//     without opening.
//   * a widget with no captured content does NOT render -- absence is
//     communicated by absence, never a "(not captured)" placeholder row.
//
// "Why" and "Watch out" were merged into "What". They were always read
// together, two open paragraphs stacked above the file list is the wall this
// page exists to avoid, and the reader does not sort reasoning from pitfalls
// before reading either. whatGroups (distill.ts) turns both into one list,
// split under area headings only when there are enough points across enough
// areas to be worth it.
//
// The Checkpoints widget was REMOVED in the page redesign: the checkpoint
// trail is now the distilled bullet list directly under the summary (see
// distill.ts), and the prompt chain already renders each checkpoint against
// the prompt it followed. A third copy on the same page was pure duplication.

interface WidgetProps {
  title: string
  open?: boolean
  /** One-line preview shown in the summary row of a CLOSED widget (CSS
   *  truncates it to the line). Open widgets pass none -- the content is
   *  already visible. */
  peek?: string
  children: ReactNode
}

function Widget({ title, open = false, peek, children }: WidgetProps) {
  return (
    <details className="session-widget" open={open}>
      <summary className="session-widget-summary">
        <span className="session-widget-title">{title}</span>
        {!open && peek && <span className="session-widget-peek">{peek}</span>}
      </summary>
      <div className="session-widget-body">{children}</div>
    </details>
  )
}

function changeCounts(c: FileChange): ReactNode {
  if (c.add === null && c.del === null) return null
  return (
    <span className="mono session-change-counts">
      {c.add !== null && <span className="session-change-add">+{c.add}</span>}
      {' '}
      {c.del !== null && <span className="session-change-del">-{c.del}</span>}
    </span>
  )
}

export function BriefWidgets({ session }: { session: Session }) {
  const keyFiles = session.changes.filter(c => c.note)
  const changes = session.changes
  const what = whatGroups(session)

  return (
    <div className="session-widgets">
      {keyFiles.length > 0 && (
        <Widget title="Key files" open>
          <ul className="session-list">
            {keyFiles.map(c => (
              <li key={c.file} className="session-keyfile">
                <span className="mono session-keyfile-name">{c.file}</span>
                <span className="session-keyfile-note">{c.note}</span>
              </li>
            ))}
          </ul>
        </Widget>
      )}
      {changes.length > 0 && (
        <Widget title="Changes" peek={changes.map(c => c.file).join(' · ')}>
          <ul className="session-list">
            {changes.map(c => (
              <li key={c.file} className={`session-change${c.dep ? ' session-change-dep' : ''}`}>
                <span className="mono session-change-name">{c.file}</span>
                <span className="session-change-status">{c.status}</span>
                {changeCounts(c)}
              </li>
            ))}
          </ul>
        </Widget>
      )}
      {what.length > 0 && (
        <Widget title="What" open>
          {what.map(group => (
            <div key={group.area ?? '_unlabelled'} className="session-what-group">
              {/* No heading for the unlabelled group: it is either the whole
                  list (not worth grouping) or the leftovers, and "Other" would
                  be inventing a category the writer did not choose. */}
              {group.area && (
                <h4 className="session-what-area" data-testid="what-area">{group.area}</h4>
              )}
              <ul className="session-list">
                {group.points.map(text => <li key={text} className="session-what">{text}</li>)}
              </ul>
            </div>
          ))}
        </Widget>
      )}
    </div>
  )
}
