import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { ProjectPage } from './ProjectPage'

describe('ProjectPage', () => {
  it('states the consequence of revoking a member by name, honestly', async () => {
    renderApp({}, <ProjectPage slug="membridge" />)
    const note = await screen.findByText(/loses access to this project/)
    expect(note).toHaveTextContent('Sarah')
    // Three things must all survive here: (1) the backend revokes access
    // immediately, (2) anything already synced to their machine is cleaned
    // up the next time it checks in (prune-on-revocation), and (3) a
    // device that never syncs again keeps its copy -- that case must read
    // as a fact, not a hedge, and must never be dropped in favor of (1)+(2)
    // alone (which would imply removal is guaranteed).
    expect(note).toHaveTextContent(/right away/i)
    expect(note).toHaveTextContent(/removed the next time it checks in/i)
    expect(note).toHaveTextContent(/never syncs again/i)
    expect(note).toHaveTextContent(/keeps its copy/i)
    expect(note.textContent).not.toMatch(/retroactive/i)
  })

  it('leads each stream entry with the outcome and shows the ask as intent', async () => {
    renderApp({}, <ProjectPage slug="membridge" />)
    expect(await screen.findByText(/Hook ownership now decided by durability/)).toBeInTheDocument()
    expect(screen.getByText(/make the summary hook fire on session boundaries/)).toBeInTheDocument()
  })

  it('toggling a member calls setProjectAccess with that member', async () => {
    renderApp({}, <ProjectPage slug="membridge" />)
    const toggle = await screen.findByRole('switch', { name: /Sarah/ })
    await userEvent.click(toggle)
    expect(await screen.findByRole('switch', { name: /Sarah/ })).toBeChecked()
  })

  // Fix 8: useSetProjectAccess rolls an optimistic toggle back on failure,
  // but no consumer said WHY the toggle snapped back -- the failure needs a
  // role="alert" line, same as setAccessDefault's below.
  it('surfaces a failed access toggle instead of silently snapping back', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'setProjectAccess').mockRejectedValue(new Error('access write rejected'))
    renderWith(client, <ProjectPage slug="membridge" />)
    await userEvent.click(await screen.findByRole('switch', { name: /Sarah/ }))
    const alert = await screen.findByText(/couldn't change access/i)
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert.textContent).toContain('access write rejected')
  })

  it('hides the access panel from a member role', async () => {
    renderApp({ role: 'member' }, <ProjectPage slug="membridge" />)
    await screen.findByText(/Hook ownership/)
    expect(screen.queryByText(/who sees this project/i)).toBeNull()
  })

  it('opens memory.md through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'openMemoryFile')
    renderWith(client, <ProjectPage slug="membridge" />)
    await userEvent.click(await screen.findByRole('button', { name: 'memory.md' }))
    expect(spy).toHaveBeenCalledWith('/Users/x/membridge')
  })

  it('toggles "new members join with access" through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setProjectAccessDefault')
    renderWith(client, <ProjectPage slug="membridge" />)
    const toggle = await screen.findByRole('switch', { name: /new members join with access/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(toggle)
    expect(spy).toHaveBeenCalledWith('/Users/x/membridge', false)
  })

  it('surfaces a failed access-default write instead of looking like nothing happened', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'setProjectAccessDefault').mockRejectedValue(new Error('default write rejected'))
    renderWith(client, <ProjectPage slug="membridge" />)
    const toggle = await screen.findByRole('switch', { name: /new members join with access/i })
    await userEvent.click(toggle)
    expect(await screen.findByText(/default write rejected/i)).toBeInTheDocument()
  })

  it('surfaces a failed memory.md open instead of looking like nothing happened', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'openMemoryFile').mockRejectedValue(new Error('open rejected'))
    renderWith(client, <ProjectPage slug="membridge" />)
    await userEvent.click(await screen.findByRole('button', { name: 'memory.md' }))
    expect(await screen.findByText(/open rejected/i)).toBeInTheDocument()
  })

  // BUG 2, project-page half: the stream shares EntryRow with the Feed, and
  // shares the same checkpoint-collapsing gap -- a session's several Stop
  // hook checkpoints must collapse to its newest, same as the Feed.
  it('collapses several checkpoint entries of the same session into one row showing the newest text', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getProjectStream').mockResolvedValue([
      { id: 'c2', author: 'Andrew', authorId: 'andrew', tool: 'Codex', at: '2026-07-29T20:05:00Z', live: false, outcome: 'second checkpoint', intent: null, files: [], session: 's1', summaryFull: null, decisions: null, gotchas: null, changes: [] },
      { id: 'c1', author: 'Andrew', authorId: 'andrew', tool: 'Codex', at: '2026-07-29T20:00:00Z', live: false, outcome: 'first checkpoint', intent: null, files: [], session: 's1', summaryFull: null, decisions: null, gotchas: null, changes: [] },
    ])
    renderWith(client, <ProjectPage slug="membridge" />)

    expect(await screen.findByText('second checkpoint')).toBeInTheDocument()
    expect(screen.queryByText('first checkpoint')).toBeNull()
  })

  // Task 6: ProjectPage renders the SAME EntryRow the Feed does, so its rows
  // inherit the session link with no ProjectPage.tsx change at all.
  it('stream rows inherit the session link from EntryRow', async () => {
    renderWith(new FakeDataClient(), <ProjectPage slug="membridge" />)
    const outcome = await screen.findByText(/Hook ownership now decided by durability/)
    const row = outcome.closest('.entry-row')
    expect(row).not.toBeNull()
    expect(row!.tagName).toBe('A')
    expect(row!.getAttribute('href')).toBe(`/sessions/${encodeURIComponent('s-e1')}`)
  })
})
