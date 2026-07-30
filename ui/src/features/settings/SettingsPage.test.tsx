import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { SettingsPage } from './SettingsPage'

describe('SettingsPage', () => {
  it('renders exactly the four groups and no API key field', async () => {
    renderApp({}, <SettingsPage />)
    await screen.findByText('Memory delivery')
    expect(screen.getByText('Privacy')).toBeInTheDocument()
    expect(screen.getByText('Daemon')).toBeInTheDocument()
    expect(screen.getByText('Team')).toBeInTheDocument()
    expect(screen.queryByText(/roadmap/i)).toBeNull()
    expect(screen.queryByLabelText(/api key/i)).toBeNull()
    expect(screen.queryByText(/anthropic/i)).toBeNull()
  })

  it('marks an uninstalled delivery channel amber with its fix', async () => {
    renderApp({}, <SettingsPage />)
    const row = await screen.findByTestId('setting-mcp')
    expect(within(row).getByText(/not registered/i)).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: /register/i })).toBeInTheDocument()
  })

  it('omits the Team group entirely in solo mode', async () => {
    renderApp({ solo: true }, <SettingsPage />)
    await screen.findByText('Memory delivery')
    expect(screen.queryByText('Team')).toBeNull()
    expect(screen.queryByRole('button', { name: /leave team/i })).toBeNull()
  })

  // The Register button has no daemon-side handler yet (lib/server.js's
  // saveSettings does not recognize 'mcpRegistered'), but per the "no dead
  // controls" rule it still must call the real DataClient.setSetting method
  // rather than doing nothing locally.
  it('wires the Register button to a real setSetting call', async () => {
    const user = userEvent.setup()
    const client = new FakeDataClient()
    const setSpy = vi.spyOn(client, 'setSetting')
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-mcp')
    await user.click(within(row).getByRole('button', { name: /register/i }))
    expect(setSpy).toHaveBeenCalledWith('mcpRegistered', true)
  })

  // Settings.daemon.port is genuinely null coming off the real daemon (Task
  // 4 finding) -- the fake fixture supplies a real port, so this proves the
  // UI reads it honestly rather than always claiming "not reported".
  it('shows the reported daemon port when the client provides one', async () => {
    renderApp({}, <SettingsPage />)
    expect(await screen.findByText(/port 7391/)).toBeInTheDocument()
  })

  // start-at-login and update-availability have no real daemon source at
  // all (lib/server.js's mapSettings hardcodes them) -- these rows must say
  // so in words, never render a value nobody actually reported.
  it('renders start-at-login and update availability as not reported, never invented', async () => {
    renderApp({}, <SettingsPage />)
    const startRow = await screen.findByTestId('setting-status')
    expect(startRow).toBeInTheDocument()
    expect(screen.getAllByText('not reported').length).toBeGreaterThanOrEqual(2)
  })

  it('shows the real redaction and excluded-folder counts the client reports', async () => {
    renderApp({}, <SettingsPage />)
    expect(await screen.findByText('18 built-in · 2 custom')).toBeInTheDocument()
    expect(screen.getByText('3 paths')).toBeInTheDocument()
  })

  it('calls setSetting when the sync interval is changed', async () => {
    const user = userEvent.setup()
    const client = new FakeDataClient()
    const setSpy = vi.spyOn(client, 'setSetting')
    renderWith(client, <SettingsPage />)
    const select = await screen.findByLabelText('Sync interval')
    await user.selectOptions(select, '900')
    expect(setSpy).toHaveBeenCalledWith('intervalSec', 900)
  })

  it("shows the viewer's role and member count for a team", async () => {
    renderApp({}, <SettingsPage />)
    expect(await screen.findByText('MemBridge HQ')).toBeInTheDocument()
    expect(screen.getByText('You are the Owner · 3 members')).toBeInTheDocument()
  })

  it('hides the Manage control from a plain member', async () => {
    renderApp({ role: 'member' }, <SettingsPage />)
    await screen.findByText('MemBridge HQ')
    expect(screen.queryByRole('link', { name: 'Manage' })).toBeNull()
  })

  it('shows Manage to an owner', async () => {
    renderApp({}, <SettingsPage />)
    expect(await screen.findByRole('link', { name: 'Manage' })).toBeInTheDocument()
  })

  // The default fixture has no 'summaries' channel -- exercise it directly
  // to prove the toggle is real (calls setSetting), not decorative.
  it('toggles the summaries channel through a real setSetting call', async () => {
    const user = userEvent.setup()
    const client = new FakeDataClient()
    const base = await client.getSettings()
    vi.spyOn(client, 'getSettings').mockResolvedValue({
      ...base,
      delivery: [
        ...base.delivery,
        { id: 'summaries', label: 'Session summaries', description: 'Distills each session.', installed: true, enabled: false },
      ],
    })
    const setSpy = vi.spyOn(client, 'setSetting')
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-summaries')
    await user.click(within(row).getByRole('switch'))
    expect(setSpy).toHaveBeenCalledWith('distill', { enabled: true })
  })

  it('surfaces a load failure instead of rendering a blank page', async () => {
    renderApp({ failWith: 'daemon unreachable' }, <SettingsPage />)
    expect(await screen.findByText(/couldn't reach/i)).toBeInTheDocument()
  })
})
