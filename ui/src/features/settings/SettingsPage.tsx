import { useState } from 'react'
import { StateChip } from '../../components/StateChip'
import { Toggle } from '../../components/Toggle'
import { useOpenConfigFile, useSetSetting, useSettings, useStatus } from '../../data/queries'
import type { DeliveryChannel } from '../../data/types'
import { ContextFilesDialog } from './ContextFilesDialog'
import { DaemonGroup } from './DaemonGroup'
import { EditListDialog } from './EditListDialog'
import { SettingRow } from './SettingRow'
import { TeamGroup } from './TeamGroup'
import './settings.css'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

function pathsLabel(n: number): string {
  return n === 1 ? '1 path' : `${n} paths`
}

type SetSettingFn = (key: string, value: unknown) => void

interface DeliveryControlProps {
  channel: DeliveryChannel
  onSetSetting: SetSettingFn
  onChooseFiles: () => void
}

// A channel's dynamic specifics (which tools, when last checked) -- '' when
// the mapper had nothing to add beyond the chip itself.
function ChannelDetail({ detail }: { detail: string }) {
  return detail ? <span className="settings-metric">{detail}</span> : null
}

// One control per known DeliveryChannel.id (types.ts's closed union). Only
// 'summaries' (the distill Stop-hook), 'mcp' (registration) and
// 'context-block' (choose files, Task 18) have a real daemon-side action
// behind them today -- lib/server.js's saveSettings has no handler for
// 'recall', so it gets status only, never a button that would silently do
// nothing.
//
// installed:null (Settings honesty fix) is handled once, for every channel,
// before any per-id branch: a channel the daemon has not actually checked
// yet must say so in words -- never fall through to a channel's own
// installed:false wording (e.g. "not registered"), which reads as a real
// failure rather than "not checked".
function DeliveryControl({ channel, onSetSetting, onChooseFiles }: DeliveryControlProps) {
  if (channel.installed === null) {
    return (
      <>
        <StateChip tone="muted" glyph="•">not checked yet</StateChip>
        <ChannelDetail detail={channel.detail} />
      </>
    )
  }

  if (channel.id === 'mcp') {
    if (channel.installed) {
      return (
        <>
          <StateChip tone="ok" glyph="✓">installed</StateChip>
          <ChannelDetail detail={channel.detail} />
        </>
      )
    }
    return (
      <>
        <StateChip tone="warn" glyph="⚠">not registered</StateChip>
        <ChannelDetail detail={channel.detail} />
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

  if (channel.id === 'context-block') {
    return (
      <>
        {channel.installed
          ? <StateChip tone="ok" glyph="✓">installed</StateChip>
          : <StateChip tone="warn" glyph="⚠">not installed</StateChip>}
        <button type="button" className="settings-btn" onClick={onChooseFiles}>Choose files</button>
      </>
    )
  }

  // recall: status only. No daemon endpoint exists to "fix" it beyond what
  // the summaries toggle above already covers.
  return (
    <>
      {channel.installed
        ? <StateChip tone="ok" glyph="✓">installed</StateChip>
        : <StateChip tone="warn" glyph="⚠">not installed</StateChip>}
      <ChannelDetail detail={channel.detail} />
    </>
  )
}

type ActiveDialog = 'contextFiles' | 'redaction' | 'exclude' | null

/**
 * Settings: one page, four groups in a fixed order -- Memory delivery,
 * Privacy, Daemon, Team (Team absent, not disabled, when solo). Matches
 * settings-solo-v2.html. There is deliberately no fifth group and no advisor
 * key/model configuration of any kind -- that whole surface was cut (Global
 * Constraints, apps-interface-rebuild plan) and never existed in the mockup.
 *
 * Every control here calls a real DataClient method (Task 17/18 finished
 * wiring the ones that used to be omitted: Restart, Start at login, Check
 * for updates, Leave team, Open config file, Choose files, Edit redaction
 * patterns, Edit excluded folders).
 */
export function SettingsPage() {
  const settingsQuery = useSettings()
  const statusQuery = useStatus()
  const setSetting = useSetSetting()
  const openConfigFile = useOpenConfigFile()
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(null)

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

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h1 className="settings-title">Settings</h1>
        <span className="mono settings-scope">this machine</span>
        <div className="settings-header-right">
          <button type="button" className="settings-btn" onClick={() => openConfigFile.mutate()} disabled={openConfigFile.isPending}>
            Open config file
          </button>
        </div>
      </div>
      {openConfigFile.isError && (
        <p className="settings-error" role="alert">Couldn't open the config file. {errorMessage(openConfigFile.error)}</p>
      )}

      <div className="settings-group-label">
        Memory delivery
        <span className="settings-group-hint">how agents on this machine receive project memory</span>
      </div>
      {setSetting.isError && (
        <p className="settings-error" role="alert">Couldn't save the change. {errorMessage(setSetting.error)}</p>
      )}
      {settings.delivery.map(channel => (
        <SettingRow
          key={channel.id}
          label={channel.label}
          description={channel.description}
          testId={`setting-${channel.id}`}
        >
          <DeliveryControl channel={channel} onSetSetting={onSetSetting} onChooseFiles={() => setActiveDialog('contextFiles')} />
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
          {settings.privacy.redactionBuiltIn === null ? 'built-in count unknown' : `${settings.privacy.redactionBuiltIn} built-in`}
          {' · '}{settings.privacy.redactionCustom} custom
        </span>
        <button type="button" className="settings-btn" onClick={() => setActiveDialog('redaction')}>Edit</button>
      </SettingRow>
      <SettingRow label="Excluded folders" description="Never watched, never synced" testId="setting-excluded">
        <span className="mono settings-metric">{pathsLabel(settings.privacy.excludedPaths)}</span>
        <button type="button" className="settings-btn" onClick={() => setActiveDialog('exclude')}>Edit</button>
      </SettingRow>

      <DaemonGroup daemon={settings.daemon} />

      {settings.team && <TeamGroup team={settings.team} />}

      {activeDialog === 'contextFiles' && (
        <ContextFilesDialog contextFiles={settings.contextFiles} onClose={() => setActiveDialog(null)} />
      )}
      {activeDialog === 'redaction' && (
        <EditListDialog
          titleId="redaction-dialog-title"
          title="Edit redaction patterns"
          hint="One regular expression per line, checked in addition to the built-in patterns."
          settingKey="redactExtra"
          initial={settings.privacy.redactExtra}
          onClose={() => setActiveDialog(null)}
        />
      )}
      {activeDialog === 'exclude' && (
        <EditListDialog
          titleId="exclude-dialog-title"
          title="Edit excluded folders"
          hint="One path or glob per line -- never watched, never synced."
          settingKey="exclude"
          initial={settings.privacy.exclude}
          onClose={() => setActiveDialog(null)}
        />
      )}
    </div>
  )
}
