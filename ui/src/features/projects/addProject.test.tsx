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
})
