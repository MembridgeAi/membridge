import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DataClientProvider } from '../data/DataClientProvider'
import { FakeDataClient } from '../data/FakeDataClient'
import type { Settings, Status, TeamAccount } from '../data/types'
import { App } from './App'
import { ROUTES } from './routes'
import { renderApp } from '../test/renderApp'

describe('Shell', () => {
  it('renders the brand mark with an accessible name, not hidden from assistive tech', async () => {
    renderApp({ solo: true })
    await screen.findByRole('link', { name: 'Today' })
    expect(screen.getByRole('img', { name: 'MemBridge' })).toBeInTheDocument()
  })

  it('shows the team switcher and team navigation for an owner on a team', async () => {
    renderApp({ solo: false })
    expect(await screen.findByRole('link', { name: 'Members' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Insights' })).toBeInTheDocument()
    expect(screen.getByText('MemBridge HQ')).toBeInTheDocument()
  })

  it('omits team navigation entirely in solo mode, not disabled, absent', async () => {
    renderApp({ solo: true })
    await screen.findByRole('link', { name: 'Today' })
    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Insights' })).toBeNull()
    expect(screen.queryByText(/MemBridge HQ/)).toBeNull()
  })

  it('offers creating a team when solo', async () => {
    renderApp({ solo: true })
    expect(await screen.findByRole('button', { name: /create a team/i })).toBeInTheDocument()
  })

  it('shows the team switcher but hides Members and Insights for a member role', async () => {
    renderApp({ solo: false, role: 'member' })
    expect(await screen.findByText('MemBridge HQ')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull()
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

    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull()
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
    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull()
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
})
