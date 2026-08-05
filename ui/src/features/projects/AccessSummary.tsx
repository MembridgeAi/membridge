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
 *
 * `roster === null` is the UNKNOWN state, and it is a first-class one: this
 * cell's entire job is answering "who can see this", and the grid can only
 * answer it authoritatively from the owner/admin access matrix. A plain member
 * has no whole-grid read available (GET /api/team/access-matrix 403s for them),
 * and the feed-derived Project.recentAuthorIds is not a roster -- a quiet shared
 * project's author set is empty, which rendered as "0 of 5" for a project the
 * whole team can see. So the cell asks the question instead of answering it
 * wrongly, and the popover behind it says what it can: the real roster for an
 * owner/admin, and for a member the reason nobody can hand them one. No number
 * is strictly better than a wrong one on this surface.
 */
export function AccessSummary({ projectName, roster, teamSize, onOpen }: {
  projectName: string
  /** The authoritative roster, or null when this grid cannot know it. */
  roster: AccessMemberRef[] | null
  teamSize: number
  onOpen: () => void
}) {
  const wholeTeam = roster !== null && teamSize > 0 && roster.length >= teamSize
  const label = roster === null ? 'Who can see' : wholeTeam ? 'Whole team' : `${roster.length} of ${teamSize}`
  const detail = roster === null
    ? 'not shown here, open for details'
    : wholeTeam ? 'whole team' : `${roster.length} of ${teamSize} members`
  const shown = (roster ?? []).slice(0, MAX_AVATARS)
  const extra = (roster ?? []).length - shown.length
  return (
    <button
      type="button"
      className="access-summary"
      onClick={onOpen}
      aria-label={`Access for ${projectName}, ${detail}`}
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
