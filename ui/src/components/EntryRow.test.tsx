import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { EntryRow, HOVER_PREVIEW_DELAY_MS } from './EntryRow'
import { sessionHref } from '../app/routes'
import type { StreamEntry } from '../data/types'

const entry = (overrides: Partial<StreamEntry> = {}): StreamEntry => ({
  id: 'e1',
  author: 'Andrew',
  authorId: 'andrew',
  tool: 'Codex',
  at: '2026-07-29T19:00:00Z',
  live: false,
  outcome: 'Hook ownership now decided by durability, not who ran last.',
  intent: 'make the summary hook fire on session boundaries',
  files: ['lib/hooks.js'],
  session: 's1',
  summaryFull: null,
  decisions: null,
  gotchas: null,
  changes: [],
  ...overrides,
})

describe('EntryRow', () => {
  it('leads with the outcome and shows the captured ask as a muted Intent line', () => {
    render(<EntryRow entry={entry()} />)
    expect(screen.getByText(/Hook ownership now decided by durability/)).toBeInTheDocument()
    expect(screen.getByText('Intent')).toBeInTheDocument()
    expect(screen.getByText(/make the summary hook fire on session boundaries/)).toBeInTheDocument()
  })

  it('renders touched files in mono', () => {
    render(<EntryRow entry={entry()} />)
    const files = screen.getByText('lib/hooks.js')
    expect(files.className).toContain('mono')
  })

  // The suite is pinned to America/Los_Angeles (vite.config.ts, test.env.TZ),
  // so the clock stamp must read as that viewer's wall clock, not UTC's.
  // \s covers the narrow no-break space ICU puts before AM/PM.
  it('renders the clock stamp in the viewer\'s local zone, not UTC', () => {
    render(<EntryRow entry={entry({ at: '2026-07-29T19:00:00Z' })} />)
    expect(screen.getByText(/12:00\s*PM/)).toBeInTheDocument()
    expect(screen.queryByText(/7:00\s*PM/)).toBeNull()
  })

  it('keeps an evening entry in the evening after UTC has rolled to the next day', () => {
    // 02:00Z Jul 30 is 19:00 Jul 29 locally. Formatting in UTC showed a
    // 7pm session as "2:00 AM" -- the wrong time AND the wrong day.
    render(<EntryRow entry={entry({ at: '2026-07-30T02:00:00Z' })} />)
    expect(screen.getByText(/7:00\s*PM/)).toBeInTheDocument()
    expect(screen.queryByText(/2:00\s*AM/)).toBeNull()
  })

  it('marks a still-running entry instead of showing a clock time', () => {
    render(<EntryRow entry={entry({ live: true, outcome: '' })} />)
    expect(screen.getByLabelText('Live')).toBeInTheDocument()
  })

  // Liveness is a recency judgement the daemon makes, so a row can carry a
  // finished-looking outcome and still be running -- and, the bug this
  // guards, a row with no outcome at all is NOT live just for lacking one.
  it('shows a clock time, not a live dot, for an entry with no outcome that is not running', () => {
    render(<EntryRow entry={entry({ live: false, outcome: '' })} />)
    expect(screen.queryByLabelText('Live')).toBeNull()
  })

  // Fix 17: a summary-less entry (outcomeOf's '' fallback -- an undistilled
  // session) used to render an empty outcome div. Say so, mutedly, instead.
  it('shows a muted "No summary yet" for an entry with no outcome', () => {
    const { container } = render(<EntryRow entry={entry({ outcome: '' })} />)
    const note = screen.getByText('No summary yet')
    expect(note).toBeInTheDocument()
    expect(note.className).toContain('entry-row-outcome-empty')
    // And a real outcome never shows the placeholder.
    expect(container.querySelectorAll('.entry-row-outcome')).toHaveLength(1)
  })

  it('renders an avatar by default', () => {
    render(<EntryRow entry={entry()} />)
    expect(screen.getByLabelText('Andrew')).toBeInTheDocument()
  })

  it('omits the avatar when showAvatar is false, without dropping the entry content', () => {
    render(<EntryRow entry={entry()} showAvatar={false} />)
    expect(screen.queryByLabelText('Andrew')).toBeNull()
    expect(screen.getByText(/Hook ownership now decided by durability/)).toBeInTheDocument()
  })

  it('shows the project name only when a cross-project caller passes one', () => {
    const { rerender } = render(<EntryRow entry={entry()} />)
    expect(screen.queryByText('membridge')).toBeNull()

    rerender(<EntryRow entry={entry()} project="membridge" />)
    expect(screen.getByText('membridge')).toBeInTheDocument()
  })

  it('omits the Intent line entirely when no ask/goal was ever captured', () => {
    render(<EntryRow entry={entry({ intent: null })} />)
    expect(screen.queryByText('Intent')).toBeNull()
  })
})

