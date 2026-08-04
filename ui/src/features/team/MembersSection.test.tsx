import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { MembersSection } from './MembersSection'

describe('MembersSection (the People section of the Team page)', () => {
  it('confirms before removing a member and says what removal does, honestly', async () => {
    renderApp({}, <MembersSection />)
    await userEvent.click(await screen.findByRole('button', { name: /more actions for Sarah/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /remove from team/i }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Sarah')
    expect(dialog).toHaveTextContent(/cuts off access to every shared project/i)
    // This is the moment the admin forms their expectation, so it must
    // carry the same honesty as the project access panel's toggle-off note:
    // access is revoked immediately, anything already synced is cleaned up
    // the next time that machine checks in (prune-on-revocation), and a
    // device that never syncs again keeps its copy -- stated as fact, not
    // hedged, and never implying removal is guaranteed or complete.
    expect(dialog).toHaveTextContent(/right away/i)
    expect(dialog).toHaveTextContent(/removed the next time it checks in/i)
    expect(dialog).toHaveTextContent(/never syncs again/i)
    expect(dialog).toHaveTextContent(/keeps its copy/i)
    expect(dialog.textContent).not.toMatch(/retroactive/i)
  })

  it('says plainly when a member has shared nothing, without guessing why', async () => {
    renderApp({}, <MembersSection />)
    expect(await screen.findByText(/nothing shared yet/i)).toBeInTheDocument()
    // We cannot see a teammate's machine, so no cause may be asserted.
    expect(screen.queryByText(/token expired|hook not installed/i)).toBeNull()
  })

  it('does not offer role changes on the owner row', async () => {
    renderApp({}, <MembersSection />)
    const ownerRow = await screen.findByTestId('member-row-me')
    expect(within(ownerRow).queryByRole('combobox')).toBeNull()
    expect(within(ownerRow).getByText('Owner')).toBeInTheDocument()
  })

  it('shows neither audit nor invites to a member role', async () => {
    renderApp({ role: 'member' }, <MembersSection />)
    await screen.findByText('Sarah')
    expect(screen.queryByText(/audit/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /invite/i })).toBeNull()
  })

  it('never calls getAudit or getInvites for a member role', async () => {
    const client = new FakeDataClient({ role: 'member' })
    const auditSpy = vi.spyOn(client, 'getAudit')
    const invitesSpy = vi.spyOn(client, 'getInvites')
    renderWith(client, <MembersSection />)
    await screen.findByText('Sarah')
    expect(auditSpy).not.toHaveBeenCalled()
    expect(invitesSpy).not.toHaveBeenCalled()
  })

  // "Transfer ownership" was a control that could not work. It called
  // setRole(memberId, 'owner'), and set_role (002_team_v2.sql) raises
  // `role must be admin or member` for any p_role outside that pair; no
  // transfer_ownership RPC exists anywhere in supabase/migrations/. So the
  // menu item opened a confirmation dialog whose only possible outcome was an
  // error message. The menu keeps Remove, which is real.
  //
  // The component moved from MembersPage to MembersSection while this was in
  // flight; the assertion is unchanged, only where it renders from.
  it('offers no "Transfer ownership" -- no RPC can perform it', async () => {
    renderApp({}, <MembersSection />)
    await userEvent.click(await screen.findByRole('button', { name: /more actions for Andrew/i }))
    expect(screen.queryByRole('menuitem', { name: /transfer ownership/i })).toBeNull()
    expect(screen.getByRole('menuitem', { name: /remove from team/i })).toBeInTheDocument()
  })

  it('offers no control anywhere that would set a role of "owner"', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setMemberRole')
    renderWith(client, <MembersSection />)
    await userEvent.click(await screen.findByRole('button', { name: /more actions for Andrew/i }))
    const roleSelect = screen.getByRole('combobox', { name: /role for andrew/i }) as HTMLSelectElement
    expect([...roleSelect.options].map(o => o.value)).not.toContain('owner')
    expect(spy.mock.calls.flat()).not.toContain('owner')
  })

  it('never shows a menu on the viewer\'s own row', async () => {
    renderApp({}, <MembersSection />)
    const ownerRow = await screen.findByTestId('member-row-me')
    expect(within(ownerRow).queryByRole('button', { name: /more actions/i })).toBeNull()
  })

  // The own-row guard used to compare a member's id against a hardcoded
  // two-letter placeholder -- a value the real daemon never sends (a real
  // user id looks like 'usr_9f2a'), so the guard silently never activated in
  // production and every member, including the viewer, got a "more
  // actions" menu on their own row. This drives the fixture with a
  // REALISTIC id AND role: 'admin' (so the viewer's own row isn't also
  // hidden by the separate "no menu on the owner row" rule, which would
  // mask the isSelf bug) to prove the guard now reads settings.viewerId
  // instead of that sentinel, for both the viewer's own row and a
  // teammate's row.
  it('suppresses the own-row menu using the real viewerId, not a hardcoded placeholder', async () => {
    const client = new FakeDataClient({ viewerId: 'usr_9f2a', role: 'admin' })
    renderWith(client, <MembersSection />)
    const ownRow = await screen.findByTestId('member-row-usr_9f2a')
    expect(within(ownRow).queryByRole('button', { name: /more actions/i })).toBeNull()

    const andrewRow = await screen.findByTestId('member-row-andrew')
    expect(within(andrewRow).getByRole('button', { name: /more actions for andrew/i })).toBeInTheDocument()
  })

  // The own-row guard was applied to the overflow menu and NOT to the role
  // select sitting one line above it, so an admin was still handed a select
  // on their own row -- the one control that can demote the viewer out of
  // the ability to use every other control on this page. The backend refuses
  // the write anyway (set_role is owner-only), which makes the offer worse,
  // not better: the admin picks "Member", nothing happens, and the only
  // feedback is an error banner explaining a rule the UI should not have
  // invited them to break. Same fixture as the menu test above -- a
  // REALISTIC viewerId plus role 'admin', so the viewer's own row is not
  // also hidden by the separate owner-row rule, which would mask the bug.
  it('never offers a role select on the viewer\'s own row', async () => {
    const client = new FakeDataClient({ viewerId: 'usr_9f2a', role: 'admin' })
    renderWith(client, <MembersSection />)
    const ownRow = await screen.findByTestId('member-row-usr_9f2a')
    expect(within(ownRow).queryByRole('combobox')).toBeNull()

    // A teammate's row must keep its select: the fix is "not on yourself",
    // not "admins can no longer change anyone's role".
    const andrewRow = await screen.findByTestId('member-row-andrew')
    expect(within(andrewRow).getByRole('combobox', { name: /role for andrew/i })).toBeInTheDocument()
  })


  // Fix 6: the audit query is ?limit=30 EVENTS -- "last 30 days" claimed a
  // time window nothing actually queries. The count now reflects the rows
  // actually on screen, which is the only number that stays true once "Show
  // more" exists.
  it('labels the audit list by event count, not a time window it never queries', async () => {
    renderApp({}, <MembersSection />)
    expect(await screen.findByText('Audit · last 4 events')).toBeInTheDocument()
    expect(screen.queryByText(/last 30 days/i)).toBeNull()
  })

  it('revokes a pending invite via a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'revokeInvite')
    renderWith(client, <MembersSection />)
    await userEvent.click(await screen.findByRole('button', { name: /revoke invite i1/i }))
    expect(spy).toHaveBeenCalledWith('i1')
  })

  it('changes a non-owner member\'s role through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setMemberRole')
    renderWith(client, <MembersSection />)
    const sarahRow = await screen.findByTestId('member-row-sarah')
    await userEvent.selectOptions(within(sarahRow).getByRole('combobox', { name: /role for sarah/i }), 'admin')
    expect(spy).toHaveBeenCalledWith('sarah', 'admin')
  })

  // "Resend" is permanently omitted -- Task 17 confirmed no mail-delivery
  // path exists anywhere in this codebase or backend for team invites.
  it('never renders "Resend" -- no mail-delivery path exists to back it', async () => {
    renderApp({}, <MembersSection />)
    await screen.findByText('Sarah')
    expect(screen.queryByRole('button', { name: /resend/i })).toBeNull()
  })









  it('surfaces a failed role change instead of looking like nothing happened', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'setMemberRole').mockRejectedValue(new Error('role change rejected'))
    renderWith(client, <MembersSection />)
    const sarahRow = await screen.findByTestId('member-row-sarah')
    await userEvent.selectOptions(within(sarahRow).getByRole('combobox', { name: /role for sarah/i }), 'admin')
    expect(await screen.findByText(/role change rejected/i)).toBeInTheDocument()
  })

  it('surfaces a failed invite revoke instead of looking like nothing happened', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'revokeInvite').mockRejectedValue(new Error('revoke rejected'))
    renderWith(client, <MembersSection />)
    await userEvent.click(await screen.findByRole('button', { name: /revoke invite i1/i }))
    expect(await screen.findByText(/revoke rejected/i)).toBeInTheDocument()
  })
})
