import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { ProjectsPage } from './ProjectsPage'

describe('ProjectsPage', () => {
  it('loads the whole matrix in a single request', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'getAccessMatrix')
    renderWith(client, <ProjectsPage />)
    await screen.findByText('membridge')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  // The redesign removed the dead dashed cells outright (spec: a private
  // row renders no checkbox at all, not a restyled disabled one).
  it('renders no access control at all for a private project', async () => {
    renderApp({}, <ProjectsPage />)
    const row = await screen.findByTestId('project-row-sublease')
    expect(within(row).queryAllByRole('checkbox')).toHaveLength(0)
    expect(within(row).getByText(/only you/i)).toBeInTheDocument()
  })

  it('shows one Access column and no per-member columns, to a member and to an admin alike', async () => {
    const member = renderApp({ role: 'member' }, <ProjectsPage />)
    await screen.findByText('membridge')
    expect(screen.getByRole('columnheader', { name: 'Access' })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: /Andrew/ })).toBeNull()
    member.unmount()

    renderApp({}, <ProjectsPage />)
    await screen.findByText('membridge')
    expect(screen.getByRole('columnheader', { name: 'Access' })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: /Andrew/ })).toBeNull()
  })

  // Renamed: this only ever asserted that team size does not add columns. It
  // was titled "never scrolls the page sideways", which it never checked and
  // which was in fact false -- an arbitrary-length project path could push the
  // table past the window regardless of the column count. jsdom does no
  // layout, so the width bound itself is unassertable here; it lives in
  // projects.css and was verified by measuring min-content in a real browser.
  it('adds no columns as the team grows, so it needs no scroll wrapper', async () => {
    const { container } = renderApp({ teamSize: 30 }, <ProjectsPage />)
    await screen.findByTestId('project-row-membridge')
    expect(container.querySelector('.scroll-x')).toBeNull()
  })

  // The width fix clamps the path to two lines, which can hide its tail -- and
  // the tail is the only thing telling two worktrees of one repo apart. What
  // IS assertable in jsdom is that the full value stays recoverable, so this
  // guards the `title` the clamp depends on rather than the clamp itself.
  it('keeps a long project path fully recoverable via title, even though it is clamped', async () => {
    const longPath = '/Users/marco/Documents/Membridge/checkouts/experimental/packages/serverRuntimeInternal/src'
    const client = new FakeDataClient()
    const [first, ...rest] = await client.getProjects()
    vi.spyOn(client, 'getProjects').mockResolvedValue([{ ...first, path: longPath }, ...rest])
    renderWith(client, <ProjectsPage />)

    const row = await screen.findByTestId(`project-row-${first.name}`)
    const path = within(row).getByText(longPath)
    expect(path).toHaveAttribute('title', longPath)
  })

  // Finding 2: asserting only the cell's rendered `checked` state would still
  // pass for a component that flipped local UI state without ever calling
  // setProjectAccess -- so this spies on the client call itself, and on the
  // exact (projectPath, memberId, canSee) it was invoked with.
  it('calls setProjectAccess with the project, member, and new value when a popover toggle is flipped', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setProjectAccess')
    renderWith(client, <ProjectsPage />)
    const row = await screen.findByTestId('project-row-membridge')
    await userEvent.click(within(row).getByRole('button', { name: /access for membridge/i }))
    const popover = await screen.findByRole('dialog')
    // membridge is shared, and Sarah starts checked=true in the fixture --
    // an enabled, non-self toggle whose click has a determinate before/after.
    await userEvent.click(within(popover).getByRole('checkbox', { name: /Sarah/ }))
    expect(spy).toHaveBeenCalledWith('/Users/x/membridge', 'sarah', false)
  })

  // Finding 3: useSetProjectAccess applies an optimistic update and rolls it
  // back in onError -- untested rollback means a failed write could leave a
  // toggle stuck flipped, telling the user someone is blocked when they are
  // not. Drives the real hook (not a mock of it) by rejecting the client
  // call it wraps. The rejection is held open on a controlled promise (never
  // mockRejectedValueOnce) so the optimistic-flip state is actually
  // observable instead of racing straight through to the rollback in the
  // same tick.
  it('reverts an optimistic popover toggle when setProjectAccess rejects', async () => {
    const client = new FakeDataClient()
    let rejectWrite!: (err: Error) => void
    const write = new Promise<void>((_, reject) => { rejectWrite = reject })
    vi.spyOn(client, 'setProjectAccess').mockReturnValue(write)
    renderWith(client, <ProjectsPage />)
    const row = await screen.findByTestId('project-row-membridge')
    await userEvent.click(within(row).getByRole('button', { name: /access for membridge/i }))
    const popover = await screen.findByRole('dialog')
    const cell = within(popover).getByRole('checkbox', { name: /Sarah/ }) as HTMLInputElement
    expect(cell.checked).toBe(true)

    await userEvent.click(cell)
    await waitFor(() => expect(cell.checked).toBe(false)) // optimistic flip, write still pending

    rejectWrite(new Error('write failed'))
    await waitFor(() => expect(cell.checked).toBe(true)) // rollback once the write rejects
  })

  // Fix 8: the rollback above needs a visible reason -- a role="alert" line,
  // mirroring how ProjectPage surfaces setAccessDefault failures.
  it('surfaces a failed access toggle instead of silently snapping back', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'setProjectAccess').mockRejectedValue(new Error('access write rejected'))
    renderWith(client, <ProjectsPage />)
    const row = await screen.findByTestId('project-row-membridge')
    await userEvent.click(within(row).getByRole('button', { name: /access for membridge/i }))
    const popover = await screen.findByRole('dialog')
    await userEvent.click(within(popover).getByRole('checkbox', { name: /Sarah/ }))
    const alert = await screen.findByText(/couldn't change access/i)
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert.textContent).toContain('access write rejected')
  })

  // Fix 9: a failed row sync must not look like nothing happened.
  it('surfaces a failed project sync instead of looking like nothing happened', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'syncProject').mockRejectedValue(new Error('sync exploded'))
    renderWith(client, <ProjectsPage />)
    const row = await screen.findByTestId('project-row-sublease') // the behind fixture row
    await userEvent.click(within(row).getByRole('button', { name: 'Sync now' }))
    const alert = await screen.findByText(/couldn't sync/i)
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert.textContent).toContain('sync exploded')
  })

  // The self-revoke guard used to compare a member's id against a hardcoded
  // two-letter placeholder -- a value the real daemon never sends (a real
  // user id looks like 'usr_9f2a'), so the guard silently never activated in
  // production. This drives the fixture with a REALISTIC id to prove the
  // guard now reads settings.viewerId instead of that sentinel.
  it('guards the viewer’s own row using the real viewerId, not a hardcoded placeholder', async () => {
    const client = new FakeDataClient({ viewerId: 'usr_9f2a' })
    renderWith(client, <ProjectsPage />)
    const row = await screen.findByTestId('project-row-membridge')
    await userEvent.click(within(row).getByRole('button', { name: /access for membridge/i }))
    const popover = await screen.findByRole('dialog')
    // Marco is the viewer (usr_9f2a): listed, but never a toggle. Sarah is
    // another member and stays toggleable, proving the guard keys off the
    // real id rather than disabling everyone.
    expect(within(popover).getByText(/Marco/)).toBeInTheDocument()
    expect(within(popover).queryByRole('checkbox', { name: /Marco/i })).toBeNull()
    expect(within(popover).getByRole('checkbox', { name: /Sarah/i })).toBeInTheDocument()
  })

  it('adds the discovered projects the user picked, through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'adoptProjects')
    renderWith(client, <ProjectsPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^add project$/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(await within(dialog).findByRole('button', { name: /add 2 projects/i }))
    expect(spy).toHaveBeenCalledWith(['/Users/x/polycopy', '/Users/x/site'])
  })

  it('surfaces a failed add instead of looking like nothing happened', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'adoptProjects').mockRejectedValue(new Error('not a directory'))
    renderWith(client, <ProjectsPage />)
    await userEvent.click(await screen.findByRole('button', { name: /^add project$/i }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(await within(dialog).findByRole('button', { name: /add 2 projects/i }))
    expect(await screen.findByText(/not a directory/i)).toBeInTheDocument()
  })
})