describe('EntryRow as a session link (Task 6)', () => {
  it('a row with a session renders a real <a> whose href comes from ROUTES', () => {
    render(<EntryRow entry={entry({ session: 's1' })} />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe(sessionHref('s1'))
    // The anatomy lives INSIDE the link -- the whole row is the target.
    expect(link.textContent).toContain('Hook ownership now decided by durability')
  })

  it('a session-less row (bare plumbing) renders no link and keeps today\'s markup', () => {
    const { container } = render(<EntryRow entry={entry({ session: null })} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(container.querySelector('div.entry-row')).not.toBeNull()
    expect(screen.getByText(/Hook ownership now decided by durability/)).toBeInTheDocument()
  })
})

describe('EntryRow hover preview (Task 6)', () => {
  const rich = () => entry({
    session: 's1',
    summaryFull: 'The full unclipped outcome, every sentence of it.',
    decisions: 'Durability beats recency.\nSecond line stays out of the preview.',
    files: ['lib/hooks.js', 'test/run-tests.js'],
    changes: [
      { file: 'lib/hooks.js', status: 'edited', add: 41, del: 12, note: null, dep: false },
      { file: 'test/run-tests.js', status: 'edited', add: 88, del: 2, note: null, dep: false },
    ],
  })

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function hoverRow(): HTMLElement {
    const row = screen.getByRole('link')
    fireEvent.mouseEnter(row)
    return row
  }

  it('appears only after the delay, aria-hidden, with outcome + first decisions line + diffstat', () => {
    render(<EntryRow entry={rich()} />)
    hoverRow()
    expect(document.querySelector('.entry-row-preview')).toBeNull()
    act(() => { vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS) })
    const preview = document.querySelector('.entry-row-preview')!
    expect(preview).not.toBeNull()
    expect(preview.getAttribute('aria-hidden')).toBe('true')
    expect(preview.textContent).toContain('The full unclipped outcome, every sentence of it.')
    expect(preview.textContent).toContain('Durability beats recency.')
    expect(preview.textContent).not.toContain('Second line stays out of the preview')
    expect(preview.textContent).toContain('2 files')
    expect(preview.textContent).toContain('+129')
    expect(preview.textContent).toContain('-14')
  })

  it('never appears on keyboard focus -- the route is the keyboard path', () => {
    render(<EntryRow entry={rich()} />)
    fireEvent.focus(screen.getByRole('link'))
    act(() => { vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS * 2) })
    expect(document.querySelector('.entry-row-preview')).toBeNull()
  })

  it('dismisses on pointer-leave and on Escape', () => {
    render(<EntryRow entry={rich()} />)
    const row = hoverRow()
    act(() => { vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS) })
    expect(document.querySelector('.entry-row-preview')).not.toBeNull()
    fireEvent.mouseLeave(row)
    expect(document.querySelector('.entry-row-preview')).toBeNull()

    hoverRow()
    act(() => { vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS) })
    expect(document.querySelector('.entry-row-preview')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('.entry-row-preview')).toBeNull()
  })

  it('nothing in the preview is focusable', () => {
    render(<EntryRow entry={rich()} />)
    hoverRow()
    act(() => { vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS) })
    const preview = document.querySelector('.entry-row-preview')!
    expect(preview.querySelectorAll('a, button, input, [tabindex]')).toHaveLength(0)
  })
})
