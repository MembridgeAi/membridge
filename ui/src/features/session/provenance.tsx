import type { Session, SessionMissing } from '../../data/types'

// Provenance for the session page: where THIS COPY came from, and what it
// structurally cannot show.
//
// The problem being solved: a teammate's session arrives with no checkpoint
// trail and no commit count, and the page renders that exactly like a session
// that genuinely had neither. The reader cannot tell "MemBridge doesn't have
// this" from "this didn't happen", so an agent's whole run reads as idle time.
// The worst case is 'earlier-activity', where a session whose earliest rows
// have not been backfilled renders as a complete, short session -- a truncated
// history read as the whole story.
//
// Three rules govern everything here:
//
//  1. NOT AN ERROR. No warning glyph, no alarm colour, no amber. A teammate's
//     session legitimately has no checkpoints and nothing is wrong. This is a
//     statement of origin, in the same quiet register as the back link. (The
//     Insights truncation banner had to be rewritten for exactly this: it
//     opened with the glyph that everywhere else in the app means "broken and
//     wants your hands", so its first reading was "Insights is broken".)
//  2. NO INTERNALS. 'team-cache' and 'team-archive' are our words for our
//     storage layout. The reader's distinction is "from my machine" vs "from
//     my team", so both team origins render the SAME sentence. The one thing
//     that actually differs -- an archive can be incomplete -- reaches the
//     reader as its consequence (the earlier-activity line, next to the times
//     it undermines) rather than as the name of a store.
//  3. ABSENT SAYS NOTHING. A payload without these fields (older daemon, or a
//     response cached before they existed) renders exactly as it did before
//     this existed. Absent is not 'local-events' and not "unknown origin".
//     mapSession already drops unrecognized values, so this file only ever
//     sees a value it has a sentence for.

/** The origin sentences. Two, not three: see rule 2 above. */
export const ORIGIN_LOCAL = 'Recorded on this machine, from your own activity.'
export const ORIGIN_TEAM = 'Shared with you by your team — this is the copy that reached your machine.'

/** Named where the reader would otherwise read absence as inactivity. */
export const MISSING_CHECKPOINTS =
  'This copy has no checkpoints: the step-by-step notes stay on the machine that ran the session.'
export const MISSING_EARLIER_ACTIVITY =
  'The earliest part of this session may not have reached your machine yet, so it may have started before the time shown.'

/** The Commits tile's stand-in when the count is named as unavailable. Two
 *  strings because the payload carries two different facts: on a team copy the
 *  count is structurally absent and always will be, while on a local one the
 *  commit map could not be read and the next load may well succeed. Both beat
 *  the tile's default "not captured", which asserts that nothing was found. */
export const COMMITS_NOT_IN_COPY = 'not in this copy'
export const COMMITS_NOT_COUNTED = "couldn't be counted"

/** True when the daemon NAMED this thing as missing from this copy. False for
 *  a payload that carries no `unavailable` at all -- absence of the field is
 *  not evidence of presence or of absence, and the caller renders nothing. */
export function isMissing(session: Session, what: SessionMissing): boolean {
  return Array.isArray(session.unavailable) && session.unavailable.includes(what)
}

/** The origin sentence, or null when the payload did not say. */
export function originSentence(session: Session): string | null {
  if (session.heldBy === 'local-events') return ORIGIN_LOCAL
  if (session.heldBy === 'team-cache' || session.heldBy === 'team-archive') return ORIGIN_TEAM
  return null
}

/** The Commits tile's wording when the count is unavailable, or null when the
 *  payload never named it -- in which case the tile keeps its own "not
 *  captured", which is the honest thing to say about a count nobody claimed. */
export function commitsMissingLabel(session: Session): string | null {
  if (!isMissing(session, 'commits')) return null
  return session.heldBy === 'local-events' ? COMMITS_NOT_COUNTED : COMMITS_NOT_IN_COPY
}

/** Origin, plus the truncation warning when the copy may be missing the start
 *  of the run. Sits directly under the meta row, so the earlier-activity line
 *  lands next to the start/end times it qualifies.
 *
 *  Renders nothing at all when the payload said nothing. */
export function SessionProvenance({ session }: { session: Session }) {
  const origin = originSentence(session)
  const truncated = isMissing(session, 'earlier-activity')
  if (!origin && !truncated) return null
  return (
    <div className="session-provenance">
      {origin && (
        <p className="session-provenance-line" data-testid="session-origin">{origin}</p>
      )}
      {truncated && (
        <p className="session-provenance-line" data-testid="session-earlier-activity">
          {MISSING_EARLIER_ACTIVITY}
        </p>
      )}
    </div>
  )
}

/** The checkpoint note, in the slot where the distilled bullets render.
 *
 *  That slot, not the prompt chain: the chain is a <details> folded shut on
 *  load, and a note nobody can see is worse than no note -- it lets us believe
 *  we told them. The bullets are this page's checkpoint trail (distill.ts
 *  builds them from session.checkpoints and silently falls back to key-file
 *  notes when there are none), so this is where absence currently reads as
 *  "the agent worked without recording anything".
 *
 *  Guarded on an EMPTY trail. A payload that both names checkpoints as missing
 *  and carries some contradicts itself, and a denial printed next to visible
 *  data would make this feature a new way to lie. */
export function MissingCheckpointsNote({ session }: { session: Session }) {
  if (!isMissing(session, 'checkpoints')) return null
  if (session.checkpoints.length > 0) return null
  return (
    <p className="session-missing-note" data-testid="session-missing-checkpoints">
      {MISSING_CHECKPOINTS}
    </p>
  )
}
