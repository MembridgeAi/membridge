import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EntryRow } from './EntryRow'
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
