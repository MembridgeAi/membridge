import { useEffect, useRef, useState } from 'react'
import { Link } from 'wouter'
import { Avatar } from './Avatar'
import { sessionHref } from '../app/routes'
import { relativeAgo } from '../data/relativeTime'
import type { StreamEntry } from '../data/types'

// The viewer's own wall clock (no timeZone option, so the browser's resolved
// zone wins) -- same reasoning as SyncStateView's shortStamp. Pinned to UTC,
// a 7pm session read "2:00 AM" to the person who had just run it.
function clockTime(at: string): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/** Hover-preview delay (spec: ~400ms -- long enough that scrubbing the list
 *  never flashes cards, short enough to answer "is this worth opening"). */
export const HOVER_PREVIEW_DELAY_MS = 400

// "2 files · +129 -14" -- the preview's one-line diffstat. Null when the
// entry has no files (nothing to preview on that line).
function diffstatLine(e: StreamEntry): string | null {
  if (e.files.length === 0) return null
  const files = e.files.length === 1 ? '1 file' : `${e.files.length} files`
  let add = 0
  let del = 0
  for (const c of e.changes) {
    if (c.add !== null) add += c.add
    if (c.del !== null) del += c.del
  }
  if (add === 0 && del === 0) return files
  return `${files} · +${add} -${del}`
}

interface EntryRowProps {
  entry: StreamEntry
  /** The entry's project, display name only -- passed by a cross-project
   *  context (Feed) so each row says which project it happened in. A
   *  single-project context (ProjectPage) omits it: the project is already
   *  the page you're on, so repeating its name on every row is noise. */
  project?: string
  /** Solo mode has exactly one person, so an avatar (a "who" signal) has
   *  nothing to distinguish -- absent, not disabled/greyed. Defaults true
   *  for every existing single-project caller. */
  showAvatar?: boolean
}

/** The row's unchanged anatomy, shared by both shells below (link and plain
 *  div) so becoming a link changed the wrapper, never the contents. */
function EntryRowBody({ entry, project, showAvatar }: Required<Pick<EntryRowProps, 'entry' | 'showAvatar'>> & { project?: string }) {
  return (
    <>
      <span className="entry-row-avatar-cell">
        {showAvatar && <Avatar id={entry.authorId} name={entry.author} size={19} />}
      </span>
      <span className="entry-row-who-cell">
        <span className="entry-row-who">{entry.author}</span>
        <span className="entry-row-tool">
          {entry.tool}
          {project && <> · <span className="mono">{project}</span></>}
          {' · '}{relativeAgo(entry.at, { justNow: 'now' })}
        </span>
      </span>
      <span className="mono entry-row-meta">
        {entry.live ? (
          <>live <span className="live-dot" role="img" aria-label="Live" /></>
        ) : clockTime(entry.at)}
      </span>
      {/* Fix 17: outcomeOf falls back to '' for an undistilled session --
          say so mutedly rather than rendering an empty element. No em dash;
          the row's timestamp already says when it happened. */}
      {entry.outcome
        ? <div className="entry-row-outcome">{entry.outcome}</div>
        : <div className="entry-row-outcome entry-row-outcome-empty">No summary yet</div>}
      {entry.intent && (
        <div className="entry-row-intent">
          <span className="entry-row-intent-label">Intent</span>
          {entry.intent}
        </div>
      )}
      {entry.files.length > 0 && (
        <div className="mono entry-row-files">{entry.files.join(' · ')}</div>
      )}
    </>
  )
}

/** The hover preview card (spec Level 1.5): the FULL outcome (summaryFull,
 *  unclipped), the first line of decisions, and the file count + diffstat.
 *  Preview, not navigation -- aria-hidden, nothing focusable, and all of its
 *  content exists on the session page it previews. CSS additionally gates it
 *  behind `(hover: hover)`, so a touch device never sees it even if a
 *  synthetic mouseenter fires. */
function HoverPreview({ entry }: { entry: StreamEntry }) {
  const outcome = entry.summaryFull || entry.outcome
  const whyLine = entry.decisions ? entry.decisions.split('\n')[0] : null
  const diffstat = diffstatLine(entry)
  return (
    <div className="entry-row-preview" aria-hidden="true">
      {outcome && <div className="entry-row-preview-outcome">{outcome}</div>}
      {whyLine && <div className="entry-row-preview-why">{whyLine}</div>}
      {diffstat && <div className="mono entry-row-preview-diffstat">{diffstat}</div>}
    </div>
  )
}

/** One merged-stream row, shared by the Feed (cross-project) and the
 *  project page (single-project) so the two never drift: author [+
 *  project] + tool + relative time, a live indicator or absolute clock
 *  time on the right, the outcome in full, a muted INTENT line (the
 *  captured ask verbatim, never inferred), and files in mono.
 *
 *  A row WITH a session is a real <a> to the session route (middle-click
 *  and cmd-click must open a new window, so never a click handler on a
 *  div), with a `›` affordance and a pointer-only hover preview. A
 *  session-less row (bare plumbing) keeps the non-interactive markup --
 *  there is no page to link to. Nothing expands inside the feed; the row's
 *  height is invariant (the preview is absolutely positioned). */
export function EntryRow({ entry, project, showAvatar = true }: EntryRowProps) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  // Escape dismisses an open preview (document-level: the preview itself is
  // never focusable, so the key lands wherever focus happens to be).
  useEffect(() => {
    if (!previewOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreviewOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [previewOpen])

  useEffect(() => clearTimer, [])

  if (!entry.session) {
    return (
      <div className="entry-row">
        <EntryRowBody entry={entry} project={project} showAvatar={showAvatar} />
      </div>
    )
  }

  // Pointer-only: scheduled from mouseenter, never from focus -- a keyboard
  // user gets the route itself, which is the real content anyway.
  const onMouseEnter = () => {
    clearTimer()
    timer.current = setTimeout(() => setPreviewOpen(true), HOVER_PREVIEW_DELAY_MS)
  }
  const onMouseLeave = () => {
    clearTimer()
    setPreviewOpen(false)
  }

  return (
    <Link
      href={sessionHref(entry.session)}
      className="entry-row entry-row-link"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <EntryRowBody entry={entry} project={project} showAvatar={showAvatar} />
      <span className="entry-row-affordance" aria-hidden="true">›</span>
      {previewOpen && <HoverPreview entry={entry} />}
    </Link>
  )
}
