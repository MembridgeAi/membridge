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

  // "Resend" is permanently omitted -- Task 17 confirmed no mail-delivery
  // path exists anywhere in this codebase or backend for team invites.
  // "Copy invite link" IS real now (Task 18): backed by
  // settings.team.inviteCode, GET /api/team's Task 17 extension.
  it('never renders "Resend" -- no mail-delivery path exists to back it', async () => {
    renderApp({}, <MembersPage />)
    await screen.findByText('Sarah')
    expect(screen.queryByRole('button', { name: /resend/i })).toBeNull()
  })

  it('copies the real invite code to the clipboard, not a placeholder', async () => {
    const client = new FakeDataClient()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    renderWith(client, <MembersPage />)
    await userEvent.click(await screen.findByRole('button', { name: /copy invite link/i }))
    expect(writeText).toHaveBeenCalledWith('INV-7F3K9Q')
    expect(await screen.findByRole('button', { name: /^copied$/i })).toBeInTheDocument()
  })

  it('surfaces a failed role change instead of looking like nothing happened', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'setMemberRole').mockRejectedValue(new Error('role change rejected'))
    renderWith(client, <MembersPage />)
    const sarahRow = await screen.findByTestId('member-row-sarah')
    await userEvent.selectOptions(within(sarahRow).getByRole('combobox', { name: /role for sarah/i }), 'admin')
    expect(await screen.findByText(/role change rejected/i)).toBeInTheDocument()
  })

  it('surfaces a failed invite revoke instead of looking like nothing happened', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'revokeInvite').mockRejectedValue(new Error('revoke rejected'))
    renderWith(client, <MembersPage />)
    await userEvent.click(await screen.findByRole('button', { name: /revoke/i }))
    expect(await screen.findByText(/revoke rejected/i)).toBeInTheDocument()
  })
})
