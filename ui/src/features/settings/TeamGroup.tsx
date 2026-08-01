import { useState } from 'react'
import { Link } from 'wouter'
import { ROUTES } from '../../app/routes'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useLeaveTeam } from '../../data/queries'
import type { Role, Settings } from '../../data/types'
import { SettingRow } from './SettingRow'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

function memberCountLabel(n: number): string {
  return n === 1 ? '1 member' : `${n} members`
}

function roleLabel(role: Role): string {
  return role.charAt(0).toUpperCase() + role.slice(1)
}

interface TeamGroupProps {
  team: NonNullable<Settings['team']>
}

/** The Team group: name/role/member count, Manage (admin/owner only, links
 *  to Members), and Leave team -- destructive, confirmed in a role="dialog"
 *  per the global rule, backed by DataClient.leaveTeam (POST /api/team/leave). */
export function TeamGroup({ team }: TeamGroupProps) {
  const isTeamAdmin = team.role === 'owner' || team.role === 'admin'
  const leaveTeam = useLeaveTeam()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirmLeave() {
    try {
      await leaveTeam.mutateAsync(team.id)
      setConfirming(false)
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <>
      <div className="settings-group-label">Team</div>
      <SettingRow
        label={team.name}
        description={`You are the ${roleLabel(team.role)} · ${memberCountLabel(team.memberCount)}`}
        testId="setting-team"
      >
        {isTeamAdmin && <Link href={ROUTES.members} className="settings-btn">Manage</Link>}
        <button type="button" className="settings-btn settings-btn-danger" onClick={() => { setError(null); setConfirming(true) }}>
          Leave team
        </button>
      </SettingRow>
      {confirming && (
        <ConfirmDialog
          title={`Leave ${team.name}?`}
          message="You'll lose access to every project this team shares. An owner or admin can re-invite you later."
          confirmLabel="Leave team"
          destructive
          pending={leaveTeam.isPending}
          error={error}
          onConfirm={confirmLeave}
          onCancel={() => { setConfirming(false); setError(null) }}
        />
      )}
    </>
  )
}
