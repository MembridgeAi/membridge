import { Avatar } from '../../components/Avatar'

export interface AccessMemberRef {
  id: string
  name: string
}

const MAX_AVATARS = 4

/**
 * The one Access cell per project row (spec: constant-width grid). A shared
 * project renders a stacked avatar group (first 4), a +N chip for the rest,
 * and a short count label; the whole cell is a single button that opens the
 * access popover. Private projects never render this component at all: the
 * row shows plain "Only you" text with no control (see ProjectsPage).
 */
export function AccessSummary({ projectName, roster, teamSize, onOpen }: {
  projectName: string
  roster: AccessMemberRef[]
  teamSize: number
  onOpen: () => void
}) {
  const wholeTeam = teamSize > 0 && roster.length >= teamSize
  const label = wholeTeam ? 'Whole team' : `${roster.length} of ${teamSize}`
  const shown = roster.slice(0, MAX_AVATARS)
  const extra = roster.length - shown.length
  return (
    <button
      type="button"
      className="access-summary"
      onClick={onOpen}
      aria-label={`Access for ${projectName}, ${wholeTeam ? 'whole team' : `${roster.length} of ${teamSize} members`}`}
      aria-haspopup="dialog"
    >
      <span className="access-avatars" aria-hidden="true">
        {shown.map(m => <Avatar key={m.id} id={m.id} name={m.name} size={18} />)}
      </span>
      {extra > 0 && <span className="access-more" aria-hidden="true">+{extra}</span>}
      <span className="access-label" aria-hidden="true">{label}</span>
    </button>
  )
}
