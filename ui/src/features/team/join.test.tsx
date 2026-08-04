// Joining a team from the app. Before this, an invited user's only option on
// the Team screen was "Create a team" -- so they created a second team, which
// is exactly what the invite existed to prevent. The daemon route
// (POST /api/team/join) already existed and nothing in the UI called it.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { TeamPage } from './TeamPage'

afterEach(cleanup)

// Signed in, on no team: the state an invited user actually lands in.
function noTeam(overrides = {}) {
  return new FakeDataClient({ solo: true, authenticated: true, ...overrides })
}

describe('joining a team with an invite', () => {
  it('offers joining before it offers creating', async () => {
    renderWith(noTeam(), <TeamPage />)
    const join = await screen.findByRole('heading', { name: /join a team/i })
    const create = screen.getByRole('heading', { name: /create a team/i })
    // Order matters: the invited user is the one with no idea what to do, so
    // the thing they came to do must be first on the screen.
    expect(join.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('sends what the user pasted, untouched, to the daemon', async () => {
    const client = noTeam()
    const spy = vi.spyOn(client, 'joinTeam')
    renderWith(client, <TeamPage />)
    await userEvent.type(await screen.findByLabelText(/invite link or code/i), 'tok_9f2aQ7')
    await userEvent.click(screen.getByRole('button', { name: /^join team$/i }))
    expect(spy).toHaveBeenCalledWith('tok_9f2aQ7')
  })

  it('accepts a whole pasted invite URL, because that is what people are sent', async () => {
    const client = noTeam()
    const spy = vi.spyOn(client, 'joinTeam')
    renderWith(client, <TeamPage />)
    // The daemon normalizes link/token/UUID (teamsync.parseInviteToken), so
    // the UI must NOT pre-parse -- a client-side guess at the format would
    // reject real invites.
    await userEvent.type(await screen.findByLabelText(/invite link or code/i), 'https://join.membridge.me/#tok_9f2aQ7')
    await userEvent.click(screen.getByRole('button', { name: /^join team$/i }))
    expect(spy).toHaveBeenCalledWith('https://join.membridge.me/#tok_9f2aQ7')
  })

  it('shows the backend’s own reason when an invite is expired or revoked', async () => {
    const client = noTeam()
    vi.spyOn(client, 'joinTeam').mockRejectedValue(new Error('this invite link has expired'))
    renderWith(client, <TeamPage />)
    await userEvent.type(await screen.findByLabelText(/invite link or code/i), 'tok_old')
    await userEvent.click(screen.getByRole('button', { name: /^join team$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/this invite link has expired/i)
  })

  it('does not call the daemon for an empty field', async () => {
    const client = noTeam()
    const spy = vi.spyOn(client, 'joinTeam')
    renderWith(client, <TeamPage />)
    await screen.findByRole('heading', { name: /join a team/i })
    await userEvent.click(screen.getByRole('button', { name: /^join team$/i }))
    expect(spy).not.toHaveBeenCalled()
  })

  it('offers no join field once you are already on a team', async () => {
    renderWith(new FakeDataClient({ solo: false, authenticated: true }), <TeamPage />)
    await screen.findByRole('heading', { name: /membridge hq/i })
    expect(screen.queryByLabelText(/invite link or code/i)).toBeNull()
  })
})

describe('signing in the way the invite page signed you up', () => {
  it('offers GitHub, not only a password nobody set', async () => {
    renderWith(new FakeDataClient({ authenticated: false }), <TeamPage />)
    const github = await screen.findByRole('link', { name: /continue with github/i })
    // The daemon's own route -- it 302s to the provider and its callback page
    // completes the exchange.
    expect(github).toHaveAttribute('href', '/team/oauth/github')
  })
})

describe('being on more than one team', () => {
  it('says which team the page is about, and where to change it', async () => {
    renderWith(new FakeDataClient({ solo: false, authenticated: true, secondTeam: true }), <TeamPage />)
    const notice = await screen.findByText(/you are on 2 teams/i)
    // Naming the team being managed is the whole point: the invite button,
    // member list and audit trail all follow the selection, and a member of
    // two teams previously had no way to know which one they were acting on.
    expect(notice).toHaveTextContent(/MemBridge HQ/)
    expect(notice).toHaveTextContent(/sidebar/i)
  })

  it('stays quiet for the normal one-team case', async () => {
    renderWith(new FakeDataClient({ solo: false, authenticated: true }), <TeamPage />)
    await screen.findByRole('heading', { name: /membridge hq/i })
    expect(screen.queryByText(/you are on \d+ teams/i)).toBeNull()
  })
})

describe('what the sender is told to tell the recipient', () => {
  it('says to paste the invite into the app, not to click it', async () => {
    const client = new FakeDataClient({ solo: false, authenticated: true })
    renderWith(client, <TeamPage />)
    await userEvent.click(await screen.findByRole('button', { name: /copy invite/i }))
    const share = await screen.findByText(/join a team/i)
    expect(within(share.closest('section') as HTMLElement).getByText(/paste it into MemBridge/i)).toBeInTheDocument()
  })
})
