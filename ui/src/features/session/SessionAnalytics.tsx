import type { ReactNode } from 'react'
import type { Session } from '../../data/types'
import { commitsMissingLabel } from './provenance'

// The session page's analytics header: four tiles, fixed order.
//
//   Files touched  -- the count, plus the top 3 by edit frequency
//   Lines          -- +added / -deleted across the session's changes
//   Commits        -- commits the session produced
//   Duration       -- wall-clock start to end
//
// DELIBERATELY EXCLUDED: survival rate. churn's own docs call it a rework
// signal that must never become a target, and a per-session page is exactly
// where it would become one. Do not add it.
//
// Every tile degrades to a muted dash when its input is absent. A tile never
// renders NaN, and never renders 0 for "not measured" -- an uncounted diff
// (binary, rename, no repo) and a real zero-line session are different facts.

export interface FileTouch {
  file: string
  /** How many prompts of the session touched this file. 0 means the frequency
   *  was not observable (no prompt carried a file list), NOT "never touched". */
  count: number
}

/** How many distinct files the session touched. `files[]` is the daemon's own
 *  union across the session's entries; `changes[]` is the fallback for a
 *  payload that carried a change model but no file union. */
export function filesTouched(session: Session): number {
  const files = Array.isArray(session.files) ? session.files : []
  if (files.length > 0) return files.length
  const changes = Array.isArray(session.changes) ? session.changes : []
  return new Set(changes.map(c => c.file)).size
}

/** The top `limit` files by edit frequency, counted over the session's prompts
 *  (each prompt carries the files it touched). Ties keep first-seen order, so
 *  the list is stable across renders. When no prompt carried a file list, the
 *  session's file union is used instead with a count of 0 -- the tile still
 *  names the files, and never claims a frequency it did not measure. */
export function topFilesByEditFrequency(session: Session, limit = 3): FileTouch[] {
  const counts = new Map<string, number>()
  const prompts = Array.isArray(session.prompts) ? session.prompts : []
  for (const p of prompts) {
    for (const f of (Array.isArray(p.files) ? p.files : [])) {
      if (!f) continue
      counts.set(f, (counts.get(f) || 0) + 1)
    }
  }
  if (counts.size > 0) {
    return [...counts.entries()]
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
  }
  const files = Array.isArray(session.files) ? session.files : []
  return files.slice(0, limit).map(file => ({ file, count: 0 }))
}

/** Added and deleted lines across the session's changes. `counted` is false
 *  when nothing was countable -- every add/del null (binary, rename, no repo)
 *  or no changes at all -- so the tile can say "not counted" instead of "0". */
export function lineTotals(session: Session): { add: number; del: number; counted: boolean } {
  let add = 0
  let del = 0
  let counted = false
  const changes = Array.isArray(session.changes) ? session.changes : []
  for (const c of changes) {
    if (c && typeof c.add === 'number' && Number.isFinite(c.add)) { add += c.add; counted = true }
    if (c && typeof c.del === 'number' && Number.isFinite(c.del)) { del += c.del; counted = true }
  }
  return counted ? { add, del, counted } : { add: 0, del: 0, counted: false }
}

/** Commits the session produced, or null when the daemon did not serve the
 *  field -- which is every team-origin payload (attribution is computed from
 *  this machine's commit map) and any local one whose commit map could not be
 *  read. Anything that is not a non-negative integer is treated as absent
 *  rather than coerced. */
export function commitsProduced(session: Session): number | null {
  const n = session.commits
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
  return Math.floor(n)
}

/** "3h 12m" / "42m" / "under a minute" -- or null when either timestamp is
 *  missing/unparseable or the range is negative (clock skew): the caller omits
 *  the duration rather than rendering NaN. */
export function durationLabel(startedAt: string | null, endedAt: string | null): string | null {
  if (!startedAt || !endedAt) return null
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  const minutes = Math.floor((end - start) / 60_000)
  if (minutes < 1) return 'under a minute'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** The muted stand-in for a tile whose input is absent. Words, never a zero:
 *  "not measured" and "measured as none" are different facts, and a glyph
 *  leaves the reader guessing which one they are looking at. */
function Empty() {
  return <span className="session-tile-empty">not captured</span>
}

/** The stand-in for a tile whose input is absent FOR A STATED REASON (this
 *  copy of the session never carried it). Same muted register as Empty -- it
 *  is provenance, not a fault -- but different words, because "not captured"
 *  and "not in this copy" are different facts. */
function Unavailable({ text }: { text: string }) {
  return <span className="session-tile-empty" data-testid="session-tile-commits-unavailable">{text}</span>
}

function Tile({ label, children, detail }: { label: string; children: ReactNode; detail?: ReactNode }) {
  return (
    <div className="session-tile">
      <span className="session-tile-label">{label}</span>
      <span className="session-tile-value">{children}</span>
      {detail && <span className="session-tile-detail">{detail}</span>}
    </div>
  )
}

export function SessionAnalytics({ session }: { session: Session }) {
  const fileCount = filesTouched(session)
  const topFiles = topFilesByEditFrequency(session)
  const lines = lineTotals(session)
  const commits = commitsProduced(session)
  const missingCommits = commitsMissingLabel(session)
  const duration = durationLabel(session.startedAt, session.endedAt)

  return (
    <div className="session-analytics">
      <Tile
        label="Files touched"
        detail={topFiles.length > 0 && (
          <span className="session-tile-files">
            {topFiles.map(f => (
              <span key={f.file} className="mono session-tile-file">
                {f.file}
                {f.count > 1 && <span className="session-tile-file-count">{`×${f.count}`}</span>}
              </span>
            ))}
          </span>
        )}
      >
        {fileCount > 0 ? fileCount : <Empty />}
      </Tile>

      <Tile label="Lines">
        {lines.counted ? (
          <>
            <span className="session-tile-add">{`+${lines.add}`}</span>
            {' '}
            <span className="session-tile-del">{`-${lines.del}`}</span>
          </>
        ) : <Empty />}
      </Tile>

      <Tile label="Commits">
        {/* Three states, not two. "not captured" is the tile's own default and
            asserts that nothing was found -- true only when nobody said
            otherwise. When the daemon NAMES commits as unavailable, the
            absence has a reason and the tile states it instead. Reached only
            in the branch that was already empty, so a payload that contradicts
            itself never prints a denial next to a real count. */}
        {commits === null ? (missingCommits ? <Unavailable text={missingCommits} /> : <Empty />) : commits}
      </Tile>

      <Tile label="Duration">
        {/* A live session has no end yet -- say "live" rather than measuring
            to a timestamp that is still moving. */}
        {session.live ? 'live' : (duration || <Empty />)}
      </Tile>
    </div>
  )
}
