// Settings-specific mapping, split out of mappers.ts (Task 18) to keep that
// file focused on feed/project/member mapping -- Settings' raw shape and
// fold logic is a large, self-contained unit of its own.
import type { DeliveryChannel, HooksVersionStatus, Role, Settings, Status } from './types'

// One row per AI tool mcp-register.js attempted -- see lib/mcp-register.js's
// `row()` for the full shape; only the fields this page actually renders are
// declared here.
export interface RawMcpRow {
  agent: string
  status: 'registered' | 'removed' | 'unchanged' | 'skipped' | 'failed'
  detail: string | null
}

// Mirrors lib/server.js's mcpStatusPayload, which mirrors bin/membridge.js's
// printMcpStatus -- same four states, structured instead of printed.
export interface RawMcpStatus {
  autoRegister: boolean
  state: 'disabled' | 'never' | 'removed' | 'registered'
  at: string | null
  rows: RawMcpRow[]
}

export interface RawRecallStatus {
  installed: boolean
}

export interface RawSettingsPayload {
  intervalSec: number
  hookInstalled: boolean
  distill: { enabled: boolean }
  // Task 17's additions to GET /api/settings -- see lib/server.js:settingsPayload.
  startAtLogin: boolean
  daemonPort: number | null
  updateAvailable: string | null
  redactExtra: string[]
  exclude: string[]
  targets: string[]
  extraTargets: Record<string, boolean>
  extraTargetFiles: Record<string, string>
  // Optional, not missing-on-purpose: an older daemon's /api/settings
  // predates these two fields entirely. mcpChannel/recallChannel below treat
  // that absence as unknown, never as false -- see DeliveryChannel.installed.
  mcp?: RawMcpStatus
  recall?: RawRecallStatus
  // Force-update hooks (lib/hooks.js's hooksVersionStatus). Optional for the
  // same older-daemon reason as mcp/recall above; absence maps to both
  // 'unknown' below -- HookVintage already HAS an honest "can't tell" state,
  // so there is no separate null layer to add here the way redactionBuiltIn
  // needed one.
  hooksVersion?: HooksVersionStatus
  // Optional for the same older-daemon reason: absence maps to null
  // (unknown), never 0 -- see Settings.privacy.redactionBuiltIn in types.ts.
  redactionBuiltIn?: number
  // The subset of `exclude` server.js's staleExcludes() found missing from
  // disk. Optional for the same reason; absence maps to [] (nothing flagged
  // stale), never "everything is stale".
  excludeStale?: string[]
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Same bucket idiom as MemberRow.tsx/StreamEntry.tsx's own relativeTime --
// no shared util exists yet for it, so this follows the established pattern
// rather than introducing a fourth one.
function relativeTime(iso: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime()
  if (ms < MINUTE) return 'just now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`
  return `${Math.floor(ms / DAY)}d ago`
}

const KNOWN_AGENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
}

