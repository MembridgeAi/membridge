import type { AuditEvent } from '../../data/types'

/** One audit row, in words.
 *
 *  The panel used to render `${action} ${objectType} ${objectLabel}`, which
 *  produced lines like "Marco access-revoked project 8f21c0de-…": it named
 *  neither the project nor the person whose access changed, which are the
 *  only two facts anyone opens an audit trail to find. Both are on the event
 *  now (objectName, targetName), so each known action gets a real sentence.
 *
 *  Unknown actions fall back to the raw shape rather than being dropped or
 *  blanked: a trail that silently omits events it does not recognise is worse
 *  than one that renders them awkwardly. */

function detailField(event: AuditEvent, key: string): string | null {
  if (!event.detail) return null
  try {
    const parsed: unknown = JSON.parse(event.detail)
    if (!parsed || typeof parsed !== 'object') return null
    const value = (parsed as Record<string, unknown>)[key]
    return typeof value === 'string' && value.trim() !== '' ? value : null
  } catch {
    return null
  }
}

/** The project a row is about: its folder path, or the raw key when the
 *  daemon sent no friendly name (an older daemon, or an event type that
 *  carries none). Never an empty string — "that project" beats a gap. */
function objectPhrase(event: AuditEvent): string {
  return event.objectName || event.objectLabel || 'that project'
}

function targetPhrase(event: AuditEvent): string {
  return event.targetName || 'someone who has since left'
}

export function auditSentence(event: AuditEvent): string {
  switch (event.action) {
    case 'access-granted':
      return `gave ${targetPhrase(event)} access to ${objectPhrase(event)}`
    case 'access-revoked':
      return `removed ${targetPhrase(event)}'s access to ${objectPhrase(event)}`
    case 'access-default-granted':
      return `made ${objectPhrase(event)} visible to new members by default`
    case 'access-default-revoked':
      return `hid ${objectPhrase(event)} from new members by default`
    case 'member-removed':
      return `removed ${targetPhrase(event)} from the team`
    case 'role-changed': {
      const role = detailField(event, 'role')
      return role ? `made ${targetPhrase(event)} ${role}` : `changed ${targetPhrase(event)}'s role`
    }
    case 'member-joined':
      return 'joined the team'
    // Distinct from member-removed on purpose: 048 records a voluntary
    // departure, and the daemon records a removal. Being removed and choosing
    // to go are different events, and anyone counting departures has to count
    // both. Without this case the row falls through to the raw shape and reads
    // "member-left member 8f21c0de-…", which names neither the action nor the
    // person -- the exact failure the header above says this function exists
    // to end.
    case 'member-left':
      return 'left the team'
    case 'invite-created':
      return 'created an invite'
    case 'invite-revoked':
      return 'revoked an invite'
    case 'team-renamed': {
      const name = detailField(event, 'name')
      return name ? `renamed the team to ${name}` : 'renamed the team'
    }
    default:
      // Deliberately still shows everything it has, in the old shape.
      return `${event.action} ${event.objectType} ${event.objectName || event.objectLabel}`.trim()
  }
}
