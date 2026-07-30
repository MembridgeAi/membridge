import { Link } from 'wouter'
import { ROUTES } from '../../app/routes'
import { StateChip } from '../../components/StateChip'
import { Toggle } from '../../components/Toggle'
import { useSetSetting, useSettings, useStatus } from '../../data/queries'
import type { DeliveryChannel, Role, Settings } from '../../data/types'
import { SettingRow } from './SettingRow'
import './settings.css'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

const NOT_REPORTED = 'not reported'

function pathsLabel(n: number): string {
  return n === 1 ? '1 path' : `${n} paths`
}

function memberCountLabel(n: number): string {
  return n === 1 ? '1 member' : `${n} members`
}

function roleLabel(role: Role): string {
  return role.charAt(0).toUpperCase() + role.slice(1)
}

// Settings.daemon.port carries the type's own null -- honor it directly.
function daemonStatusDescription(daemon: Settings['daemon']): string {
  const port = daemon.port !== null ? `port ${daemon.port}` : `port ${NOT_REPORTED}`
  return `${port} · v${daemon.version}`
}

const INTERVAL_PRESETS = [
  { value: 60, label: 'Every minute' },
  { value: 300, label: 'Every 5 minutes' },
  { value: 900, label: 'Every 15 minutes' },
  { value: 1800, label: 'Every 30 minutes' },
]

// If the daemon's real interval doesn't match a preset, show it anyway
// rather than silently rounding to the nearest option -- a <select> whose
// value matches no <option> would visually pick one at random.
function intervalOptions(current: number): { value: number; label: string }[] {
  if (INTERVAL_PRESETS.some(p => p.value === current)) return INTERVAL_PRESETS
  return [...INTERVAL_PRESETS, { value: current, label: `Every ${current}s` }]
}

type SetSettingFn = (key: string, value: unknown) => void

interface DeliveryControlProps {
  channel: DeliveryChannel
  onSetSetting: SetSettingFn
}

// One control per known DeliveryChannel.id (types.ts's closed union). Only
// 'summaries' (the distill Stop-hook) and 'mcp' (registration) have a real
// daemon-side action behind them today -- lib/server.js's saveSettings has no
// handler for the others, so context-block/recall get status only, never a
// button that would silently do nothing.
function DeliveryControl({ channel, onSetSetting }: DeliveryControlProps) {
  if (channel.id === 'mcp') {
    if (channel.installed) return <StateChip tone="ok" glyph="✓">installed</StateChip>
    return (
      <>
        <StateChip tone="warn" glyph="⚠">not registered</StateChip>
        <button type="button" className="settings-btn" onClick={() => onSetSetting('mcpRegistered', true)}>
          Register
        </button>
      </>
    )
  }

  if (channel.id === 'summaries') {
    return (
      <>
        {channel.installed
          ? <StateChip tone="ok" glyph="✓">hook installed</StateChip>
          : <StateChip tone="warn" glyph="⚠">hook not installed</StateChip>}
        {channel.enabled !== null && (
          <Toggle
            label={channel.label}
            on={channel.enabled}
            onChange={next => onSetSetting('distill', { enabled: next })}
          />
        )}
      </>
    )
  }

  // context-block, recall: status only. No daemon endpoint exists to "fix"
  // either beyond what the summaries toggle above already covers.
  return channel.installed
    ? <StateChip tone="ok" glyph="✓">installed</StateChip>
    : <StateChip tone="warn" glyph="⚠">not installed</StateChip>
}

/**
 * Settings: one page, four groups in a fixed order -- Memory delivery,
 * Privacy, Daemon, Team (Team absent, not disabled, when solo). Matches
 * settings-solo-v2.html. There is deliberately no fifth group and no advisor
 * key/model configuration of any kind -- that whole surface was cut (Global
 * Constraints, apps-interface-rebuild plan) and never existed in the mockup.
 *
 * Every control here calls a real DataClient method. Where the mockup shows
 * a control this build has no backing method for (Open config file, Restart,
 * Choose files, Edit redaction patterns, Edit excluded folders, Leave team,
 * Check for updates), it is omitted rather than shipped as a no-op -- see
 * the Task 14 report for the full list and why each one is missing.
 */
