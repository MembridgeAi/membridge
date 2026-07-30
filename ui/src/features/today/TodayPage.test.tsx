import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderApp } from '../../test/renderApp'
import { TodayPage, lastTeamSyncLabel, skeletonPercentLabel, todayDateLabel } from './TodayPage'

// Scopes a StatStrip assertion to the cell for one label, so "1" or "68%"
// is checked against the right stat, not just anywhere on the page.
async function statCell(label: string): Promise<HTMLElement> {
  const labelEl = await screen.findByText(label)
  const cell = labelEl.closest('.stat-cell')
  if (!cell) throw new Error(`no .stat-cell ancestor for label "${label}"`)
  return cell as HTMLElement
}

// The label can render before its value has finished loading (the stat
// strip's solo/team branch decides on statusQuery, the values on their own
// separate queries) -- findByText, not getByText, so this waits out that gap
// instead of racing it.
async function expectStatValue(label: string, value: string): Promise<void> {
  const cell = await statCell(label)
  expect(await within(cell).findByText(value)).toBeInTheDocument()
}

describe('TodayPage', () => {
  it('labels a live session with its captured intent', async () => {
    renderApp({}, <TodayPage />)
    expect(await screen.findByText(/make the summary hook fire on session boundaries/)).toBeInTheDocument()
    expect(screen.getAllByText('Intent').length).toBeGreaterThan(0)
  })

  it('spells out the session window', async () => {
    renderApp({}, <TodayPage />)
    expect(await screen.findByText('31 sessions · last 7 days')).toBeInTheDocument()
    expect(screen.queryByText(/· 7d$/)).toBeNull()
  })

  it('gives a Sync now button only to a behind project', async () => {
    renderApp({}, <TodayPage />)
    const rows = await screen.findAllByTestId('project-row')
    const upToDate = rows.find(r => within(r).queryByText('✓ up to date'))!
    const behind = rows.find(r => within(r).queryByText(/behind/))!
    expect(within(upToDate).queryByRole('button', { name: 'Sync now' })).toBeNull()
    expect(within(behind).getByRole('button', { name: 'Sync now' })).toBeInTheDocument()
  })

  it('renders an empty state without crashing', async () => {
    renderApp({ empty: true }, <TodayPage />)
    expect(await screen.findByText(/no projects yet/i)).toBeInTheDocument()
  })

  it('surfaces a load failure instead of rendering a blank page', async () => {
    renderApp({ failWith: 'daemon unreachable' }, <TodayPage />)
    expect(await screen.findByText(/couldn't reach/i)).toBeInTheDocument()
  })

  it('omits team-only stats in solo mode', async () => {
    renderApp({ solo: true }, <TodayPage />)
    await screen.findByText(/sessions today/i)
    expect(screen.queryByText(/updates shared/i)).toBeNull()
    expect(screen.queryByText(/last team sync/i)).toBeNull()
  })

  // FINDING 1: a naive count of every project with a latestSummary would be
  // 2 -- FakeDataClient's fixture gives BOTH membridge (shared) and sublease
  // (private) a latestSummary. Only membridge may count toward a
  // team-labelled stat, so the correct total is 1, not 2.
  it('counts updates shared only from shared projects, excluding a private project with its own summary', async () => {
    renderApp({}, <TodayPage />)
    await expectStatValue('updates shared', '1')
  })

  // FINDING 2: the old per-member synced count is gone (no per-member sync
  // state exists on the wire); "last team sync" reads status.teamLastSync directly.
  describe('lastTeamSyncLabel', () => {
    const NOW = new Date('2026-07-29T23:00:00Z').getTime()
    it('is "never" when the team has not synced', () => {
      expect(lastTeamSyncLabel(null, NOW)).toBe('never')
    })
    it('renders whole hours elapsed', () => {
      expect(lastTeamSyncLabel('2026-07-29T21:00:00Z', NOW)).toBe('2h ago')
    })
    it('renders whole days elapsed', () => {
      expect(lastTeamSyncLabel('2026-07-27T23:00:00Z', NOW)).toBe('2d ago')
    })
    it('renders "just now" under a minute', () => {
      expect(lastTeamSyncLabel('2026-07-29T22:59:30Z', NOW)).toBe('just now')
    })
  })

  it('shows last team sync as a relative label built from status.teamLastSync', async () => {
    renderApp({}, <TodayPage />)
    // Computed with the real clock, same as the component -- this proves the
    // wiring (status.teamLastSync -> the rendered stat), while the exact
    // arithmetic is covered by the lastTeamSyncLabel unit tests above.
    const expected = lastTeamSyncLabel('2026-07-29T21:00:00Z')
    await expectStatValue('last team sync', expected)
  })

  it('shows never for last team sync when the team has not synced yet', async () => {
    renderApp({ teamLastSync: null }, <TodayPage />)
    await expectStatValue('last team sync', 'never')
  })

  // FINDING 3: the solo effectiveness stat comes from the real /api/savings
  // ledger (getSkeletonStats), not a session-count proxy, and must never
  // substitute a computed number when the ledger has nothing yet.
  describe('skeletonPercentLabel', () => {
    it('renders the exact rounded percentage when the ledger has data', () => {
      expect(skeletonPercentLabel({ available: true, repeatOpens: 1204, answeredFirst: 818 })).toBe('68%')
    })
    it('renders the literal word pending, never a computed stand-in, when unavailable', () => {
      expect(skeletonPercentLabel({ available: false })).toBe('pending')
    })
  })

  it('renders the skeleton stat as a percentage when the ledger has data', async () => {
    renderApp({ solo: true }, <TodayPage />)
    await expectStatValue('repeat opens answered by memory', '68%')
  })

  it('renders pending -- never a computed stand-in -- when the ledger has no data yet', async () => {
    renderApp({ solo: true, skeletonAvailable: false }, <TodayPage />)
    await expectStatValue('repeat opens answered by memory', 'pending')
  })

  // FINDING 4: no whole-account digest endpoint exists (only per-project
  // POST /api/projects/copy), so the digest-copy button must not render here.
  it('has no whole-account digest-copy control on Today', async () => {
    renderApp({}, <TodayPage />)
    await screen.findByText('Today')
    expect(screen.queryByRole('button', { name: /copy for ai/i })).toBeNull()
    expect(screen.queryByText(/copy for ai/i)).toBeNull()
  })

  // FINDING 5: the header date is built from UTC fields with no comma.
  describe('todayDateLabel', () => {
    it('formats weekday/month/day from UTC fields with no comma', () => {
      expect(todayDateLabel(new Date('2026-07-29T23:30:00Z'))).toBe('Wed Jul 29')
    })
    it('uses the UTC calendar day even when local fields would read a different one', () => {
      // 23:30 UTC is still late evening in every western timezone -- picking
      // a date 30 minutes before UTC midnight is what would flip to the
      // NEXT day locally in zones east of UTC, proving this reads UTC.
      expect(todayDateLabel(new Date('2026-07-30T23:30:00Z'))).toBe('Thu Jul 30')
    })
  })

  it('renders the header date with no comma', async () => {
    renderApp({}, <TodayPage />)
    const dateEl = await screen.findByText(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}$/)
    expect(dateEl).toBeInTheDocument()
    expect(dateEl.textContent).not.toContain(',')
  })
})
