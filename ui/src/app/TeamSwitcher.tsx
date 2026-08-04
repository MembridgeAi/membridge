import { useQueryClient } from '@tanstack/react-query'
import { useDataClient } from '../data/DataClientProvider'
import { useTeamAccount } from '../data/queries'
import type { Settings } from '../data/types'

interface TeamSwitcherProps {
  /** The team currently in effect, as Settings reports it. */
  current: NonNullable<Settings['team']>
}

/**
 * Which team the app is about, in the rail.
 *
 * Everything team-scoped — members, invites, the audit trail, the access
 * matrix, insights, and the name shown here — used to read `teams[0]`
 * unconditionally, in the UI *and* in the daemon. Someone on two teams saw
 * one of them with no indication the other existed, and every control on
 * screen quietly acted on it.
 *
 * On one team this stays exactly what it was: a label. The control only
 * appears when there is genuinely something to switch between.
 */
export function TeamSwitcher({ current }: TeamSwitcherProps) {
  const client = useDataClient()
  const queryClient = useQueryClient()
  const accountQuery = useTeamAccount()
  const teams = accountQuery.data?.teams ?? []

  if (teams.length < 2) {
    return (
      <div className="team-switch">
        <span className="team-switch-name">{current.name}</span>
      </div>
    )
  }

  function switchTo(teamId: string) {
    client.selectTeam(teamId)
    // Every cached query answered about the OLD team -- members, audit,
    // invites, settings, insights, the projects grid's access column. None of
    // them carry the team in their query key (the client does), so a targeted
    // invalidation would be a list of everything anyway, and any omission
    // would leave one panel describing a team the rest of the screen has left.
    queryClient.invalidateQueries()
  }

  return (
    <div className="team-switch">
      {/* A native select: it is one tab stop, it announces the current team
          and the count, and it works with a keyboard and a screen reader
          without re-implementing a listbox. */}
      <label className="sr-only" htmlFor="team-switch-select">Team</label>
      <select
        id="team-switch-select"
        className="team-switch-select"
        value={current.id}
        onChange={e => switchTo(e.target.value)}
      >
        {teams.map(team => (
          <option key={team.id} value={team.id}>{team.name}</option>
        ))}
      </select>
    </div>
  )
}
