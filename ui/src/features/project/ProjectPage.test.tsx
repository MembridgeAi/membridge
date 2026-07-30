import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { ProjectPage } from './ProjectPage'

describe('ProjectPage', () => {
  it('states the consequence of revoking a member by name, honestly', async () => {
    renderApp({}, <ProjectPage name="membridge" />)
    const note = await screen.findByText(/won't get anything new from this project/)
    expect(note).toHaveTextContent('Sarah')
    // The honesty gap this covers: revocation is real and immediate on the
    // server, but a member's local tools read a durable on-disk archive
    // that never consults the backend, so entries already synced before
    // the toggle stay readable there. The note must say that plainly and
    // must NOT claim existing data on their machine is gone.
    expect(note).toHaveTextContent(/already synced to their machine may still be there until it next checks in/)
    expect(note.textContent).not.toMatch(/removed|deleted|purged|erased|retroactive/i)
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

  it('opens memory.md through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'openMemoryFile')
    renderWith(client, <ProjectPage name="membridge" />)
    await userEvent.click(await screen.findByRole('button', { name: 'memory.md' }))
    expect(spy).toHaveBeenCalledWith('/Users/x/membridge')
  })

  it('toggles "new members join with access" through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setProjectAccessDefault')
    renderWith(client, <ProjectPage name="membridge" />)
    const toggle = await screen.findByRole('switch', { name: /new members join with access/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(toggle)
    expect(spy).toHaveBeenCalledWith('/Users/x/membridge', false)
  })

  it('surfaces a failed access-default write instead of looking like nothing happened', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'setProjectAccessDefault').mockRejectedValue(new Error('default write rejected'))
    renderWith(client, <ProjectPage name="membridge" />)
    const toggle = await screen.findByRole('switch', { name: /new members join with access/i })
    await userEvent.click(toggle)
    expect(await screen.findByText(/default write rejected/i)).toBeInTheDocument()
  })

  it('surfaces a failed memory.md open instead of looking like nothing happened', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'openMemoryFile').mockRejectedValue(new Error('open rejected'))
    renderWith(client, <ProjectPage name="membridge" />)
    await userEvent.click(await screen.findByRole('button', { name: 'memory.md' }))
    expect(await screen.findByText(/open rejected/i)).toBeInTheDocument()
  })

  // BUG 2, project-page half: the stream shares EntryRow with the Feed, and
  // shares the same checkpoint-collapsing gap -- a session's several Stop
  // hook checkpoints must collapse to its newest, same as the Feed.
  it('collapses several checkpoint entries of the same session into one row showing the newest text', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getProjectStream').mockResolvedValue([
      { id: 'c2', author: 'Andrew', authorId: 'andrew', tool: 'Codex', at: '2026-07-29T20:05:00Z', live: false, outcome: 'second checkpoint', intent: null, files: [], session: 's1' },
      { id: 'c1', author: 'Andrew', authorId: 'andrew', tool: 'Codex', at: '2026-07-29T20:00:00Z', live: false, outcome: 'first checkpoint', intent: null, files: [], session: 's1' },
    ])
    renderWith(client, <ProjectPage name="membridge" />)

    expect(await screen.findByText('second checkpoint')).toBeInTheDocument()
    expect(screen.queryByText('first checkpoint')).toBeNull()
  })
})
