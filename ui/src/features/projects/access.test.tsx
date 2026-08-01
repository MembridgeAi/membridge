// Task 4 (projects tab scale and archive): the N member columns collapse
// into ONE Access cell per row, so the table's width is constant at any team
// size. Editing moves into an admin-gated popover; a member gets a read-only
// roster (a plain list, never disabled toggles).
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { ProjectsPage } from './ProjectsPage'

async function openAccessPopover(projectName: string) {
  const row = await screen.findByTestId(`project-row-${projectName}`)
  const cell = within(row).getByRole('button', { name: new RegExp(`access for ${projectName}`, 'i') })
  await userEvent.click(cell)
  return { row, cell, popover: await screen.findByRole('dialog') }
}

describe('Access cell (one column, constant width)', () => {
  it('renders 4 avatars, a +N chip and the count label for a shared 6-of-10 project', async () => {
    renderApp({ teamSize: 10 }, <ProjectsPage />)
    const row = await screen.findByTestId('project-row-membridge')
    const cell = within(row).getByRole('button', { name: /access for membridge/i })
    expect(cell.querySelectorAll('.avatar')).toHaveLength(4)
    expect(cell.textContent).toContain('+2')
    expect(cell.textContent).toContain('6 of 10')
  })

  it('labels a fully shared project Whole team', async () => {
    renderApp({}, <ProjectsPage />) // 3 members, membridge shared with all 3
    const row = await screen.findByTestId('project-row-membridge')
    const cell = within(row).getByRole('button', { name: /access for membridge/i })
    expect(cell.textContent).toContain('Whole team')
  })

  it('renders Only you and NO checkbox at all for a private project', async () => {
    renderApp({}, <ProjectsPage />)
    const row = await screen.findByTestId('project-row-sublease')
    expect(within(row).getByText(/only you/i)).toBeInTheDocument()
    expect(within(row).queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('keeps the column count identical for a 3-member and a 30-member team', async () => {
    const small = renderApp({}, <ProjectsPage />)
    await screen.findByTestId('project-row-membridge')
    const smallCols = screen.getAllByRole('columnheader').length
    small.unmount()

    renderApp({ teamSize: 30 }, <ProjectsPage />)
    await screen.findByTestId('project-row-membridge')
    expect(screen.getAllByRole('columnheader').length).toBe(smallCols)
  })
})

describe('Access popover', () => {
  it('gives an admin toggles plus Everyone / No one shortcuts', async () => {
    renderApp({}, <ProjectsPage />) // default role: owner
    const { popover } = await openAccessPopover('membridge')
    expect(within(popover).getAllByRole('checkbox').length).toBeGreaterThan(0)
    expect(within(popover).getByRole('button', { name: /everyone/i })).toBeInTheDocument()
    expect(within(popover).getByRole('button', { name: /no one/i })).toBeInTheDocument()
  })

  it('gives a member a read-only roster: no toggles, no shortcuts, plus the explanatory note', async () => {
    renderApp({ role: 'member' }, <ProjectsPage />)
    const { popover } = await openAccessPopover('membridge')
    expect(within(popover).queryAllByRole('checkbox')).toHaveLength(0)
    expect(within(popover).queryByRole('button', { name: /everyone/i })).toBeNull()
    expect(within(popover).queryByRole('button', { name: /no one/i })).toBeNull()
    expect(within(popover).getByText(/only owners and admins/i)).toBeInTheDocument()
    // The roster still names who can see the project.
    expect(within(popover).getByText('Andrew')).toBeInTheDocument()
  })

  it('never renders the viewer\'s own row as a toggle', async () => {
    renderApp({}, <ProjectsPage />) // viewer 'me' is named Marco in the fixture
    const { popover } = await openAccessPopover('membridge')
    expect(within(popover).getByText(/Marco/)).toBeInTheDocument()
    expect(within(popover).queryByRole('checkbox', { name: /Marco/i })).toBeNull()
  })

  it('shows the member search only above 8 members', async () => {
    const small = renderApp({}, <ProjectsPage />)
    const first = await openAccessPopover('membridge')
    expect(within(first.popover).queryByRole('textbox', { name: /search members/i })).toBeNull()
    small.unmount()

    renderApp({ teamSize: 10 }, <ProjectsPage />)
    const second = await openAccessPopover('membridge')
    expect(within(second.popover).getByRole('textbox', { name: /search members/i })).toBeInTheDocument()
  })

  it('writes through setProjectAccess when an admin flips a toggle', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setProjectAccess')
    renderWith(client, <ProjectsPage />)
    const { popover } = await openAccessPopover('membridge')
    await userEvent.click(within(popover).getByRole('checkbox', { name: /Sarah/i }))
    expect(spy).toHaveBeenCalledWith('/Users/x/membridge', 'sarah', false)
  })

  it('closes on Escape and returns focus to the triggering cell', async () => {
    renderApp({}, <ProjectsPage />)
    const { cell } = await openAccessPopover('membridge')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(cell)
  })
})
