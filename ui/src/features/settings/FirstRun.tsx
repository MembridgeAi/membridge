import { useSetSetting, useSettings, useStatus } from '../../data/queries'
import { Toggle } from '../../components/Toggle'
import { SettingRow } from './SettingRow'
import './settings.css'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

// status.tools is the one real signal this machine has about what it will
// watch pre-setup (types.ts) -- config.targets (which context files get the
// memory block) isn't on Status or Settings at all, so it is not claimed here.
function watchingBody(tools: string[]): string {
  return tools.length > 0
    ? `MemBridge has already spotted ${tools.join(' and ')} on this machine, and will watch the projects you open with them.`
    : 'MemBridge watches the AI coding tools on this machine and the projects you open with them.'
}

/**
 * First-run takeover, shown by App.tsx while status.setupDone is false:
 * what MemBridge will watch, and the one consent choice this screen asks for
 * -- session summaries. Nothing about teams (that upsell is the rail's
 * "Create a team" CTA, which only appears once setup is done).
 *
 * Part B finding: neither the toggle nor "Get started" ever read
 * setSetting.isError -- a rejected write looked identical to a successful
 * one (the toggle silently reverted next render, "Get started" silently did
 * nothing). Both now surface a real failure via role="alert".
 */
export function FirstRun() {
  const statusQuery = useStatus()
  const settingsQuery = useSettings()
  const setSetting = useSetSetting()

  const hasError = statusQuery.isError || settingsQuery.isError
  if (hasError) {
    return (
      <div className="first-run">
        <p className="settings-error" role="alert">
          Couldn't reach the daemon. {errorMessage(statusQuery.error ?? settingsQuery.error)}
        </p>
      </div>
    )
  }

  const status = statusQuery.data
  const settings = settingsQuery.data
  if (!status || !settings) {
    return (
      <div className="first-run">
        <p className="settings-loading">Loading…</p>
      </div>
    )
  }

  const summaries = settings.delivery.find(c => c.id === 'summaries')
  // Opted in by default until the daemon reports an explicit choice -- the
  // same default consent.js/hooks.js apply when the wizard is skipped.
  const summariesOn = summaries?.enabled ?? true

  const finish = () => setSetting.mutate({ key: 'setupCompletedAt', value: new Date().toISOString() })

  return (
    <div className="first-run">
      <h1 className="first-run-title">Welcome to MemBridge</h1>
      <p className="first-run-lede">
        MemBridge watches your AI coding sessions and keeps a shared memory that gets written back into the
        context files your tools read at startup, so nothing has to be re-explained.
      </p>

      <div className="settings-group-label">What MemBridge will watch</div>
      <p className="first-run-body">{watchingBody(status.tools)}</p>

      <div className="settings-group-label">Session summaries</div>
      <SettingRow
        label="Let a session write its own summary when it ends"
        description="You can turn this off any time from Settings."
      >
        <Toggle
          label="Session summaries"
          on={summariesOn}
          onChange={next => setSetting.mutate({ key: 'distill', value: { enabled: next } })}
        />
      </SettingRow>
      {setSetting.isError && (
        <p className="settings-error" role="alert">Couldn't save the change. {errorMessage(setSetting.error)}</p>
      )}

      <button type="button" className="first-run-btn" onClick={finish}>
        Get started
      </button>
    </div>
  )
}
