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

/** How many file paths the row names before collapsing to a count. A single
 *  live row carried 16 paths, wrapping to three lines of mono text that
 *  out-shouted the outcome above it -- the blast radius is a glance signal,
 *  not an inventory (the session page lists them all). */
export const ROW_FILE_LIMIT = 3

/** Longest path shown whole. Past this the leading directories are dropped:
 *  a row's paths are clipped from the RIGHT by CSS, which eats the filename --
 *  the one part that identifies the file. Live paths run to 90+ characters
 *  (a worktree checkout nests the repo several levels deep), so without this
 *  every long path renders as an indistinguishable prefix. */
export const PATH_MAX = 34

/** Drop leading directories until the path fits, keeping the last two
 *  segments at minimum -- "…/search/snippet.ts" says more than
 *  ".claude/worktrees/prompt-sharing-mcp-visibility-26de91/ui/src/fe…". */
export function shortPath(file: string): string {
  if (file.length <= PATH_MAX) return file
  const parts = file.split('/')
  if (parts.length <= 2) return file
  let kept = parts.slice(-2)
  // Add back as many parent directories as still fit.
  for (let i = parts.length - 3; i >= 0; i--) {
    const candidate = [parts[i], ...kept]
    if (`…/${candidate.join('/')}`.length > PATH_MAX) break
    kept = candidate
  }
  return `…/${kept.join('/')}`
}

/** Rank the files a row names: source before the docs/specs/CI churn that
 *  tends to dominate a planning-heavy session, then shortest path first so
 *  the three shown are the most legible. Pure -- never mutates the input. */
const SUPPORTING = /^(docs?|specs?|\.github|\.claude|claude)\//
export function rowFiles(files: string[]): { shown: string[]; more: number } {
  const ranked = [...files].sort((a, b) => {
    const aSupporting = SUPPORTING.test(a) ? 1 : 0
    const bSupporting = SUPPORTING.test(b) ? 1 : 0
    if (aSupporting !== bSupporting) return aSupporting - bSupporting
    return a.length - b.length
  })
  return { shown: ranked.slice(0, ROW_FILE_LIMIT), more: Math.max(0, ranked.length - ROW_FILE_LIMIT) }
}

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
  /** This row is the one a Today card sent the reader to (FeedPage reads
   *  ?session=). Marks it and scrolls it into view. Purely presentational:
   *  a miss is a plain false, never an error, because the feed is paged and
   *  the target may sit past the pages that are loaded. */
  targeted?: boolean
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
      {entry.files.length > 0 && (() => {
        const { shown, more } = rowFiles(entry.files)
        // The count sits OUTSIDE the clipped element: inside it, a row with
        // three long paths clips the very thing that says how much is hidden.
        return (
          <div className="entry-row-files">
            <span className="mono entry-row-files-list">{shown.map(shortPath).join(' · ')}</span>
            {more > 0 && <span className="entry-row-files-more">+{more} more</span>}
          </div>
        )
      })()}
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
export function EntryRow({ entry, project, showAvatar = true, targeted = false }: EntryRowProps) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rowRef = useRef<HTMLAnchorElement | null>(null)

  // Bring the targeted row into view once it exists. Guarded: jsdom and
  // older engines have no scrollIntoView, and a missing one must not throw
  // into the render path.
  useEffect(() => {
    if (!targeted || !rowRef.current) return
    if (typeof rowRef.current.scrollIntoView !== 'function') return
    rowRef.current.scrollIntoView({ block: 'center' })
  }, [targeted])

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
    // `entry-row-previewing` is what keeps the open card on top. Every row
    // keeps `transform: translateY(0)` after its settle-in animation (fill
    // mode `both`), and a non-none transform makes the row its own stacking
    // context -- which traps the card's own z-index inside the row, so the
    // next row down painted its opaque background straight over the card.
    // Raising the ROW is the only thing that escapes that, and it is scoped to
    // while a preview is actually open so the feed's paint order is otherwise
    // untouched.
    <Link
      ref={rowRef}
      href={sessionHref(entry.session)}
      className={`entry-row entry-row-link${previewOpen ? ' entry-row-previewing' : ''}${targeted ? ' entry-row-targeted' : ''}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <EntryRowBody entry={entry} project={project} showAvatar={showAvatar} />
      <span className="entry-row-affordance" aria-hidden="true">›</span>
      {previewOpen && <HoverPreview entry={entry} />}
    </Link>
  )
}
