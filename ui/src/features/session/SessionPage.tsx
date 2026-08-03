import { useState } from 'react'
import { Link } from 'wouter'
import { Avatar } from '../../components/Avatar'
import { ROUTES } from '../../app/routes'
import { relativeAgo } from '../../data/relativeTime'
import { useSession } from '../../data/queries'
import type { Session } from '../../data/types'
import { BriefWidgets } from './BriefWidgets'
import { PromptChain } from './PromptChain'
import { SessionAnalytics, durationLabel } from './SessionAnalytics'
import { distilledBullets, shortIntent } from './distill'
import './session.css'

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

/** The intent line. Whole prompts used to render here verbatim, which pushed
 *  everything below them off the screen -- so the line is clipped to one line
 *  and grows a disclosure ONLY when something was actually cut. A short intent
 *  renders exactly as before, with no control attached to it. */
function IntentLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const short = shortIntent(text)
  return (
    <div className={`session-intent${open ? ' session-intent-open' : ''}`}>
      <span className="session-intent-label">Intent</span>
      <span className="session-intent-text">{open ? text : short.text}</span>
      {short.clipped && (
        <button
          type="button"
          className="session-intent-toggle"
          aria-expanded={open}
          onClick={() => setOpen(v => !v)}
        >
          {open ? 'Show less' : 'Show full intent'}
        </button>
      )}
    </div>
  )
}

/** The distilled one-liners, between the summary and the raw prompts. Absent
 *  entirely when nothing was distilled -- absence is communicated by absence,
 *  the same rule BriefWidgets follows. */
function Bullets({ items }: { items: string[] }) {
  if (items.length === 0) return null
  return (
    <ul className="session-bullets">
      {items.map(text => <li key={text} className="session-bullet">{text}</li>)}
    </ul>
  )
}

interface SessionPageProps {
  sessionId: string
}

/** The session detail page (/sessions/:sessionId). Order, top to bottom:
 *  back button, analytics header, the one-to-two sentence summary, the
 *  distilled one-liners, the brief widgets, then the raw prompts newest-first. */
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
  const bullets = distilledBullets(s)

  return (
    <div className="session-page">
      {/* The way back, on the normal page and not only the not-found branch. */}
      <Link href={ROUTES.feed} className="session-back">
        <span className="session-back-chevron" aria-hidden="true">‹</span>
        Back to the Feed
      </Link>
      <Eyebrow s={s} />
      <SessionAnalytics session={s} />
      <h1 className="session-header">{header}</h1>
      {intent && <IntentLine text={intent} />}
      <MetaRow s={s} />
      <Bullets items={bullets} />
      <BriefWidgets session={s} />
      <PromptChain prompts={s.prompts} checkpoints={s.checkpoints} />
    </div>
  )
}
