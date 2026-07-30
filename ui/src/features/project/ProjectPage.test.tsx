import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp } from '../../test/renderApp'
import { ProjectPage } from './ProjectPage'

describe('ProjectPage', () => {
  it('states the consequence of revoking a member by name', async () => {
    renderApp({}, <ProjectPage name="membridge" />)
    expect(await screen.findByText(/Sarah can't see this project's memory or activity/)).toBeInTheDocument()
  })

  it('leads each stream entry with the outcome and shows the ask as intent', async () => {
    renderApp({}, <ProjectPage name="membridge" />)
    expect(await screen.findByText(/Hook ownership now decided by durability/)).toBeInTheDocument()
    expect(screen.getByText(/make the summary hook fire on session boundaries/)).toBeInTheDocument()
  })

  it('toggling a member calls setProjectAccess with that member', async () => {
    renderApp({}, <ProjectPage name="membridge" />)
    const toggle = await screen.findByRole('switch', { name: /Sarah/ })
    await userEvent.click(toggle)
    expect(await screen.findByRole('switch', { name: /Sarah/ })).toBeChecked()
  })

  it('hides the access panel from a member role', async () => {
    renderApp({ role: 'member' }, <ProjectPage name="membridge" />)
    await screen.findByText(/Hook ownership/)
    expect(screen.queryByText(/who sees this project/i)).toBeNull()
  })
})
