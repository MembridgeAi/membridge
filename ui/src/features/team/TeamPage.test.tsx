// The Team page: the one screen that covers all three onboarding states
// (signed out, signed in with no team, signed in on a team). Before it
// existed, a signed-out machine rendered IDENTICALLY to a machine with no
// team -- the app never said "you are signed out", and Settings' only team
// control was "Leave team", so anyone wanting to start a team dead-ended.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { TeamPage } from './TeamPage'

function visit(path: string) {
  window.history.pushState({}, '', path)
}

afterEach(() => {
  cleanup()
  visit('/')
})

describe('TeamPage, signed out', () => {
  it('says the machine is signed out, in words, and offers a sign-in card', async () => {
    renderWith(new FakeDataClient({ authenticated: false }), <TeamPage />)
    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument()
    // The whole point: signed out must not read like "you just have no team".
    expect(screen.getByText(/signed out/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/team name/i)).toBeNull()
  })

  it('posts the typed email and password to the daemon and then clears the password field', async () => {
    const client = new FakeDataClient({ authenticated: false })
    const signIn = vi.spyOn(client, 'signIn')
    renderWith(client, <TeamPage />)
    await userEvent.type(await screen.findByLabelText(/email/i), 'andrew@acme.dev')
    const password = screen.getByLabelText(/password/i)
    await userEvent.type(password, 'hunter-correct-horse')
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }))

    expect(signIn).toHaveBeenCalledWith({ email: 'andrew@acme.dev', password: 'hunter-correct-horse' })
    // The password must not outlive the submit: it is read from the form at
    // submit time and the field is emptied straight after.
    expect(password).toHaveAttribute('type', 'password')
    expect((password as HTMLInputElement).value).toBe('')
  })

  it('renders the daemon sign-in error as-is, without echoing what was typed', async () => {
    const client = new FakeDataClient({ authenticated: false })
    vi.spyOn(client, 'signIn').mockRejectedValue(new Error('Invalid login credentials'))
    renderWith(client, <TeamPage />)
    await userEvent.type(await screen.findByLabelText(/email/i), 'andrew@acme.dev')
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong-password-value')
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid login credentials')
    expect(document.body.textContent).not.toContain('wrong-password-value')
  })

  // T-78 item 9: the rail's Team link lands here for a fresh install, and it
  // used to imply signing in was the only way to make MemBridge useful. The
  // shell already routes correctly; the missing piece was one honest sentence
  // saying solo works.
  it('says solo works too, so the fresh install does not read like a defect', async () => {
    renderWith(new FakeDataClient({ authenticated: false }), <TeamPage />)
    await screen.findByRole('heading', { name: /sign in/i })
    // "MemBridge works solo too" -- the affirmative half of the pitch. The
    // regex is intentionally loose (works\s+solo) so the sentence can be
    // reworded without a test rewrite.
    expect(screen.getByText(/works\s+solo/i)).toBeInTheDocument()
  })

  // T-78 item 11: the OAuth note read "Use this if you set your account up
  // from a MemBridge invite page — that flow is GitHub-only, so your account
  // has no password to type below." A first-time user could not decode any
  // part of that. The button copy is now what it does, not who it is for.
  it('describes Continue with GitHub in terms of what it does, not what an invitee already knows', async () => {
    renderWith(new FakeDataClient({ authenticated: false }), <TeamPage />)
    // The button itself is still labelled "Continue with GitHub" -- the fix
    // is the sentence beneath it. The old copy assumed context ("if you set
    // your account up from a MemBridge invite page") that a cold-start user
    // has no way to have.
    expect(await screen.findByRole('link', { name: /continue with github/i })).toBeInTheDocument()
    expect(screen.queryByText(/invite page/i)).toBeNull()
    expect(screen.queryByText(/no password to type below/i)).toBeNull()
  })

  it('offers a sign-up path that asks for a name and says when the email needs confirming', async () => {
    const client = new FakeDataClient({ authenticated: false })
    const signUp = vi.spyOn(client, 'signUp')
    renderWith(client, <TeamPage />)
    await userEvent.click(await screen.findByRole('button', { name: /create an account/i }))
    await userEvent.type(screen.getByLabelText(/your name/i), 'Andrew')
    await userEvent.type(screen.getByLabelText(/email/i), 'andrew@acme.dev')
    await userEvent.type(screen.getByLabelText(/password/i), 'a-brand-new-password')
    await userEvent.click(screen.getByRole('button', { name: /^sign up$/i }))

    expect(signUp).toHaveBeenCalledWith({ displayName: 'Andrew', email: 'andrew@acme.dev', password: 'a-brand-new-password' })
    // needsConfirmation is a real state, not a failure -- saying nothing here
    // looks exactly like a rejected sign-up.
    expect(await screen.findByText(/confirm/i)).toBeInTheDocument()
    expect(screen.getByText(/andrew@acme.dev/)).toBeInTheDocument()
  })
})

