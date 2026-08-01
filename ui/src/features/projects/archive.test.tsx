// Task 5 (projects tab scale and archive): select mode with bulk ARCHIVE
// (never bulk delete), per-project failure reporting, and the collapsed
// Archived section with per-row Unarchive.
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { ProjectsPage } from './ProjectsPage'

async function enterSelectMode() {
  await screen.findByTestId('project-row-membridge')
  await userEvent.click(screen.getByRole('button', { name: /^select$/i }))
}

describe('select mode', () => {
  it('reveals a checkbox gutter and swaps the header controls for Done', async () => {
    renderApp({}, <ProjectsPage />)
    await screen.findByTestId('project-row-membridge')
    expect(screen.queryByRole('checkbox', { name: /select membridge/i })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /^select$/i }))
    expect(screen.getByRole('checkbox', { name: /select membridge/i })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /select sublease/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^done$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^add project$/i })).toBeNull()
  })

  it('counts the selection in the action bar', async () => {
    renderApp({}, <ProjectsPage />)
    await enterSelectMode()
    await userEvent.click(screen.getByRole('checkbox', { name: /select membridge/i }))
    expect(screen.getByText(/1 selected/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: /select sublease/i }))
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument()
  })

  it('archives once per selected path when Archive is pressed', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'archiveProject')
    renderWith(client, <ProjectsPage />)
    await enterSelectMode()
    await userEvent.click(screen.getByRole('checkbox', { name: /select membridge/i }))
    await userEvent.click(screen.getByRole('checkbox', { name: /select sublease/i }))
    await userEvent.click(screen.getByRole('button', { name: /archive 2 projects/i }))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
    expect(spy).toHaveBeenCalledWith('/Users/x/membridge')
    expect(spy).toHaveBeenCalledWith('/Users/x/sublease')
  })

  it('offers NO Delete control anywhere in select mode', async () => {
    renderApp({}, <ProjectsPage />)
    await enterSelectMode()
    await userEvent.click(screen.getByRole('checkbox', { name: /select membridge/i }))
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })

  it('states the blast radius, including that a shared project stops receiving teammates\' new activity', async () => {
    renderApp({}, <ProjectsPage />)
    await enterSelectMode()
    const note = screen.getByText(/nothing is deleted/i)
    expect(note.textContent).toMatch(/teammates/i)
  })

  it('reports a partial failure by name and does not roll back the successes', async () => {
    const client = new FakeDataClient()
    const archiveSpy = vi.spyOn(client, 'archiveProject').mockImplementation(path =>
      path === '/Users/x/sublease' ? Promise.reject(new Error('untracked')) : Promise.resolve())
    const unarchiveSpy = vi.spyOn(client, 'unarchiveProject')
    renderWith(client, <ProjectsPage />)
    await enterSelectMode()
    await userEvent.click(screen.getByRole('checkbox', { name: /select membridge/i }))
    await userEvent.click(screen.getByRole('checkbox', { name: /select sublease/i }))
    await userEvent.click(screen.getByRole('button', { name: /archive 2 projects/i }))
    const report = await screen.findByText(/archived 1 of 2/i)
    expect(report.textContent).toContain('sublease')
    expect(archiveSpy).toHaveBeenCalledTimes(2)
    // No rollback of the project that DID archive.
    expect(unarchiveSpy).not.toHaveBeenCalled()
  })

  it('clears the selection on Cancel', async () => {
    renderApp({}, <ProjectsPage />)
    await enterSelectMode()
    await userEvent.click(screen.getByRole('checkbox', { name: /select membridge/i }))
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    // Cancel leaves select mode entirely; re-entering starts empty.
    expect(screen.queryByRole('checkbox', { name: /select membridge/i })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^select$/i }))
    expect((screen.getByRole('checkbox', { name: /select membridge/i }) as HTMLInputElement).checked).toBe(false)
  })
})

describe('Archived section', () => {
  it('collapses archived projects into an Archived (N) section, out of the main table', async () => {
    renderApp({ withArchived: true }, <ProjectsPage />)
    await screen.findByTestId('project-row-membridge')
    expect(screen.queryByTestId('project-row-old-prototype')).toBeNull()
    const toggle = screen.getByRole('button', { name: /archived \(2\)/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('old-prototype')).toBeNull()

    await userEvent.click(toggle)
    expect(screen.getByText('old-prototype')).toBeInTheDocument()
    expect(screen.getByText('deleted-folder')).toBeInTheDocument()
  })

  it('unarchives a row through the real client call', async () => {
    const client = new FakeDataClient({ withArchived: true })
    const spy = vi.spyOn(client, 'unarchiveProject')
    renderWith(client, <ProjectsPage />)
    await screen.findByTestId('project-row-membridge')
    await userEvent.click(screen.getByRole('button', { name: /archived \(2\)/i }))
    await userEvent.click(screen.getByRole('button', { name: /unarchive old-prototype/i }))
    expect(spy).toHaveBeenCalledWith('/Users/x/old-prototype')
  })

  it('marks a missing folder with a muted note and still unarchives it', async () => {
    const client = new FakeDataClient({ withArchived: true })
    const spy = vi.spyOn(client, 'unarchiveProject')
    renderWith(client, <ProjectsPage />)
    await screen.findByTestId('project-row-membridge')
    await userEvent.click(screen.getByRole('button', { name: /archived \(2\)/i }))
    const row = screen.getByTestId('archived-row-deleted-folder')
    expect(within(row).getByText(/folder missing/i)).toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: /unarchive deleted-folder/i }))
    expect(spy).toHaveBeenCalledWith('/Users/x/deleted-folder')
  })

  it('hides the whole section when nothing is archived', async () => {
    renderApp({}, <ProjectsPage />)
    await screen.findByTestId('project-row-membridge')
    expect(screen.queryByRole('button', { name: /archived \(/i })).toBeNull()
  })
})
