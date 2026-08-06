// The Team page: the one screen that covers all three onboarding states
// (signed out, signed in with no team, signed in on a team). Before it
// existed, a signed-out machine rendered IDENTICALLY to a machine with no
// team -- the app never said "you are signed out", and Settings' only team
// control was "Leave team", so anyone wanting to start a team dead-ended.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, cleanup, waitFor } from '@testing-library/react'
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
    // Now carries the bounds the screen is showing -- the create-team flow
    // mints through the same shareInvite path, so it cannot quietly mint a
    // permanent link while the UI displays 7 days / single use.
    expect(mint).toHaveBeenCalledWith('team-new', { expiresDays: 7, maxUses: 1 })
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

    // Carries the bounds the screen is displaying, not a bare teamId that
    // would let the daemon decide what the user is handing out.
    expect(mint).toHaveBeenCalledWith('team-1', { expiresDays: 7, maxUses: 1 })
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

// Sign-out is TWO outcomes, not one. This machine forgetting the session
// always happens -- teamsync.signOut deletes credentials.json unconditionally,
// so a user offline can still sign out of their own laptop. Ending the session
// on the BACKEND can fail, and when it does, any copy of credentials.json
// taken before now still mints valid tokens until the session expires.
//
// The daemon reports both (`revoked` is true only when the backend confirmed
// it, never inferred from silence). The screen rendered one outcome, so a
// failed revocation looked exactly like a clean one -- a security claim
// nothing supported, and the same shape as the keyAlert chip that could never
// fire.
describe('TeamPage sign-out reports whether the session was really ended', () => {
  // Drives the FIXTURE's own signOut rather than stubbing the method. A
  // vi.spyOn(...).mockResolvedValue here replaces the implementation, so the
  // fixture never records that the machine signed out and the signed-out view
  // never renders -- which is precisely the hole this ticket closed. Going
  // through the real method is what makes the transition observable.
  const signOutReturning = (revokeError: string | null) =>
    new FakeDataClient(revokeError ? { signOutRevokeError: revokeError } : {})

  it('says the session may still be usable, and names the certain remedy, when revocation failed', async () => {
    renderWith(signOutReturning('network unreachable'), <TeamPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^sign out$/i }))

    const notice = await screen.findByTestId('signout-not-revoked')
    // Scoped honestly: the machine forgot, the server did not.
    expect(notice).toHaveTextContent(/this machine/i)
    // The backend's own words, not a generic failure.
    expect(notice).toHaveTextContent(/network unreachable/)
    // The consequence the user actually needs: a copy still works until the
    // session expires.
    expect(notice).toHaveTextContent(/until it expires/i)
    // The one real remedy.
    expect(notice).toHaveTextContent(/password/i)
  })

  // The wording rule the backend lane set deliberately, and the reason this is
  // asserted as an ABSENCE: by the time this renders the credentials are gone
  // from this machine, so there is nothing left to revoke WITH. "Try again"
  // would be a remedy that cannot work.
  it('never offers a retry, which could not revoke anything', async () => {
    renderWith(signOutReturning('network unreachable'), <TeamPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^sign out$/i }))
    const notice = await screen.findByTestId('signout-not-revoked')
    expect(notice.textContent).not.toMatch(/try again|retry|later/i)
    expect(screen.queryByRole('button', { name: /try again|retry/i })).toBeNull()
  })

  // THE COUNTER-CHECK. A confirmed revocation must stay quiet -- warning on
  // every sign-out would be the same false alarm in the other direction.
  // THE COUNTER-CHECK, now asserting what it should have all along. It used to
  // wait on the signOut mutation resolving, because FakeDataClient reported
  // `authenticated: true` forever and the signed-out view could not be reached
  // from a test at all. The fixture models the transition now, so this asserts
  // the thing that actually matters: the user lands on the signed-out screen
  // and it says nothing alarming.
  it('lands on the signed-out view with nothing extra when the revocation was confirmed', async () => {
    renderWith(signOutReturning(null), <TeamPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^sign out$/i }))

    // The state the user is actually in afterwards.
    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument()
    expect(screen.queryByTestId('signout-not-revoked')).toBeNull()
    expect(screen.queryByText(/until it expires/i)).toBeNull()
  })

  // The warning has to survive the transition, not just render before it. This
  // is the pairing that was untestable: a failed revocation AND the signed-out
  // view on screen at the same time.
  it('keeps the warning on screen after the view flips to signed-out', async () => {
    renderWith(signOutReturning('network unreachable'), <TeamPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^sign out$/i }))

    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument()
    expect(screen.getByTestId('signout-not-revoked')).toHaveTextContent(/until it expires/i)
  })
})

