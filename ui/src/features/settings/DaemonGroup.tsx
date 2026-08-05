import { useState } from 'react'
import { StateChip } from '../../components/StateChip'
import { Toggle } from '../../components/Toggle'
import { useCheckForUpdates, useRestartDaemon, useSetSetting, useStatus } from '../../data/queries'
import { relativeAgo } from '../../data/relativeTime'
import type { Settings, Status } from '../../data/types'
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

type UpdateCheck = { current: string; latest: string | null; updateAvailable: string | null }

function staleFor(sec: number | null): string {
  if (sec === null) return 'a while'
  if (sec < 90) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)} min`
  return `${Math.round(sec / 3600)}h`
}

/**
 * The Status chip. Four daemon-reported health states plus the case where the
 * daemon does not report health at all.
 *
 * The distinction that matters: `running: false` covers BOTH a wedged sync loop
 * and a daemon nobody has looked at, and rendering either as "not running" is a
 * stronger claim than the daemon supports. Telling someone their daemon is not
 * running when the process is up and only its loop is stuck sends them to start
 * something that is already started.
 *
 * `health` ABSENT is not 'unknown'. A daemon older than that field sends
 * `running` alone, and this falls back to exactly the running/not-running chip
 * it always rendered -- saying "not checked yet" there would be reporting our
 * own blindness as the daemon's. (The transport drops an unrecognised future
 * state to this same fallback; see normalizeStatus.)
 */
function StatusChip({ health, running }: { health: Status['health']; running: boolean }) {
  if (!health) {
    return running
      ? <StateChip tone="ok" glyph="✓">running</StateChip>
      : <StateChip tone="bad" glyph="✕">not running</StateChip>
  }

  if (health.state === 'ok') return <StateChip tone="ok" glyph="✓">running</StateChip>

  // Alive and rescheduling itself, but its work is failing. Neither healthy nor
  // dead, so neither an ok chip nor a bad one -- and the error is the whole
  // reason this state is distinguishable, so it is shown rather than summarised.
  if (health.state === 'erroring') {
    return (
      <>
        <StateChip tone="warn" glyph="⚠">running, last sync failed</StateChip>
        <span className="settings-note">
          {health.lastTickError
            ? `MemBridge is still trying on schedule. The last attempt failed: ${health.lastTickError}`
            : 'MemBridge is still trying on schedule, but its last sync attempt failed.'}
        </span>
      </>
    )
  }

  // Wedged. Deliberately NOT "not running": the process is up, which is why
  // Restart (beside this chip) is the thing that helps and "start it" is not.
  if (health.state === 'stalled') {
    return (
      <>
        <StateChip tone="bad" glyph="✕">sync stalled</StateChip>
        <span className="settings-note">
          {`MemBridge is running, but no sync has finished in the last ${staleFor(health.staleForSec)}. Restarting usually clears it.`}
        </span>
      </>
    )
  }

  // 'unknown' -- nobody has checked yet. Same precedent as DeliveryControl's
  // installed === null: an unobserved state must read as unobserved, never as
  // either healthy or broken.
  return (
    <>
      <StateChip tone="muted" glyph="•">not checked yet</StateChip>
      <span className="settings-note">
        MemBridge has not completed a sync since it started, so there is nothing to report yet.
      </span>
    </>
  )
}

/**
 * What "Check now" actually found, rendered instead of discarded.
 *
 * Before this, the mutation's resolved value was thrown away and a chip was
 * drawn only when an update EXISTED -- so "you are up to date", "the check
 * could not reach GitHub" and "the button did nothing" were one indis-
 * tinguishable blank. On this project that blank is the NORMAL outcome (the
 * GitHub releases this checks sit behind npm), which made the control read as
 * broken in exactly the case where it worked.
 *
 * `latest === null` is the honest not-known state: /api/updates/check answers
 * 200 with it when the network probe itself failed, so it must never be
 * folded in with "no update available".
 */
function UpdateOutcome({ result, checkedAt }: { result: UpdateCheck; checkedAt: number }) {
  const when = relativeAgo(new Date(checkedAt).toISOString(), { justNow: 'just now' })

  if (result.updateAvailable) {
    return (
      <>
        <StateChip tone="warn" glyph="⚠">{`update available · v${result.updateAvailable}`}</StateChip>
        <span className="settings-metric">{`checked ${when}`}</span>
      </>
    )
  }

  if (result.latest === null) {
    return (
      <>
        <StateChip tone="warn" glyph="⚠">couldn't check</StateChip>
        <span className="settings-note">
          MemBridge couldn't reach GitHub, so the newest version is still unknown. Try again in a moment.
        </span>
      </>
    )
  }

  return (
    <>
      <StateChip tone="ok" glyph="✓">up to date</StateChip>
      <span className="settings-metric">{`checked ${when}`}</span>
    </>
  )
}

/**
 * The Daemon group: Status (+ Restart), Start at login, Sync interval, and
 * Updates (+ Check now) -- every control here now has a real backing
 * DataClient method (Task 17/18).
 *
 * Failures are reported PER ROW. There used to be one line for the whole
 * group, reading "Couldn't save the change." for all four controls -- so
 * pressing Restart told you a save had failed, and with four controls sharing
 * one message nothing on screen said which of them was broken.
 *
 * The rule this group is now held to: NO control may end in a state the code
 * did not observe. Restart holds "restarting…" until the daemon answers
 * again rather than confirming off its own POST; Check now renders what it
 * found, including "couldn't check" when the daemon says it could not reach
 * GitHub; and the Status chip reads the polled ['status'] query rather than
 * the page's one-shot ['settings'] snapshot.
 */
export function DaemonGroup({ daemon }: DaemonGroupProps) {
  // One mutation instance PER control, not one shared by the group: a shared
  // instance has one isError, so a failed sync-interval write would light up
  // the Start-at-login row too and neither row could name its own failure.
  const setStartAtLogin = useSetSetting()
  const setInterval = useSetSetting()
  const restart = useRestartDaemon()
  const checkForUpdates = useCheckForUpdates()
  const statusQuery = useStatus()
  const [themeMode, setThemeMode] = useThemeMode()
  // The ['status'] answer that was on screen when a restart was asked for.
  // Set only from the mutation's own onSuccess, so a REJECTED restart request
  // can never strand the row in "restarting…". An identity comparison against
  // this baseline, rather than a Date.now() comparison, is what makes "the
  // daemon has answered SINCE" exact -- two reads inside the same millisecond
  // would defeat a `>`.
  const [askedAtStatusStamp, setAskedAtStatusStamp] = useState<number | null>(null)

  // "Is the daemon up" is the one value on this page that changes on its own,
  // and it was read from Settings.daemon.running -- i.e. from the ['settings']
  // query, which does not poll. getSettings() fetches /api/status internally,
  // so the chip LOOKED live while actually being frozen at page load and the
  // 10s ['status'] poll never reached it. Read from the polled query, falling
  // back to the settings snapshot only before the first status answer lands.
  const running = statusQuery.data?.running ?? daemon.running

  // Confirmation has to come from the daemon ANSWERING again, not from the
  // POST resolving: lib/server.js writes { ok, restarting } to the socket
  // BEFORE it spawns the replacement and only logs a throw from that spawn, so
  // a POST-resolved "restarted" chip would be a claim this UI cannot back.
  //
  // What a fresh status answer proves, and all it proves, is that MemBridge is
  // answering again after being asked to restart -- the outgoing process can
  // still be the one that served it, since it responds before it exits. The
  // copy below therefore says exactly that and must not be "improved" into
  // "restarted", which would be the same unearned success flag this page
  // exists to remove.
  const answeredSinceRestart = askedAtStatusStamp !== null
    && statusQuery.isSuccess
    && statusQuery.dataUpdatedAt !== askedAtStatusStamp
  const restarting = restart.isPending || (askedAtStatusStamp !== null && !answeredSinceRestart)

  return (
    <>
      <div className="settings-group-label">Background service</div>
      <SettingRow
        label="Status"
        description={daemonStatusDescription(daemon)}
        testId="setting-status"
        error={restart.isError ? `Couldn't restart MemBridge. ${errorMessage(restart.error)}` : null}
      >
        {/* While a restart is in flight the cached "running" is not a fact
            about the process the user just replaced, so it is withheld rather
            than served. Requests legitimately fail in this window; that
            degrades to SettingsPage's existing inline "can't reach MemBridge,
            retrying" banner, which is the truth at that moment. */}
        {restarting
          ? <StateChip tone="muted" glyph="⋯">restarting…</StateChip>
          : <StatusChip health={statusQuery.data?.health} running={running} />}
        {!restarting && answeredSinceRestart && (
          <span className="settings-metric">answering again after restart</span>
        )}
        <button
          type="button"
          className="settings-btn"
          onClick={() => restart.mutate(undefined, {
            onSuccess: () => setAskedAtStatusStamp(statusQuery.dataUpdatedAt),
          })}
          disabled={restarting}
        >
          Restart
        </button>
      </SettingRow>
      {/* `daemon.startAtLogin` is patched optimistically by useSetSetting, so
          the switch moves on click and this row reads the moved value straight
          out of the cache -- no second source of truth in local state to drift
          from it. A rejected write rolls the cache back AND names itself here,
          so the snap-back is explained rather than silent. */}
      <SettingRow
        label="Start at login"
        testId="setting-start-at-login"
        error={setStartAtLogin.isError ? `Couldn't change Start at login. ${errorMessage(setStartAtLogin.error)}` : null}
      >
        <Toggle
          label="Start at login"
          on={daemon.startAtLogin}
          pending={setStartAtLogin.isPending}
          onChange={next => setStartAtLogin.mutate({ key: 'startAtLogin', value: next })}
        />
      </SettingRow>
      <SettingRow
        label="Sync interval"
        testId="setting-sync-interval"
        error={setInterval.isError ? `Couldn't change the sync interval. ${errorMessage(setInterval.error)}` : null}
      >
        {/* Deliberately NOT disabled while its write is in flight, unlike
            Restart: daemon.intervalSec is patched optimistically so the select
            already shows the chosen value, and a second change here expresses
            newer intent rather than an undo (a second toggle CLICK does mean
            undo, which is why Toggle refuses one). Disabling a select a
            keyboard user just operated would also drop their focus for the
            duration of a very fast write. */}
        <select
          className="settings-select"
          aria-label="Sync interval"
          value={daemon.intervalSec}
          onChange={e => setInterval.mutate({ key: 'intervalSec', value: Number(e.target.value) })}
        >
          {intervalOptions(daemon.intervalSec).map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </SettingRow>
      <SettingRow
        label="Updates"
        description={`v${daemon.version}`}
        testId="setting-updates"
        error={checkForUpdates.isError ? `Couldn't check for updates. ${errorMessage(checkForUpdates.error)}` : null}
      >
        {/* A fresh check supersedes the daemon's cached updateAvailable for
            the same reason the MCP row's mutation result supersedes its
            recorded rows: it is the newer truth about the same machine. At
            rest (nothing checked this visit) the cached value is all there
            is, and it stays on the "an update exists" side only -- absence of
            a cached update is not evidence a check ever succeeded. */}
        {checkForUpdates.data
          ? <UpdateOutcome result={checkForUpdates.data} checkedAt={checkForUpdates.submittedAt} />
          : daemon.updateAvailable
            ? <StateChip tone="warn" glyph="⚠">{`update available · v${daemon.updateAvailable}`}</StateChip>
            : null}
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
