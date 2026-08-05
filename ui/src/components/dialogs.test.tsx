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
import { mapMember } from '../data/mappers'

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

// U-4 (`detail`) and U-3 (`errorTone`) are both additive props whose whole
// safety argument is that omitting them renders what this component rendered
// before they existed. That argument is only true if something checks it, and
// checking it HERE covers every caller at once -- present and future -- rather
// than one screen's dialog at a time.
describe('ConfirmDialog optional props default to the original rendering', () => {
  it('renders exactly one paragraph when no detail is given', () => {
    render(<ConfirmDialog {...confirmProps()} />)
    const paragraphs = screen.getByRole('dialog').querySelectorAll('.dialog-message')
    expect(paragraphs).toHaveLength(1)
    expect(paragraphs[0]).toHaveTextContent('This is immediate.')
  })

  it('renders detail as a second paragraph, after the message', () => {
    render(<ConfirmDialog {...confirmProps({ detail: 'Anything already synced is cleaned up later.' })} />)
    const paragraphs = [...screen.getByRole('dialog').querySelectorAll('.dialog-message')]
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0]).toHaveTextContent('This is immediate.')
    expect(paragraphs[1]).toHaveTextContent('Anything already synced is cleaned up later.')
  })

  it('treats an empty detail as no detail rather than an empty paragraph', () => {
    render(<ConfirmDialog {...confirmProps({ detail: '' })} />)
    expect(screen.getByRole('dialog').querySelectorAll('.dialog-message')).toHaveLength(1)
  })

  it('tones an error as final unless the caller says otherwise', () => {
    render(<ConfirmDialog {...confirmProps({ error: 'That did not work.' })} />)
    // Absent errorTone must never read as retryable: a caller that has not been
    // taught the distinction is describing a failure, not an outage.
    expect(screen.getByRole('alert')).toHaveAttribute('data-tone', 'error')
    expect(screen.getByRole('alert')).not.toHaveClass('dialog-error-retryable')
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
  // Built through the real mapper rather than as a Member literal, for the
  // same reason FakeDataClient is: a hand-authored domain object can carry
  // fields the mapper would never produce, and this suite would then be
  // exercising a member the app cannot construct. Authoring the wire row is
  // also what stops this fixture from having to be edited every time a
  // derived field changes.
  //
  // #59: zero preFixLocal, because this row is about the member MENU, not
  // about search reach -- zero is the value that asserts nothing either way.
  const member: Member = mapMember(
    {
      user_id: 'andrew', display_name: 'Andrew', role: 'admin',
      joined_at: '2026-07-20T09:00:00Z', preFixLocal: { entries: 0, projects: 0 },
    },
    { projectCount: 1, lastSharedAt: null },
  )

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
