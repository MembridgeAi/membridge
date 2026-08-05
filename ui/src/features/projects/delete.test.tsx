// Task 6 (projects tab scale and archive): Delete is demoted to a
// single-project action behind a typed confirmation. It names what is
// destroyed in plain language and requires typing the project name; bulk
// selection has no Delete at all (asserted in archive.test.tsx).
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import type { DeleteProjectResult } from '../../data/types'
import { ProjectsPage } from './ProjectsPage'

async function openDeleteDialog(projectName: string) {
  const row = await screen.findByTestId(`project-row-${projectName}`)
  await userEvent.click(within(row).getByRole('button', { name: new RegExp(`delete ${projectName}`, 'i') }))
  return screen.findByRole('dialog')
}

describe('single-project delete with a typed confirmation', () => {
  it('keeps the destructive button disabled until the exact project name is typed', async () => {
    renderApp({}, <ProjectsPage />)
    const dialog = await openDeleteDialog('sublease')
    const confirm = within(dialog).getByRole('button', { name: /delete project/i })
    expect(confirm).toBeDisabled()

    const input = within(dialog).getByRole('textbox', { name: /type the project name/i })
    await userEvent.type(input, 'subleas')
    expect(confirm).toBeDisabled()
    await userEvent.type(input, 'e')
    expect(confirm).toBeEnabled()
  })

  it('names what is destroyed: .membridge/, the context files, and the team archive', async () => {
    renderApp({}, <ProjectsPage />)
    const dialog = await openDeleteDialog('sublease')
    const text = dialog.textContent ?? ''
    expect(text).toContain('.membridge/')
    expect(text).toMatch(/CLAUDE\.md|context file/i)
    expect(text).toMatch(/team archive/i)
  })

  it('deletes through the real client call once the name is typed', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'deleteProject')
    renderWith(client, <ProjectsPage />)
    const dialog = await openDeleteDialog('sublease')
    await userEvent.type(within(dialog).getByRole('textbox', { name: /type the project name/i }), 'sublease')
    await userEvent.click(within(dialog).getByRole('button', { name: /delete project/i }))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('/Users/x/sublease')
  })

  it('is reachable for exactly ONE project at a time and names it', async () => {
    renderApp({}, <ProjectsPage />)
    const dialog = await openDeleteDialog('membridge')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(dialog.textContent).toContain('membridge')
    expect(dialog.textContent).not.toContain('sublease')
  })

  it('offers no delete control at all while select mode is active', async () => {
    renderApp({}, <ProjectsPage />)
    await screen.findByTestId('project-row-membridge')
    expect(screen.getByRole('button', { name: /delete sublease/i })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^select$/i }))
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })
})

