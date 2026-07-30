// Settings-specific mapping, split out of mappers.ts (Task 18) to keep that
// file focused on feed/project/member mapping -- Settings' raw shape and
// fold logic is a large, self-contained unit of its own.
import type { Role, Settings, Status } from './types'

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
}

export interface RawTeamRow {
  team_id: string
  team_name: string
  role: Role
  memberCount: number | null
}

// GET /api/team's top-level fields beyond `teams` (Task 17) -- viewerId is
// creds.userId (null when signed out/solo), inviteCode is teams[0]'s current
// invite_code (null when solo or between teams). Both are read fresh on
// every /api/team call, never cached or derived client-side.
export interface RawTeamMeta {
  viewerId: string | null
  inviteCode: string | null
}

const EMPTY_TEAM_META: RawTeamMeta = { viewerId: null, inviteCode: null }

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
        installed: true, enabled: null,
      },
      {
        id: 'summaries', label: 'Session summaries',
        description: 'A Claude Code Stop-hook that distills each session into a summary as it ends.',
        installed: raw.hookInstalled, enabled: raw.distill.enabled,
      },
      {
        id: 'recall', label: 'Recall',
        description: 'Surfaces a relevant past note the moment a matching file is opened.',
        installed: false, enabled: null,
      },
      {
        id: 'mcp', label: 'MCP server',
        description: 'Lets any MCP-capable tool query team memory directly.',
        installed: false, enabled: null,
      },
    ],
    privacy: {
      endToEnd: status.encryption.enabled,
      plaintextShared: !status.encryption.plaintextOff,
      // No field in /api/settings carries a built-in-pattern count -- see
      // the Settings.privacy.redactionBuiltIn comment in types.ts. null, not
      // 0: this is unknown, not "no protection".
      redactionBuiltIn: null,
      redactionCustom: raw.redactExtra.length,
      excludedPaths: raw.exclude.length,
      redactExtra: raw.redactExtra,
      exclude: raw.exclude,
    },
    daemon: {
      running: status.running,
      port: raw.daemonPort,
      version: status.version,
      startAtLogin: raw.startAtLogin,
      intervalSec: raw.intervalSec,
      updateAvailable: raw.updateAvailable,
    },
    team: status.solo || !team
      ? null
      : { id: team.team_id, name: team.team_name, role: team.role, memberCount: team.memberCount ?? 0, inviteCode: teamMeta.inviteCode },
    viewerId: teamMeta.viewerId,
    contextFiles: { targets: raw.targets, extraTargets: raw.extraTargets, extraTargetFiles: raw.extraTargetFiles },
  }
}