// The security lane bounded invite lifetime on the daemon (agent-sec cff17e3):
// POST /api/team/invite has always accepted expiresDays and maxUses, but the UI
// posted { teamId } alone, so absent meant null -- "never expires, unlimited
// uses". Every invite the app had ever minted was permanent.
//
// The daemon now defaults an omitted value to 7 days / single use. That closes
// the hole, but it leaves the UI stating nothing and offering nothing: the
// screen has to let a user SET the lifetime, and what it says has to match what
// the minted invite really has. The old row rendered "unlimited" as a fixed
// string with no way to change it, which is how this went unnoticed.
describe('minting an invite link lets the user set its lifetime', () => {
  const onTeam = () => new FakeDataClient()

  it('offers controls for expiry and use count', async () => {
    renderWith(onTeam(), <TeamPage />)
    expect(await screen.findByLabelText(/expires/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/uses/i)).toBeInTheDocument()
  })

  // The defaults on screen must be the ones the daemon would apply, or the
  // screen is describing an invite the backend is not going to mint.
  it('defaults to the daemon own 7 days and single use', async () => {
    renderWith(onTeam(), <TeamPage />)
    expect(await screen.findByLabelText(/expires/i)).toHaveValue('7')
    expect(screen.getByLabelText(/uses/i)).toHaveValue('1')
  })

  it('sends the chosen values, so what the screen says is what the invite gets', async () => {
    const client = onTeam()
    const mint = vi.spyOn(client, 'createInviteLink')
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    renderWith(client, <TeamPage />)
    await userEvent.selectOptions(await screen.findByLabelText(/expires/i), '30')
    await userEvent.selectOptions(screen.getByLabelText(/uses/i), '0')
    await userEvent.click(screen.getByRole('button', { name: /^copy invite link$/i }))
    // 0 uses is the daemon's deliberate opt-out meaning "no limit" -- passed
    // through as 0, not dropped, because omitting it would silently mean 1.
    await waitFor(() => expect(mint).toHaveBeenCalledWith('team-1', { expiresDays: 30, maxUses: 0 }))
  })

  // The counter-check: the defaults must travel too. Sending nothing would let
  // the daemon apply its own default -- the same answer today, but it would
  // stop the screen from being the thing that decides, which is what made the
  // original bug invisible.
  it('sends the defaults explicitly rather than relying on the daemon to guess', async () => {
    const client = onTeam()
    const mint = vi.spyOn(client, 'createInviteLink')
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    renderWith(client, <TeamPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^copy invite link$/i }))
    await waitFor(() => expect(mint).toHaveBeenCalledWith('team-1', { expiresDays: 7, maxUses: 1 }))
  })
})

// TeamPage.tsx:274 gated the invite affordance on `!!(webUrl && team)` with no
// role check, but create_invite is manager-gated on the daemon. A plain member
// saw "Copy invite link", clicked it, and got a 403 -- and the "copy the code
// instead" fallback that used to soften that was removed on purpose, because
// handing the standing team code to ordinary members was itself the hole being
// closed. So the button was left unaccompanied: an affordance whose only
// possible outcome is an error.
describe('inviting is offered only to people who can actually invite', () => {
  it('offers no invite control to a plain member', async () => {
    renderWith(new FakeDataClient({ role: 'member' }), <TeamPage />)
    await screen.findByText('MemBridge HQ')
    expect(screen.queryByRole('button', { name: /copy invite link/i })).toBeNull()
    // The standing code is not a consolation prize -- handing it to a member
    // is the thing the security lane removed.
    expect(screen.queryByRole('button', { name: /copy invite code/i })).toBeNull()
    // And no orphaned lifetime controls for a link they cannot mint.
    expect(screen.queryByLabelText(/expires/i)).toBeNull()
  })

  // Not silence. A member who finds no affordance at all cannot tell whether
  // the feature is missing, broken, or not theirs -- so say which. The People
  // list immediately below names every member and their role, so this points
  // at the answer rather than duplicating it (two lists that can disagree is
  // how the roster and the invite area would drift apart).
  it('tells the member that inviting is an owner/admin action, rather than saying nothing', async () => {
    renderWith(new FakeDataClient({ role: 'member' }), <TeamPage />)
    const note = await screen.findByTestId('invite-manager-only')
    expect(note).toHaveTextContent(/owner/i)
    expect(note).toHaveTextContent(/admin/i)
    // Points at the roster that is already on this page.
    expect(note).toHaveTextContent(/below/i)
  })

  // THE COUNTER-CHECK, both directions.
  it('still offers the control to an admin, and says nothing about permission', async () => {
    renderWith(new FakeDataClient({ role: 'admin' }), <TeamPage />)
    expect(await screen.findByRole('button', { name: /copy invite link/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/expires/i)).toBeInTheDocument()
    expect(screen.queryByTestId('invite-manager-only')).toBeNull()
  })

  it('still offers the control to the owner', async () => {
    renderWith(new FakeDataClient({ role: 'owner' }), <TeamPage />)
    expect(await screen.findByRole('button', { name: /copy invite link/i })).toBeInTheDocument()
    expect(screen.queryByTestId('invite-manager-only')).toBeNull()
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
