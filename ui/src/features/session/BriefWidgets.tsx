import type { ReactNode } from 'react'
import type { FileChange, Session } from '../../data/types'

// The five collapsible brief widgets, native <details>/<summary> (keyboard
// and screen-reader behavior for free). Locked decisions honored here:
//   * fixed order Why -> Watch out -> Key files -> Changes -> Checkpoints,
//     so the page reads the same on every session; only open state varies.
//   * Why + Watch out open by default; the rest closed with a one-line
//     truncated peek in the summary row so the reader can judge without
//     opening.
//   * a widget with no captured content does NOT render -- absence is
//     communicated by absence, never a "(not captured)" placeholder row.

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
  const checkpoints = session.checkpoints

  return (
    <div className="session-widgets">
      {session.decisions && (
        <Widget title="Why" open>
          <p className="session-widget-text">{session.decisions}</p>
        </Widget>
      )}
      {session.gotchas && (
        <Widget title="Watch out" open>
          <p className="session-widget-text">{session.gotchas}</p>
        </Widget>
      )}
      {keyFiles.length > 0 && (
        <Widget title="Key files" peek={keyFiles.map(c => c.file).join(' · ')}>
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
      {checkpoints.length > 0 && (
        <Widget title="Checkpoints" peek={checkpoints[checkpoints.length - 1]?.text}>
          {/* Oldest-first: the trail reads top to bottom as the session ran. */}
          <ol className="session-list session-checkpoints">
            {checkpoints.map(c => (
              <li key={`${c.ts}|${c.text}`} className="session-checkpoint">
                <span className="session-checkpoint-text">{c.text}</span>
              </li>
            ))}
          </ol>
        </Widget>
      )}
    </div>
  )
}
