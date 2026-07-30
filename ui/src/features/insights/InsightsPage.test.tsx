import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { InsightsPage } from './InsightsPage'

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
    // severity -- "joined 3 days ago" for the broken (absence-phrased)
    // problem, "of 412" for the minor one.
    expect(within(broken).getByText(/joined 3 days ago/)).toBeInTheDocument()
    expect(within(minor).getByText(/of 412/)).toBeInTheDocument()
  })

  it('offers the fixing action on a broken problem', async () => {
    renderApp({}, <InsightsPage />)
    expect(await screen.findByRole('button', { name: /send setup steps/i })).toBeInTheDocument()
  })

  // Task 18 Part C: the default fixture used to phrase this as a machine
  // diagnosis ("...hook not installed since she joined"), which this
  // machine has no way to actually know -- it can only see that nothing has
  // arrived. Fixed to match lib/api-insights.js's real silentTeammateProblems
  // wording exactly ("Nothing has arrived from X").
  it('phrases a teammate problem as absence, never as a machine diagnosis', async () => {
    renderApp({}, <InsightsPage />)
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

  // Assists breakdown (owner's ask: "answered by our memory first should be
  // a better stat -- it should be any instance where the memory helped").
  // The default FakeDataClient fixture is total: 876, byKind: { recallServed:
  // 818, teammateNotes: 46, mcpQueries: 12 } -- 818 + 46 + 12 = 876, so the
  // headline is provably the sum of the auditable rows underneath it, not a
  // magic number.
  it('renders the assists breakdown and its rows sum to the headline', async () => {
    renderApp({}, <InsightsPage />)
    const strip = await screen.findByText('876')
    expect(strip.closest('.stat-cell')).toHaveTextContent('times memory helped')

    const breakdown = await screen.findByTestId('assists-breakdown')
    const rows = within(breakdown).getAllByRole('row')
    expect(rows).toHaveLength(3)
    expect(within(breakdown).getByText('Recall served a file instead of a read')).toBeInTheDocument()
    expect(within(breakdown).getByText('818')).toBeInTheDocument()
    expect(within(breakdown).getByText('Teammate notes delivered into a session')).toBeInTheDocument()
    expect(within(breakdown).getByText('46')).toBeInTheDocument()
    expect(within(breakdown).getByText('MCP memory tools queried')).toBeInTheDocument()
    expect(within(breakdown).getByText('12')).toBeInTheDocument()

    const sum = 818 + 46 + 12
    expect(sum).toBe(876)
  })

  it('shows no breakdown, only pending, when assists are unavailable', async () => {
    renderApp({ skeletonAvailable: false }, <InsightsPage />)
    await screen.findAllByText(/pending/i)
    expect(screen.queryByTestId('assists-breakdown')).toBeNull()
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
