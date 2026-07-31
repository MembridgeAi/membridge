import { monthDay } from '../../data/localTime'
import { useAudit } from '../../data/queries'
import type { AuditEvent } from '../../data/types'

// Local fields -- same fix as ProjectPage's dayLabel. An audit trail stamped
// in UTC dated an evening action to the next day and put its clock time
// hours off, which is exactly the wrong property for the one log people
// consult to reconstruct who did what, when.
function timeLabel(iso: string): string {
  const d = new Date(iso)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${monthDay(d)} ${hh}:${mm}`
}

function describe(event: AuditEvent): string {
  return `${event.action} ${event.objectType} ${event.objectLabel}`.trim()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

/**
 * The team audit trail — owner/admin only. MembersPage only mounts this
 * component when the viewer's role qualifies, so `getAudit()` never fires
 * for a member (who would get a 403 from the real daemon anyway).
 */
export function AuditList() {
  const auditQuery = useAudit(30)
  const events = auditQuery.data ?? []

  return (
    <div className="audit-panel">
      <div className="section-label">Audit · last 30 days</div>
      {auditQuery.isError && (
        <p className="audit-error" role="alert">Couldn't load the audit trail. {errorMessage(auditQuery.error)}</p>
      )}
      {!auditQuery.isError && !auditQuery.isLoading && events.length === 0 && (
        <p className="audit-empty">No activity recorded yet.</p>
      )}
      {events.map(event => (
        <div className="audit-row" key={event.id}>
          <span className="mono audit-time">{timeLabel(event.at)}</span>
          <span className="audit-text"><b>{event.actorName}</b> {describe(event)}</span>
        </div>
      ))}
    </div>
  )
}
