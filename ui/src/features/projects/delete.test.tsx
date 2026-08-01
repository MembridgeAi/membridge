// Task 6 (projects tab scale and archive): Delete is demoted to a
// single-project action behind a typed confirmation. It names what is
// destroyed in plain language and requires typing the project name; bulk
// selection has no Delete at all (asserted in archive.test.tsx).
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { ProjectsPage } from './ProjectsPage'

async function openDeleteDialog(projectName: string) {
  const row = await screen.findByTestId(`project-row-${projectName}`)
  await userEvent.click(within(row).getByRole('button', { name: new RegExp(`delete ${projectName}`, 'i') }))
  return screen.findByRole('dialog')
}

describe('single-project delete with a typed confirmation', () => {
  it('keeps the destructive button disabled until the exact project name is typed', async () => {
    renderApp({}, <ProjectsPage />)
    const dialog = await openDeleteDialog('sublease')
    const confirm = within(dialog).getByRole('button', { name: /delete project/i })
    expect(confirm).toBeDisabled()

    const input = within(dialog).getByRole('textbox', { name: /type the project name/i })
    await userEvent.type(input, 'subleas')
    expect(confirm).toBeDisabled()
    await userEvent.type(input, 'e')
    expect(confirm).toBeEnabled()
  })

  it('names what is destroyed: .membridge/, the context files, and the team archive', async () => {
    renderApp({}, <ProjectsPage />)
    const dialog = await openDeleteDialog('sublease')
    const text = dialog.textContent ?? ''
    expect(text).toContain('.membridge/')
    expect(text).toMatch(/CLAUDE\.md|context file/i)
    expect(text).toMatch(/team archive/i)
  })

  it('deletes through the real client call once the name is typed', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'deleteProject')
    renderWith(client, <ProjectsPage />)
    const dialog = await openDeleteDialog('sublease')
    await userEvent.type(within(dialog).getByRole('textbox', { name: /type the project name/i }), 'sublease')
    await userEvent.click(within(dialog).getByRole('button', { name: /delete project/i }))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('/Users/x/sublease')
  })

  it('is reachable for exactly ONE project at a time and names it', async () => {
    renderApp({}, <ProjectsPage />)
    const dialog = await openDeleteDialog('membridge')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(dialog.textContent).toContain('membridge')
    expect(dialog.textContent).not.toContain('sublease')
  })

  it('offers no delete control at all while select mode is active', async () => {
    renderApp({}, <ProjectsPage />)
    await screen.findByTestId('project-row-membridge')
    expect(screen.getByRole('button', { name: /delete sublease/i })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^select$/i }))
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })
})

// Review finding (data loss): the daemon answers a plain member's delete of a
// SHARED project with HTTP 200 and { archived: false, message }, after
// unlinkProject has already pruned that member's durable teammate archive
// (lib/teamsync.js unlinkProject -> teamArchive.pruneArchive). The project is
// NOT deleted. Two independent defenses are required: never offer the control
// to someone the daemon will refuse, and never read a refusal body as success.
describe('a shared project’s delete is manager-only', () => {
  it('does not offer Delete on a shared project to a member (absent, not disabled)', async () => {
    renderApp({ role: 'member' }, <ProjectsPage />)
    await screen.findByTestId('project-row-membridge')
    const sharedRow = screen.getByTestId('project-row-membridge')
    expect(within(sharedRow).queryByRole('button', { name: /delete/i })).toBeNull()
    // A member keeps Delete on their OWN private project: this is a
    // shared-project gate, not a blanket role gate.
    const privateRow = screen.getByTestId('project-row-sublease')
    expect(within(privateRow).getByRole('button', { name: /delete sublease/i })).toBeInTheDocument()
  })

  it('offers Delete on a shared project to an owner', async () => {
    renderApp({}, <ProjectsPage />) // default role: owner
    const sharedRow = await screen.findByTestId('project-row-membridge')
    expect(within(sharedRow).getByRole('button', { name: /delete membridge/i })).toBeInTheDocument()
  })

  // The second defense, exercised for the race the gate above cannot cover
  // (role changed server-side, or a stale cached role): a 200 that reports
  // the delete did NOT happen must keep the dialog open and say why.
  it('keeps the dialog open and shows the daemon message when the delete was refused', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'deleteProject').mockResolvedValue({
      path: '/Users/x/membridge',
      scope: 'local',
      archived: false,
      unlinked: true,
      message: 'only owners or managers can delete a shared project for the team',
    })
    renderWith(client, <ProjectsPage />)
    const dialog = await openDeleteDialog('membridge')
    await userEvent.type(within(dialog).getByRole('textbox', { name: /type the project name/i }), 'membridge')
    await userEvent.click(within(dialog).getByRole('button', { name: /delete project/i }))

    const alert = await screen.findByText(/only owners or managers can delete a shared project/i)
    expect(alert).toHaveAttribute('role', 'alert')
    // Still open: the user must not be told a destruction they confirmed
    // succeeded when it did not.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('closes the dialog only on a real success', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'deleteProject').mockResolvedValue({ path: '/Users/x/sublease', scope: 'local', deleted: true })
    renderWith(client, <ProjectsPage />)
    const dialog = await openDeleteDialog('sublease')
    await userEvent.type(within(dialog).getByRole('textbox', { name: /type the project name/i }), 'sublease')
    await userEvent.click(within(dialog).getByRole('button', { name: /delete project/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
