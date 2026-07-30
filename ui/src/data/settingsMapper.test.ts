import { describe, it, expect } from 'vitest'
import { mapSettings } from './settingsMapper'
import type { Status } from './types'

describe('mapSettings', () => {
  const status: Status = {
    running: true, version: '0.1.7', solo: false, setupDone: true, projectCount: 2,
    lastSync: null, teamLastSync: null, tools: [],
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
  it('is solo-null for team even when a team row is passed, if status says solo', () => {
    const soloStatus: Status = { ...status, solo: true }
    const team = { team_id: 't1', team_name: 'Acme', role: 'owner' as const, memberCount: 3 }
    expect(mapSettings(raw, soloStatus, team).team).toBeNull()
  })
  it('surfaces the real team name, role, member count and invite code when not solo', () => {
    const team = { team_id: 't1', team_name: 'Acme', role: 'owner' as const, memberCount: 3 }
    expect(mapSettings(raw, status, team, { viewerId: 'usr_1', inviteCode: 'INV-1' }).team)
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
    const s = mapSettings(raw, status, null, { viewerId: 'usr_9f2a', inviteCode: null })
    expect(s.viewerId).toBe('usr_9f2a')
  })
  it('is null for viewerId and inviteCode when no team meta is supplied', () => {
    const s = mapSettings(raw, status, null)
    expect(s.viewerId).toBeNull()
  })
  it('carries context-file targets and extraTargets straight through', () => {
    const s = mapSettings(raw, status, null)
    expect(s.contextFiles).toEqual({ targets: ['CLAUDE.md', 'AGENTS.md'], extraTargets: { gemini: false }, extraTargetFiles: { gemini: 'GEMINI.md' } })
  })
})
