// Renaming a team and rotating its standing invite code. Both had daemon
// routes (POST /api/team/rename, POST /api/team/rotate-invite) that no UI
// called, so a typo'd team name was permanent from the app and a LEAKED
// invite code had no in-app remedy at all -- the code is long-lived and
// unlimited-use, so replacing it is the only fix.
import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { SettingsPage } from './SettingsPage'

function onTeam(overrides = {}) {
  return new FakeDataClient({ solo: false, authenticated: true, ...overrides })
}

describe('renaming a team from Settings', () => {
  it('saves the new name through a real DataClient call', async () => {
    const client = onTeam()
    const spy = vi.spyOn(client, 'renameTeam')
    renderWith(client, <SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^rename$/i }))
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByRole('textbox', { name: /team name/i })
    await userEvent.clear(input)
    await userEvent.type(input, 'Acme AI')
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
    expect(spy).toHaveBeenCalledWith('team-1', 'Acme AI')
  })

  it('does not fire a write when the name was left alone', async () => {
    const client = onTeam()
    const spy = vi.spyOn(client, 'renameTeam')
    renderWith(client, <SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^rename$/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
    expect(spy).not.toHaveBeenCalled()
  })

  it('is not offered to a plain member', async () => {
    renderWith(onTeam({ role: 'member' }), <SettingsPage />)
    await screen.findByTestId('setting-team')
    expect(screen.queryByRole('button', { name: /^rename$/i })).toBeNull()
  })
})

describe('rotating the standing invite code', () => {
  it('warns that outstanding invite links die with it, because the RPC revokes them', async () => {
    renderWith(onTeam(), <SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: /rotate code/i }))
    const dialog = await screen.findByRole('dialog')
    // rotate_invite (002_team_v2.sql) rotates the code AND sets revoked_at on
    // every live invite for the team -- a consequence the admin must know
    // before confirming, not discover from a teammate's broken link.
    expect(dialog).toHaveTextContent(/every invite link you have already sent is cancelled/i)
    expect(dialog).toHaveTextContent(/already on the team are unaffected/i)
  })

  it('shows the new code, since nothing else on this screen will', async () => {
    const client = onTeam()
    const spy = vi.spyOn(client, 'rotateInviteCode')
    renderWith(client, <SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: /rotate code/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /rotate code/i }))
    expect(spy).toHaveBeenCalledWith('team-1')
    expect(await screen.findByText(/INV-NEW42X/)).toBeInTheDocument()
  })

  it('is not offered to a plain member', async () => {
    renderWith(onTeam({ role: 'member' }), <SettingsPage />)
    await screen.findByTestId('setting-team')
    expect(screen.queryByRole('button', { name: /rotate code/i })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Deleting your own synced data. Two properties matter more than the happy
// path, and both are asserted below:
//
//   1. IT IS BURIED. Andrew's decision: deletion must not be easy or obvious,
//      so the control lives inside a disclosure that is CLOSED on load. A
//      regression that promotes it to a plain visible row is a product bug,
//      not a cosmetic one, and no type check or lint would catch it.
//   2. NOTHING IS DESTROYED UNTIL THE TOKEN IS TYPED. The ConfirmDialog
//      disables its confirm button until the input matches exactly, so the
//      DataClient method must not be reachable before then.
//
// Plus the third thing: it is NOT role gated, unlike Rename and the invite
// controls above. A plain member -- including one demoted a minute ago -- must
// still be able to erase what they pushed.
// ---------------------------------------------------------------------------
describe('deleting your own synced data', () => {
  it('is buried: nothing about it is on screen until the disclosure is opened', async () => {
    renderWith(onTeam(), <SettingsPage />)
    await screen.findByTestId('setting-team')
    // The section header exists (it is never hidden outright -- a control
    // nobody can find is a different failure), but the control does not.
    expect(await screen.findByRole('button', { name: /danger zone/i })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('setting-delete-my-data')).toBeNull()
    expect(screen.queryByRole('button', { name: /delete my data/i })).toBeNull()
  })

  it('does not call the client until the disclosure is opened AND DELETE is typed', async () => {
    const client = onTeam()
    const previewSpy = vi.spyOn(client, 'getMyData')
    const deleteSpy = vi.spyOn(client, 'deleteMyData')
    renderWith(client, <SettingsPage />)
    await screen.findByTestId('setting-team')

    // Closed: not even the preview read has fired. The count query is
    // `enabled` on the disclosure for exactly this reason.
    expect(previewSpy).not.toHaveBeenCalled()
    expect(deleteSpy).not.toHaveBeenCalled()

    // Step one of two: open the disclosure.
    await userEvent.click(screen.getByRole('button', { name: /danger zone/i }))
    await screen.findByTestId('setting-delete-my-data')
    expect(deleteSpy).not.toHaveBeenCalled()

    // Step two of two: the dialog, which destroys nothing on open.
    await userEvent.click(await screen.findByRole('button', { name: /delete my data/i }))
    const dialog = await screen.findByRole('dialog')
    expect(deleteSpy).not.toHaveBeenCalled()

    // Clicking confirm with the box empty must do nothing at all.
    const confirm = within(dialog).getByRole('button', { name: /delete my data/i })
    await userEvent.click(confirm)
    expect(deleteSpy).not.toHaveBeenCalled()

    // A partial token is still not the token.
    const input = within(dialog).getByRole('textbox', { name: /type delete to confirm/i })
    await userEvent.type(input, 'DELET')
    await userEvent.click(confirm)
    expect(deleteSpy).not.toHaveBeenCalled()

    // Only now.
    await userEvent.type(input, 'E')
    await userEvent.click(confirm)
    expect(deleteSpy).toHaveBeenCalledWith({ teamId: 'team-1', confirm: 'DELETE' })
  })

  it('quotes the real count and both consequences, including the audit trail', async () => {
    renderWith(onTeam(), <SettingsPage />)
    await screen.findByTestId('setting-team')
    await userEvent.click(screen.getByRole('button', { name: /danger zone/i }))
    await userEvent.click(await screen.findByRole('button', { name: /delete my data/i }))
    const dialog = await screen.findByRole('dialog')

    // The count comes from the preview query (FakeDataClient: 184 + 27), not
    // from a vague "your data" -- a confirmation that will not say how much it
    // is about to destroy is not a confirmation.
    expect(dialog).toHaveTextContent(/211 entries/i)
    // This deletes backend rows and cannot reach anyone else's disk. Somebody
    // deleting for privacy reasons must not leave believing otherwise.
    expect(dialog).toHaveTextContent(/teammates keep whatever they have already pulled/i)
    // Andrew's decision: people learn this HERE, before acting, rather than
    // finding out afterwards that an owner watched it happen.
    expect(dialog).toHaveTextContent(/recorded in the team audit trail/i)
    expect(dialog).toHaveTextContent(/owners and admins can see/i)
  })

  it('is offered to a plain member, unlike Rename and the invite controls', async () => {
    renderWith(onTeam({ role: 'member' }), <SettingsPage />)
    await screen.findByTestId('setting-team')
    await userEvent.click(screen.getByRole('button', { name: /danger zone/i }))
    // The one thing on this screen a non-manager may still do to team data.
    expect(await screen.findByRole('button', { name: /delete my data/i })).toBeEnabled()
  })
})
