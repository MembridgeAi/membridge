// The signed-out screen. It is a whole screen rather than a card on the Team
// page because its job -- being trusted with a password -- is not served by
// sitting under a dashboard title with an amber warning above it.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { AuthScreen } from './AuthScreen'

afterEach(cleanup)

describe('AuthScreen', () => {
  it('leads with the product, the action, and what the action is for', async () => {
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByText('to continue to MemBridge')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'MemBridge' })).toBeInTheDocument()
  })

  it('offers GitHub as a real navigation, not a fetch', async () => {
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    const link = await screen.findByRole('link', { name: /continue with github/i })
    expect(link).toHaveAttribute('href', '/team/oauth/github')
  })

  it('switches to sign-up and back, and the switch is a link, not a second button', async () => {
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))
    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument()
    // The name field only exists on the sign-up side.
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /sign in instead/i }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/your name/i)).toBeNull()
  })

  it('still says the build has no backend when it has none', async () => {
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured={false} />)
    expect(await screen.findByText(/no team service to sign in to/i)).toBeInTheDocument()
  })

  it('keeps the solo promise on screen, below the form rather than above it', async () => {
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    expect(await screen.findByText(/works solo too/i)).toBeInTheDocument()
  })
})

describe('AuthScreen password rules', () => {
  it('shows no meter on the sign-in side, where an old short password must still work', async () => {
    const client = new FakeDataClient({ authenticated: false })
    const signIn = vi.spyOn(client, 'signIn')
    renderWith(client, <AuthScreen configured />)
    await userEvent.type(await screen.findByLabelText(/email/i), 'andrew@acme.dev')
    await userEvent.type(screen.getByLabelText(/password/i), 'short')
    expect(screen.queryByTestId('auth-strength')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    // Not blocked: a client-side minimum on sign-in locks out real accounts
    // created before the rule, and every GitHub account, for no benefit.
    expect(signIn).toHaveBeenCalledWith({ email: 'andrew@acme.dev', password: 'short' })
  })

  it('refuses a short sign-up without calling the daemon, and says the minimum', async () => {
    const client = new FakeDataClient({ authenticated: false })
    const signUp = vi.spyOn(client, 'signUp')
    renderWith(client, <AuthScreen configured />)
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))
    await userEvent.type(screen.getByLabelText(/your name/i), 'Andrew')
    await userEvent.type(screen.getByLabelText(/email/i), 'new@acme.dev')
    await userEvent.type(screen.getByLabelText(/password/i), 'short')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText('Use at least 8 characters.')).toBeInTheDocument()
    expect(signUp).not.toHaveBeenCalled()
  })

  it('rates a typed sign-up password, and never renders the password itself', async () => {
    const { container } = renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))
    const secret = 'Abcdefghijklmno1'
    await userEvent.type(screen.getByLabelText(/password/i), secret)

    expect(await screen.findByTestId('auth-strength')).toHaveTextContent('Strong')
    // The password may live in the DOM field's value; it must appear nowhere
    // in rendered TEXT, which is what a state-held password would leak into.
    expect(container.textContent).not.toContain(secret)
  })

  it('submits a weak-but-long-enough password: the meter advises, it does not gate', async () => {
    const client = new FakeDataClient({ authenticated: false })
    const signUp = vi.spyOn(client, 'signUp')
    renderWith(client, <AuthScreen configured />)
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))
    await userEvent.type(screen.getByLabelText(/your name/i), 'Andrew')
    await userEvent.type(screen.getByLabelText(/email/i), 'new@acme.dev')
    await userEvent.type(screen.getByLabelText(/password/i), 'abcdefgh')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(signUp).toHaveBeenCalledWith({ displayName: 'Andrew', email: 'new@acme.dev', password: 'abcdefgh' })
  })

  it('does not render the meter over an untouched field, shows it once typing starts, and hides it again once a rejected submit clears the field', async () => {
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))

    // Switching to sign-up alone must not render "Weak" and a red segment
    // under a field nobody has touched yet -- there is nothing to score.
    const passwordField = screen.getByLabelText(/password/i)
    expect(screen.queryByTestId('auth-strength')).toBeNull()

    await userEvent.type(passwordField, 'a')
    expect(await screen.findByTestId('auth-strength')).toBeInTheDocument()

    // Backspacing back to nothing is the same "nothing to score" state --
    // the meter should not linger describing an empty field either.
    await userEvent.clear(passwordField)
    expect(screen.queryByTestId('auth-strength')).toBeNull()

    // Now drive an actual rejected submit (short password) and confirm the
    // meter disappears via the finally-block reset, not just the manual clear.
    await userEvent.type(screen.getByLabelText(/your name/i), 'Andrew')
    await userEvent.type(screen.getByLabelText(/email/i), 'new@acme.dev')
    await userEvent.type(passwordField, 'short')
    expect(await screen.findByTestId('auth-strength')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText('Use at least 8 characters.')).toBeInTheDocument()
    expect(screen.queryByTestId('auth-strength')).toBeNull()
  })

  it('clears a typed password on toggling away from sign-up, so switching back does not silently carry an undescribed password in the DOM', async () => {
    // Regression: the password <input> is never unmounted by the isSignUp
    // toggle -- only "Your name" and the meter are conditional -- so its
    // uncontrolled DOM value used to survive a round trip through sign-in
    // while `strength` (reset to null by the toggle handler) did not. That
    // let a real, weak, non-empty password sit in the field with no meter
    // describing it: state and DOM disagreed about whether it was empty.
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))

    const passwordField = screen.getByLabelText(/password/i)
    await userEvent.type(passwordField, 'short')
    expect(await screen.findByTestId('auth-strength')).toBeInTheDocument()

    // Sign-up -> sign-in -> sign-up, without ever retyping the password.
    await userEvent.click(screen.getByRole('button', { name: /sign in instead/i }))
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))

    expect(screen.getByLabelText(/password/i)).toHaveValue('')
    expect(screen.queryByTestId('auth-strength')).toBeNull()
  })
})

