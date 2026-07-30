import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
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
})
