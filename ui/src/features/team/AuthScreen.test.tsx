// The signed-out screen. It is a whole screen rather than a card on the Team
// page because its job -- being trusted with a password -- is not served by
// sitting under a dashboard title with an amber warning above it.
import { describe, it, expect, afterEach } from 'vitest'
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
