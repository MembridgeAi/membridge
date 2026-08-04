// Task 3: the Knowledge Concentration list names single-owner projects and
// its own footnote tells the reader the fix is "one toggle on the project
// page" -- while giving them no way to reach that page. The project name is
// the link.
//
// Insights carries a project NAME and no path (lib/api-insights.js groups by
// project_id and emits `projectName`), which the project route already
// accepts: ProjectPage resolves a slug by path first and falls back to a name
// match for exactly this kind of link.
import { describe, expect, it, afterEach } from 'vitest'
import { screen, cleanup } from '@testing-library/react'
import { renderApp } from '../../test/renderApp'
import { projectHref } from '../../app/routes'
import { InsightsPage } from './InsightsPage'

const SETTLED = { timeout: 8000 }

afterEach(() => {
  cleanup()
  window.history.pushState({}, '', '/')
})

describe('Knowledge Concentration rows link to the project', () => {
  it('the project name is a link to that project page', async () => {
    renderApp({}, <InsightsPage />)
    const link = await screen.findByRole('link', { name: /billing-poc/ }, SETTLED)
    expect(link.getAttribute('href')).toBe(projectHref('billing-poc'))
  })

  it('still says who the only owner is, and still carries the footnote', async () => {
    renderApp({}, <InsightsPage />)
    expect(await screen.findByText(/Andrew only/, {}, SETTLED)).toBeInTheDocument()
    expect(screen.getByText(/one toggle on the project page/)).toBeInTheDocument()
  })
})
