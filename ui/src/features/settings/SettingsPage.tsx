import { useState } from 'react'
import { DaemonErrorBanner, daemonErrorOf } from '../../components/DaemonError'
import { StateChip } from '../../components/StateChip'
import { Toggle } from '../../components/Toggle'
import { readEncryption } from '../../components/encryptionState'
import { useDataClient } from '../../data/DataClientProvider'
import { useOpenConfigFile, useSetSetting, useSettings, useSoloView, useStatus } from '../../data/queries'
import { absoluteTime, relativeAgo } from '../../data/relativeTime'
import type { DeliveryChannel, HooksVersionStatus, Settings, SharePromptsMode } from '../../data/types'
import { ContextFilesDialog } from './ContextFilesDialog'
import { DaemonGroup } from './DaemonGroup'
import { EditListDialog } from './EditListDialog'
import { ExcludedFoldersDialog } from './ExcludedFoldersDialog'
import { McpRegisterControl } from './McpRegisterControl'
import { SettingRow } from './SettingRow'
import { SharePromptsControl } from './SharePromptsControl'
import { TeamGroup } from './TeamGroup'
import { UpdateHooksControl } from './UpdateHooksControl'
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
  hooksVersion: HooksVersionStatus
  /** A delivery write is in flight, so the summaries switch must not accept a
   *  second flip (which would queue an opposite write) -- see Toggle. */
  settingPending: boolean
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
// failure rather than "not checked". mcp is the one exception carried
// through this early return too: Re-register (McpRegisterControl) must stay
// available even when the daemon has never reported a check, since running
// it IS how a check happens.
function DeliveryControl({ channel, onSetSetting, onChooseFiles, hooksVersion, settingPending }: DeliveryControlProps) {
  if (channel.installed === null) {
    return (
      <>
        <StateChip tone="muted" glyph="•">not checked yet</StateChip>
        <ChannelDetail detail={channel.detail} />
        {channel.id === 'mcp' && <McpRegisterControl />}
        {channel.id === 'summaries' && <UpdateHooksControl hooksVersion={hooksVersion} />}
      </>
    )
  }

  if (channel.id === 'mcp') {
    // Re-register (Task: always available, never gated on the reported
    // install state -- the real fix for "it claims installed but is
    // misbehaving") replaces the old Register button, which only ever
    // rendered on !installed and had no daemon-side handler behind it.
    return (
      <>
        {channel.installed
          ? <StateChip tone="ok" glyph="✓">installed</StateChip>
          : <StateChip tone="warn" glyph="⚠">not registered</StateChip>}
        <ChannelDetail detail={channel.detail} />
        <McpRegisterControl />
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
            pending={settingPending}
            onChange={next => onSetSetting('distill', { enabled: next })}
          />
        )}
        {/* Force-update: covers BOTH the Stop hook (this row) and the recall
            hook (its own row below) in one action -- see UpdateHooksControl. */}
        <UpdateHooksControl hooksVersion={hooksVersion} />
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

/**
 * The whole state of team-memory encryption, in one row. The three-state
 * decision itself lives in components/encryptionState.ts, shared with the
 * project page's Sync panel; this component owns only the wording.
 *
 * It used to key off `endToEnd` alone, which collapsed two different facts:
 * whether rows are encrypted at all, and whether a READABLE copy is written
 * beside each encrypted one (`plaintextShared`, i.e. the daemon's team
 * .plaintextOff being off). The dual-write middle state therefore rendered
 * identically to the safe one -- a green "end-to-end" chip over a server that
 * can read your memory. That distinction is the exact fact behind the plaintext
 * history that made this row read-only, so showing half of it defeated the row.
 *
 * The encryption-off branch deliberately does NOT report plaintextShared: with
 * no key, the daemon's nulling never runs (it lives inside encryptRow, which is
 * skipped), so ciphertext-only is inert there. Reporting it would let a
 * ciphertext-only reading imply a protection that is not in force.
 */
function EncryptionDetail({ privacy }: { privacy: Settings['privacy'] }) {
  // Converted into the daemon's own vocabulary, which is what readEncryption
  // takes: Settings' `plaintextShared` is the INVERSE of status.encryption
  // .plaintextOff (see settingsMapper). Only the state and its tone come from
  // the shared reading; the words below are this row's own, because it has room
  // for a sentence and the project page's 300px side panel does not.
  const { state, tone, glyph } = readEncryption(privacy.endToEnd, !privacy.plaintextShared)

  if (state === 'off') {
    return (
      <>
        <StateChip tone={tone} glyph={glyph}>plaintext shared</StateChip>
        <span className="settings-note">
          Encryption is off, so everything this machine syncs is readable on the server. Ciphertext-only has no effect until encryption is on.
        </span>
      </>
    )
  }
  if (state === 'dual-write') {
    return (
      <>
        <StateChip tone={tone} glyph={glyph}>end-to-end, readable copy also stored</StateChip>
        <span className="settings-note">
          Rows are encrypted, but a readable copy is still written beside each one, so the server can read your memory.
        </span>
      </>
    )
  }
  // "content sealed", not "ciphertext only": the row's routing envelope
  // (project, author_id, author_name, ts, source, session) ships in clear so
  // upserts and threading work -- see docs/ENCRYPTION-SPEC.md §0.1. The old
  // wording claimed the server holds nothing readable, which is false.
  return <StateChip tone={tone} glyph={glyph}>end-to-end, content sealed</StateChip>
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
  const client = useDataClient()
  const settingsQuery = useSettings()
  const statusQuery = useStatus()
  const setSetting = useSetSetting()
  const openConfigFile = useOpenConfigFile()
  // T-78: hides the Team memory encryption row on solo. Called here, above
  // any conditional return below, per rules-of-hooks.
  const soloView = useSoloView()
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(null)

  // Full error page only for a first-load failure (no data at all); a failed
  // refetch with cached data degrades to the inline banner below instead of
  // blanking a populated screen every time the daemon hiccups -- which on
  // THIS page is guaranteed to happen right after "Restart daemon".
  const daemonError = daemonErrorOf([settingsQuery, statusQuery])
  if (daemonError?.blocking) {
    return (
      <div className="settings-page">
        <p className="settings-error" role="alert">Couldn't reach MemBridge.</p>
        <p className="settings-group-hint">{errorMessage(daemonError.error)}</p>
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

  // Everything on this page except the Status chip is a one-shot read taken
  // when the page mounted: hook vintages, MCP registration, update
  // availability, stale excluded paths. Any of them can be minutes out of
  // date by the time it is read, and nothing on screen said so. The fix is an
  // explicit recheck plus a stamp, NOT a refetchInterval -- getSettings()
  // fans out to three endpoints, so polling would triple this page's request
  // volume forever to solve what a button solves once.
  const checkedAt = settingsQuery.dataUpdatedAt
    ? new Date(settingsQuery.dataUpdatedAt).toISOString()
    : null
  // forgetCachedReads FIRST, or this button is itself a false confirmation:
  // getSettings()'s /api/status and /api/team reads (and the Status chip's own
  // query) go through the transport's 5s coalescing cache, so a Recheck pressed
  // inside that window re-stamped "checked just now" over answers up to five
  // seconds old. Refetching react-query alone cannot reach that layer.
  const recheck = () => {
    client.forgetCachedReads()
    settingsQuery.refetch()
    statusQuery.refetch()
  }

  return (
    <div className="settings-page">
      {daemonError && <DaemonErrorBanner className="settings-error" error={daemonError.error} />}
      <div className="settings-header">
        <h1 className="settings-title">Settings</h1>
        <span className="mono settings-scope">this machine</span>
        <div className="settings-header-right">
          {checkedAt && (
            <span className="settings-metric" title={absoluteTime(checkedAt) || undefined}>
              {`checked ${relativeAgo(checkedAt)}`}
            </span>
          )}
          <button type="button" className="settings-btn" onClick={recheck} disabled={settingsQuery.isFetching}>
            {settingsQuery.isFetching ? 'Rechecking…' : 'Recheck'}
          </button>
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
      {/* The group used to carry one "Couldn't save the change." line above
          every row. The only write in this group is the summaries switch, so
          the message now names that control and sits on its row -- same rule
          as the Background service group. */}
      {settings.delivery.map(channel => (
        <SettingRow
          key={channel.id}
          label={channel.label}
          description={channel.description}
          testId={`setting-${channel.id}`}
          error={channel.id === 'summaries' && setSetting.isError
            ? `Couldn't change Session summaries. ${errorMessage(setSetting.error)}`
            : null}
        >
          <DeliveryControl
            channel={channel}
            onSetSetting={onSetSetting}
            onChooseFiles={() => setActiveDialog('contextFiles')}
            hooksVersion={settings.hooksVersion}
            settingPending={setSetting.isPending}
          />
        </SettingRow>
      ))}

      {/* The four Privacy rows are two STAGES of one pipeline, not four peers:
          what never gets captured, then what leaves once something has been.
          Ordered that way, reading top to bottom traces what happens to your
          data -- which is the question ("what can my team see about me?") the
          group is opened to answer, and which previously had to be assembled
          from four rows in no particular order. The split is labelled rather
          than implied, because two hairline rows under one heading do not read
          as a stage on their own. */}
      <div className="settings-group-label">
        Privacy
        <span className="settings-group-hint">what never gets captured</span>
      </div>
      <SettingRow label="Excluded folders" description="Never watched, never synced" testId="setting-excluded">
        <span className="mono settings-metric">{pathsLabel(settings.privacy.excludedPaths)}</span>
        {settings.privacy.excludeStale.length > 0 && (
          <StateChip tone="warn" glyph="⚠">{`${settings.privacy.excludeStale.length} no longer exist`}</StateChip>
        )}
        <button type="button" className="settings-btn" onClick={() => setActiveDialog('exclude')}>Edit</button>
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

      {/* Second stage. Absent entirely on solo for the same reason its two rows
          are: with no team, nothing leaves, and a heading over nothing is
          noise. */}
      {!soloView && (
        <div className="settings-group-label">
          Shared with your team
          <span className="settings-group-hint">what leaves this machine</span>
        </div>
      )}
      {/* Share-prompts is a MACHINE preference (what this daemon transmits to
          teammates on top of each summary), so it leads this stage -- it is
          the one row here the user actually decides. Hidden on solo for the
          same reason the encryption row is: with no team to transmit to, the
          control is noise, not a choice.
          Wired via the same setSetting mutation every other Settings write
          uses; the key is 'team' with a nested `{sharePrompts}` value so the
          daemon's PUT /api/settings body reads {team: {sharePrompts: '...'}}
          -- see optimisticSettings in data/queries.ts for the cache patch,
          and settingsMapper.normalizeSharePrompts for the read side (which
          accepts the legacy boolean shape too). */}
      {!soloView && settings.team && (
        <SharePromptsControl
          value={settings.team.sharePrompts}
          pending={setSetting.isPending}
          error={setSetting.isError
            ? `Couldn't change Share prompts. ${errorMessage(setSetting.error)}`
            : null}
          onChange={(next: SharePromptsMode) => {
            // mutateAsync so SharePromptsControl can await the write and
            // roll its local selection back on rejection -- mutate() alone
            // is fire-and-forget and would leave the radio one click ahead
            // of reality.
            return setSetting.mutateAsync({ key: 'team', value: { sharePrompts: next } })
          }}
        />
      )}
      {/* READ-ONLY ON PURPOSE -- do not turn this back into a toggle.
       *
       * It used to read "Share plaintext with team" and be described as "Off
       * means...", i.e. exactly like a switch, while its only child was a chip
       * and it ignored clicks. Restated as a status row: the label names the
       * state, and a padlocked aside says where the state is actually changed
       * -- the aside rather than the description because this row now sits
       * beside three rows that ARE editable in-app, and a sentence buried in
       * grey prose was not enough to tell them apart.
       *
       * Marco's reasoning for keeping it read-only (his call, 2026-08-05): an
       * accidental `encrypt: false` in his own config already shipped a full
       * plaintext history to the server once. A privacy DOWNGRADE one click
       * away, on a page with no confirmation step, is how that recurs. This
       * row's job is to let him SEE the state, not to change it here; the
       * config file is deliberately the only way in, and "Open config file"
       * above is how you get there. */}
      {/* T-78: Team memory encryption is the ONE Privacy row that describes
          team behaviour ("teammates' apps decrypt locally") and names the two
          config keys (team.encrypt, team.plaintextOff) that only mean
          something once a team exists. On a solo (or signed-out) install both
          are noise: there is no team to encrypt for, and pointing at those
          keys hands the user two variables to search their config for with no
          value. Hidden entirely, matching the ticket's rule that the
          surface goes AWAY on solo rather than saying "n/a". */}
      {!soloView && (
        <SettingRow
          label="Team memory encryption"
          // The metadata carve-out comes from master (PR #40) and is kept
          // verbatim through this rebase. It is the honesty half of this row:
          // "end-to-end" alone reads as "the server knows nothing", and the
          // server does know project, timestamp, session, tool and who you
          // are. My shorter rewrite said "nothing readable is stored on the
          // server", which that carve-out makes FALSE -- so master's wording
          // wins and only the config-file clause moves to the aside.
          description="Teammates' apps decrypt locally and the server cannot read your content. Routing metadata — project, timestamp, session, tool and your display name — travels outside the ciphertext."
          testId="setting-plaintext"
          // The label now carries a description AND the padlocked aside, so a
          // centred chip would float against three lines of text.
          align="start"
          labelAside={(
            <span className="setting-locked">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                <rect x="4" y="11" width="16" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
              set in your config file · team.encrypt, team.plaintextOff
            </span>
          )}
        >
          <EncryptionDetail privacy={settings.privacy} />
        </SettingRow>
      )}

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
        <ExcludedFoldersDialog
          exclude={settings.privacy.exclude}
          excludeStale={settings.privacy.excludeStale}
          onClose={() => setActiveDialog(null)}
        />
      )}
    </div>
  )
}
