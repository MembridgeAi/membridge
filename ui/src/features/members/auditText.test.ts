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
  })

  it('describes somebody erasing their own history, with the count and the scope', () => {
    // Written from SQL (035 §3), not by the daemon, which is why it had no
    // case here for so long: nothing in lib/ names the action.
    expect(auditSentence(event({
      action: 'own-data-deleted', objectType: 'member',
      detail: JSON.stringify({ memberId: 'usr_1', deleted: 12, projectKey: null }),
    }))).toBe('deleted 12 of their own entries')
    expect(auditSentence(event({
      action: 'own-data-deleted', objectType: 'member',
      detail: JSON.stringify({ memberId: 'usr_1', deleted: 1, projectKey: 'proj_9' }),
    }))).toBe('deleted 1 of their own entry from one project')
    // A count the row does not carry must not become "deleted null entries".
    expect(auditSentence(event({ action: 'own-data-deleted', objectType: 'member', detail: null })))
      .toBe('deleted their own entries')
  })

  it('names the person rather than their id when an unknown action is about a member', () => {
    // The fallback still shows everything it has -- an unrecognised event
    // rendered awkwardly beats one silently dropped -- but it must not print a
    // uuid where the daemon already resolved a name.
    expect(auditSentence(event({
      action: 'some-future-action', objectType: 'member',
      objectLabel: '8f21c0de-1111-4222-8333-444444444444', objectName: null, targetName: 'Priya',
    }))).toBe('some-future-action member Priya')
    // With no name resolved it falls back to the raw key, as before.
    expect(auditSentence(event({
      action: 'some-future-action', objectType: 'member',
      objectLabel: 'usr_gone', objectName: null, targetName: null,
    }))).toBe('some-future-action member usr_gone')
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