// Review finding (data loss): the daemon answers a plain member's delete of a
// SHARED project with HTTP 200 and { archived: false, message }, after
// unlinkProject has already pruned that member's durable teammate archive
// (lib/teamsync.js unlinkProject -> teamArchive.pruneArchive). The project is
// NOT deleted. Two independent defenses are required: never offer the control
// to someone the daemon will refuse, and never read a refusal body as success.
describe('a shared project’s delete is manager-only', () => {
  it('does not offer Delete on a shared project to a member (absent, not disabled)', async () => {
    renderApp({ role: 'member' }, <ProjectsPage />)
    await screen.findByTestId('project-row-membridge')
    const sharedRow = screen.getByTestId('project-row-membridge')
    expect(within(sharedRow).queryByRole('button', { name: /delete/i })).toBeNull()
    // A member keeps Delete on their OWN private project: this is a
    // shared-project gate, not a blanket role gate.
    const privateRow = screen.getByTestId('project-row-sublease')
    expect(within(privateRow).getByRole('button', { name: /delete sublease/i })).toBeInTheDocument()
  })

  it('offers Delete on a shared project to an owner', async () => {
    renderApp({}, <ProjectsPage />) // default role: owner
    const sharedRow = await screen.findByTestId('project-row-membridge')
    expect(within(sharedRow).getByRole('button', { name: /delete membridge/i })).toBeInTheDocument()
  })

  // The second defense, exercised for the race the gate above cannot cover
  // (role changed server-side, or a stale cached role): a 200 that reports
  // the delete did NOT happen must keep the dialog open and say why.
  it('keeps the dialog open and shows the daemon message when the delete was refused', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'deleteProject').mockResolvedValue({
      path: '/Users/x/membridge',
      scope: 'local',
      archived: false,
      unlinked: true,
      message: 'only owners or managers can delete a shared project for the team',
    })
    renderWith(client, <ProjectsPage />)
    const dialog = await openDeleteDialog('membridge')
    await userEvent.type(within(dialog).getByRole('textbox', { name: /type the project name/i }), 'membridge')
    await userEvent.click(within(dialog).getByRole('button', { name: /delete project/i }))

    const alert = await screen.findByText(/only owners or managers can delete a shared project/i)
    expect(alert).toHaveAttribute('role', 'alert')
    // Still open: the user must not be told a destruction they confirmed
    // succeeded when it did not.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('closes the dialog only on a real success', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'deleteProject').mockResolvedValue({ path: '/Users/x/sublease', scope: 'local', deleted: true })
    renderWith(client, <ProjectsPage />)
    const dialog = await openDeleteDialog('sublease')
    await userEvent.type(within(dialog).getByRole('textbox', { name: /type the project name/i }), 'sublease')
    await userEvent.click(within(dialog).getByRole('button', { name: /delete project/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

// U-3: two very different refusals arrive as the same 200 with the same field
// shapes. "You are not a manager" is FINAL -- retrying changes nothing. "We
// could not establish whether you are a manager" is INDETERMINATE: no
// connection or an expired sign-in, nothing on this machine was touched, and
// the identical delete may well succeed on the next attempt. Rendered
// identically, the outage sent the user off to argue about a role they already
// hold while the real cause was their connection.
//
// The discriminator is the daemon's `retryable` (lib/server.js
// RETRYABLE_REFUSALS). This screen must branch on THAT and never on the
// `refusal` code list, so a determinate refusal the daemon adds later reads as
// final here without this screen being taught its name.
describe('an outage refusal reads as retryable, a role refusal reads as final', () => {
  async function attemptDelete(result: DeleteProjectResult) {
    const client = new FakeDataClient()
    vi.spyOn(client, 'deleteProject').mockResolvedValue(result)
    renderWith(client, <ProjectsPage />)
    const dialog = await openDeleteDialog('membridge')
    await userEvent.type(within(dialog).getByRole('textbox', { name: /type the project name/i }), 'membridge')
    await userEvent.click(within(dialog).getByRole('button', { name: /delete project|try again/i }))
    return dialog
  }

  const ROLE_UNKNOWN = {
    path: '/Users/x/membridge', scope: 'local' as const, archived: false, unlinked: false,
    refusal: 'role-unknown' as const, retryable: true,
    message: 'could not confirm whether you manage this team — MemBridge could not be reached. '
      + 'Try the delete again in a moment. Nothing on this machine was changed.',
  }
  const NOT_MANAGER = {
    path: '/Users/x/membridge', scope: 'local' as const, archived: false, unlinked: true,
    refusal: 'not-manager' as const, retryable: false,
    message: 'only owners or managers can delete a shared project for the team',
  }

  it('offers the retry as the button itself, and tones the message down from red', async () => {
    const dialog = await attemptDelete(ROLE_UNKNOWN)
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent(/nothing on this machine was changed/i)
    // Amber, not red: this did not fail, it did not happen.
    expect(alert).toHaveAttribute('data-tone', 'retryable')
    // The confirm button IS the retry, and it says so. The typed name survives
    // the refusal, so it is enabled and one click away.
    const retry = within(dialog).getByRole('button', { name: /^try again$/i })
    expect(retry).toBeEnabled()
    expect(within(dialog).queryByRole('button', { name: /^delete project$/i })).toBeNull()
    // The dialog must still be open -- a refusal is never reported as a done
    // destruction.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('leaves a genuine role refusal final: still red, still "Delete project"', async () => {
    const dialog = await attemptDelete(NOT_MANAGER)
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent(/only owners or managers/i)
    expect(alert).toHaveAttribute('data-tone', 'error')
    expect(within(dialog).getByRole('button', { name: /^delete project$/i })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /^try again$/i })).toBeNull()
  })

  // The gate is `retryable`, NOT the refusal code. A refusal code this client
  // has never heard of, without retryable, must read as final -- which is what
  // makes a fourth determinate refusal safe to add daemon-side.
  it('treats an unrecognized refusal code as final rather than guessing', async () => {
    // Cast on purpose: 'quota-exceeded' is deliberately NOT in the declared
    // union, which is the whole point -- this models a daemon newer than this
    // client, and the type must not be able to pretend that cannot happen.
    const dialog = await attemptDelete({
      path: '/Users/x/membridge', scope: 'local', archived: false, unlinked: false,
      refusal: 'quota-exceeded', retryable: false,
      message: 'this team is over its project limit',
    } as unknown as DeleteProjectResult)
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveAttribute('data-tone', 'error')
    expect(within(dialog).queryByRole('button', { name: /^try again$/i })).toBeNull()
  })

  // An older daemon sends neither field. Absent must mean final, which is
  // exactly the behaviour this screen had before the discriminator existed --
  // the alternative (absent means retryable) would invite a retry after a
  // refusal that already unlinked the machine.
  it('reads a pre-discriminator daemon\'s refusal as final', async () => {
    const dialog = await attemptDelete({
      path: '/Users/x/membridge', scope: 'local', archived: false, unlinked: true,
      message: 'only owners or managers can delete a shared project for the team',
    })
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveAttribute('data-tone', 'error')
    expect(within(dialog).getByRole('button', { name: /^delete project$/i })).toBeInTheDocument()
  })

  // A transport failure is a different thing again: the request itself threw,
  // so nothing is known about what the daemon did. It must not borrow the
  // retryable treatment -- "nothing on this machine was changed" is a promise
  // only a refusal body can make.
  it('does not dress a thrown request up as a retryable refusal', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'deleteProject').mockRejectedValue(new Error('fetch failed'))
    renderWith(client, <ProjectsPage />)
    const dialog = await openDeleteDialog('membridge')
    await userEvent.type(within(dialog).getByRole('textbox', { name: /type the project name/i }), 'membridge')
    await userEvent.click(within(dialog).getByRole('button', { name: /^delete project$/i }))
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent(/fetch failed/i)
    expect(alert).toHaveAttribute('data-tone', 'error')
    expect(within(dialog).queryByRole('button', { name: /^try again$/i })).toBeNull()
  })
})
