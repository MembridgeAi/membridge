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

  it('shows the new code', async () => {
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

  // Finding 8: rotation stashed the new code in local component state with no
  // copy affordance, it vanished on navigation, and the CURRENT code was shown
  // nowhere in the app. So the only route back to a code you had to send a
  // teammate was rotating again -- which invalidates the code you may have just
  // sent them, and every invite link with it.
  describe('the live code itself', () => {
    it('is visible without rotating anything, with a way to copy it', async () => {
      renderWith(onTeam(), <SettingsPage />)
      const row = await screen.findByTestId('setting-invite-code')
      expect(within(row).getByText(/INV-7F3K9Q/)).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: /^copy$/i })).toBeInTheDocument()
    })

    it('copies the live code to the clipboard', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.assign(navigator, { clipboard: { writeText } })
      renderWith(onTeam(), <SettingsPage />)
      const row = await screen.findByTestId('setting-invite-code')
      await userEvent.click(within(row).getByRole('button', { name: /^copy$/i }))
      expect(writeText).toHaveBeenCalledWith('INV-7F3K9Q')
      expect(await within(row).findByText(/^copied$/i)).toBeInTheDocument()
    })

    // A denied clipboard must never read as a success -- the code is still on
    // screen to select by hand, which is the whole point of showing it.
    it('never claims copied when the clipboard write is refused', async () => {
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
      renderWith(onTeam(), <SettingsPage />)
      const row = await screen.findByTestId('setting-invite-code')
      await userEvent.click(within(row).getByRole('button', { name: /^copy$/i }))
      expect(await within(row).findByText(/couldn't copy/i)).toBeInTheDocument()
      expect(within(row).queryByText(/^copied$/i)).toBeNull()
      expect(within(row).getByText(/INV-7F3K9Q/)).toBeInTheDocument()
    })

    // Exactly one code on screen, always the live one: a rotation replaces the
    // row's value in place rather than appending a second "New code:" line
    // beside a code that no longer works.
    it('replaces the displayed code in place when rotated, leaving no dead code on screen', async () => {
      renderWith(onTeam(), <SettingsPage />)
      const row = await screen.findByTestId('setting-invite-code')
      await userEvent.click(within(row).getByRole('button', { name: /rotate code/i }))
      const dialog = await screen.findByRole('dialog')
      await userEvent.click(within(dialog).getByRole('button', { name: /rotate code/i }))
      expect(await within(row).findByText(/INV-NEW42X/)).toBeInTheDocument()
      expect(within(row).queryByText(/INV-7F3K9Q/)).toBeNull()
    })

    it('clears a stale "copied" note when the code is rotated out from under it', async () => {
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
      renderWith(onTeam(), <SettingsPage />)
      const row = await screen.findByTestId('setting-invite-code')
      await userEvent.click(within(row).getByRole('button', { name: /^copy$/i }))
      expect(await within(row).findByText(/^copied$/i)).toBeInTheDocument()

      await userEvent.click(within(row).getByRole('button', { name: /rotate code/i }))
      const dialog = await screen.findByRole('dialog')
      await userEvent.click(within(dialog).getByRole('button', { name: /rotate code/i }))
      expect(await within(row).findByText(/INV-NEW42X/)).toBeInTheDocument()
      expect(within(row).queryByText(/^copied$/i)).toBeNull()
    })
  })
})
