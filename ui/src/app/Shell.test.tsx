import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DataClientProvider } from '../data/DataClientProvider'
import { FakeDataClient } from '../data/FakeDataClient'
import type { Settings, Status, TeamAccount } from '../data/types'
import { App } from './App'
import { ROUTES } from './routes'
import { renderApp, renderWith } from '../test/renderApp'

// A machine that has not finished setup. FakeDataClient pins setupDone true,
// and the first-run takeover is the only state in the app where the rendered
// screen is decoupled from the URL, so it has to be reachable to test.
class FirstRunClient extends FakeDataClient {
  async getStatus(): Promise<Status> {
    return { ...(await super.getStatus()), setupDone: false }
  }
}

// The route survives a render, so a test that navigates has to put it back or
// it leaks into every test after it in this file.
afterEach(() => {
  cleanup()
  window.history.pushState({}, '', '/')
})

describe('Shell', () => {
  it('renders the brand mark with an accessible name, not hidden from assistive tech', async () => {
    renderApp({ solo: true })
    await screen.findByRole('link', { name: 'Today' })
    expect(screen.getByRole('img', { name: 'MemBridge' })).toBeInTheDocument()
  })

  it('shows the team switcher and team navigation for an owner on a team', async () => {
    renderApp({ solo: false })
    // No Members link: the roster is a section of the Team page now, and
    // Team is an unconditional nav item above this block.
    expect(await screen.findByRole('link', { name: 'Insights' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull()
    expect(screen.getByText('MemBridge HQ')).toBeInTheDocument()
  })

  it('omits team navigation entirely in solo mode, not disabled, absent', async () => {
    renderApp({ solo: true })
    await screen.findByRole('link', { name: 'Today' })
    expect(screen.queryByRole('link', { name: 'Insights' })).toBeNull()
    expect(screen.queryByText(/MemBridge HQ/)).toBeNull()
  })

  it('offers creating a team when solo', async () => {
    renderApp({ solo: true })
    expect(await screen.findByRole('button', { name: /create a team/i })).toBeInTheDocument()
  })

  it('shows the team switcher but hides Insights for a member role', async () => {
    renderApp({ solo: false, role: 'member' })
    expect(await screen.findByText('MemBridge HQ')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Insights' })).toBeNull()
  })

  it('renders neither the team group nor the solo CTA while status and settings are loading', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // Never-resolving client: proves the loading window itself, not just the
    // eventual settled state.
    const pendingClient = new FakeDataClient()
    pendingClient.getStatus = () => new Promise<Status>(() => {})
    pendingClient.getSettings = () => new Promise<Settings>(() => {})

    render(
      <QueryClientProvider client={qc}>
        <DataClientProvider client={pendingClient}><App /></DataClientProvider>
      </QueryClientProvider>,
    )

    expect(screen.queryByRole('link', { name: 'Insights' })).toBeNull()
    expect(screen.queryByRole('button', { name: /create a team/i })).toBeNull()
  })

  it('renders neither the team group nor the solo CTA, plus a visible message, when getStatus() rejects', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // getSettings() resolves fine (would otherwise show Members/Insights) —
    // isolates the assertion to getStatus() actually rejecting, not both.
    const rejectingClient = new FakeDataClient({ solo: false })
    rejectingClient.getStatus = () => Promise.reject(new Error('daemon unreachable'))

    render(
      <QueryClientProvider client={qc}>
        <DataClientProvider client={rejectingClient}><App /></DataClientProvider>
      </QueryClientProvider>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('daemon unreachable')
    expect(screen.queryByRole('link', { name: 'Insights' })).toBeNull()
    expect(screen.queryByRole('button', { name: /create a team/i })).toBeNull()
  })

  // The rail footer is the only always-visible chrome on every screen, so it
  // is where a signed-out machine has to admit it is signed out. Before this,
  // the footer read the literal word "You" in both states and the rail
  // carried no sign-in affordance at all, which is how a freshly installed
  // app left someone with no discoverable way in.
  describe('rail footer identity', () => {
    it('offers a sign-in control pointing at the Team page when the machine is signed out', async () => {
      renderApp({ authenticated: false, solo: true })
      // Team page, not Settings: TeamPage's SignInCard is the only surface in
      // the app that can actually take credentials.
      expect(await screen.findByRole('link', { name: /sign in/i })).toHaveAttribute('href', ROUTES.team)
    })

    it('names the signed-in user in the rail footer rather than the hardcoded "You"', async () => {
      renderApp({ authenticated: true, solo: true })
      expect(await screen.findByTestId('rail-identity')).toHaveTextContent('Marco')
      expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull()
    })

    // Signed out, `solo` is also true, so a create-team CTA keyed on solo
    // alone invites someone to create a team before they have an account and
    // drops them on a sign-in wall instead. Being signed in is what the
    // create flow actually requires, so that is what gates it.
    it('withholds the create-team CTA from a signed-out machine and offers sign-in instead', async () => {
      renderApp({ authenticated: false, solo: true })
      await screen.findByRole('link', { name: /sign in/i })
      expect(screen.queryByRole('button', { name: /create a team/i })).toBeNull()
    })

    it('still offers the create-team CTA to a signed-in machine with no team', async () => {
      renderApp({ authenticated: true, solo: true })
      expect(await screen.findByRole('button', { name: /create a team/i })).toBeInTheDocument()
    })

    it('renders neither a sign-in control nor an identity while the account is still loading', () => {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      // Only getTeamAccount hangs; status and settings resolve normally. That
      // isolates the assertion to the account query, and proves the footer
      // stays silent rather than flashing "Sign in" at someone who turns out
      // to be signed in a moment later.
      const pendingClient = new FakeDataClient({ solo: true })
      pendingClient.getTeamAccount = () => new Promise<TeamAccount>(() => {})

      render(
        <QueryClientProvider client={qc}>
          <DataClientProvider client={pendingClient}><App /></DataClientProvider>
        </QueryClientProvider>,
      )

      expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull()
      expect(screen.queryByTestId('rail-identity')).toBeNull()
    })
  })

  // App.tsx renders the first-run takeover regardless of path, but NavLink
  // derived its active state straight from useRoute(to). So clicking Settings
  // during first run pushed /settings, lit the Settings rail entry, and left
  // the Welcome screen on the page: the app reported a location it was not
  // rendering. That is worse than a dead link, because the rail is the app's
  // own answer to "where am I" and it was giving a false one -- and FirstRun's
  // copy points at Settings in the present tense, so the reader has every
  // reason to believe the highlight.
  //
  // This asserts ONLY the honesty half. Whether the takeover should be
  // escapable at all is a product call and lands separately; making Settings
  // reachable here would pre-empt it.
  describe('first-run takeover', () => {
    it('marks no nav route active, because the app is not rendering any of them', async () => {
      renderWith(new FirstRunClient(), <App />)
      await screen.findByText('Welcome to MemBridge')

      await userEvent.click(screen.getByRole('link', { name: 'Settings' }))

      // The takeover is still what is on screen...
      expect(screen.getByText('Welcome to MemBridge')).toBeInTheDocument()
      // ...so nothing in the rail may claim otherwise.
      expect(document.querySelectorAll('.nav-item-active')).toHaveLength(0)
    })

    it('still marks the route active once setup is done', async () => {
      window.history.pushState({}, '', ROUTES.settings)
      renderApp({})
      await screen.findByRole('link', { name: 'Settings' })
      // The guard must be scoped to the takeover: normal navigation still
      // shows the reader where they are.
      expect(document.querySelectorAll('.nav-item-active').length).toBeGreaterThan(0)
    })
  })
})
