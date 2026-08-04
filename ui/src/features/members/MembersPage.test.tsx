import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { MembersPage } from './MembersPage'

describe('MembersPage', () => {
  it('confirms before removing a member and says what removal does, honestly', async () => {
    renderApp({}, <MembersPage />)
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
    renderWith(client, <MembersPage />)
    const ownRow = await screen.findByTestId('member-row-usr_9f2a')
    expect(within(ownRow).queryByRole('button', { name: /more actions/i })).toBeNull()

    const andrewRow = await screen.findByTestId('member-row-andrew')
    expect(within(andrewRow).getByRole('button', { name: /more actions for andrew/i })).toBeInTheDocument()
  })

  // P0 Fix 2: invite-by-email could never succeed -- no daemon endpoint
  // accepts an email or role (POST /api/team/invite mints a generic link
  // only), so the form always ended in a developer-facing rejection message.
  // The form is gone; the invite-link/code path is the one real invite path.
  it('offers no email invite form -- only the real invite-link/code path', async () => {
    renderApp({}, <MembersPage />)
    await screen.findByTestId('member-row-andrew')
    expect(screen.queryByRole('button', { name: /invite by email/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /send invite/i })).toBeNull()
    expect(screen.queryByLabelText(/invite email/i)).toBeNull()
    // The real path stays.
    expect(screen.getByRole('button', { name: /^copy invite link$/i })).toBeInTheDocument()
  })

  // Fix 6: the audit query is ?limit=30 EVENTS -- "last 30 days" claimed a
  // time window nothing actually queries. The count now reflects the rows
  // actually on screen, which is the only number that stays true once "Show
  // more" exists.
  it('labels the audit list by event count, not a time window it never queries', async () => {
    renderApp({}, <MembersPage />)
    expect(await screen.findByText('Audit · last 4 events')).toBeInTheDocument()
    expect(screen.queryByText(/last 30 days/i)).toBeNull()
  })

  it('revokes a pending invite via a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'revokeInvite')
    renderWith(client, <MembersPage />)
    await userEvent.click(await screen.findByRole('button', { name: /revoke invite i1/i }))
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
  it('never renders "Resend" -- no mail-delivery path exists to back it', async () => {
    renderApp({}, <MembersPage />)
    await screen.findByText('Sarah')
    expect(screen.queryByRole('button', { name: /resend/i })).toBeNull()
  })

  // Fix 1: "Copy invite link" mints a real onboarding-invite token
  // (DataClient.createInviteLink, POST /api/team/invite) and copies
  // `${webUrl}/#${token}` -- the exact shape cloudflare/join's hosted page
  // reads via location.hash, and exactly what cloudflare/ops-dashboard's own
  // JOIN_BASE + token construction produces. FakeDataClient's default webUrl
  // ('https://join.membridge.me') matches the real shipped lib/backend.json.
  it('mints an invite and copies the real join link, matching <webUrl>/#<token>', async () => {
    const client = new FakeDataClient()
    const mintSpy = vi.spyOn(client, 'createInviteLink')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    renderWith(client, <MembersPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^copy invite link$/i }))
    expect(mintSpy).toHaveBeenCalledWith('team-1')
    expect(writeText).toHaveBeenCalledWith('https://join.membridge.me/#tok_9f2aQ7')
    expect(await screen.findByRole('button', { name: /^copied$/i })).toBeInTheDocument()
  })

  // Clipboard failure must not read as success -- a rejected (or denied)
  // write falls back to revealing the value on the page so the viewer can
  // select and copy it by hand, instead of showing a false "Copied".
  it('reveals the link for manual copying when the clipboard write fails, never claiming Copied', async () => {
    const client = new FakeDataClient()
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.assign(navigator, { clipboard: { writeText } })
    renderWith(client, <MembersPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^copy invite link$/i }))
    expect(await screen.findByText(/copy this link: https:\/\/join\.membridge\.me\/#tok_9f2aQ7/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^copied$/i })).toBeNull()
  })

  it('reveals the link for manual copying when no clipboard API exists at all', async () => {
    const client = new FakeDataClient()
    Object.assign(navigator, { clipboard: undefined })
    renderWith(client, <MembersPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^copy invite link$/i }))
    expect(await screen.findByText(/copy this link: https:\/\/join\.membridge\.me\/#tok_9f2aQ7/i)).toBeInTheDocument()
  })

  // Degrade path: a build with no hosted join page configured (self-hosted,
  // empty lib/backend.json -- modeled here as Settings.webUrl: null) must not
  // produce a broken/incomplete URL. It falls back to the standing code, and
  // the label changes to match what is actually being copied.
  it('falls back to copying the standing invite code when no webUrl is configured', async () => {
    const client = new FakeDataClient({ webUrl: null })
    const mintSpy = vi.spyOn(client, 'createInviteLink')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    renderWith(client, <MembersPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^copy invite code$/i }))
    expect(mintSpy).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith('INV-7F3K9Q')
    expect(await screen.findByRole('button', { name: /^copied$/i })).toBeInTheDocument()
  })

  // Cheap secondary escape hatch to the raw code, kept alongside the primary
  // link button -- the code still works with `membridge join <code>` when a
  // link isn't convenient (no browser handy, reading it aloud, etc).
  it('keeps a secondary action for the standing code alongside the link', async () => {
    const client = new FakeDataClient()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    renderWith(client, <MembersPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^copy standing code$/i }))
    expect(writeText).toHaveBeenCalledWith('INV-7F3K9Q')
  })

  // The standing code and a minted link are NOT interchangeable, and the
  // control used to imply they were: "Copy code instead" reads as a format
  // choice. team.inviteCode is one permanent per-team secret that every member
  // shares and that no one can revoke individually -- rotating it is the only
  // undo, and that cuts off everyone holding it. Handing that out believing it
  // was a throwaway alternative to a link is the mistake this copy prevents.
  it('says the standing code is permanent and cannot be revoked individually', async () => {
    renderWith(new FakeDataClient(), <MembersPage />)
    expect(await screen.findByRole('button', { name: /^copy standing code$/i })).toBeInTheDocument()
    expect(await screen.findByText(/can't be revoked, only rotated/i)).toBeInTheDocument()
  })

  it('surfaces a failed invite-link mint instead of looking like nothing happened', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'createInviteLink').mockRejectedValue(new Error('mint rejected'))
    renderWith(client, <MembersPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^copy invite link$/i }))
    expect(await screen.findByText(/mint rejected/i)).toBeInTheDocument()
  })

  it('renders no invite-copy control at all when there is nothing to mint or copy', async () => {
    const client = new FakeDataClient({ webUrl: null })
    vi.spyOn(client, 'getSettings').mockImplementation(async () => {
      const settings = await new FakeDataClient({ webUrl: null }).getSettings()
      return { ...settings, team: settings.team && { ...settings.team, inviteCode: null } }
    })
    renderWith(client, <MembersPage />)
    await screen.findByText('Sarah')
    expect(screen.queryByRole('button', { name: /copy invite|copy code/i })).toBeNull()
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
    await userEvent.click(await screen.findByRole('button', { name: /revoke invite i1/i }))
    expect(await screen.findByText(/revoke rejected/i)).toBeInTheDocument()
  })
})
