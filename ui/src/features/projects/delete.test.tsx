// Task 6 (projects tab scale and archive): Delete is demoted to a
// single-project action behind a typed confirmation. It names what is
// destroyed in plain language and requires typing the project name; bulk
// selection has no Delete at all (asserted in archive.test.tsx).
import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
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
