import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import {
  COMMITS_NOT_COUNTED, COMMITS_NOT_IN_COPY, MISSING_CHECKPOINTS, MISSING_EARLIER_ACTIVITY,
  MissingCheckpointsNote, ORIGIN_LOCAL, ORIGIN_TEAM, SessionProvenance,
  commitsMissingLabel, isMissing, originSentence,
} from './provenance'
import type { Session } from '../../data/types'

const session = (overrides: Partial<Session> = {}): Session => ({
  session: 's1', project: 'membridge', projectPath: '/x/membridge',
  author: 'Jamal', authorId: 'jamal', source: 'Claude Code',
  startedAt: '2026-07-29T19:00:00Z', endedAt: '2026-07-29T20:30:00Z', live: false,
  summary: 'done', summaryFull: 'done', goal: null, headline: null,
  decisions: null, gotchas: null,
  files: ['lib/util.js'],
  changes: [],
  checkpoints: [],
  prompts: [{ ts: '2026-07-29T19:00:00Z', ask: 'do the thing', files: [] }],
  ...overrides,
})

afterEach(cleanup)

// The words themselves are the deliverable here, so they are asserted
// literally in one place. A copy change should show up as a test change a
// human can read and veto, not slip through because every assertion compared
// the constant to itself.
describe('the copy, verbatim', () => {
  it('says where the copy came from without naming our stores', () => {
    expect(ORIGIN_LOCAL).toBe('Recorded on this machine, from your own activity.')
    expect(ORIGIN_TEAM).toBe('Shared with you by your team — this is the copy that reached your machine.')
    // Our words for our storage layout must never reach the reader.
    for (const line of [ORIGIN_LOCAL, ORIGIN_TEAM, MISSING_CHECKPOINTS, MISSING_EARLIER_ACTIVITY]) {
      expect(line).not.toMatch(/cache|archive|local-events|backfill|payload|sync/i)
    }
  })

  it('states each absence as a property of this copy, not as an absence of work', () => {
    expect(MISSING_CHECKPOINTS).toBe(
      'This copy has no checkpoints: the step-by-step notes stay on the machine that ran the session.',
    )
    expect(MISSING_EARLIER_ACTIVITY).toBe(
      'The earliest part of this session may not have reached your machine yet, so it may have started before the time shown.',
    )
    expect(COMMITS_NOT_IN_COPY).toBe('not in this copy')
    expect(COMMITS_NOT_COUNTED).toBe("couldn't be counted")
  })
})

describe('originSentence', () => {
  it('names your own machine for a local session', () => {
    expect(originSentence(session({ heldBy: 'local-events' }))).toBe(ORIGIN_LOCAL)
  })

  // The locked decision: cache and archive are OUR storage layout and the
  // reader cannot act on which one answered, so they say the same thing. What
  // actually differs between them -- an archive can be incomplete -- surfaces
  // as the earlier-activity line instead.
  it('says the same thing for both team origins', () => {
    expect(originSentence(session({ heldBy: 'team-cache' }))).toBe(ORIGIN_TEAM)
    expect(originSentence(session({ heldBy: 'team-archive' }))).toBe(ORIGIN_TEAM)
  })

  it('says NOTHING when the payload carried no origin', () => {
    expect(originSentence(session())).toBeNull()
  })
})

describe('isMissing', () => {
  it('is true only for a thing the daemon actually named', () => {
    const s = session({ unavailable: ['checkpoints'] })
    expect(isMissing(s, 'checkpoints')).toBe(true)
    expect(isMissing(s, 'commits')).toBe(false)
    expect(isMissing(s, 'earlier-activity')).toBe(false)
  })

  it('is false for every member when the field is absent entirely', () => {
    const s = session()
    expect(isMissing(s, 'checkpoints')).toBe(false)
    expect(isMissing(s, 'commits')).toBe(false)
    expect(isMissing(s, 'earlier-activity')).toBe(false)
  })
})

