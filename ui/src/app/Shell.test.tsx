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
  // The rail's health dot is the only status indicator on every screen. It used
  // to render on `status.running` alone, so BOTH running:false states -- a
  // wedged sync loop and a daemon nobody has observed -- made it silently
  // vanish, and the degraded-but-alive 'erroring' state showed the same healthy
  // green as 'ok'. An absent dot asserts nothing, which is right for "not
  // observed" and wrong for "stalled": that is exactly when the rail should be
  // sending the user to look.
  describe('rail health dot', () => {
    const dot = () => document.querySelector('.status-dot')
    // `Insights` only renders once Shell's `ready` is true, i.e. once the status
    // AND settings queries have both resolved. Anchoring on the Settings link
    // instead reads the dot mid-load, when status is still undefined and the dot
    // is legitimately absent for every state -- which would make the two
    // "no dot" cases pass for the wrong reason.
    const railReady = () => screen.findByRole('link', { name: 'Insights' })

    it('is green and says running when a pass completed', async () => {
      renderWith(new FakeDataClient({ health: { state: 'ok', lastTickAt: '2026-07-29T21:00:00Z', lastTickError: null, staleForSec: 5 } }), <App />)
      await railReady()
      expect(dot()).toBeTruthy()
      expect(dot()!.className).not.toMatch(/status-dot-(warn|bad)/)
      expect(dot()!.getAttribute('aria-label')).toMatch(/running/i)
    })

    it('goes amber and names the failure while erroring, rather than reading healthy', async () => {
      renderWith(new FakeDataClient({ health: { state: 'erroring', lastTickAt: '2026-07-29T21:00:00Z', lastTickError: 'boom', staleForSec: 9 } }), <App />)
      await railReady()
      expect(dot()!.className).toMatch(/status-dot-warn/)
      expect(dot()!.getAttribute('aria-label')).toMatch(/last sync failed/i)
    })

    // The dot must be PRESENT here. Hiding it was the old behaviour and it is
    // the wrong one: a stalled loop is the state most worth surfacing.
    it('stays visible and turns red when the loop is stalled', async () => {
      renderWith(new FakeDataClient({ health: { state: 'stalled', lastTickAt: '2026-07-29T18:00:00Z', lastTickError: null, staleForSec: 900 } }), <App />)
      await railReady()
      expect(dot()).toBeTruthy()
      expect(dot()!.className).toMatch(/status-dot-bad/)
      expect(dot()!.getAttribute('aria-label')).toMatch(/stalled/i)
    })

    // A dot is an assertion, so an unobserved state renders none.
    it('shows no dot at all when health was never observed', async () => {
      renderWith(new FakeDataClient({ health: { state: 'unknown', lastTickAt: null, lastTickError: null, staleForSec: null } }), <App />)
      await railReady()
      expect(dot()).toBeNull()
    })

    // An older daemon sends `running` alone; the rail keeps its original
    // behaviour rather than editorialising about a field it cannot see.
    it('falls back to the plain running dot when the daemon sends no health', async () => {
      renderWith(new FakeDataClient({ health: null }), <App />)
      await railReady()
      expect(dot()).toBeTruthy()
      expect(dot()!.className).not.toMatch(/status-dot-(warn|bad)/)
    })
  })
})

// ---------------------------------------------------------------------------
// Focus follows the route.
//
// A client-side navigation replaces the page without moving focus, which left
// a keyboard user on <body> at the destination with the whole rail to tab back
// through. These cover the move AND the two cases where moving focus would be
// the wrong thing to do.
// ---------------------------------------------------------------------------
describe('Shell: keyboard focus across route changes', () => {
  const main = () => document.querySelector('main.shell-main') as HTMLElement

  it('moves focus to the main landmark after a client-side navigation', async () => {
    const user = userEvent.setup()
    renderApp({ solo: true })
    await screen.findByRole('link', { name: 'Projects' })

    await user.click(screen.getByRole('link', { name: 'Projects' }))

    expect(document.activeElement).toBe(main())
  })

  it('leaves focus alone on first mount', async () => {
    renderApp({ solo: true })
    await screen.findByRole('link', { name: 'Today' })
    // A cold load has not navigated anywhere. Grabbing focus here would skip
    // the rail before the reader has had a chance to see it.
    expect(document.activeElement).not.toBe(main())
  })

  it('does not steal focus when the path is unchanged', async () => {
    const user = userEvent.setup()
    renderApp({ solo: true })
    await screen.findByRole('link', { name: 'Projects' })

    await user.click(screen.getByRole('link', { name: 'Projects' }))
    expect(document.activeElement).toBe(main())

    // Re-activating the link the app is already on is not a navigation. If the
    // effect keyed on anything looser than the path, this would yank focus off
    // whatever control the reader had moved to since.
    const projectsLink = screen.getByRole('link', { name: 'Projects' })
    projectsLink.focus()
    await user.click(projectsLink)

    expect(document.activeElement).toBe(projectsLink)
  })

  it('keeps the landmark out of the tab order', async () => {
    renderApp({ solo: true })
    await screen.findByRole('link', { name: 'Today' })
    // Programmatically focusable, never a tab stop.
    expect(main().getAttribute('tabindex')).toBe('-1')
  })
})
