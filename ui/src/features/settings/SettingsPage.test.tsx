import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient, type FakeOptions } from '../../data/FakeDataClient'
import { SettingsPage } from './SettingsPage'

describe('SettingsPage', () => {
  it('renders exactly the four groups and no API key field', async () => {
    renderApp({}, <SettingsPage />)
    await screen.findByText('Memory delivery')
    expect(screen.getByText('Privacy')).toBeInTheDocument()
    expect(screen.getByText('Background service')).toBeInTheDocument()
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

  // `membridge status` prints, per tool, the specific cause AND the config
  // key that fixes it. The dashboard showed one vague summary sentence
  // ("Registration ran, but no AI tool on this machine picked it up.")
  // instead, even though /api/settings already carries every one of those
  // per-row sentences (verified against a live daemon). The per-tool chips
  // existed but were fed ONLY by the POST /api/mcp/register mutation, so the
  // reasons appeared only after clicking Re-register -- they have to be
  // visible at rest, without the user guessing that re-registering is how
  // you find out why nothing registered.
  it('names each tool and the config key that fixes it, without clicking Re-register', async () => {
    const client = new FakeDataClient()
    const base = await client.getSettings()
    vi.spyOn(client, 'getSettings').mockResolvedValue({
      ...base,
      delivery: base.delivery.map(c => c.id === 'mcp'
        ? {
            ...c,
            installed: false,
            detail: 'Registration ran, but no AI tool on this machine picked it up.',
            mcpRows: [
              { agent: 'claude-code', status: 'skipped' as const, detail: 'could not find the `claude` binary; set config.mcp.claudeBin to its full path' },
              { agent: 'codex', status: 'skipped' as const, detail: '/Users/x/.codex does not exist, so nothing was written; if you keep this config elsewhere, set config.mcp.codex.configPath' },
            ],
          }
        : c),
    })
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-mcp')

    // The exact cause and the exact config key, per tool -- the same two
    // things the CLI prints, and no click needed to reach them.
    expect(await within(row).findByText(/claude code: nothing changed · could not find the `claude` binary; set config\.mcp\.claudeBin/i)).toBeInTheDocument()
    expect(within(row).getByText(/codex: nothing changed · .*set config\.mcp\.codex\.configPath/i)).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: /re-register/i })).toBeInTheDocument()
  })

  // Finding 7: these chips interpolated lib/mcp-register.js's raw status token,
  // so they read "Codex: skipped" / "Cursor: removed" -- the daemon's internal
  // control-flow vocabulary. Worse, 'skipped' was toned MUTED alongside
  // 'removed', so the colour said "fine" while the word said something had not
  // happened, for the one status that always carries a fix.
  it('describes each tool in terms of this machine, never the daemon status token', async () => {
    const client = new FakeDataClient()
    const base = await client.getSettings()
    vi.spyOn(client, 'getSettings').mockResolvedValue({
      ...base,
      delivery: base.delivery.map(c => c.id === 'mcp'
        ? {
            ...c,
            installed: false,
            mcpRows: [
              { agent: 'codex', status: 'skipped' as const, detail: 'config.mcp.autoRegister is false' },
              { agent: 'cursor', status: 'unchanged' as const, detail: null },
            ],
          }
        : c),
    })
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-mcp')

    const skipped = await within(row).findByText(/codex: nothing changed/i)
    expect(skipped.className).toMatch(/chip-warn/)
    expect(within(row).queryByText(/codex: skipped/i)).toBeNull()

    const unchanged = within(row).getByText(/cursor: already registered/i)
    expect(unchanged.className).toMatch(/chip-ok/)
    expect(within(row).queryByText(/cursor: unchanged/i)).toBeNull()
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

  // T-78 items 7 & 8: Team memory encryption is the one Privacy row that
  // describes team behaviour ("teammates' apps decrypt locally") and names
  // two config keys (team.encrypt, team.plaintextOff) that only mean
  // something once a team exists. Absent on solo/signed-out, not restated.
  it('omits Team memory encryption entirely on solo, along with the config-key advisor', async () => {
    renderApp({ solo: true, authenticated: false }, <SettingsPage />)
    await screen.findByText('Privacy')
    expect(screen.queryByText('Team memory encryption')).toBeNull()
    // The advisor sentence names the config keys; those keys are meaningless
    // to a solo user, so it must not linger on this page.
    expect(screen.queryByText(/team\.encrypt/)).toBeNull()
    expect(screen.queryByText(/team\.plaintextOff/)).toBeNull()
    // Other Privacy rows must still render -- solo users still care about
    // redaction and excluded folders on their local files.
    expect(screen.getByText('Redaction patterns')).toBeInTheDocument()
    expect(screen.getByText('Excluded folders')).toBeInTheDocument()
  })

  it('keeps Team memory encryption on a team install', async () => {
    renderApp({}, <SettingsPage />)
    expect(await screen.findByText('Team memory encryption')).toBeInTheDocument()
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
    expect(await within(row).findByText(/claude code: registered now/i)).toBeInTheDocument()
    expect(within(row).getByText(/codex: already registered/i)).toBeInTheDocument()
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
    const resultChip = await within(row).findByText(/cursor: couldn't register · config file is not writable/i)
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

  // Settings honesty: no control on this page may end in a state the code did
  // not verify. "Check now" resolved with { current, latest, updateAvailable }
  // and the UI kept none of it, drawing a chip ONLY when an update existed --
  // so "up to date", "the check couldn't reach GitHub" and "the button did
  // nothing" were one indistinguishable blank. On this project the no-update
  // answer is the NORMAL one (its GitHub releases sit behind npm), so the
  // blank was what users saw essentially every time.
  describe('Check for updates', () => {
    it('reports "up to date" with a checked stamp instead of no visible outcome', async () => {
      const client = new FakeDataClient()
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-updates')
      await userEvent.click(within(row).getByRole('button', { name: /check now/i }))
      expect(await within(row).findByText(/up to date/i)).toBeInTheDocument()
      expect(within(row).getByText(/checked just now/i)).toBeInTheDocument()
    })

    it('names the new version when the check finds an update', async () => {
      const client = new FakeDataClient()
      vi.spyOn(client, 'checkForUpdates').mockResolvedValue({ current: '0.1.7', latest: '0.2.9', updateAvailable: '0.2.9' })
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-updates')
      await userEvent.click(within(row).getByRole('button', { name: /check now/i }))
      expect(await within(row).findByText(/update available · v0\.2\.9/i)).toBeInTheDocument()
    })

    // latest === null is the daemon saying its network probe failed -- 200,
    // but nothing learned. It must never fold into "no update available",
    // which is a claim about the newest version that nobody established.
    it('says the check could not run when the daemon reports no latest version, never "up to date"', async () => {
      const client = new FakeDataClient()
      vi.spyOn(client, 'checkForUpdates').mockResolvedValue({ current: '0.1.7', latest: null, updateAvailable: null })
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-updates')
      await userEvent.click(within(row).getByRole('button', { name: /check now/i }))
      expect(await within(row).findByText(/couldn't check/i)).toBeInTheDocument()
      expect(within(row).getByText(/couldn't reach github/i)).toBeInTheDocument()
      expect(within(row).queryByText(/up to date/i)).toBeNull()
    })
  })

  describe('Restart', () => {
    // Finding 2, UI half: pressing Restart changed nothing on screen, ever --
    // no confirmation, no error, and the Status chip went on serving its
    // cached "running" for a process the user had just asked to be replaced.
    //
    // The confirmation has to resolve on the daemon ANSWERING again, never on
    // the POST resolving: lib/server.js writes { ok, restarting } to the
    // socket before it even attempts the spawn, so a POST-resolved
    // confirmation would be a lie the UI renders.
    it('withholds the cached "running" chip until MemBridge answers again, then confirms', async () => {
      const client = new FakeDataClient()
      const realGetStatus = client.getStatus.bind(client)
      let release: (() => void) | null = null
      let calls = 0
      vi.spyOn(client, 'getStatus').mockImplementation(async () => {
        calls += 1
        if (calls === 1) return realGetStatus()
        // Every read after the first hangs until the test lets it through --
        // standing in for the window where the daemon is genuinely down.
        await new Promise<void>(resolve => { release = resolve })
        return realGetStatus()
      })

      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-status')
      expect(within(row).getByText(/running/i)).toBeInTheDocument()

      await userEvent.click(within(row).getByRole('button', { name: /restart/i }))

      expect(await within(row).findByText(/restarting/i)).toBeInTheDocument()
      expect(within(row).queryByText(/✓ running/)).toBeNull()
      expect(within(row).getByRole('button', { name: /restart/i })).toBeDisabled()

      await waitFor(() => expect(release).not.toBeNull())
      release!()

      expect(await within(row).findByText(/answering again after restart/i)).toBeInTheDocument()
      expect(within(row).getByText(/✓ running/)).toBeInTheDocument()
    })

    it('surfaces a rejected restart request and never enters the restarting state', async () => {
      const client = new FakeDataClient()
      vi.spyOn(client, 'restartDaemon').mockRejectedValue(new Error('restart refused'))
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-status')
      await userEvent.click(within(row).getByRole('button', { name: /restart/i }))
      expect(await screen.findByText(/restart refused/i)).toBeInTheDocument()
      expect(within(row).queryByText(/restarting/i)).toBeNull()
      expect(within(row).getByRole('button', { name: /restart/i })).toBeEnabled()
    })
  })

  // Finding 5: useSetSetting had onSuccess only and no optimistic update, and
  // Toggle could not express in-flight at all -- so flipping a switch left it
  // sitting on the old value for a full round trip. The natural read is "it
  // didn't take", so users flip again, queue a second write, and land on the
  // opposite value from the one they wanted.
  describe('toggle feedback', () => {
    it('moves the switch on click rather than after the round trip', async () => {
      const client = new FakeDataClient()
      // Never resolves: the in-flight window is what is under test, so the
      // write must not be allowed to finish and end it.
      vi.spyOn(client, 'setSetting').mockReturnValue(new Promise<void>(() => {}))
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-start-at-login')
      const toggle = within(row).getByRole('switch')
      expect(toggle).toHaveAttribute('aria-checked', 'true')

      await userEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-checked', 'false')
      expect(toggle).toHaveAttribute('aria-busy', 'true')
    })

    it('refuses a second flip while the first write is in flight, so no opposite value is queued', async () => {
      const client = new FakeDataClient()
      const spy = vi.spyOn(client, 'setSetting').mockReturnValue(new Promise<void>(() => {}))
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-start-at-login')
      const toggle = within(row).getByRole('switch')
      await userEvent.click(toggle)
      await userEvent.click(toggle)
      expect(spy).toHaveBeenCalledTimes(1)
    })

    // A silent revert is the exact failure this page exists to prevent, so the
    // rollback has to be explained as well as performed.
    it('rolls the switch back AND says which action failed', async () => {
      const client = new FakeDataClient()
      vi.spyOn(client, 'setSetting').mockRejectedValue(new Error('launchd refused'))
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-start-at-login')
      const toggle = within(row).getByRole('switch')
      await userEvent.click(toggle)
      expect(await within(row).findByText(/couldn't change start at login/i)).toBeInTheDocument()
      expect(toggle).toHaveAttribute('aria-checked', 'true')
    })
  })

  // Finding 6: Restart, Start at login, Sync interval and Check now shared one
  // line reading "Couldn't save the change." -- so pressing Restart told you a
  // save had failed, and nothing said which of the four controls was broken.
  describe('per-action failures', () => {
    it('names Restart on the Status row, not a generic save failure', async () => {
      const client = new FakeDataClient()
      vi.spyOn(client, 'restartDaemon').mockRejectedValue(new Error('spawn refused'))
      renderWith(client, <SettingsPage />)
      const statusRow = await screen.findByTestId('setting-status')
      await userEvent.click(within(statusRow).getByRole('button', { name: /restart/i }))
      expect(await within(statusRow).findByText(/couldn't restart membridge/i)).toBeInTheDocument()
      expect(screen.queryByText(/couldn't save the change/i)).toBeNull()
    })

    it('keeps a failed sync-interval write off the unrelated rows', async () => {
      const client = new FakeDataClient()
      vi.spyOn(client, 'setSetting').mockRejectedValue(new Error('write rejected'))
      renderWith(client, <SettingsPage />)
      await userEvent.selectOptions(await screen.findByLabelText('Sync interval'), '900')
      const intervalRow = screen.getByTestId('setting-sync-interval')
      expect(await within(intervalRow).findByText(/couldn't change the sync interval/i)).toBeInTheDocument()
      expect(within(screen.getByTestId('setting-start-at-login')).queryByRole('alert')).toBeNull()
      expect(within(screen.getByTestId('setting-status')).queryByRole('alert')).toBeNull()
    })

    it('names the update check when it is the request that was rejected', async () => {
      const client = new FakeDataClient()
      vi.spyOn(client, 'checkForUpdates').mockRejectedValue(new Error('endpoint gone'))
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-updates')
      await userEvent.click(within(row).getByRole('button', { name: /check now/i }))
      expect(await within(row).findByText(/couldn't check for updates/i)).toBeInTheDocument()
    })

    it('names the summaries switch when its write is refused', async () => {
      const client = new FakeDataClient()
      vi.spyOn(client, 'setSetting').mockRejectedValue(new Error('hook write failed'))
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-summaries')
      await userEvent.click(within(row).getByRole('switch'))
      expect(await within(row).findByText(/couldn't change session summaries/i)).toBeInTheDocument()
    })
  })

  // Finding 4, decided read-only by Marco: an accidental `encrypt: false` in
  // his config already shipped a full plaintext history to the server once, and
  // a privacy downgrade one click away on a page with no confirm step is how
  // that recurs. The row's job is to let him SEE the state. It used to LOOK
  // like a switch -- "Share plaintext with team", described as "Off means..."
  // -- while ignoring every click.
  it('presents team encryption as a status row, never as a control that ignores clicks', async () => {
    renderApp({}, <SettingsPage />)
    const row = await screen.findByTestId('setting-plaintext')
    expect(within(row).queryByRole('switch')).toBeNull()
    expect(within(row).queryByRole('button')).toBeNull()
    // "where it is actually changed" moved out of the grey description and
    // into the padlocked aside, because this row now sits directly beneath
    // rows that ARE editable in-app and a sentence in prose was not enough to
    // tell them apart. The assertion follows the fact, not the old sentence:
    // the row must still name the config file and both keys.
    expect(within(row).getByText(/set in your config file · team\.encrypt, team\.plaintextOff/i)).toBeInTheDocument()
    expect(screen.queryByText(/share plaintext with team/i)).toBeNull()
  })

  // The row keyed off `endToEnd` alone, so "encrypted, ciphertext only" and
  // "encrypted but a readable copy is also stored" rendered as one identical
  // green chip. That second state is the dual-write middle ground, and it is
  // the exact fact behind the plaintext history that made this row read-only in
  // the first place -- so showing half of it defeated the row's whole job.
  describe('encryption state', () => {
    async function withPrivacy(overrides: Partial<Awaited<ReturnType<FakeDataClient['getSettings']>>['privacy']>) {
      const client = new FakeDataClient()
      const base = await client.getSettings()
      vi.spyOn(client, 'getSettings').mockResolvedValue({
        ...base,
        privacy: { ...base.privacy, ...overrides },
      })
      renderWith(client, <SettingsPage />)
      return screen.findByTestId('setting-plaintext')
    }

    // "content sealed", not "ciphertext only": the routing envelope
    // (project, author_id, author_name, ts, source, session) ships in clear --
    // docs/ENCRYPTION-SPEC.md 0.1. The old chip claimed the server holds
    // nothing readable at all, which is not true, so the assertion pins the
    // narrower claim AND pins that the broader one is gone.
    it('says content is sealed when no readable copy is stored', async () => {
      const row = await withPrivacy({ endToEnd: true, plaintextShared: false })
      expect(within(row).getByText(/end-to-end, content sealed/i)).toBeInTheDocument()
      expect(within(row).queryByText(/ciphertext only/i)).toBeNull()
    })

    it('never claims nothing readable reaches the server', async () => {
      const row = await withPrivacy({ endToEnd: true, plaintextShared: false })
      expect(within(row).queryByText(/nothing readable is stored/i)).toBeNull()
      // and it names the metadata that does travel in clear
      expect(within(row).getByText(/routing metadata/i)).toBeInTheDocument()
      expect(within(row).getByText(/display name/i)).toBeInTheDocument()
    })

    it('warns when rows are encrypted but a readable copy is stored too', async () => {
      const row = await withPrivacy({ endToEnd: true, plaintextShared: true })
      const chip = within(row).getByText(/end-to-end, readable copy also stored/i)
      expect(chip.className).toMatch(/chip-warn/)
      expect(within(row).getByText(/the server can read your memory/i)).toBeInTheDocument()
      expect(within(row).queryByText(/content sealed/i)).toBeNull()
    })

    // With no key the daemon's plaintext-nulling never runs (it lives inside
    // encryptRow, which is skipped), so ciphertext-only is INERT when
    // encryption is off. Reporting it here would let a ciphertext-only reading
    // imply a protection that is not in force.
    it('does not credit ciphertext-only while encryption is off, where it has no effect', async () => {
      const row = await withPrivacy({ endToEnd: false, plaintextShared: false })
      const chip = within(row).getByText(/plaintext shared/i)
      expect(chip.className).toMatch(/chip-warn/)
      expect(within(row).getByText(/ciphertext-only has no effect until encryption is on/i)).toBeInTheDocument()
      // No reassuring chip of any kind -- the row's description explains what
      // end-to-end MEANS, which is not the same as claiming it is in force.
      expect(row.querySelector('.chip-ok')).toBeNull()
      expect(within(row).queryByText(/content sealed/i)).toBeNull()
    })
  })

  // The daemon now reports its sync loop's own health, and `running: false`
  // covers two very different things: a WEDGED loop and a daemon nobody has
  // observed yet. Rendering either as "not running" is a stronger claim than the
  // daemon supports -- and telling someone their daemon is not running when the
  // process is up sends them to start something already started.
  describe('sync-loop health', () => {
    async function statusRow(health: FakeOptions['health']) {
      renderWith(new FakeDataClient({ health }), <SettingsPage />)
      return screen.findByTestId('setting-status')
    }

    it('reads plainly as running when a pass completed inside the window', async () => {
      const row = await statusRow({ state: 'ok', lastTickAt: '2026-07-29T21:00:00Z', lastTickError: null, staleForSec: 5 })
      const chip = within(row).getByText(/✓ running/)
      expect(chip.className).toMatch(/chip-ok/)
    })

    // Alive and rescheduling, work failing. Neither an ok chip nor a bad one,
    // and the error is the whole reason the state is distinguishable, so it has
    // to be on screen rather than summarised away.
    it('reads as neither healthy nor dead while erroring, and shows the error', async () => {
      const row = await statusRow({ state: 'erroring', lastTickAt: '2026-07-29T21:00:00Z', lastTickError: 'ENOSPC writing memory.md', staleForSec: 12 })
      const chip = within(row).getByText(/running, last sync failed/i)
      expect(chip.className).toMatch(/chip-warn/)
      expect(within(row).getByText(/ENOSPC writing memory\.md/)).toBeInTheDocument()
      expect(row.querySelector('.chip-ok')).toBeNull()
      expect(within(row).queryByText(/not running/i)).toBeNull()
    })

    // The headline: a wedged loop must not be described as a stopped process.
    it('never calls a stalled loop "not running", and keeps Restart reachable', async () => {
      const row = await statusRow({ state: 'stalled', lastTickAt: '2026-07-29T18:00:00Z', lastTickError: null, staleForSec: 900 })
      const chip = within(row).getByText(/sync stalled/i)
      expect(chip.className).toMatch(/chip-bad/)
      expect(within(row).queryByText(/not running/i)).toBeNull()
      // Says the process IS up, so the user reaches for Restart rather than Start.
      expect(within(row).getByText(/MemBridge is running, but no sync has finished/i)).toBeInTheDocument()
      expect(within(row).getByText(/15 min/)).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: /restart/i })).toBeEnabled()
    })

    // Same precedent as DeliveryControl's installed === null: an unobserved
    // state reads as unobserved, never as healthy and never as broken.
    it('claims nothing at all when health was never observed', async () => {
      const row = await statusRow({ state: 'unknown', lastTickAt: null, lastTickError: null, staleForSec: null })
      expect(within(row).getByText(/not checked yet/i)).toBeInTheDocument()
      expect(row.querySelector('.chip-ok')).toBeNull()
      expect(row.querySelector('.chip-bad')).toBeNull()
      expect(within(row).queryByText(/not running/i)).toBeNull()
      expect(within(row).getByRole('button', { name: /restart/i })).toBeEnabled()
    })

    // A daemon older than the health field sends `running` alone. Rendering
    // "not checked yet" at that user would be reporting OUR blindness as THEIR
    // daemon's, so the page must fall back to exactly what it rendered before.
    it('falls back to the running/not-running chip when the daemon sends no health at all', async () => {
      const row = await statusRow(null)
      expect(within(row).getByText(/✓ running/)).toBeInTheDocument()
      expect(within(row).queryByText(/not checked yet/i)).toBeNull()
      expect(within(row).queryByText(/sync stalled/i)).toBeNull()
    })
  })

  describe('page freshness', () => {
    // Finding 10: useSettings has a staleTime and no refetchInterval, so hook
    // vintages, MCP registration, update availability and stale excluded paths
    // were all one snapshot taken when the page mounted, with nothing on
    // screen admitting it. The fix is an explicit control plus a stamp rather
    // than a poll -- getSettings() fans out to three endpoints.
    it('stamps how old the reading is and rechecks on demand', async () => {
      const client = new FakeDataClient()
      const settingsSpy = vi.spyOn(client, 'getSettings')
      const statusSpy = vi.spyOn(client, 'getStatus')
      renderWith(client, <SettingsPage />)
      expect(await screen.findByText(/checked just now/i)).toBeInTheDocument()

      const settingsCalls = settingsSpy.mock.calls.length
      const statusCalls = statusSpy.mock.calls.length
      await userEvent.click(screen.getByRole('button', { name: /^recheck$/i }))
      await waitFor(() => expect(settingsSpy.mock.calls.length).toBeGreaterThan(settingsCalls))
      expect(statusSpy.mock.calls.length).toBeGreaterThan(statusCalls)
    })

    // Recheck was itself a false confirmation of the kind this page exists to
    // remove: LocalDaemonClient coalesces reads of /api/status and /api/team
    // through a 5s cache, and getSettings() plus the Status chip BOTH read
    // through it -- so a Recheck inside that window re-stamped "checked just
    // now" over answers up to five seconds old. Refetching react-query cannot
    // reach that layer, so the button has to stand the transport cache down
    // first. Asserted on ordering, because clearing after the refetch would
    // type-check, run green on the fake, and still lie on the real client.
    it('stands the transport read cache down before refetching, so the stamp is earned', async () => {
      const client = new FakeDataClient()
      const order: string[] = []
      vi.spyOn(client, 'forgetCachedReads').mockImplementation(() => { order.push('forget') })
      const settingsSpy = vi.spyOn(client, 'getSettings')
      renderWith(client, <SettingsPage />)
      await screen.findByText(/checked just now/i)
      settingsSpy.mockImplementation(async () => {
        order.push('getSettings')
        return new FakeDataClient().getSettings()
      })

      await userEvent.click(screen.getByRole('button', { name: /^recheck$/i }))
      await waitFor(() => expect(order).toContain('getSettings'))
      expect(order[0]).toBe('forget')
    })

    // The specific trap: Settings.daemon.running comes from getSettings()'s
    // INTERNAL /api/status read, so it rides the non-polling ['settings']
    // query. The chip therefore looked live while being frozen at page load,
    // and the 10s ['status'] poll never reached it.
    it('reads the Status chip from the polled status query, not the settings snapshot', async () => {
      const client = new FakeDataClient()
      const base = await client.getSettings()
      const status = await client.getStatus()
      // Settings still insists the daemon is up; the polled status says it is
      // not. The chip must follow status.
      //
      // `health` is deliberately STRIPPED here rather than left at the fixture's
      // 'ok': the chip now prefers health over running, so keeping both would
      // present a running:false / health:ok payload the daemon cannot produce,
      // and the test would be asserting against an impossible state. Without
      // health this is the older-daemon shape, where running IS the only signal
      // -- which is exactly the contrast this test needs.
      const { health: _dropped, ...statusWithoutHealth } = status
      vi.spyOn(client, 'getSettings').mockResolvedValue({ ...base, daemon: { ...base.daemon, running: true } })
      vi.spyOn(client, 'getStatus').mockResolvedValue({ ...statusWithoutHealth, running: false })
      renderWith(client, <SettingsPage />)
      const row = await screen.findByTestId('setting-status')
      expect(await within(row).findByText(/not running/i)).toBeInTheDocument()
      expect(within(row).queryByText(/✓ running/)).toBeNull()
    })
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

  // role: 'admin', not the fixture's default 'owner'. leave_team refuses every
  // owner (045:96), so the Leave button is disabled for them and an owner can
  // never reach this flow. These two tests are about the flow's MECHANICS --
  // confirm before calling, surface a rejection -- so they run as the role
  // that can actually perform it. Owner behaviour has its own test below.
  it('leaves the team only after confirming in a dialog, through a real DataClient call', async () => {
    const client = new FakeDataClient({ role: 'admin' })
    const spy = vi.spyOn(client, 'leaveTeam')
    renderWith(client, <SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^leave team$/i }))
    const dialog = await screen.findByRole('dialog')
    expect(spy).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: /^leave team$/i }))
    expect(spy).toHaveBeenCalledWith('team-1')
  })

  it('surfaces a failed leave-team instead of silently closing the dialog', async () => {
    const client = new FakeDataClient({ role: 'admin' })
    vi.spyOn(client, 'leaveTeam').mockRejectedValue(new Error('leave rejected'))
    renderWith(client, <SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^leave team$/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^leave team$/i }))
    expect(await screen.findByText(/leave rejected/i)).toBeInTheDocument()
  })

  // The defect this replaces: Leave team was rendered for owners
  // unconditionally, and leave_team refuses every owner, so the one role that
  // could never succeed got a live button and a 500 for pressing it.
  it('never offers an owner a leave they cannot perform', async () => {
    const client = new FakeDataClient({ role: 'owner' })
    const spy = vi.spyOn(client, 'leaveTeam')
    renderWith(client, <SettingsPage />)
    const leave = await screen.findByRole('button', { name: /^leave team$/i })
    expect(leave).toBeDisabled()
    await userEvent.click(leave)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
    expect(await screen.findByTestId('owner-cannot-leave')).toBeInTheDocument()
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

  // Task 8: Settings opens the exact same IdentityDialog the rail footer
  // does -- one picker, one validation path, one useSetDisplayName mutation.
  // Default fixture (renderApp({})) is authenticated with a signed-in user,
  // same as every other row-visibility test in this file.
  it('opens the identity editor from the Settings row', async () => {
    renderApp({}, <SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: /change name/i }))
    expect(await screen.findByRole('dialog', { name: /your name/i })).toBeInTheDocument()
  })

  // One control, two doors: Settings must not grow its own picker. Asserting
  // both the shape AND colour radiogroups render proves the SHARED dialog
  // opened -- a bespoke Settings-only "Change name" form with just a text
  // field would pass a weaker "a dialog opened" check but fail this one.
  it('shows the same shape and colour rows as the rail editor', async () => {
    renderApp({}, <SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: /change name/i }))
    expect(await screen.findByRole('radiogroup', { name: /avatar shape/i })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: /avatar colour/i })).toBeInTheDocument()
  })

  // Round 1 fix (a): the row must be gated on authenticated, not merely on
  // rendering unconditionally. A signed-out visitor has no account.data.user
  // to seed the dialog with and no mutation to run, so the door must not
  // exist at all -- not render disabled, not render and no-op on click.
  it('offers no identity editor when signed out', async () => {
    renderApp({ authenticated: false }, <SettingsPage />)
    await screen.findByText('Privacy')
    expect(screen.queryByRole('button', { name: /change name/i })).toBeNull()
  })

  // Round 1 fix (b): onClose must actually be wired to the dialog's own
  // Cancel button, not a no-op -- otherwise the Settings door opens a dialog
  // nothing can close.
  it('closes the identity editor on Cancel', async () => {
    renderApp({}, <SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: /change name/i }))
    const dialog = await screen.findByRole('dialog', { name: /your name/i })
    await userEvent.click(within(dialog).getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('dialog', { name: /your name/i })).toBeNull()
  })

  // Round 1 fix (c): the dialog must actually be seeded from the signed-in
  // account, not from hardcoded/empty props -- an empty currentName leaves
  // the field blank (Save disabled), and an empty viewerId would make the
  // Settings-door preview resolve a different avatar registry entry than
  // the rail door for the same person.
  it('seeds the identity editor with the signed-in account name', async () => {
    renderApp({}, <SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: /change name/i }))
    const dialog = await screen.findByRole('dialog', { name: /your name/i })
    expect(within(dialog).getByLabelText('Display name')).toHaveValue('Marco')
  })
})
