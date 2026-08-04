import { describe, it, expect } from 'vitest'
import { mapSettings } from './settingsMapper'
import type { Status } from './types'

describe('mapSettings', () => {
  const status: Status = {
    running: true, version: '0.1.7', solo: false, setupDone: true, projectCount: 2,
    intervalSec: 60, lastSync: null, teamLastSync: null, tools: [],
    encryption: { enabled: true, plaintextOff: true, paused: null, keyAlerts: 0 },
    auth: { paused: null, detail: null, since: null },
  }
  const raw = {
    intervalSec: 300, hookInstalled: true, distill: { enabled: true },
    startAtLogin: true, daemonPort: 7391, updateAvailable: null,
    redactExtra: ['CUSTOM_KEY'], exclude: ['dist'],
    targets: ['CLAUDE.md', 'AGENTS.md'], extraTargets: { gemini: false }, extraTargetFiles: { gemini: 'GEMINI.md' },
  }

  it('maps the summaries delivery channel from the real hook/distill config', () => {
    const s = mapSettings(raw, status, null)
    const summaries = s.delivery.find(d => d.id === 'summaries')
    expect(summaries).toMatchObject({ installed: true, enabled: true })
  })
  // Reversed deliberately. `solo` (teamsync.isSoloMachine) means "no LINKED
  // PROJECT belongs to a multi-member team" -- it is not an answer to "are
  // you on a team". Nulling the team on solo hid the Members/Insights nav and
  // the Leave-team control from real members who had simply not linked a repo
  // yet, and kept offering "Create a team" to an owner who had just created
  // one.
  it('keeps the team a real member is on, even while the machine still reads solo', () => {
    const soloStatus: Status = { ...status, solo: true }
    const team = { team_id: 't1', team_name: 'Acme', role: 'owner' as const, memberCount: 3 }
    expect(mapSettings(raw, soloStatus, team).team).toMatchObject({ id: 't1', name: 'Acme' })
  })
  it('is null only when there is genuinely no team', () => {
    expect(mapSettings(raw, status, null).team).toBeNull()
  })
  it('surfaces the real team name, role, member count and invite code when not solo', () => {
    const team = { team_id: 't1', team_name: 'Acme', role: 'owner' as const, memberCount: 3 }
    expect(mapSettings(raw, status, team, { viewerId: 'usr_1', inviteCode: 'INV-1', webUrl: null }).team)
      .toEqual({ id: 't1', name: 'Acme', role: 'owner', memberCount: 3, inviteCode: 'INV-1' })
  })
  it('surfaces the real daemon port, start-at-login and update fields instead of "not reported"', () => {
    const s = mapSettings(raw, status, null)
    expect(s.daemon).toMatchObject({ port: 7391, startAtLogin: true, updateAvailable: null })
  })
  it('derives redaction-custom and excluded-path counts from the real arrays, never zeroed', () => {
    const s = mapSettings(raw, status, null)
    expect(s.privacy.redactionCustom).toBe(1)
    expect(s.privacy.excludedPaths).toBe(1)
    expect(s.privacy.redactExtra).toEqual(['CUSTOM_KEY'])
    expect(s.privacy.exclude).toEqual(['dist'])
  })
  it('renders the built-in redaction count as unknown (null), never a fabricated 0 -- the daemon reports no such count', () => {
    const s = mapSettings(raw, status, null)
    expect(s.privacy.redactionBuiltIn).toBeNull()
  })
  it('carries the real viewerId through regardless of team/solo state', () => {
    const s = mapSettings(raw, status, null, { viewerId: 'usr_9f2a', inviteCode: null, webUrl: null })
    expect(s.viewerId).toBe('usr_9f2a')
  })
  it('is null for viewerId, inviteCode and webUrl when no team meta is supplied', () => {
    const s = mapSettings(raw, status, null)
    expect(s.viewerId).toBeNull()
    expect(s.webUrl).toBeNull()
  })
  it('carries the real webUrl through regardless of team/solo state, independent of inviteCode', () => {
    const s = mapSettings(raw, status, null, { viewerId: null, inviteCode: null, webUrl: 'https://join.membridge.me' })
    expect(s.webUrl).toBe('https://join.membridge.me')
  })
  it('carries context-file targets and extraTargets straight through', () => {
    const s = mapSettings(raw, status, null)
    expect(s.contextFiles).toEqual({ targets: ['CLAUDE.md', 'AGENTS.md'], extraTargets: { gemini: false }, extraTargetFiles: { gemini: 'GEMINI.md' } })
  })

  // Settings honesty fix: /api/settings used to carry no mcp/recall field at
  // all, so the UI defaulted to installed:false -- a state that reads as
  // broken even when the channel is actually working. These pin the mapper
  // reading the REAL daemon shape (RawMcpStatus/RawRecallStatus), never a
  // hardcoded true/false standing in for it.
  describe('mcp channel', () => {
    it('is unknown, never false, when an older daemon reports no mcp field at all', () => {
      const s = mapSettings(raw, status, null)
      const mcp = s.delivery.find(d => d.id === 'mcp')
      expect(mcp?.installed).toBeNull()
    })
    it('is not installed, with no redundant detail, when nothing was ever registered', () => {
      const s = mapSettings({ ...raw, mcp: { autoRegister: true, state: 'never', at: null, rows: [] } }, status, null)
      const mcp = s.delivery.find(d => d.id === 'mcp')
      expect(mcp).toMatchObject({ installed: false, detail: '' })
    })
    it('is not installed and says so when auto-registration is turned off', () => {
      const s = mapSettings({ ...raw, mcp: { autoRegister: false, state: 'disabled', at: null, rows: [] } }, status, null)
      const mcp = s.delivery.find(d => d.id === 'mcp')
      expect(mcp).toMatchObject({ installed: false })
      expect(mcp?.detail).toMatch(/auto-registration/i)
    })
    it('is installed, naming the real registered tools, when the daemon reports a live registration', () => {
      const s = mapSettings({
        ...raw,
        mcp: {
          autoRegister: true, state: 'registered', at: null,
          rows: [
            { agent: 'claude-code', status: 'registered', detail: null },
            { agent: 'codex', status: 'unchanged', detail: null },
            { agent: 'cursor', status: 'skipped', detail: '~/.cursor does not exist' },
          ],
        },
      }, status, null)
      const mcp = s.delivery.find(d => d.id === 'mcp')
      expect(mcp?.installed).toBe(true)
      expect(mcp?.detail).toContain('Claude Code')
      expect(mcp?.detail).toContain('Codex')
      expect(mcp?.detail).not.toContain('Cursor')
    })
    it('reports the real checked time, never a fabricated one', () => {
      const at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      const s = mapSettings({
        ...raw,
        mcp: { autoRegister: true, state: 'registered', at, rows: [{ agent: 'codex', status: 'registered', detail: null }] },
      }, status, null)
      const mcp = s.delivery.find(d => d.id === 'mcp')
      expect(mcp?.detail).toMatch(/checked 2h ago/)
    })
    it('is not installed when a registration ran but every row failed or was skipped', () => {
      const s = mapSettings({
        ...raw,
        mcp: { autoRegister: true, state: 'registered', at: null, rows: [{ agent: 'cursor', status: 'skipped', detail: 'not installed' }] },
      }, status, null)
      const mcp = s.delivery.find(d => d.id === 'mcp')
      expect(mcp?.installed).toBe(false)
    })
    // `membridge status` names the exact cause and the config key that fixes
    // it for every tool it could not register. /api/settings has always
    // carried those same per-row `detail` sentences (verified against a live
    // daemon), but mcpChannel collapsed the rows into one summary string and
    // filtered out everything that was not registered/unchanged -- so the
    // dashboard threw away precisely the rows that were actionable. The
    // summary string stays as it is; the rows have to survive alongside it
    // for the UI to be able to render them at all.
    it('carries the per-tool rows through, including the skipped ones the summary omits', () => {
      const s = mapSettings({
        ...raw,
        mcp: {
          autoRegister: true, state: 'registered', at: null,
          rows: [
            { agent: 'claude-code', status: 'skipped', detail: 'could not find the `claude` binary; set config.mcp.claudeBin to its full path' },
            { agent: 'codex', status: 'registered', detail: null },
          ],
        },
      }, status, null)
      const mcp = s.delivery.find(d => d.id === 'mcp')
      expect(mcp?.mcpRows).toHaveLength(2)
      expect(mcp?.mcpRows?.[0]).toMatchObject({
        agent: 'claude-code',
        status: 'skipped',
        detail: 'could not find the `claude` binary; set config.mcp.claudeBin to its full path',
      })
    })
    it('is not installed after a real unregister', () => {
      const s = mapSettings({ ...raw, mcp: { autoRegister: true, state: 'removed', at: null, rows: [{ agent: 'codex', status: 'removed', detail: null }] } }, status, null)
      const mcp = s.delivery.find(d => d.id === 'mcp')
      expect(mcp?.installed).toBe(false)
    })
  })

  describe('recall channel', () => {
    it('is unknown, never false, when an older daemon reports no recall field at all', () => {
      const s = mapSettings(raw, status, null)
      const recall = s.delivery.find(d => d.id === 'recall')
      expect(recall?.installed).toBeNull()
    })
    it('is installed when the daemon confirms a live, resolvable recall hook', () => {
      const s = mapSettings({ ...raw, recall: { installed: true } }, status, null)
      const recall = s.delivery.find(d => d.id === 'recall')
      expect(recall?.installed).toBe(true)
    })
    it('is not installed when the daemon reports the hook missing', () => {
      const s = mapSettings({ ...raw, recall: { installed: false } }, status, null)
      const recall = s.delivery.find(d => d.id === 'recall')
      expect(recall?.installed).toBe(false)
    })
  })

  // Force-update hooks (lib/hooks.js's hooksVersionStatus): the three honest
  // states -- current / outdated / unknown -- must pass through unmodified,
  // and an older daemon with no field at all must read as unknown for BOTH
  // hooks, never a fabricated 'current' that would hide a real update.
  describe('hooksVersion', () => {
    it('is unknown for both hooks when an older daemon reports no hooksVersion field at all', () => {
      const s = mapSettings(raw, status, null)
      expect(s.hooksVersion).toEqual({ stop: 'unknown', recall: 'unknown' })
    })
    it('carries the real per-hook state straight through when the daemon reports it', () => {
      const s = mapSettings({ ...raw, hooksVersion: { stop: 'outdated', recall: 'current' } }, status, null)
      expect(s.hooksVersion).toEqual({ stop: 'outdated', recall: 'current' })
    })
  })
})