describe('commitsMissingLabel', () => {
  // Two different facts: a team copy will never carry the count, while a local
  // one failed to read the commit map and the next load may succeed.
  it('distinguishes a structural absence from a failed read', () => {
    expect(commitsMissingLabel(session({ heldBy: 'team-cache', unavailable: ['commits'] })))
      .toBe(COMMITS_NOT_IN_COPY)
    expect(commitsMissingLabel(session({ heldBy: 'team-archive', unavailable: ['commits'] })))
      .toBe(COMMITS_NOT_IN_COPY)
    expect(commitsMissingLabel(session({ heldBy: 'local-events', unavailable: ['commits'] })))
      .toBe(COMMITS_NOT_COUNTED)
  })

  it('claims nothing when the payload never named commits', () => {
    expect(commitsMissingLabel(session({ heldBy: 'local-events', unavailable: [] }))).toBeNull()
    expect(commitsMissingLabel(session())).toBeNull()
  })
})

describe('<SessionProvenance />', () => {
  it('renders the local origin line', () => {
    render(<SessionProvenance session={session({ heldBy: 'local-events', unavailable: [] })} />)
    expect(screen.getByTestId('session-origin')).toHaveTextContent(ORIGIN_LOCAL)
    expect(screen.queryByTestId('session-earlier-activity')).toBeNull()
  })

  it('renders the team origin line for a cached teammate session', () => {
    render(<SessionProvenance session={session({ heldBy: 'team-cache', unavailable: ['checkpoints', 'commits'] })} />)
    expect(screen.getByTestId('session-origin')).toHaveTextContent(ORIGIN_TEAM)
    // A cached copy holds the whole session it holds -- it must not claim the
    // history might be truncated.
    expect(screen.queryByTestId('session-earlier-activity')).toBeNull()
  })

  it('warns that the history may be partial when the archive has not backfilled', () => {
    render(<SessionProvenance session={session({
      heldBy: 'team-archive', unavailable: ['checkpoints', 'commits', 'earlier-activity'],
    })} />)
    expect(screen.getByTestId('session-origin')).toHaveTextContent(ORIGIN_TEAM)
    expect(screen.getByTestId('session-earlier-activity')).toHaveTextContent(MISSING_EARLIER_ACTIVITY)
  })

  // The absent case. An older daemon, or a response cached before these fields
  // existed, must render EXACTLY as it did before this feature -- absent is
  // not 'local-events', and it is not "unknown origin" either.
  it('renders nothing at all when the payload carried neither field', () => {
    const { container } = render(<SessionProvenance session={session()} />)
    expect(container).toBeEmptyDOMElement()
  })

  // Not an error state: no glyph, no alarm role. Everywhere else in this app a
  // warning mark means something is broken and wants the reader's hands, and
  // nothing here is broken.
  it('is a quiet statement, never an alert', () => {
    render(<SessionProvenance session={session({ heldBy: 'team-archive', unavailable: ['earlier-activity'] })} />)
    expect(screen.queryByRole('alert')).toBeNull()
    const text = screen.getByTestId('session-origin').textContent || ''
    expect(text).not.toMatch(/[⚠!]/)
  })
})

describe('<MissingCheckpointsNote />', () => {
  it('says the checkpoints are not in this copy', () => {
    render(<MissingCheckpointsNote session={session({
      heldBy: 'team-cache', unavailable: ['checkpoints', 'commits'],
    })} />)
    expect(screen.getByTestId('session-missing-checkpoints')).toHaveTextContent(MISSING_CHECKPOINTS)
  })

  it('renders nothing for a session that simply has no checkpoints and no claim about them', () => {
    const { container } = render(<MissingCheckpointsNote session={session({ heldBy: 'local-events', unavailable: [] })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the payload carried neither field', () => {
    const { container } = render(<MissingCheckpointsNote session={session()} />)
    expect(container).toBeEmptyDOMElement()
  })

  // The self-contradicting payload. A denial printed next to visible data is
  // this feature becoming a new way to lie, so the visible data wins.
  it('stays silent when the copy DOES carry checkpoints, whatever the payload claims', () => {
    const { container } = render(<MissingCheckpointsNote session={session({
      heldBy: 'team-archive',
      unavailable: ['checkpoints'],
      checkpoints: [{ ts: '2026-07-29T19:30:00Z', text: 'Gate extracted; stop path green.' }],
    })} />)
    expect(container).toBeEmptyDOMElement()
  })
})
