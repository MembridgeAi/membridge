import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { renderApp } from '../test/renderApp'

describe('Shell', () => {
  it('shows the team switcher and team navigation on a team', async () => {
    renderApp({ solo: false })
    expect(await screen.findByRole('link', { name: 'Members' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Insights' })).toBeInTheDocument()
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

  it('hides team navigation from a member role', async () => {
    renderApp({ solo: false, role: 'member' })
    await screen.findByRole('link', { name: 'Today' })
    expect(screen.queryByRole('link', { name: 'Insights' })).toBeNull()
  })
})
