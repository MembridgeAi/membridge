import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import type { Insights } from '../../data/types'
import { InsightsPage } from './InsightsPage'

// The shared FakeDataClient fixture (ui/src/data/FakeDataClient.ts, out of
// this task's scope) phrases its "broken" problem as a machine diagnosis
// ("...hook not installed since she joined") rather than the absence
// framing the product requires ("Nothing has arrived from Sarah"). This
// subclass -- local to this test file, touching nothing under ui/src/data/
// -- overrides just the problems list so the phrasing rule itself can be
// verified. See the task report for the fixture-drift flag.
class AbsenceFixtureClient extends FakeDataClient {
  async getInsights(window: 7 | 30 | 90): Promise<Insights> {
    const base = await super.getInsights(window)
    return {
      ...base,
      problems: [
        {
          id: 'p1', severity: 'broken', headline: 'Nothing has arrived from Sarah',
          scale: 'joined 3 days ago · 0 entries shared',
          action: { label: 'Send setup steps', kind: 'setup-steps' },
        },
        {
          id: 'p2', severity: 'minor', headline: '2 sessions missing summaries',
          scale: 'of 412 · both crashed mid-session', action: null,
        },
      ],
    }
  }
}

describe('InsightsPage', () => {
  it('renders exactly two skeleton lines', async () => {
    renderApp({}, <InsightsPage />)
    const panel = await screen.findByTestId('skeleton-panel')
    expect(within(panel).getAllByRole('row')).toHaveLength(2)
    expect(within(panel).getByText('Repeat file opens')).toBeInTheDocument()
    expect(within(panel).getByText('Answered by our memory first')).toBeInTheDocument()
  })

  it('shows the stat as pending rather than a number when unavailable', async () => {
    renderApp({ skeletonAvailable: false }, <InsightsPage />)
    expect(await screen.findAllByText(/pending/i)).not.toHaveLength(0)
    expect(screen.queryByText('68%')).toBeNull()
  })

  it('separates broken problems from minor ones and shows each denominator', async () => {
    renderApp({}, <InsightsPage />)
    const broken = await screen.findByTestId('problems-broken')
    const minor = screen.getByTestId('problems-minor')
    // Denominators come straight from the API's `scale` line for either
    // severity -- 47 of 47 for the broken problem, of 412 for the minor one.
    expect(within(broken).getByText(/47 of 47/)).toBeInTheDocument()
    expect(within(minor).getByText(/of 412/)).toBeInTheDocument()
  })

  it('offers the fixing action on a broken problem', async () => {
    renderApp({}, <InsightsPage />)
    expect(await screen.findByRole('button', { name: /send setup steps/i })).toBeInTheDocument()
  })

  it('phrases a teammate problem as absence, never as a machine diagnosis', async () => {
    renderWith(new AbsenceFixtureClient(), <InsightsPage />)
    const broken = await screen.findByTestId('problems-broken')
    expect(within(broken).getByText(/Nothing has arrived from Sarah/)).toBeInTheDocument()
    expect(within(broken).getByText(/0 entries shared/)).toBeInTheDocument()
    // The action asks them to check; it must not diagnose their machine.
    expect(screen.queryByText(/hook not installed|token expired/i)).toBeNull()
  })

  it('renders no dollar figure anywhere', async () => {
    const { container } = renderApp({}, <InsightsPage />)
    await screen.findByText(/repeat file opens/i)
    expect(container.textContent).not.toMatch(/\$/)
  })

  it('has no heat grid', async () => {
    renderApp({}, <InsightsPage />)
    await screen.findByText(/repeat file opens/i)
    expect(screen.queryByText(/when the team works/i)).toBeNull()
  })

  it('never calls getInsights for a member role', async () => {
    const client = new FakeDataClient({ role: 'member' })
    const insightsSpy = vi.spyOn(client, 'getInsights')
    renderWith(client, <InsightsPage />)
    expect(await screen.findByText(/owners and admins/i)).toBeInTheDocument()
    expect(insightsSpy).not.toHaveBeenCalled()
  })

  it('never calls getInsights in solo mode', async () => {
    const client = new FakeDataClient({ solo: true })
    const insightsSpy = vi.spyOn(client, 'getInsights')
    renderWith(client, <InsightsPage />)
    expect(await screen.findByText(/owners and admins/i)).toBeInTheDocument()
    expect(insightsSpy).not.toHaveBeenCalled()
  })

  it('switches the time window and refetches for the new window', async () => {
    const client = new FakeDataClient()
    const insightsSpy = vi.spyOn(client, 'getInsights')
    renderWith(client, <InsightsPage />)
    await screen.findByText(/repeat file opens/i)
    expect(insightsSpy).toHaveBeenCalledWith(30)

    await userEvent.click(screen.getByRole('button', { name: '7 days' }))
    expect(await screen.findByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true')
    expect(insightsSpy).toHaveBeenCalledWith(7)
  })
})