// lib/mcp-register.js supports a user-declared agent on a tool it has never
// heard of (mcp spec §6) -- so this falls back to a title-cased version of
// the raw id instead of assuming the three built-in agents are the only ones
// that can ever appear in a row.
function agentLabel(agent: string): string {
  return KNOWN_AGENT_LABELS[agent] ?? agent.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

const MCP_LABEL = 'MCP server'
const MCP_DESCRIPTION = 'Lets any MCP-capable tool query team memory directly.'

// The MCP channel used to be hardcoded installed:false with no daemon field
// behind it at all (the bug this mapping fixes) -- every branch below is a
// real, distinct state mcpStatusPayload can report, mirrored from
// bin/membridge.js's printMcpStatus so the dashboard and the CLI never
// disagree about what "registered" means.
function mcpChannel(mcp: RawMcpStatus | undefined): DeliveryChannel {
  const base = { id: 'mcp' as const, label: MCP_LABEL, description: MCP_DESCRIPTION }
  if (!mcp) return { ...base, installed: null, enabled: null, detail: 'Not reported by this daemon yet.' }
  if (mcp.state === 'disabled') {
    return { ...base, installed: false, enabled: null, detail: 'Auto-registration is turned off in your config.' }
  }
  if (mcp.state === 'never') {
    // No detail beyond the chip: "not registered" already says everything
    // there is to say here, and a detail string echoing it back (see the
    // 'disabled'/'removed'/no-active-rows branches for cases that DO add
    // real information) would just be noise next to it.
    return { ...base, installed: false, enabled: null, detail: '' }
  }
  const checked = mcp.at ? ` · checked ${relativeTime(mcp.at)}` : ''
  if (mcp.state === 'removed') {
    return { ...base, installed: false, enabled: null, detail: `Removed from your AI tools${checked}.` }
  }
  // state === 'registered'
  const active = mcp.rows.filter(r => r.status === 'registered' || r.status === 'unchanged')
  if (!active.length) {
    return { ...base, installed: false, enabled: null, detail: 'Registration ran, but no AI tool on this machine picked it up.' }
  }
  return { ...base, installed: true, enabled: null, detail: `registered with ${active.map(r => agentLabel(r.agent)).join(', ')}${checked}` }
}

function recallChannel(recall: RawRecallStatus | undefined): DeliveryChannel {
  const base = {
    id: 'recall' as const, label: 'Recall',
    description: 'Surfaces a relevant past note the moment a matching file is opened.',
  }
  if (!recall) return { ...base, installed: null, enabled: null, detail: 'Not reported by this daemon yet.' }
  return {
    ...base, installed: recall.installed, enabled: null,
    detail: recall.installed ? 'Installed as a Claude Code hook.' : 'Not installed.',
  }
}

export interface RawTeamRow {
  team_id: string
  team_name: string
  role: Role
  memberCount: number | null
}

// GET /api/team's top-level fields beyond `teams` (Task 17) -- viewerId is
// creds.userId (null when signed out/solo), inviteCode is teams[0]'s current
// invite_code (null when solo or between teams). webUrl is teamsync.webUrl(config),
// independent of team/solo state (Fix 1: the hosted join page's base URL,
// null when no webUrl is configured). All three are read fresh on every
// /api/team call, never cached or derived client-side.
export interface RawTeamMeta {
  viewerId: string | null
  inviteCode: string | null
  webUrl: string | null
}

const EMPTY_TEAM_META: RawTeamMeta = { viewerId: null, inviteCode: null, webUrl: null }

// Settings: /api/settings predates this screen's redesigned shape (delivery
// channels, privacy counters, daemon control) -- it was built for the old
// dashboard's API-key/advisor form. Fields with a real source are mapped;
// fields with none are nulled rather than invented (see Task 4/17 reports
// for the full list and why each one is unavailable today).
export function mapSettings(raw: RawSettingsPayload, status: Status, team: RawTeamRow | null, teamMeta: RawTeamMeta = EMPTY_TEAM_META): Settings {
  return {
    delivery: [
      {
        id: 'context-block', label: 'Context block',
        description: 'A small skeleton written into CLAUDE.md, AGENTS.md and other context files your AI tools read at startup.',
        installed: true, enabled: null, detail: '',
      },
      {
        id: 'summaries', label: 'Session summaries',
        description: 'A Claude Code Stop-hook that distills each session into a summary as it ends.',
        installed: raw.hookInstalled, enabled: raw.distill.enabled, detail: '',
      },
      recallChannel(raw.recall),
      mcpChannel(raw.mcp),
    ],
    // Absence (an older daemon) reads as 'unknown' for both -- never a
    // fabricated 'current', which would tell the owner an update is
    // unnecessary when this daemon genuinely cannot say.
    hooksVersion: raw.hooksVersion ?? { stop: 'unknown', recall: 'unknown' },
    privacy: {
      endToEnd: status.encryption.enabled,
      plaintextShared: !status.encryption.plaintextOff,
      // Real, derived count from a daemon that reports it; null (never 0)
      // only for the older-daemon case -- see the types.ts comment.
      redactionBuiltIn: raw.redactionBuiltIn ?? null,
      redactionCustom: raw.redactExtra.length,
      excludedPaths: raw.exclude.length,
      redactExtra: raw.redactExtra,
      exclude: raw.exclude,
      excludeStale: raw.excludeStale ?? [],
    },
    daemon: {
      running: status.running,
      port: raw.daemonPort,
      version: status.version,
      startAtLogin: raw.startAtLogin,
      intervalSec: raw.intervalSec,
      updateAvailable: raw.updateAvailable,
    },
    // Membership, NOT `status.solo`. The two are different questions and this
    // used to answer the wrong one: teamsync.isSoloMachine reports solo unless
    // some LINKED PROJECT belongs to a multi-member team, so a user who really
    // did join a team -- but has not linked a repo yet, or whose team is still
    // just them -- had settings.team nulled here. Downstream that hid the
    // Members/Insights nav and the Leave-team control, and left the rail
    // offering "Create a team" to somebody who is already on one. `solo`
    // remains the right signal for "is anyone else actually here" (the access
    // columns), and is still read for that elsewhere.
    team: team
      ? { id: team.team_id, name: team.team_name, role: team.role, memberCount: team.memberCount ?? 0, inviteCode: teamMeta.inviteCode }
      : null,
    viewerId: teamMeta.viewerId,
    webUrl: teamMeta.webUrl,
    contextFiles: { targets: raw.targets, extraTargets: raw.extraTargets, extraTargetFiles: raw.extraTargetFiles },
  }
}