describe('TeamPage, signed in with no team', () => {
  it('creates a team from a single name field and shows the invite link to share', async () => {
    const client = new FakeDataClient({ solo: true })
    const createTeam = vi.spyOn(client, 'createTeam')
    const mint = vi.spyOn(client, 'createInviteLink')
    renderWith(client, <TeamPage />)
    await userEvent.type(await screen.findByLabelText(/team name/i), 'Acme AI')
    await userEvent.click(screen.getByRole('button', { name: /create team/i }))

    expect(createTeam).toHaveBeenCalledWith('Acme AI')
    expect(mint).toHaveBeenCalledWith('team-new')
    // Same link shape the Members page already mints and the hosted join page
    // actually redeems (cloudflare/join reads location.hash).
    expect(await screen.findByText(/https:\/\/join\.membridge\.me\/#tok_9f2aQ7/)).toBeInTheDocument()
  })

  it('never shows the sign-in card once the daemon reports an authenticated user', async () => {
    renderWith(new FakeDataClient({ solo: true }), <TeamPage />)
    expect(await screen.findByLabelText(/team name/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/password/i)).toBeNull()
  })

  it('surfaces a failed create instead of looking like nothing happened', async () => {
    const client = new FakeDataClient({ solo: true })
    vi.spyOn(client, 'createTeam').mockRejectedValue(new Error('team name is required'))
    renderWith(client, <TeamPage />)
    await userEvent.type(await screen.findByLabelText(/team name/i), 'Acme AI')
    await userEvent.click(screen.getByRole('button', { name: /create team/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('team name is required')
  })
})

describe('TeamPage, signed in on a team', () => {
  it('names the team and the signed-in account', async () => {
    renderWith(new FakeDataClient(), <TeamPage />)
    expect(await screen.findByText('MemBridge HQ')).toBeInTheDocument()
    expect(screen.getByText(/marco@melika\.com/)).toBeInTheDocument()
  })

  it('mints an invite and puts <webUrl>/#<token> on the clipboard', async () => {
    const client = new FakeDataClient()
    const mint = vi.spyOn(client, 'createInviteLink')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    renderWith(client, <TeamPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^copy invite link$/i }))

    expect(mint).toHaveBeenCalledWith('team-1')
    expect(writeText).toHaveBeenCalledWith('https://join.membridge.me/#tok_9f2aQ7')
    expect(await screen.findByRole('button', { name: /^copied$/i })).toBeInTheDocument()
  })

  it('reveals the link for manual copying when the clipboard write fails, never claiming Copied', async () => {
    const client = new FakeDataClient()
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    renderWith(client, <TeamPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^copy invite link$/i }))
    expect(await screen.findByText(/https:\/\/join\.membridge\.me\/#tok_9f2aQ7/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^copied$/i })).toBeNull()
  })

  it('falls back to the standing invite code when no hosted join page is configured', async () => {
    const client = new FakeDataClient({ webUrl: null })
    const mint = vi.spyOn(client, 'createInviteLink')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    renderWith(client, <TeamPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^copy invite code$/i }))
    expect(mint).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith('INV-7F3K9Q')
  })

  // Carried over when the Members screen merged into this page. shareInvite()
  // mints a link whenever a webUrl exists, so without a second control the
  // standing code becomes unreachable from the UI the moment a hosted join
  // page is configured -- and it is the only shape `membridge join <code>`
  // accepts. It must copy the code WITHOUT minting: a mint here would hand
  // out a revocable token under a label promising the permanent one.
  it('still offers the standing code beside the link, and copies it without minting', async () => {
    const client = new FakeDataClient()
    const mint = vi.spyOn(client, 'createInviteLink')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    renderWith(client, <TeamPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^copy standing code$/i }))
    expect(mint).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith('INV-7F3K9Q')
    // And it says what it just handed out, since the two secrets differ.
    expect(await screen.findByText(/permanent, shared by the whole team/i)).toBeInTheDocument()
  })

  it('signs the machine out through the daemon', async () => {
    const client = new FakeDataClient()
    const signOut = vi.spyOn(client, 'signOut')
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    renderWith(client, <TeamPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^sign out$/i }))
    expect(signOut).toHaveBeenCalled()
  })

  // The Leave-team danger zone stays in Settings; this page must not grow a
  // second one.
  it('offers no leave-team control, that stays in Settings', async () => {
    renderWith(new FakeDataClient(), <TeamPage />)
    await screen.findByText('MemBridge HQ')
    expect(screen.queryByRole('button', { name: /leave team/i })).toBeNull()
  })
})

describe('Team page routing', () => {
  it('is in the rail even on a machine with no team, and resolves at /team', async () => {
    visit('/team')
    renderApp({ solo: true })
    expect(await screen.findByRole('link', { name: 'Team' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { level: 1, name: 'Team' })).toBeInTheDocument()
  })
})
