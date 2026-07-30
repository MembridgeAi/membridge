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

  // The "not installed" render state -- amber chip + its real fix (Register).
  it('marks an uninstalled delivery channel amber with its fix', async () => {
    renderApp({}, <SettingsPage />)
    const row = await screen.findByTestId('setting-mcp')
    expect(within(row).getByText(/not registered/i)).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: /register/i })).toBeInTheDocument()
  })

  // Settings honesty fix: the bug was mcp.installed defaulting to false (and
  // rendering "not registered") on a machine where the MCP server was
  // actually working. This is the "installed" render state -- it must read
  // as installed, carry its real detail, and never show the amber "not
  // registered" wording the false-failure bug produced.
  it('shows the MCP channel as installed, with its real detail, when the daemon reports a real registration', async () => {
    const client = new FakeDataClient()
    const base = await client.getSettings()
    vi.spyOn(client, 'getSettings').mockResolvedValue({
      ...base,
      delivery: base.delivery.map(c => c.id === 'mcp'
        ? { ...c, installed: true, detail: 'registered with Claude Code, Codex · checked 2h ago' }
        : c),
    })
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-mcp')
    expect(within(row).getByText(/installed/i)).toBeInTheDocument()
    expect(within(row).getByText(/registered with claude code, codex/i)).toBeInTheDocument()
    expect(within(row).queryByText(/not registered/i)).toBeNull()
    expect(within(row).queryByRole('button', { name: /register/i })).toBeNull()
  })

  // The "unknown" render state (installed:null -- an older daemon that has
  // not reported a real check for this channel yet). Must say so in words,
  // and must never fall back to "not registered": that would tell the user
  // something is broken when the truth is simply "never checked".
  it('shows the MCP channel as not checked yet -- never "not registered" -- when the daemon reports no real check', async () => {
    const client = new FakeDataClient()
    const base = await client.getSettings()
    vi.spyOn(client, 'getSettings').mockResolvedValue({
      ...base,
      delivery: base.delivery.map(c => c.id === 'mcp'
        ? { ...c, installed: null, detail: 'Not reported by this daemon yet.' }
        : c),
    })
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-mcp')
    expect(within(row).getByText(/not checked yet/i)).toBeInTheDocument()
    expect(within(row).queryByText(/not registered/i)).toBeNull()
    expect(within(row).queryByRole('button', { name: /register/i })).toBeNull()
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

  // Settings.daemon.port is genuinely null coming off the real daemon when no
  // server has bound yet (Task 4/17) -- the fake fixture supplies a real
  // port, so this proves the UI reads it honestly rather than guessing.
  it('shows the reported daemon port when the client provides one', async () => {
    renderApp({}, <SettingsPage />)
    expect(await screen.findByText(/port 7391/)).toBeInTheDocument()
  })

  // Task 18: start-at-login and update-availability now have a real daemon
  // source (Task 17's /api/settings extension) -- "not reported" must be
  // gone from this page entirely.
  it('renders no "not reported" placeholder anywhere -- every value Task 17 supplies is real', async () => {
    renderApp({}, <SettingsPage />)
    await screen.findByTestId('setting-status')
    expect(screen.queryByText('not reported')).toBeNull()
  })

  it('shows the real redaction and excluded-folder counts the client reports', async () => {
    renderApp({}, <SettingsPage />)
    expect(await screen.findByText('18 built-in · 2 custom')).toBeInTheDocument()
    expect(screen.getByText('3 paths')).toBeInTheDocument()
  })

  // The real /api/settings payload carries no built-in-pattern count at all
  // (lib/redact.js has ~20 patterns, but nothing reports a count) -- when the
  // client is honest about that gap, Settings must say so in words, never
  // fabricate a 0 (which would read as "no protection").
  it('renders the built-in redaction count as unknown, never 0, when the client cannot report it', async () => {
    const client = new FakeDataClient()
    const base = await client.getSettings()
    vi.spyOn(client, 'getSettings').mockResolvedValue({
      ...base,
      privacy: { ...base.privacy, redactionBuiltIn: null },
    })
    renderWith(client, <SettingsPage />)
    expect(await screen.findByText(/built-in count unknown/i)).toBeInTheDocument()
    expect(screen.queryByText(/^0 built-in/)).toBeNull()
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
        { id: 'summaries', label: 'Session summaries', description: 'Distills each session.', installed: true, enabled: false, detail: '' },
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

  // Part B finding: nothing read setSetting.isError -- a rejected write
  // (Register, the summaries toggle, or the sync-interval select) looked
  // identical to a successful one. Driven through the sync-interval select
  // since it needs no extra fixture setup.
  it('surfaces a failed setSetting write instead of silently reverting', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'setSetting').mockRejectedValue(new Error('write rejected'))
    renderWith(client, <SettingsPage />)
    const select = await screen.findByLabelText('Sync interval')
    await userEvent.selectOptions(select, '900')
    expect(await screen.findByText(/write rejected/i)).toBeInTheDocument()
  })

  it('opens the config file through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'openConfigFile')
    renderWith(client, <SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: /open config file/i }))
    expect(spy).toHaveBeenCalled()
  })

  it('restarts the daemon through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'restartDaemon')
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-status')
    await userEvent.click(within(row).getByRole('button', { name: /restart/i }))
    expect(spy).toHaveBeenCalled()
  })

  it('toggles start-at-login through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setSetting')
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-start-at-login')
    await userEvent.click(within(row).getByRole('switch'))
    expect(spy).toHaveBeenCalledWith('startAtLogin', false)
  })

  it('checks for updates through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'checkForUpdates')
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-updates')
    await userEvent.click(within(row).getByRole('button', { name: /check now/i }))
    expect(spy).toHaveBeenCalled()
  })

  it('leaves the team only after confirming in a dialog, through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'leaveTeam')
    renderWith(client, <SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^leave team$/i }))
    const dialog = await screen.findByRole('dialog')
    expect(spy).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: /^leave team$/i }))
    expect(spy).toHaveBeenCalledWith('team-1')
  })

  it('surfaces a failed leave-team instead of silently closing the dialog', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'leaveTeam').mockRejectedValue(new Error('leave rejected'))
    renderWith(client, <SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^leave team$/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^leave team$/i }))
    expect(await screen.findByText(/leave rejected/i)).toBeInTheDocument()
  })

  it('saves edited redaction patterns through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setSetting')
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-redaction')
    await userEvent.click(within(row).getByRole('button', { name: /edit/i }))
    const dialog = await screen.findByRole('dialog')
    const textarea = within(dialog).getByRole('textbox')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, 'PATTERN_ONE\nPATTERN_TWO')
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
    expect(spy).toHaveBeenCalledWith('redactExtra', ['PATTERN_ONE', 'PATTERN_TWO'])
  })

  it('saves edited excluded folders through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setSetting')
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-excluded')
    await userEvent.click(within(row).getByRole('button', { name: /edit/i }))
    const dialog = await screen.findByRole('dialog')
    const textarea = within(dialog).getByRole('textbox')
    await userEvent.clear(textarea)
    await userEvent.type(textarea, 'build')
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
    expect(spy).toHaveBeenCalledWith('exclude', ['build'])
  })

  it('surfaces a failed edit-list save instead of silently closing the dialog', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'setSetting').mockRejectedValue(new Error('save rejected'))
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-excluded')
    await userEvent.click(within(row).getByRole('button', { name: /edit/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText(/save rejected/i)).toBeInTheDocument()
  })

  it('saves chosen context files through real DataClient calls', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setSetting')
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-context-block')
    await userEvent.click(within(row).getByRole('button', { name: /choose files/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /gemini\.md/i }))
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
    expect(spy).toHaveBeenCalledWith('targets', ['CLAUDE.md', 'AGENTS.md'])
    expect(spy).toHaveBeenCalledWith('extraTargets', expect.objectContaining({ gemini: true }))
  })

  it('surfaces a failed context-files save instead of silently closing the dialog', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'setSetting').mockRejectedValue(new Error('context save rejected'))
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-context-block')
    await userEvent.click(within(row).getByRole('button', { name: /choose files/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText(/context save rejected/i)).toBeInTheDocument()
  })
})
