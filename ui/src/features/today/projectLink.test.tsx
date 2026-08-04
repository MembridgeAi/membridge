// Task 3: Today's "Projects · this week" rows name a project and then give
// the reader nowhere to go with it. The name is the obvious target, so it is
// the link.
import { describe, expect, it, afterEach } from 'vitest'
import { screen, cleanup, within } from '@testing-library/react'
import { renderApp } from '../../test/renderApp'
import { projectHref } from '../../app/routes'
import { TodayPage } from './TodayPage'

const SETTLED = { timeout: 8000 }

afterEach(() => {
  cleanup()
  window.history.pushState({}, '', '/')
})

describe("Today's project rows link to the project", () => {
  it('the project name is a link built from projectHref', async () => {
    renderApp({}, <TodayPage />)
    const rows = await screen.findAllByTestId('project-row', {}, SETTLED)
    const link = within(rows[0]).getByRole('link', { name: /membridge/ })
    expect(link.getAttribute('href')).toBe(projectHref('/Users/x/membridge'))
  })

  it('routes on the project PATH, so a shared basename cannot collide', async () => {
    renderApp({}, <TodayPage />)
    const rows = await screen.findAllByTestId('project-row', {}, SETTLED)
    for (const row of rows) {
      const link = within(row).getAllByRole('link')[0]
      expect(link.getAttribute('href')!.startsWith('/projects/%2FUsers%2Fx%2F')).toBe(true)
    }
  })
})
