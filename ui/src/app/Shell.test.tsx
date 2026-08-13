import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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

// FakeOptions has no `authenticated` flag, so the signed-out machine is
// modelled the way FirstRunClient models an unfinished setup above: a
// subclass overriding the one query that decides.
class SignedOutClient extends FakeDataClient {
  async getTeamAccount(): Promise<TeamAccount> {
    return { ...(await super.getTeamAccount()), authenticated: false, user: null }
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

    it('opens the identity editor on a double-click of your name', async () => {
      renderApp({ solo: false })
      const identity = await screen.findByTestId('rail-identity')
      await userEvent.dblClick(identity)
      expect(await screen.findByRole('dialog', { name: /your name/i })).toBeInTheDocument()
    })

    // Double-click is unreachable without a mouse, so the same control answers
    // Enter and Space when focused -- the keyboard path for a sighted user
    // tabbing in without assistive tech running (see the AT test below for
    // the separate path a screen reader takes).
    it.each(['{Enter}', ' '])('opens the identity editor with the keyboard (%s)', async key => {
      renderApp({ solo: false })
      const identity = await screen.findByTestId('rail-identity')
      identity.focus()
      await userEvent.keyboard(key)
      expect(await screen.findByRole('dialog', { name: /your name/i })).toBeInTheDocument()
    })

    // A single click must NOT open it -- "double tap" is the asked-for gesture,
    // and a plain <button> would fire on the first one.
    it('does not open the editor on a single click', async () => {
      renderApp({ solo: false })
      const identity = await screen.findByTestId('rail-identity')
      await userEvent.click(identity)
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    // NVDA/JAWS activate a role="button" element by dispatching a synthetic
    // CLICK, not a keydown -- so a screen-reader user pressing Enter on this
    // control never reaches the onKeyDown handler above. A real mouse click
    // always carries MouseEvent.detail 1; only an AT-synthesised (or
    // programmatic) click carries 0, which is the only thing that tells the
    // two apart. userEvent.click always sets detail 1, so this has to go
    // through fireEvent directly to exercise the AT path at all.
    it('opens the identity editor on an assistive-technology activation (detail: 0)', async () => {
      renderApp({ solo: false })
      const identity = await screen.findByTestId('rail-identity')
      fireEvent.click(identity, { detail: 0 })
      expect(await screen.findByRole('dialog', { name: /your name/i })).toBeInTheDocument()
    })

    it('offers no identity editor when signed out', async () => {
      renderWith(new SignedOutClient({ solo: true }), <App />)
      expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument()
      expect(screen.queryByTestId('rail-identity')).toBeNull()
    })
  })

  // Shell mounts AvatarRegistryProvider around the whole app so that every
  // Avatar anywhere -- MemberRow, AccessPopover, feed entries, and so on --
  // can resolve a teammate's picked glyph purely from their id. Nothing
  // upstream of this test exercised that: it is possible to delete the
  // useMemo AND the provider wrapper in Shell.tsx and have every other test
  // in this suite (and components.test.tsx's own registry test, which
  // supplies its own provider directly) stay green.
  describe('teammate avatar registry', () => {
    // Scoped to this test only, via a getMembers() override, rather than
    // editing FakeDataClient's shared roster -- that roster backs many other
    // suites (MembersSection, ProjectsPage, ...) and giving Andrew a glyph
    // there would change what they see too.
    class AvatarRosterClient extends FakeDataClient {
      async getMembers() {
        const members = await super.getMembers()
        return members.map(m => (m.id === 'andrew' ? { ...m, avatar: 'halo', avatarColor: '#22C08F' } : m))
      }
    }

    it("renders a teammate's registered glyph, not their initial", async () => {
      window.history.pushState({}, '', ROUTES.team)
      renderWith(new AvatarRosterClient({ solo: false }), <App />)
      // Same discriminator components.test.tsx's Avatar suite uses:
      // AvatarGlyph puts the accessible name on the <svg role="img">, which
      // the plain-initial <span class="avatar"> never gets.
      expect(await screen.findByRole('img', { name: 'Andrew' })).toBeInTheDocument()
    })

    // Shape and colour are independent choices (the picker has two separate
    // rows), so a teammate who left the glyph on "Initial" and picked only a
    // colour must still get that colour -- registering members solely on
    // `person.avatar` being truthy drops this person from the map entirely,
    // and every call site silently falls back to colorForId(id) instead.
    class ColorOnlyRosterClient extends FakeDataClient {
      async getMembers() {
        const members = await super.getMembers()
        return members.map(m => (m.id === 'sarah' ? { ...m, avatar: null, avatarColor: '#22C08F' } : m))
      }
    }

    it("renders a teammate's picked colour even with no glyph chosen, not the id-derived colour", async () => {
      window.history.pushState({}, '', ROUTES.team)
      renderWith(new ColorOnlyRosterClient({ solo: false }), <App />)
      const el = await screen.findByLabelText('Sarah')
      // colorForId('sarah') is deterministic -- #F0616D / rgb(240, 97, 109),
      // per components.test.tsx's Avatar suite -- so asserting the exact
      // picked value AND that it differs from the derived one rules out a
      // regression that silently falls back to the derived colour.
      expect(el.style.background).toBe('rgb(34, 192, 143)')
      expect(el.style.background).not.toBe('rgb(240, 97, 109)')
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
