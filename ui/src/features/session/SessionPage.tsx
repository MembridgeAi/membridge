import { Link } from 'wouter'
import { Avatar } from '../../components/Avatar'
import { ROUTES } from '../../app/routes'
import { relativeAgo } from '../../data/relativeTime'
import { useSession } from '../../data/queries'
import type { Session } from '../../data/types'

// ---------------------------------------------------------------------------
// Pure header helpers, exported for tests.
// ---------------------------------------------------------------------------

/** The header is summaryFull CLIPPED TO TWO SENTENCES (locked decision:
 *  `headline` stays the feed's outcome line, the page header is the summary).
 *  Sentence-boundary split, defensive: text with no terminal punctuation, or
 *  fewer sentences than the cap, passes through whole. */
export function firstSentences(text: string, max: number): string {
  const sentences = text.match(/[^.!?]*[.!?]+["')\]]*\s*/g)
  if (!sentences || sentences.length <= max) return text.trim()
  return sentences.slice(0, max).join('').trim()
}

/** "3h 12m" / "42m" / "under a minute" -- or null when either timestamp is
 *  missing/unparseable or the range is negative (clock skew): the eyebrow
 *  omits the duration rather than rendering NaN. */
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

// The viewer's own wall clock, explicit locale (the suite pins TZ; every
// toLocale* call passes 'en-US' so formatting never varies by machine).
function clockTime(at: string): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

// Intent rule, same precedence the feed uses (mappers.ts intentOf): the
// captured goal first, the session's OPENING ask (oldest prompt -- prompts
// are newest-first) as fallback, nothing when neither was captured.
function sessionIntent(s: Session): string | null {
  if (s.goal) return s.goal
  const opening = s.prompts[s.prompts.length - 1]
  return (opening && opening.ask) || null
}

function Eyebrow({ s }: { s: Session }) {
  if (s.live) {
    return (
      <div className="mono session-eyebrow">
        Session · live <span className="live-dot" role="img" aria-label="Live" />
      </div>
    )
  }
  const duration = durationLabel(s.startedAt, s.endedAt)
  return (
    <div className="mono session-eyebrow">
      Session
      {s.endedAt && <> · finished {relativeAgo(s.endedAt)}</>}
      {duration && <> · {duration}</>}
    </div>
  )
}

function MetaRow({ s }: { s: Session }) {
  const promptCount = s.prompts.length
  return (
    <div className="session-meta">
      <Avatar id={s.authorId || s.author} name={s.author} size={19} />
      <span className="session-meta-author">{s.author}</span>
      <span className="session-meta-tool">{s.source}</span>
      {s.project && <span className="mono session-meta-project">{s.project}</span>}
      {s.startedAt && s.endedAt && (
        <span className="mono session-meta-times">{clockTime(s.startedAt)} to {clockTime(s.endedAt)}</span>
      )}
      <span className="session-meta-prompts">{promptCount === 1 ? '1 prompt' : `${promptCount} prompts`}</span>
    </div>
  )
}

interface SessionPageProps {
  sessionId: string
}

/** The session detail page (/sessions/:sessionId). Task 3 shell: eyebrow +
 *  header (summaryFull, 2 sentences) + Intent + meta row; widgets and the
 *  prompt chain land in their own tasks. */
export function SessionPage({ sessionId }: SessionPageProps) {
  const query = useSession(sessionId)

  if (query.isError) {
    return (
      <div className="session-page">
        <p className="session-error" role="alert">
          Couldn't load this session. {query.error instanceof Error ? query.error.message : 'Unknown error'}
        </p>
      </div>
    )
  }

  if (query.isLoading) return <div className="session-page" />

  const s = query.data
  // null is the daemon's honest 404: evicted from memory or never existed.
  // A plain state with a way back -- never a blank screen, never a redirect.
  if (!s) {
    return (
      <div className="session-page">
        <p className="session-gone">This session isn't in memory anymore.</p>
        <Link href={ROUTES.feed} className="session-gone-link">Back to the Feed</Link>
      </div>
    )
  }

  const header = s.summaryFull ? firstSentences(s.summaryFull, 2) : (s.summary || 'No summary yet')
  const intent = sessionIntent(s)

  return (
    <div className="session-page">
      <Eyebrow s={s} />
      <h1 className="session-header">{header}</h1>
      {intent && (
        <div className="session-intent">
          <span className="session-intent-label">Intent</span>
          {intent}
        </div>
      )}
      <MetaRow s={s} />
    </div>
  )
}
