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

  // A member used to get a "read-only roster" here, built from the feed-derived
  // Project.recentAuthorIds -- which is not a roster (see the C4 block below), so the
  // list was wrong whenever the project was quiet. There is no authoritative
  // read available to a member either: project_access's select policy is
  // is_team_manager (migration 025) and RLS filters silently, so the per-project
  // endpoint reports the WHOLE TEAM as able to see it. The popover therefore
  // names the boundary rather than listing anyone.
  it('tells a member who to ask instead of listing a roster it cannot verify', async () => {
    renderApp({ role: 'member' }, <ProjectsPage />)
    const { popover } = await openAccessPopover('membridge')
    expect(within(popover).getByText(/only owners and admins can see who has access/i)).toBeInTheDocument()
    expect(within(popover).queryAllByRole('checkbox')).toHaveLength(0)
    expect(within(popover).queryByRole('button', { name: /everyone/i })).toBeNull()
    expect(within(popover).queryByRole('button', { name: /no one/i })).toBeNull()
    expect(within(popover).queryByRole('listitem')).toBeNull()
  })

  it("never calls the per-project access read as a member (RLS makes it answer wrongly)", async () => {
    const client = new FakeDataClient({ role: 'member' })
    const spy = vi.spyOn(client, 'getProjectAccess')
    renderWith(client, <ProjectsPage />)
    await openAccessPopover('membridge')
    expect(spy).not.toHaveBeenCalled()
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

// C4: the Access cell used to derive its roster from Project.recentAuthorIds, which
// is the distinct author set of the project's slice of ONE capped /api/feed
// page covering every project at once. A shared project quiet enough to have
// no entry on that page therefore rendered "0 of 5" -- a confident wrong
// answer on the one surface whose entire job is answering "who can see this".
// The grid now shows a count ONLY where it has authority (the owner/admin
// access matrix) and otherwise says it does not know here, with the real
// per-project answer fetched when the popover opens.
describe('Access cell honesty (C4)', () => {
  /** A shared project with NO recent activity: the exact case that produced
   *  "0 of 3". Everything else about the fixture is untouched. */
  function quietSharedClient(opts: { role?: 'owner' | 'member' } = {}) {
    const client = new FakeDataClient({ role: opts.role ?? 'member' })
    const real = client.getProjects.bind(client)
    vi.spyOn(client, 'getProjects').mockImplementation(async () =>
      (await real()).map(p => (p.shared ? { ...p, recentAuthorIds: [] } : p)))
    return client
  }

  it('does not claim a member count for a quiet shared project', async () => {
    renderWith(quietSharedClient(), <ProjectsPage />)
    const row = await screen.findByTestId('project-row-membridge')
    const cell = within(row).getByRole('button', { name: /access for membridge/i })
    expect(cell.textContent).not.toMatch(/\bof\b/)
    expect(cell.textContent).toContain('Who can see')
    // Nor via the accessible name, which is what a screen reader announces.
    expect(cell.getAttribute('aria-label')).not.toMatch(/\bmembers\b/)
  })

  it('renders no avatars when it cannot say who can see the project', async () => {
    renderWith(quietSharedClient(), <ProjectsPage />)
    const row = await screen.findByTestId('project-row-membridge')
    const cell = within(row).getByRole('button', { name: /access for membridge/i })
    expect(cell.querySelectorAll('.avatar')).toHaveLength(0)
  })

  it('keeps the authoritative matrix count for an admin, ignoring recent activity', async () => {
    // Same emptied recentAuthorIds, but an owner reads the matrix instead: the count
    // must still be the real one, not "0 of 3".
    renderWith(quietSharedClient({ role: 'owner' }), <ProjectsPage />)
    const row = await screen.findByTestId('project-row-membridge')
    const cell = within(row).getByRole('button', { name: /access for membridge/i })
    expect(cell.textContent).toContain('Whole team')
  })

  /** An owner whose access matrix carries no row for the shared project -- the
   *  one case where even a manager's grid cannot answer, and so falls back to
   *  the per-project read when the popover opens. */
  function adminWithoutMatrixRow() {
    const client = quietSharedClient({ role: 'owner' })
    const real = client.getAccessMatrix.bind(client)
    vi.spyOn(client, 'getAccessMatrix').mockImplementation(async () => {
      const matrix = await real()
      return { ...matrix, rows: matrix.rows.filter(r => r.projectPath !== '/Users/x/membridge') }
    })
    return client
  }

  it('asks for one project\'s access only once its popover opens, never on load', async () => {
    const client = adminWithoutMatrixRow()
    const spy = vi.spyOn(client, 'getProjectAccess')
    renderWith(client, <ProjectsPage />)
    const row = await screen.findByTestId('project-row-membridge')
    // The grid says it cannot answer, and has fired no per-project request for
    // it: a request per row on load is what the constant-width grid forbids.
    expect(within(row).getByRole('button', { name: /access for membridge/i }).textContent).toContain('Who can see')
    expect(spy).not.toHaveBeenCalled()

    const { popover } = await openAccessPopover('membridge')
    expect(spy).toHaveBeenCalledWith('/Users/x/membridge')
    expect(spy).toHaveBeenCalledTimes(1)
    // The authoritative answer: Sarah is listed but revoked, not omitted, so an
    // admin can grant her back.
    expect(await within(popover).findByText('Andrew')).toBeInTheDocument()
    expect(within(popover).getByRole('checkbox', { name: /Sarah can see this project/i })).not.toBeChecked()
  })

  it('says it is still checking rather than showing an empty roster', async () => {
    const client = adminWithoutMatrixRow()
    vi.spyOn(client, 'getProjectAccess').mockReturnValue(new Promise(() => {})) // never resolves
    renderWith(client, <ProjectsPage />)
    const { popover } = await openAccessPopover('membridge')
    expect(within(popover).getByText(/checking who can see this project/i)).toBeInTheDocument()
    expect(within(popover).queryByRole('listitem')).toBeNull()
  })

  it('reports a failed access read instead of implying nobody has access', async () => {
    const client = adminWithoutMatrixRow()
    vi.spyOn(client, 'getProjectAccess').mockRejectedValue(new Error('project_access unreachable'))
    renderWith(client, <ProjectsPage />)
    const { popover } = await openAccessPopover('membridge')
    const alert = await within(popover).findByRole('alert')
    expect(alert.textContent).toMatch(/couldn't load who can see this project/i)
    expect(alert.textContent).toContain('project_access unreachable')
    expect(within(popover).queryByRole('listitem')).toBeNull()
  })
})
