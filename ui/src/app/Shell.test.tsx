import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DataClientProvider } from '../data/DataClientProvider'
import { FakeDataClient } from '../data/FakeDataClient'
import type { Settings, Status } from '../data/types'
import { App } from './App'
import { renderApp } from '../test/renderApp'

describe('Shell', () => {
  it('shows the team switcher and team navigation for an owner on a team', async () => {
    renderApp({ solo: false })
    expect(await screen.findByRole('link', { name: 'Members' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Insights' })).toBeInTheDocument()
    expect(screen.getByText('MemBridge HQ')).toBeInTheDocument()
  })

  it('omits team navigation entirely in solo mode — not disabled, absent', async () => {
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
})