export function SettingsPage() {
  const settingsQuery = useSettings()
  const statusQuery = useStatus()
  const setSetting = useSetSetting()

  const hasError = settingsQuery.isError || statusQuery.isError
  if (hasError) {
    return (
      <div className="settings-page">
        <p className="settings-error" role="alert">
          Couldn't reach the daemon. {errorMessage(settingsQuery.error ?? statusQuery.error)}
        </p>
      </div>
    )
  }

  const settings = settingsQuery.data
  if (!settings) {
    return (
      <div className="settings-page">
        <p className="settings-loading">Loading…</p>
      </div>
    )
  }

  const onSetSetting: SetSettingFn = (key, value) => setSetting.mutate({ key, value })
  const isTeamAdmin = settings.team?.role === 'owner' || settings.team?.role === 'admin'

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h1 className="settings-title">Settings</h1>
        <span className="mono settings-scope">this machine</span>
      </div>

      <div className="settings-group-label">
        Memory delivery
        <span className="settings-group-hint">how agents on this machine receive project memory</span>
      </div>
      {settings.delivery.map(channel => (
        <SettingRow
          key={channel.id}
          label={channel.label}
          description={channel.description}
          testId={`setting-${channel.id}`}
        >
          <DeliveryControl channel={channel} onSetSetting={onSetSetting} />
        </SettingRow>
      ))}

      <div className="settings-group-label">Privacy</div>
      <SettingRow
        label="Share plaintext with team"
        description="Off means teammates' apps decrypt locally; nothing readable is stored on the server"
        testId="setting-plaintext"
      >
        {settings.privacy.endToEnd
          ? <StateChip tone="ok" glyph="✓">end-to-end</StateChip>
          : <StateChip tone="warn" glyph="⚠">plaintext shared</StateChip>}
      </SettingRow>
      <SettingRow
        label="Redaction patterns"
        description="Built-in key, token and credential shapes, plus your own"
        testId="setting-redaction"
      >
        <span className="mono settings-metric">
          {settings.privacy.redactionBuiltIn} built-in · {settings.privacy.redactionCustom} custom
        </span>
      </SettingRow>
      <SettingRow label="Excluded folders" description="Never watched, never synced" testId="setting-excluded">
        <span className="mono settings-metric">{pathsLabel(settings.privacy.excludedPaths)}</span>
      </SettingRow>

      <div className="settings-group-label">Daemon</div>
      <SettingRow label="Status" description={daemonStatusDescription(settings.daemon)} testId="setting-status">
        {settings.daemon.running
          ? <StateChip tone="ok" glyph="✓">running</StateChip>
          : <StateChip tone="bad" glyph="✕">not running</StateChip>}
      </SettingRow>
      {/* Start at login: /api/settings has no field for this at all (Task 4)
          -- rendering a toggle bound to a value the daemon cannot actually
          read or write would look functional while doing nothing either way. */}
      <SettingRow label="Start at login" testId="setting-start-at-login">
        <span className="settings-unknown">{NOT_REPORTED}</span>
      </SettingRow>
      <SettingRow label="Sync interval" testId="setting-sync-interval">
        <select
          className="settings-select"
          aria-label="Sync interval"
          value={settings.daemon.intervalSec}
          onChange={e => onSetSetting('intervalSec', Number(e.target.value))}
        >
          {intervalOptions(settings.daemon.intervalSec).map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </SettingRow>
      <SettingRow label="Updates" description={`v${settings.daemon.version}`} testId="setting-updates">
        {settings.daemon.updateAvailable
          ? <StateChip tone="warn" glyph="⚠">{`update available · v${settings.daemon.updateAvailable}`}</StateChip>
          : <span className="settings-unknown">{NOT_REPORTED}</span>}
      </SettingRow>

      {settings.team && (
        <>
          <div className="settings-group-label">Team</div>
          <SettingRow
            label={settings.team.name}
            description={`You are the ${roleLabel(settings.team.role)} · ${memberCountLabel(settings.team.memberCount)}`}
            testId="setting-team"
          >
            {isTeamAdmin && (
              <Link href={ROUTES.members} className="settings-btn">Manage</Link>
            )}
          </SettingRow>
        </>
      )}
    </div>
  )
}
