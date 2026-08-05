import { useState } from 'react'
import { monthDay } from '../../data/localTime'
import { useAudit } from '../../data/queries'
import { auditSentence } from './auditText'

// Local fields -- same fix as ProjectPage's dayLabel. An audit trail stamped
// in UTC dated an evening action to the next day and put its clock time
// hours off, which is exactly the wrong property for the one log people
// consult to reconstruct who did what, when.
//
// The year is included once a row is not from this year: without it, a
// fourteen-month-old event and last Tuesday's read identically, and this is
// the one panel where "when" has to be unambiguous.
function timeLabel(iso: string, now: Date): string {
  const d = new Date(iso)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const year = d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`
  return `${monthDay(d)}${year} ${hh}:${mm}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

// The daemon caps at 200 (lib/api-access.js readAudit). Start small, let the
// reader ask for the rest -- a hardcoded 30 with no way past it silently
// truncated the trail while looking complete.
const FIRST_PAGE = 30
const MAX_PAGE = 200

/**
 * The team audit trail — owner/admin only. MembersPage only mounts this
 * component when the viewer's role qualifies, so `getAudit()` never fires
 * for a member (who would get a 403 from the real daemon anyway).
 */
export function AuditList() {
  const [limit, setLimit] = useState(FIRST_PAGE)
  const auditQuery = useAudit(limit)
  const events = auditQuery.data ?? []
  const now = new Date()
  // Only offer more when this page came back full: a short page IS the end of
  // the trail, and a "Show more" that fetches the same rows again reads as
  // broken.
  const mayHaveMore = limit < MAX_PAGE && events.length >= limit

  return (
    <div className="audit-panel">
      <div className="section-label">Team activity · last {events.length} events</div>
      {auditQuery.isError && (
        <p className="audit-error" role="alert">Couldn't load the audit trail. {errorMessage(auditQuery.error)}</p>
      )}
      {!auditQuery.isError && !auditQuery.isLoading && events.length === 0 && (
        // Names WHAT is recorded, so an empty panel reads as "nothing has
        // happened yet" rather than "this feature is broken".
        <p className="audit-empty">
          Nothing yet. Joins, removals, role changes, invites and project-access changes all show up here.
        </p>
      )}
      {events.map(event => (
        <div className="audit-row" key={event.id}>
          <span className="mono audit-time">{timeLabel(event.at, now)}</span>
          {/* title carries the exact backend key the row is about -- the
              readable sentence is for people, the UUID for anyone who has to
              match a row against the backend. */}
          <span className="audit-text" title={event.objectLabel || undefined}>
            <b>{event.actorName}</b> {auditSentence(event)}
          </span>
        </div>
      ))}
      {mayHaveMore && (
        <button type="button" className="audit-more" onClick={() => setLimit(MAX_PAGE)}>
          Show more
        </button>
      )}
    </div>
  )
}
