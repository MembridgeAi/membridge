import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { ProjectsPage } from './ProjectsPage'

describe('ProjectsPage', () => {
  it('loads the whole matrix in a single request', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getAccessMatrix')
    renderWith(client, <ProjectsPage />)
    await screen.findByText('membridge')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('disables access cells for a private project', async () => {
    renderApp({}, <ProjectsPage />)
    const row = await screen.findByTestId('project-row-sublease')
    for (const cell of within(row).getAllByRole('checkbox')) {
      if (cell.getAttribute('data-self') !== 'true') expect(cell).toBeDisabled()
    }
  })

  it("shows only the viewer's own access column to a member", async () => {
    renderApp({ role: 'member' }, <ProjectsPage />)
    await screen.findByText('membridge')
    expect(screen.queryByRole('columnheader', { name: /Andrew/ })).toBeNull()
  })

  it('never scrolls the page sideways', async () => {
    renderApp({}, <ProjectsPage />)
    const wrap = await screen.findByTestId('projects-scroll')
    expect(wrap.className).toContain('scroll-x')
  })

  // Finding 2: asserting only the cell's rendered `checked` state would still
  // pass for a component that flipped local UI state without ever calling
  // setProjectAccess -- so this spies on the client call itself, and on the
  // exact (projectPath, memberId, canSee) it was invoked with.
  it('calls setProjectAccess with the project, member, and new value when a cell is toggled', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setProjectAccess')
    renderWith(client, <ProjectsPage />)
    const row = await screen.findByTestId('project-row-membridge')
    // membridge is shared, and Sarah starts checked=true in the fixture --
    // an enabled, non-self cell whose click has a determinate before/after.
    const cell = within(row).getByRole('checkbox', { name: /Sarah/ })
    await userEvent.click(cell)
    expect(spy).toHaveBeenCalledWith('/Users/x/membridge', 'sarah', false)
  })

  // Finding 3: useSetProjectAccess applies an optimistic update and rolls it
  // back in onError -- untested rollback means a failed write could leave a
  // toggle stuck flipped, telling the user someone is blocked when they are
  // not. Drives the real hook (not a mock of it) by rejecting the client
  // call it wraps. The rejection is held open on a controlled promise (never
  // mockRejectedValueOnce) so the optimistic-flip state is actually
  // observable instead of racing straight through to the rollback in the
  // same tick.
  it('reverts an optimistic toggle when setProjectAccess rejects', async () => {
    const client = new FakeDataClient()
    let rejectWrite!: (err: Error) => void
    const write = new Promise<void>((_, reject) => { rejectWrite = reject })
    vi.spyOn(client, 'setProjectAccess').mockReturnValue(write)
    renderWith(client, <ProjectsPage />)
    const row = await screen.findByTestId('project-row-membridge')
    const cell = within(row).getByRole('checkbox', { name: /Sarah/ }) as HTMLInputElement
    expect(cell.checked).toBe(true)

    await userEvent.click(cell)
    await waitFor(() => expect(cell.checked).toBe(false)) // optimistic flip, write still pending

    rejectWrite(new Error('write failed'))
    await waitFor(() => expect(cell.checked).toBe(true)) // rollback once the write rejects
  })

  // The self-revoke guard used to compare a member's id against a hardcoded
  // two-letter placeholder -- a value the real daemon never sends (a real
  // user id looks like 'usr_9f2a'), so the guard silently never activated in
  // production. This drives the fixture with a REALISTIC id to prove the
  // guard now reads settings.viewerId instead of that sentinel.
  it('disables the viewer’s own access cell using the real viewerId, not a hardcoded placeholder', async () => {
    const client = new FakeDataClient({ viewerId: 'usr_9f2a' })
    renderWith(client, <ProjectsPage />)
    const row = await screen.findByTestId('project-row-membridge')
    const cell = within(row).getByRole('checkbox', { name: /Marco/i })
    expect(cell).toBeDisabled()
    expect(cell.getAttribute('data-self')).toBe('true')
  })

  it('adds a project through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'addProject')
    renderWith(client, <ProjectsPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^add project$/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox', { name: /folder path/i }), '/Users/x/new-project')
    await userEvent.click(within(dialog).getByRole('button', { name: /^add project$/i }))
    expect(spy).toHaveBeenCalledWith('/Users/x/new-project')
  })

  it('surfaces a failed add-project instead of looking like nothing happened', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'addProject').mockRejectedValue(new Error('not a directory'))
    renderWith(client, <ProjectsPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^add project$/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox', { name: /folder path/i }), '/not/a/dir')
    await userEvent.click(within(dialog).getByRole('button', { name: /^add project$/i }))
    expect(await screen.findByText(/not a directory/i)).toBeInTheDocument()
  })
})