describe('AuthScreen sign-up outcome handling is exhaustive', () => {
  // A runtime test cannot prove `tsc` rejects a dropped switch case, so this
  // instead pins the three outcomes to three distinct, mutually exclusive,
  // user-visible results. If a future case were ever handled by falling into
  // a neighboring branch (the failure mode a non-exhaustive if/else-if
  // permits silently), one of these three assertions goes false loudly.
  it('produces a distinct visible outcome for each of the three SignUpResult statuses', async () => {
    // needs-confirmation: the "go check your email" notice, sign-in mode.
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))
    await userEvent.type(screen.getByLabelText(/your name/i), 'Andrew')
    await userEvent.type(screen.getByLabelText(/email/i), 'brand-new@acme.dev')
    await userEvent.type(screen.getByLabelText(/password/i), 'long-enough-password')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText(/Account created\. Confirm brand-new@acme\.dev/)).toBeInTheDocument()
    expect(screen.queryByText(/already has an account/)).toBeNull()
    cleanup()

    // email-exists: the "sign in instead" notice, sign-in mode, no confirm wording.
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))
    await userEvent.type(screen.getByLabelText(/your name/i), 'Andrew')
    await userEvent.type(screen.getByLabelText(/email/i), FakeDataClient.REGISTERED_EMAIL)
    await userEvent.type(screen.getByLabelText(/password/i), 'long-enough-password')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText(/That email already has an account\./)).toBeInTheDocument()
    expect(screen.queryByText(/Account created/)).toBeNull()
    cleanup()

    // signed-in: a deliberate no-op. The fake never resolves this status on
    // its own (it only ever answers needs-confirmation or email-exists), so
    // it's mocked directly to actually exercise that branch of the switch --
    // no notice, no mode switch, unlike the other two outcomes which both
    // produce one of each.
    const signedInClient = new FakeDataClient({ authenticated: false })
    vi.spyOn(signedInClient, 'signUp').mockResolvedValue({ status: 'signed-in' })
    renderWith(signedInClient, <AuthScreen configured />)
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))
    await userEvent.type(screen.getByLabelText(/your name/i), 'Andrew')
    await userEvent.type(screen.getByLabelText(/email/i), 'anyone@acme.dev')
    await userEvent.type(screen.getByLabelText(/password/i), 'long-enough-password')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))

    await screen.findByLabelText(/email/i) // let the submit's state updates settle
    expect(screen.queryByText(/Account created/)).toBeNull()
    expect(screen.queryByText(/already has an account/)).toBeNull()
    // Neither notice-producing branch ran, so mode never switched off sign-up.
    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument()
  })
})

describe('AuthScreen, signing up with an address that already has an account', () => {
  it('says so, switches to sign-in, keeps the email, and puts the cursor in the password', async () => {
    // The shipped bug: this path told the user "Account created. Confirm
    // <email> from the email just sent to it" -- no account was created and
    // no mail was sent, so they waited for something that never arrived.
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))
    await userEvent.type(screen.getByLabelText(/your name/i), 'Andrew')
    await userEvent.type(screen.getByLabelText(/email/i), FakeDataClient.REGISTERED_EMAIL)
    await userEvent.type(screen.getByLabelText(/password/i), 'long-enough-password')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText(/That email already has an account\./)).toBeInTheDocument()
    expect(screen.getByText(/Sign in below to continue\./)).toBeInTheDocument()
    // Never the old sentence, on this path or any other.
    expect(screen.queryByText(/Account created/)).toBeNull()

    // The form is now sign-in, the email survived, and the password is where
    // the cursor is -- the email was correct, it just meant something else.
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByLabelText(/email/i)).toHaveValue(FakeDataClient.REGISTERED_EMAIL)
    expect(screen.getByLabelText(/password/i)).toHaveFocus()
    expect(screen.getByLabelText(/password/i)).toHaveValue('')
  })

  it('still tells a genuinely new account to go and confirm its email', async () => {
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))
    await userEvent.type(screen.getByLabelText(/your name/i), 'Andrew')
    await userEvent.type(screen.getByLabelText(/email/i), 'brand-new@acme.dev')
    await userEvent.type(screen.getByLabelText(/password/i), 'long-enough-password')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText(/Account created\. Confirm brand-new@acme\.dev/)).toBeInTheDocument()
  })
})
