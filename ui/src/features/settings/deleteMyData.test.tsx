// Self-serve deletion from Settings (#42). The daemon has served GET
// /api/team/my-data and POST /api/team/delete-my-data since migration 035,
// and nothing in ui/ called either -- so the app promised a right the product
// documents but could not exercise. These cover the states where getting it
// wrong is expensive rather than merely ugly: a destructive confirm offered
// against an unknown blast radius, a count that under-reports what will be
// removed, and a delete that fires without the typed confirmation.
import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { SettingsPage } from './SettingsPage'

function onTeam(overrides = {}) {
  return new FakeDataClient({ solo: false, authenticated: true, ...overrides })
}

async function openDialog(client: FakeDataClient) {
  renderWith(client, <SettingsPage />)
  await userEvent.click(await screen.findByRole('button', { name: /delete my data/i }))
  return screen.findByRole('dialog')
}

describe('deleting my own data from Settings', () => {
  it('is offered to a plain member, not just an admin', async () => {
    // 035 §1 scopes the DELETE policy on author_id ALONE, deliberately without
    // the membership/access predicates the other policies carry, so that
    // someone who left or lost access can still erase what they wrote. A role
    // gate in the UI would put that back.
    renderWith(onTeam({ role: 'member' }), <SettingsPage />)
    expect(await screen.findByRole('button', { name: /delete my data/i })).toBeInTheDocument()
  })

  it('states the backend total before asking, not a local count', async () => {
    const dialog = await openDialog(onTeam())
    // 500 across 3 projects is the fake's fixture, and one of those projects
    // has no local path -- it must still be counted, because the delete still
    // removes it.
    expect(within(dialog).getByText(/500 entries/)).toBeInTheDocument()
    expect(within(dialog).getByText(/3 projects/)).toBeInTheDocument()
  })

  it('says teammates lose the entries too', async () => {
    const dialog = await openDialog(onTeam())
    expect(within(dialog).getByText(/teammates lose these entries/i)).toBeInTheDocument()
  })

  it('will not delete until DELETE is typed', async () => {
    const client = onTeam()
    const spy = vi.spyOn(client, 'deleteMyData')
    const dialog = await openDialog(client)
    const confirm = within(dialog).getByRole('button', { name: /^delete my data$/i })
    await userEvent.click(confirm)
    expect(spy).not.toHaveBeenCalled()
  })

  it('deletes every project in the team once confirmed', async () => {
    const client = onTeam()
    const spy = vi.spyOn(client, 'deleteMyData')
    const dialog = await openDialog(client)
    await userEvent.type(within(dialog).getByRole('textbox'), 'DELETE')
    await userEvent.click(within(dialog).getByRole('button', { name: /^delete my data$/i }))
    // null, not a project id: this control is all-or-nothing on purpose.
    expect(spy).toHaveBeenCalledWith(null)
  })

  it('offers nothing to destroy when nothing has synced', async () => {
    const client = onTeam()
    vi.spyOn(client, 'getMyData').mockResolvedValue({ projects: [], total: 0 })
    const spy = vi.spyOn(client, 'deleteMyData')
    const dialog = await openDialog(client)
    expect(within(dialog).getByText(/nothing synced/i)).toBeInTheDocument()
    // The only button that acts is a Close. Confirming an empty state must not
    // reach the RPC at all.
    await userEvent.click(within(dialog).getByRole('button', { name: /^close$/i }))
    expect(spy).not.toHaveBeenCalled()
  })

  it('never offers the delete when the blast radius could not be read', async () => {
    // The failure that matters: agreeing to destroy an unknown quantity. The
    // preview failing must close the door, not open it with a blank number.
    const client = onTeam()
    vi.spyOn(client, 'getMyData').mockRejectedValue(new Error('offline'))
    const spy = vi.spyOn(client, 'deleteMyData')
    const dialog = await openDialog(client)
    expect(within(dialog).getByText(/could not reach/i)).toBeInTheDocument()
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: /^close$/i }))
    expect(spy).not.toHaveBeenCalled()
  })
})
