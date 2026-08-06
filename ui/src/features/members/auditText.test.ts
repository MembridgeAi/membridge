import { describe, it, expect } from 'vitest'
import { auditSentence } from './auditText'
import type { AuditEvent } from '../../data/types'

function event(over: Partial<AuditEvent>): AuditEvent {
  return {
    id: 'a1', at: '2026-07-29T14:02:00Z', actorName: 'Andrew', action: 'access-revoked',
    objectType: 'project', objectLabel: '8f21c0de-1c44-4a0b-9a0e-2b6d5f7c1234',
    objectName: '/Users/x/billing-poc', targetName: 'Dana', detail: null,
    ...over,
  }
}

describe('audit rows in words', () => {
  it('names both the person and the project an access change was about', () => {
    // The bug this replaces: "access-revoked project 8f21c0de-..." answered
    // neither "who" nor "which project".
    const text = auditSentence(event({ action: 'access-revoked' }))
    expect(text).toContain('Dana')
    expect(text).toContain('/Users/x/billing-poc')
    expect(text).not.toContain('8f21c0de')
  })

  it('reads a granted access the other way round', () => {
    expect(auditSentence(event({ action: 'access-granted' }))).toMatch(/gave Dana access to/)
  })

  it('names the new role, which only exists inside detail', () => {
    const text = auditSentence(event({
      action: 'role-changed', targetName: 'Sarah', detail: JSON.stringify({ role: 'admin' }),
    }))
    expect(text).toBe('made Sarah admin')
  })

  it('still says something useful when detail is missing or unparseable', () => {
    expect(auditSentence(event({ action: 'role-changed', targetName: 'Sarah', detail: null })))
      .toBe("changed Sarah's role")
    expect(auditSentence(event({ action: 'role-changed', targetName: 'Sarah', detail: 'not json' })))
      .toBe("changed Sarah's role")
  })

  it('covers membership and invite events', () => {
    expect(auditSentence(event({ action: 'member-removed', targetName: 'Priya' }))).toBe('removed Priya from the team')
    expect(auditSentence(event({ action: 'member-joined' }))).toBe('joined the team')
    // Leaving and being removed are different events and must read differently:
    // the actor of a departure is its own subject, so "left the team" needs no
    // target phrase, where "removed Priya" does.
    expect(auditSentence(event({ action: 'member-left', targetName: 'Priya' }))).toBe('left the team')
    expect(auditSentence(event({ action: 'invite-created' }))).toBe('created an invite')
    expect(auditSentence(event({ action: 'invite-revoked' }))).toBe('revoked an invite')
    expect(auditSentence(event({ action: 'team-renamed', detail: JSON.stringify({ name: 'Acme AI' }) })))
      .toBe('renamed the team to Acme AI')
  })

  it('falls back to the raw shape for an action it does not know, never to nothing', () => {
    const text = auditSentence(event({ action: 'some-future-action', objectName: null }))
    expect(text).toBe('some-future-action project 8f21c0de-1c44-4a0b-9a0e-2b6d5f7c1234')
  })

  it('degrades to the raw key rather than a blank when an older daemon sent no friendly name', () => {
    const text = auditSentence(event({ objectName: null }))
    expect(text).toContain('8f21c0de-1c44-4a0b-9a0e-2b6d5f7c1234')
  })

  it('says a member has left rather than naming nobody', () => {
    expect(auditSentence(event({ action: 'member-removed', targetName: null })))
      .toBe('removed someone who has since left from the team')
  })
})
