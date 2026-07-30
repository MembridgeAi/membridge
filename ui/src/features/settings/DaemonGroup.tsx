import { StateChip } from '../../components/StateChip'
import { Toggle } from '../../components/Toggle'
import { useCheckForUpdates, useRestartDaemon, useSetSetting } from '../../data/queries'
import type { Settings } from '../../data/types'
import { useThemeMode } from '../../theme/useThemeMode'
import type { ThemeMode } from '../../theme/theme'
import { SettingRow } from './SettingRow'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

function daemonStatusDescription(daemon: Settings['daemon']): string {
  const port = daemon.port !== null ? `port ${daemon.port}` : 'port unknown'
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

interface DaemonGroupProps {
  daemon: Settings['daemon']
}

/**
 * The Daemon group: Status (+ Restart), Start at login, Sync interval, and
 * Updates (+ Check now) -- every control here now has a real backing
 * DataClient method (Task 17/18). One shared error line for the group: all
 * four writes (restart, start-at-login, interval, update check) land here
 * instead of failing silently, matching the same "no silent failure" rule
 * enforced elsewhere on this page.
 */
export function DaemonGroup({ daemon }: DaemonGroupProps) {
  const setSetting = useSetSetting()
  const restart = useRestartDaemon()
  const checkForUpdates = useCheckForUpdates()
  const [themeMode, setThemeMode] = useThemeMode()

  const failure = setSetting.isError ? setSetting.error : restart.isError ? restart.error : checkForUpdates.isError ? checkForUpdates.error : null

  return (
    <>
      <div className="settings-group-label">Daemon</div>
      {failure && (
        <p className="settings-error" role="alert">Couldn't save the change. {errorMessage(failure)}</p>
      )}
      <SettingRow label="Status" description={daemonStatusDescription(daemon)} testId="setting-status">
        {daemon.running
          ? <StateChip tone="ok" glyph="✓">running</StateChip>
          : <StateChip tone="bad" glyph="✕">not running</StateChip>}
        <button type="button" className="settings-btn" onClick={() => restart.mutate()} disabled={restart.isPending}>
          Restart
        </button>
      </SettingRow>
      <SettingRow label="Start at login" testId="setting-start-at-login">
        <Toggle
          label="Start at login"
          on={daemon.startAtLogin}
          onChange={next => setSetting.mutate({ key: 'startAtLogin', value: next })}
        />
      </SettingRow>
      <SettingRow label="Sync interval" testId="setting-sync-interval">
        <select
          className="settings-select"
          aria-label="Sync interval"
          value={daemon.intervalSec}
          onChange={e => setSetting.mutate({ key: 'intervalSec', value: Number(e.target.value) })}
        >
          {intervalOptions(daemon.intervalSec).map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </SettingRow>
      <SettingRow label="Updates" description={`v${daemon.version}`} testId="setting-updates">
        {daemon.updateAvailable && (
          <StateChip tone="warn" glyph="⚠">{`update available · v${daemon.updateAvailable}`}</StateChip>
        )}
        <button type="button" className="settings-btn" onClick={() => checkForUpdates.mutate()} disabled={checkForUpdates.isPending}>
          {checkForUpdates.isPending ? 'Checking…' : 'Check now'}
        </button>
      </SettingRow>
      <SettingRow label="Appearance" description="Follows your system setting unless you override it" testId="setting-appearance">
        <select
          className="settings-select"
          aria-label="Appearance"
          value={themeMode}
          onChange={e => setThemeMode(e.target.value as ThemeMode)}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </SettingRow>
    </>
  )
}
