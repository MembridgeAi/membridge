// Adding a project is picking from a list or clicking through a native
// picker — never typing an absolute path. These tests pin BOTH halves of
// that: the path field is gone, and each of the two remaining routes ends in
// the same bulk adopt call.
import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { AddProjectDialog } from './AddProjectDialog'

function open(client: FakeDataClient) {
  renderWith(client, <AddProjectDialog onClose={() => {}} />)
  return screen.findByRole('dialog')
}

describe('add project without ever typing a path', () => {
  it('offers no path field at all', async () => {
    const dialog = await open(new FakeDataClient())
    await within(dialog).findByRole('checkbox', { name: 'polycopy' })
    expect(within(dialog).queryByRole('textbox')).toBeNull()
  })

  it('lists what the scan found, and never a folder that is already watched', async () => {
    const dialog = await open(new FakeDataClient())
    expect(await within(dialog).findByRole('checkbox', { name: 'polycopy' })).toBeInTheDocument()
    expect(within(dialog).getByRole('checkbox', { name: 'site' })).toBeInTheDocument()
    // membridge is tracked in the fixture: it is already being watched, so
    // offering it again would be a checkbox that does nothing.
    expect(within(dialog).queryByRole('checkbox', { name: 'membridge' })).toBeNull()
  })

  it('shows how much work each folder holds, so the choice is informed', async () => {
    const dialog = await open(new FakeDataClient())
    const row = await within(dialog).findByTestId('discover-row-polycopy')
    expect(row.textContent).toMatch(/12 sessions/)
    expect(row.textContent).toMatch(/Claude Code/)
  })

  it('adds only the rows still checked', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'adoptProjects')
    const dialog = await open(client)
    await userEvent.click(await within(dialog).findByRole('checkbox', { name: 'site' }))
    await userEvent.click(within(dialog).getByRole('button', { name: /add 1 project/i }))
    expect(spy).toHaveBeenCalledWith(['/Users/x/polycopy'])
  })

  it('sends one request for the whole selection, not one per folder', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'adoptProjects')
    const dialog = await open(client)
    await userEvent.click(await within(dialog).findByRole('button', { name: /add 2 projects/i }))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('opens a native folder picker and adopts what came back', async () => {
    const client = new FakeDataClient({ pickPathsResult: ['/Users/x/brand-new'] })
    const spy = vi.spyOn(client, 'adoptProjects')
    const dialog = await open(client)
    await userEvent.click(await within(dialog).findByRole('button', { name: /browse for a folder/i }))
    expect(spy).toHaveBeenCalledWith(['/Users/x/brand-new'])
  })

  it('adds nothing when the picker is cancelled', async () => {
    const client = new FakeDataClient({ pickPathsResult: [] })
    const spy = vi.spyOn(client, 'adoptProjects')
    const dialog = await open(client)
    await userEvent.click(await within(dialog).findByRole('button', { name: /browse for a folder/i }))
    expect(spy).not.toHaveBeenCalled()
  })

  it('says where to browse from instead of rendering a picker a browser tab cannot open', async () => {
    const dialog = await open(new FakeDataClient({ filePickerAvailable: false }))
    await within(dialog).findByRole('checkbox', { name: 'polycopy' })
    expect(within(dialog).queryByRole('button', { name: /browse/i })).toBeNull()
    expect(within(dialog).getByText(/desktop app/i)).toBeInTheDocument()
  })

  it('names the folders that were skipped rather than reporting the sweep as a success', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'adoptProjects').mockResolvedValue({
      adopted: ['/Users/x/polycopy'],
      skipped: [{ path: '/Users/x/site', reason: 'not a directory' }],
      historyWithheld: [],
    })
    const dialog = await open(client)
    await userEvent.click(await within(dialog).findByRole('button', { name: /add 2 projects/i }))
    const report = await screen.findByRole('alert')
    expect(report.textContent).toMatch(/Added 1 of 2/)
    expect(report.textContent).toMatch(/not a directory/)
  })

  it('says the machine is fully covered rather than showing an empty list', async () => {
    const dialog = await open(new FakeDataClient({ discovered: [] }))
    expect(await within(dialog).findByText(/already being watched/i)).toBeInTheDocument()
  })

  // A re-adopt of a project the user deleted on purpose comes back with the
  // path in historyWithheld: the folder IS watched again, but the injected
  // memory block will land empty for it. The CLI already prints this; before
  // this test the dialog swallowed it and closed, so the user saw an empty
  // block and had no reason offered for it.
  it('names the folders whose earlier memory was withheld so an empty block is explained', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'adoptProjects').mockResolvedValue({
      adopted: ['/Users/x/polycopy', '/Users/x/site'],
      skipped: [],
      historyWithheld: ['/Users/x/polycopy'],
    })
    const dialog = await open(client)
    await userEvent.click(await within(dialog).findByRole('button', { name: /add 2 projects/i }))
    const notice = await within(dialog).findByRole('status')
    expect(notice.textContent).toMatch(/previously deleted/i)
    expect(notice.textContent).toMatch(/\/Users\/x\/polycopy/)
    // site was adopted normally: its path must NOT be listed in the
    // withheld notice, otherwise "withheld" stops meaning anything.
    expect(notice.textContent).not.toMatch(/\/Users\/x\/site/)
  })

  it('keeps the dialog open when history is withheld so the reason stays on screen', async () => {
    const onClose = vi.fn()
    const client = new FakeDataClient()
    vi.spyOn(client, 'adoptProjects').mockResolvedValue({
      adopted: ['/Users/x/polycopy', '/Users/x/site'],
      skipped: [],
      historyWithheld: ['/Users/x/polycopy'],
    })
    renderWith(client, <AddProjectDialog onClose={onClose} />)
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(await within(dialog).findByRole('button', { name: /add 2 projects/i }))
    await within(dialog).findByRole('status')
    expect(onClose).not.toHaveBeenCalled()
  })
})
