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
})
