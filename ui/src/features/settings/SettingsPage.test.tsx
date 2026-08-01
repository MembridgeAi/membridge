import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
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
  // registered" wording the false-failure bug produced. Re-register (Task:
  // always available) DOES still render here -- that is the whole point of
  // "always", not "only when missing".
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
    expect(within(row).getByRole('button', { name: /re-register/i })).toBeInTheDocument()
  })

  // The "unknown" render state (installed:null -- an older daemon that has
  // not reported a real check for this channel yet). Must say so in words,
  // and must never fall back to "not registered": that would tell the user
  // something is broken when the truth is simply "never checked". Unlike
  // every other channel's fix control, Re-register stays available here too
  // -- running it IS how a first check happens (Task: always-available
  // re-registration).
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
    expect(within(row).getByRole('button', { name: /re-register/i })).toBeInTheDocument()
  })

  it('omits the Team group entirely in solo mode', async () => {
    renderApp({ solo: true }, <SettingsPage />)
    await screen.findByText('Memory delivery')
    expect(screen.queryByText('Team')).toBeNull()
    expect(screen.queryByRole('button', { name: /leave team/i })).toBeNull()
  })

  // Task: Re-register is ALWAYS available (not only when the channel reports
  // missing), wired to the real registration path -- POST /api/mcp/register
  // -> lib/mcp-register.js's registerNow(), the same thing `membridge mcp
  // register` runs. Driven against the "installed" state specifically,
  // since the OLD Register button never even rendered there.
  it('offers Re-register even when MCP already reports installed, and calls the real DataClient method', async () => {
    const user = userEvent.setup()
    const client = new FakeDataClient()
    const base = await client.getSettings()
    vi.spyOn(client, 'getSettings').mockResolvedValue({
      ...base,
      delivery: base.delivery.map(c => c.id === 'mcp' ? { ...c, installed: true, detail: 'registered with Claude Code' } : c),
    })
    const registerSpy = vi.spyOn(client, 'registerMcp')
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-mcp')
    await user.click(within(row).getByRole('button', { name: /re-register/i }))
    expect(registerSpy).toHaveBeenCalled()
  })

  // The real per-tool result (rows carry a status per agent) must render
  // afterwards, not just a generic "done".
  it('reports the per-tool result after Re-register succeeds', async () => {
    const user = userEvent.setup()
    const client = new FakeDataClient()
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-mcp')
    await user.click(within(row).getByRole('button', { name: /re-register/i }))
    expect(await within(row).findByText(/claude code: registered/i)).toBeInTheDocument()
    expect(within(row).getByText(/codex: unchanged, already registered/i)).toBeInTheDocument()
  })

  // A failed row must surface visibly, never read as a silent success.
  it('surfaces a failed tool in the Re-register result instead of a silent success', async () => {
    const user = userEvent.setup()
    const client = new FakeDataClient()
    vi.spyOn(client, 'registerMcp').mockResolvedValue({
      rows: [{ agent: 'cursor', status: 'failed', detail: 'config file is not writable' }],
    })
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-mcp')
    await user.click(within(row).getByRole('button', { name: /re-register/i }))
    const resultChip = await within(row).findByText(/cursor: failed, config file is not writable/i)
    expect(resultChip).toBeInTheDocument()
    expect(resultChip.className).toMatch(/chip-bad/)
  })

  // A request-level failure (the endpoint itself rejecting) is a different
  // failure mode than a per-tool 'failed' row, and must surface too.
  it('surfaces a rejected Re-register call instead of failing silently', async () => {
    const user = userEvent.setup()
    const client = new FakeDataClient()
    vi.spyOn(client, 'registerMcp').mockRejectedValue(new Error('daemon unreachable'))
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-mcp')
    await user.click(within(row).getByRole('button', { name: /re-register/i }))
    expect(await within(row).findByText(/daemon unreachable/i)).toBeInTheDocument()
  })

  // Force-update hooks: the three honest hooksVersion states must each
  // render their own words, never collapse into one another. The control
  // lives on the "summaries" (Stop hook) row and covers the recall hook too.
  describe('Update hooks', () => {
    it('renders "up to date" for both hooks when hooksVersion reports current', async () => {
      renderApp({}, <SettingsPage />)
      const row = await screen.findByTestId('setting-summaries')
      expect(within(row).getByText(/stop hook: up to date/i)).toBeInTheDocument()
      expect(within(row).getByText(/recall hook: up to date/i)).toBeInTheDocument()
    })

    it('renders "outdated, update available" honestly, distinct from up to date', async () => {
      const client = new FakeDataClient({ hooksVersion: { stop: 'outdated', recall: 'current' } })
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-summaries')
      expect(within(row).getByText(/stop hook: outdated, update available/i)).toBeInTheDocument()
      expect(within(row).getByText(/recall hook: up to date/i)).toBeInTheDocument()
    })

    it('renders "unknown" when the daemon genuinely cannot tell', async () => {
      const client = new FakeDataClient({ hooksVersion: { stop: 'unknown', recall: 'unknown' } })
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-summaries')
      expect(within(row).getByText(/stop hook: unknown/i)).toBeInTheDocument()
      expect(within(row).getByText(/recall hook: unknown/i)).toBeInTheDocument()
    })

    it('calls the real updateHooks method and reports the per-hook result', async () => {
      const user = userEvent.setup()
      const client = new FakeDataClient({ hooksVersion: { stop: 'outdated', recall: 'outdated' } })
      const updateSpy = vi.spyOn(client, 'updateHooks')
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-summaries')
      await user.click(within(row).getByRole('button', { name: /update hooks/i }))
      expect(updateSpy).toHaveBeenCalled()
      expect(await within(row).findByText(/stop: rewritten to the current version/i)).toBeInTheDocument()
      expect(within(row).getByText(/recall: rewritten to the current version/i)).toBeInTheDocument()
    })

    // A per-hook failure must surface visibly, never read as a silent
    // success -- the same non-negotiable as the MCP Re-register result above.
    it('surfaces a per-hook failure instead of a silent success', async () => {
      const user = userEvent.setup()
      const client = new FakeDataClient({
        hooksUpdateResult: {
          stop: { ok: false, detail: 'settings.json is not valid JSON, fix or remove it first' },
          recall: { ok: true, detail: 'already up to date' },
          search: { ok: true, detail: 'already up to date' },
        },
      })
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-summaries')
      await user.click(within(row).getByRole('button', { name: /update hooks/i }))
      const failChip = await within(row).findByText(/stop: settings\.json is not valid json/i)
      expect(failChip).toBeInTheDocument()
      expect(failChip.className).toMatch(/chip-bad/)
      expect(within(row).getByText(/recall: already up to date/i)).toBeInTheDocument()
    })

    it('surfaces a rejected updateHooks call instead of failing silently', async () => {
      const user = userEvent.setup()
      const client = new FakeDataClient()
      vi.spyOn(client, 'updateHooks').mockRejectedValue(new Error('daemon unreachable'))
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-summaries')
      await user.click(within(row).getByRole('button', { name: /update hooks/i }))
      expect(await within(row).findByText(/daemon unreachable/i)).toBeInTheDocument()
    })
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
      delivery: base.delivery.map(c => c.id === 'summaries' ? { ...c, enabled: false } : c),
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

  // Appearance (light/dark/system, Task 1). This is a per-machine display
  // preference persisted to localStorage rather than through setSetting --
  // see ui/src/theme/theme.ts's header comment for why -- so these tests
  // assert on document.documentElement's data-theme attribute directly
  // instead of spying on the DataClient.
  describe('Appearance', () => {
    beforeEach(() => {
      window.localStorage.clear()
      document.documentElement.removeAttribute('data-theme')
    })

    it('selecting Light sets data-theme="light" immediately', async () => {
      renderApp({}, <SettingsPage />)
      const row = await screen.findByTestId('setting-appearance')
      await userEvent.selectOptions(within(row).getByLabelText('Appearance'), 'light')
      expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    })

    it('selecting Dark sets an explicit data-theme="dark"', async () => {
      renderApp({}, <SettingsPage />)
      const row = await screen.findByTestId('setting-appearance')
      await userEvent.selectOptions(within(row).getByLabelText('Appearance'), 'dark')
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    })

    it('selecting System resolves against the current OS preference (stubbed matchMedia: dark)', async () => {
      renderApp({}, <SettingsPage />)
      const row = await screen.findByTestId('setting-appearance')
      const select = within(row).getByLabelText('Appearance')
      await userEvent.selectOptions(select, 'light')
      await userEvent.selectOptions(select, 'system')
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    })

    it('persists the chosen mode across a remount, applying it on first render', async () => {
      const { unmount } = renderApp({}, <SettingsPage />)
      const row = await screen.findByTestId('setting-appearance')
      await userEvent.selectOptions(within(row).getByLabelText('Appearance'), 'light')
      unmount()
      document.documentElement.removeAttribute('data-theme')

      renderApp({}, <SettingsPage />)
      const rowAgain = await screen.findByTestId('setting-appearance')
      expect(within(rowAgain).getByLabelText('Appearance')).toHaveValue('light')
      expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    })
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

  // Task 4a: excluded folders are a managed list -- one Remove button per
  // entry (staged locally, nothing is written until Save), plus a typed-path
  // "Add" affordance for new ones.
  it('saves edited excluded folders through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setSetting')
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-excluded')
    await userEvent.click(within(row).getByRole('button', { name: /edit/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove node_modules' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove dist' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove .git' }))
    await userEvent.type(within(dialog).getByRole('textbox', { name: /new excluded folder/i }), 'build')
    await userEvent.click(within(dialog).getByRole('button', { name: /^add$/i }))
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
    expect(spy).toHaveBeenCalledWith('exclude', ['build'])
  })

  it('removes a single excluded folder without touching the others', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setSetting')
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-excluded')
    await userEvent.click(within(row).getByRole('button', { name: /edit/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove dist' }))
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
    expect(spy).toHaveBeenCalledWith('exclude', ['node_modules', '.git'])
  })

  // "Do not silently auto-delete anything from their config" -- Remove only
  // ever changes LOCAL dialog state; nothing is written to the daemon until
  // Save, and Cancel discards the change entirely.
  it('does not write anything when a folder is removed but the dialog is cancelled instead of saved', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setSetting')
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-excluded')
    await userEvent.click(within(row).getByRole('button', { name: /edit/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove node_modules' }))
    expect(spy).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }))
    expect(spy).not.toHaveBeenCalled()
  })

  // A path the daemon reported as no-longer-existing (server.js's
  // staleExcludes -- exactly the shape of the leaked test-fixture-path
  // incident) must be visibly marked, both on the row's summary and inside
  // the management dialog, never silently dropped.
  it('marks an excluded folder as stale when its path no longer exists, and lets the owner remove it', async () => {
    const user = userEvent.setup()
    const client = new FakeDataClient()
    const base = await client.getSettings()
    const stalePath = '/tmp/membridge-test-7RBk1s/projects/excluded-app'
    vi.spyOn(client, 'getSettings').mockResolvedValue({
      ...base,
      privacy: { ...base.privacy, exclude: [...base.privacy.exclude, stalePath], excludeStale: [stalePath] },
    })
    const setSpy = vi.spyOn(client, 'setSetting')
    renderWith(client, <SettingsPage />)
    const summaryRow = await screen.findByTestId('setting-excluded')
    expect(within(summaryRow).getByText(/1 no longer exist/i)).toBeInTheDocument()

    await user.click(within(summaryRow).getByRole('button', { name: /edit/i }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(stalePath)).toBeInTheDocument()
    // Exactly one entry is flagged -- the other (non-stale) rows must not
    // carry the badge.
    expect(within(dialog).getAllByText(/no longer exists/i)).toHaveLength(1)

    await user.click(within(dialog).getByRole('button', { name: `Remove ${stalePath}` }))
    await user.click(within(dialog).getByRole('button', { name: /^save$/i }))
    expect(setSpy).toHaveBeenCalledWith('exclude', base.privacy.exclude)
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

  // Native picker (Electron bridge) tests -- "Choosing files should open a
  // finder/file explorer tab not a path." The picker itself lives behind
  // DataClient.pickPaths; these prove the UI wires it correctly on both
  // sides (present + absent) rather than assuming it.
  describe('native file/folder picker', () => {
    it('opens a native picker for context files when the desktop bridge is available, and merges the picked path into the list', async () => {
      const client = new FakeDataClient({ pickPathsResult: ['/Users/x/membridge/EXTRA.md'] })
      const pickSpy = vi.spyOn(client, 'pickPaths')
      const setSpy = vi.spyOn(client, 'setSetting')
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-context-block')
      await userEvent.click(within(row).getByRole('button', { name: /choose files/i }))
      const dialog = await screen.findByRole('dialog')

      await userEvent.click(within(dialog).getByRole('button', { name: /browse files/i }))
      expect(pickSpy).toHaveBeenCalledWith({ kind: 'file', multiple: true })
      await waitFor(() => {
        expect(within(dialog).getByRole('textbox', { name: /always-written context files/i }))
          .toHaveValue('CLAUDE.md\nAGENTS.md\n/Users/x/membridge/EXTRA.md')
      })

      await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
      expect(setSpy).toHaveBeenCalledWith('targets', ['CLAUDE.md', 'AGENTS.md', '/Users/x/membridge/EXTRA.md'])
    })

    it('falls back to typed text entry for context files when the desktop bridge is unavailable, with no dead Browse button', async () => {
      const client = new FakeDataClient({ filePickerAvailable: false })
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-context-block')
      await userEvent.click(within(row).getByRole('button', { name: /choose files/i }))
      const dialog = await screen.findByRole('dialog')

      expect(within(dialog).queryByRole('button', { name: /browse/i })).toBeNull()
      const textarea = within(dialog).getByRole('textbox', { name: /always-written context files/i })
      await userEvent.type(textarea, '\nEXTRA.md')
      expect(textarea).toHaveValue('CLAUDE.md\nAGENTS.md\nEXTRA.md')
    })

    it('leaves the context-files list unchanged when the native picker is cancelled', async () => {
      const client = new FakeDataClient({ pickPathsResult: [] })
      const setSpy = vi.spyOn(client, 'setSetting')
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-context-block')
      await userEvent.click(within(row).getByRole('button', { name: /choose files/i }))
      const dialog = await screen.findByRole('dialog')

      await userEvent.click(within(dialog).getByRole('button', { name: /browse files/i }))
      await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
      expect(setSpy).toHaveBeenCalledWith('targets', ['CLAUDE.md', 'AGENTS.md'])
    })

    it('opens a native folder picker for excluded folders when the desktop bridge is available, and merges the picked path', async () => {
      const client = new FakeDataClient({ pickPathsResult: ['/Users/x/build'] })
      const pickSpy = vi.spyOn(client, 'pickPaths')
      const setSpy = vi.spyOn(client, 'setSetting')
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-excluded')
      await userEvent.click(within(row).getByRole('button', { name: /edit/i }))
      const dialog = await screen.findByRole('dialog')

      await userEvent.click(within(dialog).getByRole('button', { name: /browse folders/i }))
      expect(pickSpy).toHaveBeenCalledWith({ kind: 'folder', multiple: true })
      await waitFor(() => {
        expect(within(dialog).getByText('/Users/x/build')).toBeInTheDocument()
      })

      await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
      expect(setSpy).toHaveBeenCalledWith('exclude', ['node_modules', 'dist', '.git', '/Users/x/build'])
    })

    it('falls back to typed text entry for excluded folders when the desktop bridge is unavailable, with no dead Browse button', async () => {
      const client = new FakeDataClient({ filePickerAvailable: false })
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-excluded')
      await userEvent.click(within(row).getByRole('button', { name: /edit/i }))
      const dialog = await screen.findByRole('dialog')

      expect(within(dialog).queryByRole('button', { name: /browse/i })).toBeNull()
      expect(within(dialog).getByRole('textbox', { name: /new excluded folder/i })).toBeInTheDocument()
    })

    it('leaves the excluded-folders list unchanged when the native picker is cancelled', async () => {
      const client = new FakeDataClient({ pickPathsResult: [] })
      const setSpy = vi.spyOn(client, 'setSetting')
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-excluded')
      await userEvent.click(within(row).getByRole('button', { name: /edit/i }))
      const dialog = await screen.findByRole('dialog')

      await userEvent.click(within(dialog).getByRole('button', { name: /browse folders/i }))
      await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))
      expect(setSpy).toHaveBeenCalledWith('exclude', ['node_modules', 'dist', '.git'])
    })

    // Redaction patterns are regular expressions, not filesystem paths -- a
    // folder/file dialog has nothing to offer here, so this dialog must
    // never render a Browse button, even when the bridge is available.
    it('never shows a Browse button on the redaction-patterns dialog', async () => {
      renderApp({}, <SettingsPage />)
      const row = await screen.findByTestId('setting-redaction')
      await userEvent.click(within(row).getByRole('button', { name: /edit/i }))
      const dialog = await screen.findByRole('dialog')
      expect(within(dialog).queryByRole('button', { name: /browse/i })).toBeNull()
    })

    // Fix 15: handleBrowse awaited pickPaths.mutateAsync with no try/catch --
    // a failed native picker (the Electron IPC call CAN reject) became an
    // unhandled rejection and the click just silently did nothing.
    it('surfaces a failed file picker in the context-files dialog instead of nothing', async () => {
      class BrokenPickerClient extends FakeDataClient {
        pickPaths(): Promise<string[]> { return Promise.reject(new Error('picker exploded')) }
      }
      renderWith(new BrokenPickerClient(), <SettingsPage />)
      const row = await screen.findByTestId('setting-context-block')
      await userEvent.click(within(row).getByRole('button', { name: /choose files/i }))
      const dialog = await screen.findByRole('dialog')
      await userEvent.click(within(dialog).getByRole('button', { name: /browse files/i }))
      const alert = await within(dialog).findByText(/couldn't open the file picker/i)
      expect(alert).toHaveAttribute('role', 'alert')
      expect(alert.textContent).toContain('picker exploded')
    })

    it('surfaces a failed folder picker in the excluded-folders dialog instead of nothing', async () => {
      class BrokenPickerClient extends FakeDataClient {
        pickPaths(): Promise<string[]> { return Promise.reject(new Error('picker exploded')) }
      }
      renderWith(new BrokenPickerClient(), <SettingsPage />)
      const row = await screen.findByTestId('setting-excluded')
      await userEvent.click(within(row).getByRole('button', { name: /edit/i }))
      const dialog = await screen.findByRole('dialog')
      await userEvent.click(within(dialog).getByRole('button', { name: /browse folders/i }))
      const alert = await within(dialog).findByText(/couldn't open the folder picker/i)
      expect(alert).toHaveAttribute('role', 'alert')
      expect(alert.textContent).toContain('picker exploded')
    })
  })
})
