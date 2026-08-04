// Task 3: every place that names a project should be a way INTO that
// project. The Projects table only linked from a small "Open" button at the
// far right of the row (and built that href from a re-typed route literal,
// which routes.ts's own rule forbids); the name itself, the thing a reader
// actually points at, was dead text.
import { describe, expect, it, afterEach } from 'vitest'
import { screen, cleanup, within } from '@testing-library/react'
import { renderApp } from '../../test/renderApp'
import { projectHref } from '../../app/routes'
import { ProjectsPage } from './ProjectsPage'

const SETTLED = { timeout: 8000 }

afterEach(() => {
  cleanup()
  window.history.pushState({}, '', '/')
})

describe('ProjectsPage rows link to the project', () => {
  it('the project name is a link to that project', async () => {
    renderApp({}, <ProjectsPage />)
    const row = await screen.findByTestId('project-row-membridge', {}, SETTLED)
    const link = within(row).getByRole('link', { name: /membridge/ })
    expect(link.getAttribute('href')).toBe(projectHref('/Users/x/membridge'))
  })

  it('Open still points at the same place, built from projectHref', async () => {
    renderApp({}, <ProjectsPage />)
    const row = await screen.findByTestId('project-row-membridge', {}, SETTLED)
    const open = within(row).getByRole('link', { name: 'Open' })
    expect(open.getAttribute('href')).toBe(projectHref('/Users/x/membridge'))
  })

  it('routes on the PATH, never the basename, so two same-named checkouts differ', async () => {
    renderApp({}, <ProjectsPage />)
    const row = await screen.findByTestId('project-row-sublease', {}, SETTLED)
    const link = within(row).getByRole('link', { name: /sublease/ })
    expect(link.getAttribute('href')).toBe(projectHref('/Users/x/sublease'))
    expect(link.getAttribute('href')).not.toBe(projectHref('sublease'))
  })
})
