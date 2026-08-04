// Fix 11: both dialogs claimed aria-modal="true" but implemented none of the
// modal contract -- no focus on open, no Tab trap, no Escape, no focus
// restore. These tests drive the testable half of that contract through the
// shared useDialogFocus hook; the Tab-trap edge wrapping is covered too.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { ConfirmDialog } from './ConfirmDialog'
import { FormDialog } from './FormDialog'
import { MemberRow } from '../features/members/MemberRow'
import type { Member } from '../data/types'

function confirmProps(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  return {
    title: 'Remove Sarah from the team?',
    message: 'This is immediate.',
    confirmLabel: 'Remove',
    onConfirm: () => {},
    onCancel: () => {},
    ...overrides,
  }
}

afterEach(cleanup)

describe('ConfirmDialog modal behavior (Fix 11)', () => {
  it('moves focus into the dialog on open', async () => {
    render(<ConfirmDialog {...confirmProps()} />)
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  })

  it('closes on Escape', async () => {
    const onCancel = vi.fn()
    render(<ConfirmDialog {...confirmProps({ onCancel })} />)
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalled()
  })

  it('does not close on Escape while the action is pending', async () => {
    const onCancel = vi.fn()
    render(<ConfirmDialog {...confirmProps({ onCancel, pending: true })} />)
    await userEvent.keyboard('{Escape}')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('traps Tab inside the dialog (wraps from last to first)', async () => {
    render(<ConfirmDialog {...confirmProps()} />)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const confirm = screen.getByRole('button', { name: 'Remove' })
    confirm.focus()
    await userEvent.keyboard('{Tab}')
    expect(document.activeElement).toBe(cancel)
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
    expect(document.activeElement).toBe(confirm)
  })

  it('restores focus to the opener when the dialog closes', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
          {open && <ConfirmDialog {...confirmProps({ onCancel: () => setOpen(false) })} />}
        </>
      )
    }
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open dialog' })
    await userEvent.click(opener)
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })
})

describe('FormDialog modal behavior (Fix 11)', () => {
  it('moves focus into the dialog on open and closes on Escape', async () => {
    const onClose = vi.fn()
    render(
      <FormDialog titleId="t" title="Edit things" onClose={onClose}>
        <button type="button">Save</button>
      </FormDialog>,
    )
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })
})

describe('MemberRow menu focus restore (Fix 11)', () => {
  const member: Member = {
    id: 'andrew', name: 'Andrew', email: 'andrew@acme.dev', role: 'admin',
    joinedAt: '2026-07-20T09:00:00Z', projectCount: 1, lastSharedAt: null, keyAlert: false,
  }

  function renderRow(onRequestRemove: (m: Member) => void = () => {}) {
    render(
      <MemberRow
        member={member}
        isSelf={false}
        canManage
        onSetRole={() => {}}
        onRequestRemove={onRequestRemove}
      />,
    )
  }

  it('returns focus to the ⋯ button when the menu closes on Escape', async () => {
    renderRow()
    const more = screen.getByRole('button', { name: /more actions for andrew/i })
    await userEvent.click(more)
    await screen.findByRole('menu')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(document.activeElement).toBe(more))
  })

  it('returns focus to the ⋯ button after choosing a menu item', async () => {
    const onRequestRemove = vi.fn()
    renderRow(onRequestRemove)
    const more = screen.getByRole('button', { name: /more actions for andrew/i })
    await userEvent.click(more)
    await userEvent.click(await screen.findByRole('menuitem', { name: /remove from team/i }))
    expect(onRequestRemove).toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(more))
  })
})
