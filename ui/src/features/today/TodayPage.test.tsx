import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderApp } from '../../test/renderApp'
import { TodayPage } from './TodayPage'

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
    expect(screen.queryByText(/members synced/i)).toBeNull()
  })
})
