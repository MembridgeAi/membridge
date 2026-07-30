import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { MembersPage } from './MembersPage'

describe('MembersPage', () => {
  it('confirms before removing a member and says what removal does', async () => {
    renderApp({}, <MembersPage />)
    await userEvent.click(await screen.findByRole('button', { name: /more actions for Sarah/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /remove from team/i }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/revokes .*access to every shared project/i)
  })

  it('says plainly when a member has shared nothing, without guessing why', async () => {
    renderApp({}, <MembersPage />)
    expect(await screen.findByText(/nothing shared yet/i)).toBeInTheDocument()
    // We cannot see a teammate's machine, so no cause may be asserted.
    expect(screen.queryByText(/token expired|hook not installed/i)).toBeNull()
  })

  it('does not offer role changes on the owner row', async () => {
    renderApp({}, <MembersPage />)
    const ownerRow = await screen.findByTestId('member-row-me')
    expect(within(ownerRow).queryByRole('combobox')).toBeNull()
    expect(within(ownerRow).getByText('Owner')).toBeInTheDocument()
  })

  it('shows neither audit nor invites to a member role', async () => {
    renderApp({ role: 'member' }, <MembersPage />)
    await screen.findByText('Sarah')
    expect(screen.queryByText(/audit/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /invite/i })).toBeNull()
  })

  it('never calls getAudit or getInvites for a member role', async () => {
    const client = new FakeDataClient({ role: 'member' })
    const auditSpy = vi.spyOn(client, 'getAudit')
    const invitesSpy = vi.spyOn(client, 'getInvites')
    renderWith(client, <MembersPage />)
    await screen.findByText('Sarah')
    expect(auditSpy).not.toHaveBeenCalled()
    expect(invitesSpy).not.toHaveBeenCalled()
  })

  it('offers "Transfer ownership" from another member\'s menu, owner-only', async () => {
    renderApp({}, <MembersPage />)
    await userEvent.click(await screen.findByRole('button', { name: /more actions for Andrew/i }))
    expect(screen.getByRole('menuitem', { name: /transfer ownership/i })).toBeInTheDocument()
  })

  it('never shows a menu on the viewer\'s own row', async () => {
    renderApp({}, <MembersPage />)
    const ownerRow = await screen.findByTestId('member-row-me')
    expect(within(ownerRow).queryByRole('button', { name: /more actions/i })).toBeNull()
  })

  it('lets an owner or admin send an invite by email through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'inviteMember')
    renderWith(client, <MembersPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^invite by email$/i }))
    await userEvent.type(screen.getByLabelText(/invite email/i), 'newperson@acme.dev')
    await userEvent.click(screen.getByRole('button', { name: /send invite/i }))
    expect(spy).toHaveBeenCalledWith('newperson@acme.dev', 'member')
  })

  it('revokes a pending invite via a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'revokeInvite')
    renderWith(client, <MembersPage />)
    await userEvent.click(await screen.findByRole('button', { name: /revoke/i }))
    expect(spy).toHaveBeenCalledWith('i1')
  })

  it('changes a non-owner member\'s role through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setMemberRole')
    renderWith(client, <MembersPage />)
    const sarahRow = await screen.findByTestId('member-row-sarah')
    await userEvent.selectOptions(within(sarahRow).getByRole('combobox', { name: /role for sarah/i }), 'admin')
    expect(spy).toHaveBeenCalledWith('sarah', 'admin')
  })

  it('never renders "Copy invite link" or "Resend" -- neither has a backing DataClient method', async () => {
    renderApp({}, <MembersPage />)
    await screen.findByText('Sarah')
    expect(screen.queryByRole('button', { name: /copy invite link/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /resend/i })).toBeNull()
  })
})
