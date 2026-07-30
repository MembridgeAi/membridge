import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SyncStateView } from './SyncState'
import { StatStrip } from './StatStrip'
import { Sparkline } from './Sparkline'
import { StateChip } from './StateChip'
import { Toggle } from './Toggle'
import { Avatar } from './Avatar'
import { RuledRow } from './RuledRow'
import { Placeholder } from './Placeholder'

describe('SyncStateView', () => {
  it('renders up to date with no timestamp and no button', () => {
    render(<SyncStateView state={{ state: 'up-to-date' }} onSync={() => {}} />)
    expect(screen.getByText('✓ up to date')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders behind with its date and a Sync now button', async () => {
    const onSync = vi.fn()
    render(<SyncStateView state={{ state: 'behind', lastSyncedAt: '2026-07-23T10:00:00Z' }} onSync={onSync} />)
    expect(screen.getByText(/behind · Jul 23/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    expect(onSync).toHaveBeenCalledOnce()
  })

  // Regression: a bare date cannot tell "minutes ago" from "dead since
  // midnight" -- both printed today's date under a warning glyph, which is
  // what made a 12-second lag read as an outage.
  it('renders a same-day sync as a time, not today\'s date', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-07-30T19:53:00Z'))
      render(<SyncStateView state={{ state: 'behind', lastSyncedAt: '2026-07-30T19:51:48Z' }} onSync={() => {}} />)
      expect(screen.getByText(/behind · 19:51/)).toBeInTheDocument()
      expect(screen.queryByText(/Jul 30/)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the date for a sync older than today', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-07-30T19:53:00Z'))
      render(<SyncStateView state={{ state: 'behind', lastSyncedAt: '2026-07-29T23:59:00Z' }} onSync={() => {}} />)
      expect(screen.getByText(/behind · Jul 29/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders never when no sync has ever been recorded', () => {
    render(<SyncStateView state={{ state: 'behind', lastSyncedAt: null }} onSync={() => {}} />)
    expect(screen.getByText(/behind · never/)).toBeInTheDocument()
  })

  it('renders paused as muted with no button', () => {
    render(<SyncStateView state={{ state: 'paused' }} onSync={() => {}} />)
    expect(screen.getByText('paused')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('StatStrip', () => {
  it('renders each value in a tabular mono element beside its label', () => {
    render(<StatStrip items={[{ value: '412', label: 'sessions' }]} />)
    const value = screen.getByText('412')
    expect(value.className).toContain('mono')
    expect(screen.getByText('sessions')).toBeInTheDocument()
  })
})

describe('Sparkline', () => {
  it('describes the series for assistive tech', () => {
    render(<Sparkline values={[1, 2, 3]} />)
    expect(screen.getByLabelText(/activity/i)).toBeInTheDocument()
  })
})

describe('StateChip', () => {
  it('carries the glyph and the words in one accessible text run', () => {
    render(<StateChip tone="bad" glyph="✗">broken</StateChip>)
    expect(screen.getByText('✗ broken')).toBeInTheDocument()
  })
})

describe('Toggle', () => {
  it('exposes role=switch, aria-checked, and an accessible name from its label', () => {
    render(<Toggle on={false} label="Auto-sync" onChange={() => {}} />)
    const toggle = screen.getByRole('switch', { name: 'Auto-sync' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('calls onChange with the flipped value on click', async () => {
    const onChange = vi.fn()
    render(<Toggle on={false} label="Auto-sync" onChange={onChange} />)
    await userEvent.click(screen.getByRole('switch', { name: 'Auto-sync' }))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('is queryable by a member name embedded in its label', () => {
    render(<Toggle on={true} label="Sarah — can see this project" onChange={() => {}} />)
    expect(screen.getByRole('switch', { name: /Sarah/ })).toHaveAttribute('aria-checked', 'true')
  })
})

describe('Avatar', () => {
  it('exposes the person name and renders their initial', () => {
    render(<Avatar name="Sarah" id="sarah" />)
    expect(screen.getByLabelText('Sarah')).toHaveTextContent('S')
  })

  it('gives the same id the same color on every render', () => {
    const { unmount } = render(<Avatar name="Sarah" id="sarah" />)
    const first = screen.getByLabelText('Sarah').style.background
    unmount()
    render(<Avatar name="Sarah" id="sarah" />)
    expect(screen.getByLabelText('Sarah').style.background).toBe(first)
  })
})

describe('RuledRow', () => {
  it('renders its children inside a bottom-ruled row', () => {
    render(<RuledRow>membridge</RuledRow>)
    expect(screen.getByText('membridge')).toBeInTheDocument()
  })
})

describe('Placeholder', () => {
  it('renders the given title for a route not yet built', () => {
    render(<Placeholder title="Insights" />)
    expect(screen.getByText('Insights')).toBeInTheDocument()
  })
})
